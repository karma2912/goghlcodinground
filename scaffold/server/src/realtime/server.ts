import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { membership, sessionFromCookieHeader } from '../auth/middleware.js';
import { config } from '../config.js';
import { RealtimeHub } from './hub.js';

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
}

/**
 * Browsers attach cookies to WebSocket handshakes from any page, so a
 * browser's Origin must be ours (cross-site WebSocket hijacking). Clients
 * that send no Origin are not browsers and cannot ride a victim's cookie.
 */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const allowed = new Set([new URL(config.webOrigin).origin, new URL(config.oidc.redirectUri).origin]);
  return allowed.has(origin);
}

export function parseAfter(raw: string | null): number | null | 'invalid' {
  if (raw === null || raw === '') return null;
  if (!/^\d{1,15}$/.test(raw)) return 'invalid';
  return Number(raw);
}

/**
 * GET /ws?workspace=<id>[&after=<seq>], authenticated by the session cookie.
 * Refused before the upgrade: 401 without a session, 403 for a workspace the
 * user is not in or a foreign Origin, 400 for a bad request.
 */
export async function attachRealtime(server: Server): Promise<{ hub: RealtimeHub; close: () => Promise<void> }> {
  const hub = new RealtimeHub();
  await hub.start();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return socket.destroy();
      if (!originAllowed(req.headers.origin)) return refuse(socket, 403, 'Forbidden');
      const workspace = url.searchParams.get('workspace');
      const after = parseAfter(url.searchParams.get('after'));
      if (!workspace || after === 'invalid') return refuse(socket, 400, 'Bad Request');

      const session = await sessionFromCookieHeader(req.headers.cookie);
      if (!session) return refuse(socket, 401, 'Unauthorized');
      if (!membership(session, workspace)) return refuse(socket, 403, 'Forbidden');

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        ws.on('message', () => undefined); // the protocol is server -> client only
        hub.add(ws, workspace, after).catch((err) => {
          console.error('realtime: could not start a socket:', (err as Error).message);
          ws.close(1011, 'unavailable');
        });
      });
    })().catch((err) => {
      console.error('realtime: upgrade failed:', (err as Error).message);
      refuse(socket, 503, 'Service Unavailable');
    });
  };
  server.on('upgrade', onUpgrade);

  // Drop sockets whose peer vanished without closing (no pong since last ping).
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, config.realtime.heartbeatMs);

  return {
    hub,
    close: async () => {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      await hub.stop();
      wss.close();
    },
  };
}
