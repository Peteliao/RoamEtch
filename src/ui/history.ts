type UIState = { type: string; id?: number; [key: string]: any };

let sequence = 0;
let pendingBacks = 0;
let pendingBackResolvers: Array<() => void> = [];
let queuedWrites: Array<() => void> = [];
let skipPopHandlers = false;
const overlayStack: Array<{ id: number; closeFromHistory: () => void }> = [];

window.addEventListener('popstate', () => {
  if (!pendingBacks) return;
  pendingBacks--;
  if (pendingBacks) return;
  const writes = queuedWrites;
  queuedWrites = [];
  skipPopHandlers = writes.length > 0;
  for (const write of writes) write();
  const resolvers = pendingBackResolvers;
  pendingBackResolvers = [];
  for (const resolve of resolvers) resolve();
});

function writeState(state: Omit<UIState, 'id'>, replace: boolean) {
  const entry = { ...state, id: ++sequence };
  const write = () => {
    const current = currentUIState();
    const previous = current ? { ...current } : null;
    if (previous) delete previous.previous;
    const saved = replace
      ? { ...entry, ...(current?.previous ? { previous: current.previous } : {}) }
      : { ...entry, previous };
    history[replace ? 'replaceState' : 'pushState']({ ...(history.state || {}), lt: saved }, '');
  };
  if (pendingBacks) queuedWrites.push(write);
  else write();
  return entry;
}

export function currentUIState(): UIState | null {
  return history.state?.lt || null;
}

export function pushUIState(state: Omit<UIState, 'id'>) {
  return writeState(state, false);
}

export function replaceUIState(state: Omit<UIState, 'id'>) {
  return writeState(state, true);
}

export function ownsUIState(id: number) {
  return currentUIState()?.id === id;
}

export function backFromUIState(id: number) {
  if (!ownsUIState(id)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pendingBacks++;
    pendingBackResolvers.push(resolve);
    history.back();
  });
}

export function onUIPop(handler: (state: UIState | null, event: PopStateEvent) => boolean) {
  const listener = (event: PopStateEvent) => {
    if (skipPopHandlers) {
      skipPopHandlers = false;
      return;
    }
    if (handler(currentUIState(), event)) event.stopImmediatePropagation();
  };
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

export function pushOverlayState(closeFromHistory: () => void) {
  const entry = pushUIState({ type: 'overlay' });
  overlayStack.push({ id: entry.id, closeFromHistory });
  return entry.id;
}

export function removeOverlayState(id: number, { history = true } = {}) {
  const index = overlayStack.findIndex((entry) => entry.id === id);
  if (index < 0) return Promise.resolve();
  overlayStack.splice(index, 1);
  return history ? backFromUIState(id) : Promise.resolve();
}

onUIPop((state) => {
  const top = overlayStack[overlayStack.length - 1];
  if (!top || (state?.type === 'overlay' && state.id === top.id)) return false;
  overlayStack.pop();
  top.closeFromHistory();
  return true;
});
