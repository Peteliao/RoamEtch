// Undo/redo stack for edit operations (cap 50 steps per spec 20~50).
import { emit } from './events';

const CAP = 50;
let undoStack = [];
let redoStack = [];
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

/** action: { label, undo: async fn, redo: async fn } */
export function pushAction(action) {
  if (pendingTasks) enqueueTask(() => applyPush(action));
  else applyPush(action);
}

export async function undo() {
  return enqueueOperation(async () => {
    const a = undoStack.pop();
    if (!a) return false;
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

export async function redo() {
  return enqueueOperation(async () => {
    const a = redoStack.pop();
    if (!a) return false;
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