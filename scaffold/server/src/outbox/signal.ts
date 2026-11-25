// A nudge from "a reply was stored" to "the worker in this process should
// look now". Only an optimisation: workers also poll, which is what makes
// replies stored by other instances (or before a crash) get sent.
type Listener = () => void;
const listeners = new Set<Listener>();

export function onOutboxNudge(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyOutbox(): void {
  for (const fn of listeners) fn();
}
