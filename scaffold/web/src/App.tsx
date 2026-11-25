import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, explain, type Me } from './api';
import { Inbox } from './Inbox';

type Session = { state: 'loading' } | { state: 'signedOut'; reason?: string } | { state: 'error'; message: string } | { state: 'ready'; me: Me };

// The open workspace and conversation live in the URL, so a refresh or a
// shared link lands in the same place.
const params = () => new URLSearchParams(location.search);
function setParam(name: string, value: string | null) {
  const p = params();
  if (value) p.set(name, value);
  else p.delete(name);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [workspace, setWorkspace] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSession({ state: 'loading' });
    try {
      const me = await api.me();
      setSession({ state: 'ready', me });
      const wanted = params().get('ws');
      setWorkspace(me.workspaces.some((w) => w.id === wanted) ? wanted : (me.workspaces[0]?.id ?? null));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession({ state: 'signedOut' });
      else setSession({ state: 'error', message: explain(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signedOut = useCallback(() => setSession({ state: 'signedOut', reason: 'Your session has ended. Sign in again to continue.' }), []);
  const onContactChange = useCallback((contact: string | null) => setParam('c', contact), []);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setParam('c', null);
    setSession({ state: 'signedOut' });
  };

  if (session.state === 'loading') {
    return <Centered>Loading…</Centered>;
  }
  if (session.state === 'error') {
    return (
      <Centered>
        <p className="empty-title">Switchboard is not reachable</p>
        <p className="muted">{session.message}</p>
        <button className="button" onClick={() => void load()}>
          Try again
        </button>
      </Centered>
    );
  }
  if (session.state === 'signedOut') {
    return (
      <Centered>
        <h1 className="brand-big">Switchboard</h1>
        <p className="muted">The shared inbox for your support team.</p>
        {session.reason && <p className="notice">{session.reason}</p>}
        <a className="button primary" href="/auth/login">
          Sign in
        </a>
      </Centered>
    );
  }

  const { me } = session;
  const role = me.workspaces.find((w) => w.id === workspace)?.role;
  return (
    <div className="app">
      <header className="top">
        <span className="brand">Switchboard</span>
        {me.workspaces.length > 1 ? (
          <select
            className="workspace"
            value={workspace ?? ''}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setParam('ws', e.target.value);
              setParam('c', null);
            }}
            aria-label="Workspace"
          >
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id}
              </option>
            ))}
          </select>
        ) : (
          workspace && <span className="workspace-name">{workspace}</span>
        )}
        <span className="spacer" />
        <span className="muted small">
          {me.name ?? me.sub}
          {role ? ` · ${role}` : ''}
        </span>
        <button className="link" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {workspace ? (
        <Inbox key={workspace} me={me} workspace={workspace} initialContact={params().get('c')} onContactChange={onContactChange} onSignedOut={signedOut} />
      ) : (
        <Centered>
          <p className="empty-title">No workspaces</p>
          <p className="muted">Your account is not a member of any workspace. Ask an admin to add you.</p>
        </Centered>
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="centered">{children}</main>;
}
