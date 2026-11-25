import type { Me } from './api';

/** "14:05" today, "25 Nov 14:05" on other days. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** "You" for the signed-in agent, otherwise their id (the IdP gives us no directory of names). */
export function personLabel(sub: string, me: Me): string {
  return sub === me.sub ? 'You' : sub;
}
