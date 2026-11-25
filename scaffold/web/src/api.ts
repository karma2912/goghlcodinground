// Typed calls to the server. The Vite dev server proxies /api, /auth and /ws
// to it, so the browser talks to one origin and the session cookie just works.

export type Role = 'admin' | 'agent';
export interface Me {
  sub: string;
  name: string | null;
  email: string | null;
  workspaces: { id: string; role: Role }[];
}

export type ConversationStatus = 'open' | 'closed';
export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface ConversationSummary {
  contact: string;
  assignee: string | null;
  status: ConversationStatus;
  lastActivityAt: string;
}

export interface Message {
  id: string; // Pigeon message id (inbound) or client_ref (outbound)
  direction: 'inbound' | 'outbound';
  text: string;
  at: string;
  status?: OutboundStatus;
  author?: string;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
}

export interface ConversationPage {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `Request failed (${res.status})`, data);
  return data as T;
}

const q = (workspace: string) => `workspace=${encodeURIComponent(workspace)}`;
const conv = (workspace: string, contact: string, action = '') => `/api/conversations/${encodeURIComponent(contact)}${action}?${q(workspace)}`;

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  logout: () => fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }),

  list: (workspace: string, opts: { cursor?: string | null; status?: ConversationStatus | 'all' } = {}) => {
    const params = new URLSearchParams({ workspace, limit: '30' });
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.status && opts.status !== 'all') params.set('status', opts.status);
    return request<ConversationPage>('GET', `/api/conversations?${params}`);
  },
  conversation: (workspace: string, contact: string) => request<Conversation>('GET', conv(workspace, contact)),
  reply: (workspace: string, contact: string, text: string, clientRef: string) => request<{ client_ref: string }>('POST', conv(workspace, contact, '/reply'), { text, client_ref: clientRef }),
  claim: (workspace: string, contact: string) => request<{ assignee: string }>('POST', conv(workspace, contact, '/claim'), {}),
  close: (workspace: string, contact: string) => request<ConversationSummary>('POST', conv(workspace, contact, '/close'), {}),
  reopen: (workspace: string, contact: string) => request<ConversationSummary>('POST', conv(workspace, contact, '/reopen'), {}),
};

/** A message for people, not developers. */
export function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (err.status) {
    case 0:
      return err.message;
    case 401:
      return 'Your session has ended. Sign in again.';
    case 402:
      return "Sending is off: this workspace's subscription is canceled. An admin can subscribe again.";
    case 403:
      return 'You do not have access to this workspace.';
    case 404:
      return 'This conversation does not exist (any more).';
    case 409:
      return `Someone else holds this conversation${typeof err.body.assignee === 'string' ? ` (${err.body.assignee})` : ''}.`;
    default:
      return err.status >= 500 ? 'The server had a problem. Try again in a moment.' : err.message;
  }
}

export const STATUS_RANK: Record<OutboundStatus, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };
