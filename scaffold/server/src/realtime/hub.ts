import type { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { getRedis } from '../redis.js';
import { EVENTS_CHANNEL, readAfter, streamBounds } from './events.js';

const PAGE = 500;
const SAFETY_PUMP_MS = 2000; // catches a notice lost while the subscriber reconnected
const MAX_BUFFERED = 4 * 1024 * 1024; // a client that stops reading is dropped

interface Client {
  socket: WebSocket;
  workspace: string;
  lastSent: number; // highest seq this socket has been sent
  pumping: boolean;
  again: boolean;
}

/**
 * This instance's sockets. Each socket reads the workspace stream from its
 * own lastSent: replay and live delivery are the same loop, one read at a
 * time per socket, so frames go out in seq order with no gaps or repeats.
 * Redis pub/sub only says "workspace X has seq N"; the stream is the truth.
 */
export class RealtimeHub {
  private readonly clients = new Map<string, Set<Client>>();
  private subscriber: Redis | undefined;
  private safety: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    this.subscriber = getRedis().duplicate();
    this.subscriber.on('message', (_channel: string, message: string) => {
      const [workspace, seq] = message.split(' ');
      this.onNotice(workspace, Number(seq));
    });
    await this.subscriber.subscribe(EVENTS_CHANNEL);
    this.safety = setInterval(() => {
      for (const set of this.clients.values()) for (const c of set) void this.pump(c);
    }, SAFETY_PUMP_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.safety);
    for (const set of this.clients.values()) for (const c of set) c.socket.terminate();
    this.clients.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }

  /** Register an open socket; replays from `after`, or starts at "now" without it. */
  async add(socket: WebSocket, workspace: string, after: number | null): Promise<void> {
    const { last, first } = await streamBounds(workspace);
    const client: Client = { socket, workspace, lastSent: after ?? last, pumping: false, again: false };
    if (after !== null && after > last) {
      // The client is ahead of the log (it was reset): it must refetch.
      this.sendRaw(client, JSON.stringify({ type: 'resync', reason: 'after is ahead of the log', last }));
      client.lastSent = last;
    } else if (after !== null && first !== null && first > after + 1) {
      // Frames it missed were trimmed: say so, then send what is still kept.
      this.sendRaw(client, JSON.stringify({ type: 'resync', reason: 'frames after this seq were trimmed', first }));
    }
    if (socket.readyState !== WebSocket.OPEN) return; // closed while we read the bounds
    let set = this.clients.get(workspace);
    if (!set) this.clients.set(workspace, (set = new Set()));
    set.add(client);
    socket.on('close', () => set.delete(client));
    await this.pump(client);
  }

  count(): number {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  private onNotice(workspace: string, seq: number): void {
    for (const c of this.clients.get(workspace) ?? []) {
      // Usually a pump already sent it. But if the log was reset, new frames
      // start again at 1 and this socket would wait forever: check.
      if (seq <= c.lastSent) void this.checkReset(c);
      else void this.pump(c);
    }
  }

  /** The log only shrinks below what we sent when it was reset: tell the client to start over. */
  private async checkReset(c: Client): Promise<void> {
    try {
      const { last } = await streamBounds(c.workspace);
      if (last >= c.lastSent) return;
      this.sendRaw(c, JSON.stringify({ type: 'resync', reason: 'the event log was reset' }));
      c.socket.close(4000, 'resync');
    } catch (err) {
      console.error('realtime: reset check failed:', (err as Error).message);
    }
  }

  private async pump(c: Client): Promise<void> {
    if (c.pumping) {
      c.again = true;
      return;
    }
    c.pumping = true;
    try {
      do {
        c.again = false;
        for (;;) {
          if (c.socket.readyState !== WebSocket.OPEN) return;
          const frames = await readAfter(c.workspace, c.lastSent, PAGE);
          for (const f of frames) {
            if (f.seq <= c.lastSent) continue;
            if (!this.sendRaw(c, f.json)) return;
            c.lastSent = f.seq;
          }
          if (frames.length < PAGE) break;
        }
      } while (c.again);
    } catch (err) {
      console.error('realtime: pump failed:', (err as Error).message); // the safety pump retries
    } finally {
      c.pumping = false;
    }
  }

  private sendRaw(c: Client, json: string): boolean {
    if (c.socket.readyState !== WebSocket.OPEN) return false;
    if (c.socket.bufferedAmount > MAX_BUFFERED) {
      c.socket.terminate();
      return false;
    }
    c.socket.send(json);
    return true;
  }
}
