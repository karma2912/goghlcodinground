import { useEffect, useRef, useState } from 'react';
import type { OutboundStatus } from './api';

// Server -> browser frames on /ws (see the server's realtime/events.ts).
export type Frame =
  | { seq: number; type: 'message.inbound'; contact: string; message_id: string; text: string; occurred_at: string }
  | { seq: number; type: 'message.outbound'; contact: string; client_ref: string; text: string; status: OutboundStatus; author: string }
  | { seq: number; type: 'message.status'; contact: string; client_ref: string; status: OutboundStatus }
  | { seq: number; type: 'conversation.assigned'; contact: string; assignee: string | null }
  | { seq: number; type: 'conversation.status'; contact: string; status: 'open' | 'closed' };

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/**
 * One WebSocket per workspace. It remembers the last seq it saw and, after a
 * drop, reconnects with ?after=<seq> so the server replays what was missed:
 * nothing is lost and nothing is applied twice.
 *
 * `onResync` asks the caller to refetch from the API. That happens when a
 * socket opens without a seq to resume from (anything between the first
 * fetch and the socket opening would otherwise be missed) and when the
 * server says the log cannot be replayed.
 */
export function useLiveEvents(workspace: string, onFrame: (f: Frame) => void, onResync: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const handlers = useRef({ onFrame, onResync });
  handlers.current = { onFrame, onResync };

  useEffect(() => {
    let lastSeq: number | null = null;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let stopped = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const after = lastSeq === null ? '' : `&after=${lastSeq}`;
      const ws = new WebSocket(`${proto}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}${after}`);
      socket = ws;

      ws.onopen = () => {
        delay = 500;
        setState('live');
        if (lastSeq === null) handlers.current.onResync();
      };
      ws.onmessage = (m) => {
        let f: { seq?: unknown; type?: unknown };
        try {
          f = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (f.type === 'resync') {
          lastSeq = null;
          handlers.current.onResync();
          return;
        }
        if (typeof f.seq !== 'number') return;
        if (lastSeq !== null && f.seq <= lastSeq) return; // already applied
        lastSeq = f.seq;
        handlers.current.onFrame(f as Frame);
      };
      ws.onclose = (e) => {
        if (stopped) return;
        if (e.code === 4000) lastSeq = null; // the server's log was reset: start over
        setState('reconnecting');
        retry = setTimeout(connect, delay);
        delay = Math.min(10_000, delay * 2);
      };
    };

    setState('connecting');
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [workspace]);

  return state;
}
