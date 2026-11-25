import { billingSnapshot } from '../billing/service.js';
import { workspaceIds } from '../config.js';
import { conversations, messages, type OutboundStatus } from '../db.js';

interface ContactSnapshot {
  inbound: string[];
  assignee: string | null;
}

interface WorkspaceSnapshot {
  contacts: Record<string, ContactSnapshot>;
  outbound: Record<string, OutboundStatus>;
  billing?: Awaited<ReturnType<typeof billingSnapshot>>;
}

export interface Snapshot {
  workspaces: Record<string, WorkspaceSnapshot>;
}

/**
 * What the system currently believes, in the shape the check reads.
 * Inbound order is the order the UI shows: occurred_at, then message id.
 */
export async function buildSnapshot(): Promise<Snapshot> {
  const out: Snapshot = { workspaces: {} };
  const convCol = await conversations();
  const msgCol = await messages();

  for (const ws of workspaceIds()) {
    const snap: WorkspaceSnapshot = { contacts: {}, outbound: {} };
    out.workspaces[ws] = snap;
    const contact = (c: string) => (snap.contacts[c] ??= { inbound: [], assignee: null });

    for await (const conv of convCol.find({ workspace: ws }, { projection: { contact: 1, assignee: 1 } })) {
      contact(conv.contact).assignee = conv.assignee ?? null;
    }

    const inbound = msgCol
      .find({ workspace: ws, direction: 'inbound' }, { projection: { contact: 1, messageId: 1 } })
      .sort({ contact: 1, occurredAt: 1, messageId: 1 });
    for await (const m of inbound) contact(m.contact).inbound.push(m.messageId!);

    const outbound = msgCol.find({ workspace: ws, direction: 'outbound' }, { projection: { clientRef: 1, status: 1 } });
    for await (const m of outbound) snap.outbound[m.clientRef!] = m.status!;

    snap.billing = await billingSnapshot(ws); // bonus: { status, seats, can_send }
  }
  return out;
}
