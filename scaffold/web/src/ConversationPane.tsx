import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Me } from './api';
import { formatTime, personLabel } from './format';
import type { LocalMessage, Thread } from './inbox-state';

interface Props {
  me: Me;
  selected: string | null;
  thread: Thread | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
  onReply: (text: string, clientRef?: string) => Promise<void>;
  onAction: (action: 'claim' | 'close' | 'reopen') => Promise<string | null>;
}

const STATUS_LABEL: Record<string, string> = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' };

export function ConversationPane(p: Props) {
  if (!p.selected) {
    return (
      <section className="pane empty-pane">
        <div className="empty">
          <p className="empty-title">Select a conversation</p>
          <p className="muted">Pick a customer on the left to read and reply.</p>
        </div>
      </section>
    );
  }
  if (p.loading) {
    return (
      <section className="pane" aria-busy="true">
        <div className="empty muted">Loading conversation…</div>
      </section>
    );
  }
  if (!p.thread) {
    return (
      <section className="pane">
        <div className="empty">
          <p className="empty-title">Could not open this conversation</p>
          <p className="muted">{p.error}</p>
          <button className="button" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      </section>
    );
  }
  return <Open {...p} thread={p.thread} />;
}

function Open({ me, thread, error, onBack, onReply, onAction }: Props & { thread: Thread }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => setActionError(null), [thread.contact]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [thread.messages.length, thread.contact]);

  const run = async (action: 'claim' | 'close' | 'reopen') => {
    setBusy(action);
    setActionError(null);
    setActionError(await onAction(action));
    setBusy(null);
  };

  const mine = thread.assignee === me.sub;
  const closed = thread.status === 'closed';

  return (
    <section className="pane" aria-label={`Conversation with ${thread.contact}`}>
      <header className="pane-head">
        <button className="link back" onClick={onBack} aria-label="Back to the list">
          ←
        </button>
        <div className="who">
          <h2>{thread.contact}</h2>
          <p className="muted small">
            <span className={`badge ${thread.status}`}>{thread.status}</span> {thread.assignee ? `Assigned to ${mine ? 'you' : thread.assignee}` : 'Unassigned'}
          </p>
        </div>
        <div className="actions">
          {!mine && (
            <button className="button" onClick={() => run('claim')} disabled={!!busy} title={thread.assignee ? `Held by ${thread.assignee}` : 'Take this conversation'}>
              {busy === 'claim' ? 'Claiming…' : 'Claim'}
            </button>
          )}
          {closed ? (
            <button className="button" onClick={() => run('reopen')} disabled={!!busy}>
              {busy === 'reopen' ? 'Reopening…' : 'Reopen'}
            </button>
          ) : (
            <button className="button" onClick={() => run('close')} disabled={!!busy}>
              {busy === 'close' ? 'Closing…' : 'Close'}
            </button>
          )}
        </div>
      </header>

      {(actionError || error) && (
        <div className="notice error" role="alert">
          {actionError ?? error}
        </div>
      )}

      <ol className="messages">
        {thread.messages.length === 0 && <li className="empty muted">No messages yet. Write the first one below.</li>}
        {thread.messages.map((m) => (
          <Bubble key={m.id} m={m} me={me} onRetry={() => onReply(m.text, m.id)} />
        ))}
        <div ref={bottom} />
      </ol>

      <ReplyBox key={thread.contact} closed={closed} onSend={(text) => onReply(text)} />
    </section>
  );
}

function Bubble({ m, me, onRetry }: { m: LocalMessage; me: Me; onRetry: () => void }) {
  const out = m.direction === 'outbound';
  return (
    <li className={`bubble ${out ? 'out' : 'in'}`}>
      <p className="text">{m.text}</p>
      <p className="meta small">
        <time dateTime={m.at}>{formatTime(m.at)}</time>
        {out && m.author && <span> · {personLabel(m.author, me)}</span>}
        {out && (
          <span className={`status ${m.error ? 'failed' : (m.status ?? '')}`}>
            {' · '}
            {m.sending ? 'Sending…' : m.error ? 'Not sent' : STATUS_LABEL[m.status ?? 'queued']}
          </span>
        )}
      </p>
      {m.error && (
        <p className="small bubble-error">
          {m.error} <button className="link" onClick={onRetry}>Retry</button>
        </p>
      )}
    </li>
  );
}

function ReplyBox({ closed, onSend }: { closed: boolean; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const trimmed = text.trim();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!trimmed) return;
    setText(''); // the message shows at once with "Sending…"; a failure offers Retry on it
    void onSend(trimmed);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  };

  return (
    <form className="reply" onSubmit={submit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={2}
        maxLength={4000}
        placeholder={closed ? 'This conversation is closed. Replying still works.' : 'Write a reply… (Enter to send, Shift+Enter for a new line)'}
        aria-label="Reply"
      />
      <button className="button primary" type="submit" disabled={!trimmed}>
        Send
      </button>
    </form>
  );
}
