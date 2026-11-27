// Undo/redo stack for edit operations (cap 50 steps per spec 20~50).
import { emit } from './events';

const CAP = 50;
export interface EditScope {
  tripId: string;
  session: number;
}
type HistoryAction = {
  label: string;
  tripId?: string;
  session?: number;
  undo: () => unknown | Promise<unknown>;
  redo: () => unknown | Promise<unknown>;
};
let undoStack: HistoryAction[] = [];
let redoStack: HistoryAction[] = [];
let pendingTasks = 0;
let taskTail = Promise.resolve();

function applyPush(action) {
  undoStack.push(action);
  if (undoStack.length > CAP) undoStack.shift();
  redoStack = [];
  emit('history:changed', state());
}

function applyClear() {
  undoStack = [];
  redoStack = [];
  emit('history:changed', state());
}

function enqueueTask<T>(task: () => T | Promise<T>): Promise<T> {
  pendingTasks++;
  const result = taskTail.then(task);
  const settled = result.then(
    () => { pendingTasks--; },
    () => { pendingTasks--; }
  );
  taskTail = settled.catch(() => undefined);
  return result;
}

function enqueueOperation<T>(operation: () => T | Promise<T>) {
  return enqueueTask(operation);
}

function matchesScope(action: HistoryAction, scope?: EditScope) {
  return !scope || (action.tripId === scope.tripId
    && (action.session == null || action.session === scope.session));
}

function popForScope(stack: HistoryAction[], scope?: EditScope) {
  let discarded = false;
  while (stack.length) {
    const action = stack[stack.length - 1];
    if (matchesScope(action, scope)) {
      stack.pop();
      return { action, discarded };
    }
    stack.pop();
    discarded = true;
  }
  return { action: null, discarded };
}

/** action: { label, undo: async fn, redo: async fn } */
export function pushAction(action: HistoryAction) {
  if (pendingTasks) enqueueTask(() => applyPush(action));
  else applyPush(action);
}

export async function undo(scope?: EditScope) {
  return enqueueOperation(async () => {
    const { action: a, discarded } = popForScope(undoStack, scope);
    if (!a) {
      if (discarded) emit('history:changed', state());
      return false;
    }
    try {
      await a.undo();
    } catch (error) {
      undoStack.push(a);
      emit('history:changed', state());
      throw error;
    }
    redoStack.push(a);
    emit('history:changed', state());
    return true;
  });
}

export async function redo(scope?: EditScope) {
  return enqueueOperation(async () => {
    const { action: a, discarded } = popForScope(redoStack, scope);
    if (!a) {
      if (discarded) emit('history:changed', state());
      return false;
    }
    try {
      await a.redo();
    } catch (error) {
      redoStack.push(a);
      emit('history:changed', state());
      throw error;
    }
    undoStack.push(a);
    emit('history:changed', state());
    return true;
  });
}

export function state() {
  return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, depth: undoStack.length };
}

export function clearHistory() {
  if (pendingTasks) enqueueTask(applyClear);
  else applyClear();
}