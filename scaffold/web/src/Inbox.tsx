import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, explain, type ConversationSummary, type Me } from './api';
import { ConversationList } from './ConversationList';
import { ConversationPane } from './ConversationPane';
import { applyToList, applyToThread, mergeFetched, type Filter, type LocalMessage, type Thread } from './inbox-state';
import { useLiveEvents, type Frame } from './live';

type ListState = { items: ConversationSummary[]; cursor: string | null; loading: boolean; loadingMore: boolean; error: string | null };
type ThreadState = { thread: Thread | null; loading: boolean; error: string | null };

interface Props {
  me: Me;
  workspace: string;
  initialContact: string | null;
  onContactChange: (contact: string | null) => void;
  onSignedOut: () => void;
}

/** One workspace: the conversation list, the open conversation, and the live connection feeding both. */
export function Inbox({ me, workspace, initialContact, onContactChange, onSignedOut }: Props) {
  const [filter, setFilter] = useState<Filter>('open');
  const [list, setList] = useState<ListState>({ items: [], cursor: null, loading: true, loadingMore: false, error: null });
  const [selected, setSelected] = useState<string | null>(initialContact);
  const [view, setView] = useState<ThreadState>({ thread: null, loading: false, error: null });

  // Refs so live callbacks always see the latest values without reconnecting.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const itemsRef = useRef(list.items);
  itemsRef.current = list.items;
  const listRequest = useRef(0);
  const threadRequest = useRef(0);

  const failed = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      return explain(err);
    },
    [onSignedOut],
  );

  // ------------------------------------------------------------ the list
  const loadList = useCallback(async () => {
    const id = ++listRequest.current; // only the newest request may write
    setList((s) => ({ ...s, loading: s.items.length === 0, error: null }));
    try {
      const page = await api.list(workspace, { status: filterRef.current });
      if (id === listRequest.current) setList({ items: page.conversations, cursor: page.nextCursor, loading: false, loadingMore: false, error: null });
    } catch (err) {
      if (id === listRequest.current) setList((s) => ({ ...s, loading: false, error: failed(err) }));
    }
  }, [workspace, failed]);

  const loadMore = useCallback(async () => {
    if (!list.cursor) return;
    const id = listRequest.current;
    setList((s) => ({ ...s, loadingMore: true }));
    try {
      const page = await api.list(workspace, { status: filterRef.current, cursor: list.cursor });
      if (id !== listRequest.current) return;
      setList((s) => {
        const known = new Set(s.items.map((c) => c.contact));
        return { ...s, items: [...s.items, ...page.conversations.filter((c) => !known.has(c.contact))], cursor: page.nextCursor, loadingMore: false };
      });
    } catch (err) {
      setList((s) => ({ ...s, loadingMore: false, error: failed(err) }));
    }
  }, [workspace, list.cursor, failed]);

  useEffect(() => {
    setList({ items: [], cursor: null, loading: true, loadingMore: false, error: null });
    void loadList();
  }, [loadList, filter]);

  // ------------------------------------------------------- one conversation
  const loadThread = useCallback(
    async (contact: string, quiet = false) => {
      const id = ++threadRequest.current;
      if (!quiet) setView({ thread: null, loading: true, error: null });
      try {
        const fetched = await api.conversation(workspace, contact);
        if (id === threadRequest.current) setView((v) => ({ thread: mergeFetched(fetched, v.thread), loading: false, error: null }));
      } catch (err) {
        if (id === threadRequest.current) setView((v) => ({ thread: quiet ? v.thread : null, loading: false, error: failed(err) }));
      }
    },
    [workspace, failed],
  );

  useEffect(() => {
    onContactChange(selected);
    if (selected) void loadThread(selected);
    else setView({ thread: null, loading: false, error: null });
  }, [selected, loadThread, onContactChange]);

  // ------------------------------------------------------------ live
  const onFrame = useCallback(
    (f: Frame) => {
      // React may run state updaters later, so decide "reload?" from the items on screen now.
      if (applyToList(itemsRef.current, f, filterRef.current).reload) void loadList();
      else
        setList((s) => {
          const r = applyToList(s.items, f, filterRef.current);
          return r.items === s.items ? s : { ...s, items: r.items };
        });
      if (f.contact === selectedRef.current) setView((v) => (v.thread ? { ...v, thread: applyToThread(v.thread, f) } : v));
    },
    [loadList],
  );
  const onResync = useCallback(() => {
    void loadList();
    if (selectedRef.current) void loadThread(selectedRef.current, true);
  }, [loadList, loadThread]);
  const live = useLiveEvents(workspace, onFrame, onResync);

  // ------------------------------------------------------------ actions
  const patchThread = (fn: (t: Thread) => Thread) => setView((v) => (v.thread ? { ...v, thread: fn(v.thread) } : v));
  const patchItem = (contact: string, patch: Partial<ConversationSummary>) =>
    setList((s) => ({ ...s, items: s.items.map((c) => (c.contact === contact ? { ...c, ...patch } : c)) }));

  /** Send a reply. The client_ref is made here, so a retry of the same reply is the same reply. */
  const sendReply = async (text: string, clientRef: string = crypto.randomUUID()) => {
    const thread = view.thread;
    if (!thread) return;
    const contact = thread.contact;
    const draft: LocalMessage = { id: clientRef, direction: 'outbound', text, at: new Date().toISOString(), status: 'queued', author: me.sub, sending: true };
    patchThread((t) => ({ ...t, messages: t.messages.some((m) => m.id === clientRef) ? t.messages.map((m) => (m.id === clientRef ? { ...m, sending: true, error: undefined } : m)) : [...t.messages, draft] }));
    try {
      await api.reply(workspace, contact, text, clientRef);
      patchThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === clientRef ? { ...m, sending: false } : m)) }));
    } catch (err) {
      const message = failed(err);
      patchThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === clientRef ? { ...m, sending: false, error: message } : m)) }));
    }
  };

  /** Claim, close or reopen; the server's answer (and the live frame) updates the screen. */
  const act = async (action: 'claim' | 'close' | 'reopen'): Promise<string | null> => {
    const contact = view.thread?.contact;
    if (!contact) return null;
    try {
      if (action === 'claim') {
        const { assignee } = await api.claim(workspace, contact);
        patchThread((t) => ({ ...t, assignee }));
        patchItem(contact, { assignee });
      } else {
        const updated = await (action === 'close' ? api.close : api.reopen)(workspace, contact);
        patchThread((t) => ({ ...t, status: updated.status }));
        if (filterRef.current !== 'all' && filterRef.current !== updated.status) setList((s) => ({ ...s, items: s.items.filter((c) => c.contact !== contact) }));
        else patchItem(contact, { status: updated.status });
      }
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.body.assignee === 'string') {
        const assignee = err.body.assignee;
        patchThread((t) => ({ ...t, assignee }));
        patchItem(contact, { assignee });
      }
      return failed(err);
    }
  };

  return (
    <div className="inbox">
      <ConversationList
        me={me}
        items={list.items}
        loading={list.loading}
        loadingMore={list.loadingMore}
        error={list.error}
        hasMore={!!list.cursor}
        filter={filter}
        selected={selected}
        live={live}
        onFilter={(f) => setFilter(f)}
        onSelect={setSelected}
        onRetry={() => void loadList()}
        onMore={() => void loadMore()}
      />
      <ConversationPane
        me={me}
        selected={selected}
        thread={view.thread}
        loading={view.loading}
        error={view.error}
        onRetry={() => selected && void loadThread(selected)}
        onBack={() => setSelected(null)}
        onReply={sendReply}
        onAction={act}
      />
    </div>
  );
}
