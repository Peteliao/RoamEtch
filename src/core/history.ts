// Undo/redo stack for edit operations (cap 50 steps per spec 20~50).
import { emit } from './events';

const CAP = 50;
let undoStack = [];
let redoStack = [];

/** action: { label, undo: async fn, redo: async fn } */
export function pushAction(action) {
  undoStack.push(action);
  if (undoStack.length > CAP) undoStack.shift();
  redoStack = [];
  emit('history:changed', state());
}

export async function undo() {
  const a = undoStack.pop();
  if (!a) return false;
  await a.undo();
  redoStack.push(a);
  emit('history:changed', state());
  return true;
}

export async function redo() {
  const a = redoStack.pop();
  if (!a) return false;
  await a.redo();
  undoStack.push(a);
  emit('history:changed', state());
  return true;
}

export function state() {
  return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, depth: undoStack.length };
}

export function clearHistory() {
  undoStack = [];
  redoStack = [];
  emit('history:changed', state());
}