// Minimal event bus with registration scopes (views are rebuilt on language change).
const listeners = new Map();
let activeScope = 'core';

export function setScope(scope) { activeScope = scope; }

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  const entry = { fn, scope: activeScope };
  listeners.get(event).add(entry);
  return () => listeners.get(event)?.delete(entry);
}
export function off(event, fn) {
  const set = listeners.get(event);
  if (!set) return;
  for (const e of set) if (e.fn === fn) set.delete(e);
}
export function clearScope(scope) {
  for (const [, set] of listeners) {
    for (const e of [...set]) if (e.scope === scope) set.delete(e);
  }
}
export function emit(event, payload) {
  listeners.get(event)?.forEach((e) => {
    try { e.fn(payload); } catch (err) { console.error(`[bus:${event}]`, err); }
  });
}