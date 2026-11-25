import type { ConversationSummary, Me } from './api';
import type { Filter } from './inbox-state';
import type { LiveState } from './live';
import { formatTime, personLabel } from './format';

interface Props {
  me: Me;
  items: ConversationSummary[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  filter: Filter;
  selected: string | null;
  live: LiveState;
  onFilter: (f: Filter) => void;
  onSelect: (contact: string) => void;
  onRetry: () => void;
  onMore: () => void;
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

const LIVE_LABEL: Record<LiveState, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };

export function ConversationList(p: Props) {
  return (
    <aside className={`list ${p.selected ? 'has-selection' : ''}`} aria-label="Conversations">
      <div className="list-head">
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={p.filter === f.id} className={p.filter === f.id ? 'tab active' : 'tab'} onClick={() => p.onFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className={`live live-${p.live}`} title="Updates arrive without refreshing">
          <span className="dot" /> {LIVE_LABEL[p.live]}
        </span>
      </div>

      {p.error && (
        <div className="notice error" role="alert">
          {p.error} <button className="link" onClick={p.onRetry}>Try again</button>
        </div>
      )}

      {p.loading ? (
        <ul className="rows" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="row skeleton" />
          ))}
        </ul>
      ) : p.items.length === 0 && !p.error ? (
        <div className="empty">
          <p className="empty-title">{p.filter === 'closed' ? 'No closed conversations' : 'No conversations yet'}</p>
          <p className="muted">{p.filter === 'closed' ? 'Closed conversations will show up here.' : 'When a customer writes in, the conversation appears here instantly.'}</p>
        </div>
      ) : (
        <ul className="rows">
          {p.items.map((c) => (
            <li key={c.contact}>
              <button className={`row ${p.selected === c.contact ? 'selected' : ''}`} onClick={() => p.onSelect(c.contact)} aria-current={p.selected === c.contact}>
                <span className="row-top">
                  <span className="contact">{c.contact}</span>
                  <time className="muted small" dateTime={c.lastActivityAt}>
                    {formatTime(c.lastActivityAt)}
                  </time>
                </span>
                <span className="row-bottom">
                  <span className={`badge ${c.status}`}>{c.status}</span>
                  <span className="muted small">{c.assignee ? personLabel(c.assignee, p.me) : 'Unassigned'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {p.hasMore && !p.loading && (
        <button className="more" onClick={p.onMore} disabled={p.loadingMore}>
          {p.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </aside>
  );
}
