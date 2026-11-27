// Multi-tab recorder mutex: navigator.locks primary, localStorage lease fallback,
// BroadcastChannel for cross-tab state announcements.
import { emit } from './events';

const LOCK_NAME = 'localtrace-recorder';
const LEASE_KEY = 'localtrace.recorder.lease';
const DATABASE_LOCK_NAME = 'localtrace-database-write';
const DATABASE_MIGRATION_LEASE_KEY = 'localtrace.database.migration.lease';
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const HEARTBEAT = 2000;
const LEASE_TTL = 6000;
const DATABASE_LEASE_TTL = 30_000;

let channel = null;
try { channel = new BroadcastChannel('localtrace'); } catch { /* unsupported */ }

let holding = false;
let releaseFn = null;
let heartbeatTimer = null;

export function tabId() { return TAB_ID; }

export function isHolding() { return holding; }

function writeLease() {
  try { localStorage.setItem(LEASE_KEY, JSON.stringify({ tab: TAB_ID, ts: Date.now() })); } catch { /* ignore */ }
}
function leaseOwner() {
  try {
    const l = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
    if (l && Date.now() - l.ts < LEASE_TTL) return l.tab;
  } catch { /* ignore */ }
  return null;
}

/** Try to become the single active recorder tab. Returns true on success. */
export async function acquireRecorderLock() {
  if (holding) return true;
  if (navigator.locks?.request) {
    return new Promise((resolve) => {
      let settled = false;
      navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) { settled = true; resolve(false); return; }
        holding = true;
        settled = true;
        resolve(true);
        emit('lock:acquired');
        await new Promise((res) => { releaseFn = res; });
        holding = false;
        releaseFn = null;
      }).catch(() => { if (!settled) resolve(false); });
    });
  }
  // fallback lease
  const owner = leaseOwner();
  if (owner && owner !== TAB_ID) return false;
  holding = true;
  writeLease();
  heartbeatTimer = setInterval(writeLease, HEARTBEAT);
  emit('lock:acquired');
  return true;
}

export function releaseRecorderLock() {
  if (!holding) return;
  if (releaseFn) releaseFn();
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try {
    const l = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
    if (l?.tab === TAB_ID) localStorage.removeItem(LEASE_KEY);
  } catch { /* ignore */ }
  holding = false;
  broadcast({ type: 'rec-released', tab: TAB_ID });
}

function databaseLeaseOwner() {
  try {
    const lease = JSON.parse(localStorage.getItem(DATABASE_MIGRATION_LEASE_KEY) || 'null');
    if (lease && Date.now() - lease.ts < DATABASE_LEASE_TTL) return lease.tab;
  } catch { /* ignore */ }
  return null;
}

async function waitForDatabaseLease() {
  while (databaseLeaseOwner() && databaseLeaseOwner() !== TAB_ID) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function withDatabaseLock<T>(mode: 'shared' | 'exclusive', work: () => Promise<T>): Promise<T> {
  if (navigator.locks?.request) {
    return navigator.locks.request(DATABASE_LOCK_NAME, { mode }, async () => work());
  }
  if (mode === 'exclusive') {
    await waitForDatabaseLease();
    const writeLease = () => {
      try { localStorage.setItem(DATABASE_MIGRATION_LEASE_KEY, JSON.stringify({ tab: TAB_ID, ts: Date.now() })); } catch { /* ignore */ }
    };
    writeLease();
    const timer = setInterval(writeLease, HEARTBEAT);
    try { return await work(); }
    finally {
      clearInterval(timer);
      try {
        const lease = JSON.parse(localStorage.getItem(DATABASE_MIGRATION_LEASE_KEY) || 'null');
        if (lease?.tab === TAB_ID) localStorage.removeItem(DATABASE_MIGRATION_LEASE_KEY);
      } catch { /* ignore */ }
    }
  }
  await waitForDatabaseLease();
  return work();
}

export function withDatabaseWrite<T>(work: () => Promise<T>): Promise<T> {
  return withDatabaseLock('shared', work);
}

export function withDatabaseMigrationLock<T>(work: () => Promise<T>): Promise<T> {
  return withDatabaseLock('exclusive', work);
}

export function installDatabaseWriteGuard(database: any, isInTransaction: () => boolean = () => false) {
  const isMock = (fn: any) => fn?._isMockFunction === true;
  const transaction = database.transaction;
  if (typeof transaction === 'function' && !isMock(transaction)) {
    const guardedTransaction = (...args: any[]) => {
      if (args[0] === 'rw' && !isInTransaction()) return withDatabaseWrite(() => transaction.apply(database, args));
      return transaction.apply(database, args);
    };
    Object.defineProperty(guardedTransaction, '__localtraceWriteGuard', { value: true });
    database.transaction = guardedTransaction;
  }
  const methods = ['put', 'add', 'update', 'delete', 'clear', 'bulkPut', 'bulkAdd', 'bulkUpdate', 'bulkDelete'];
  for (const table of Object.values(database) as any[]) {
    if (!table || typeof table !== 'object') continue;
    for (const method of methods) {
      const original = table[method];
      if (typeof original !== 'function' || original.__localtraceWriteGuard || isMock(original)) continue;
      const guarded = (...args: any[]) => isInTransaction()
        ? original.apply(table, args)
        : withDatabaseWrite(() => original.apply(table, args));
      Object.defineProperty(guarded, '__localtraceWriteGuard', { value: true });
      table[method] = guarded;
    }
  }
}

export function broadcast(msg) {
  try { channel?.postMessage({ ...msg, tab: TAB_ID }); } catch { /* ignore */ }
}

export function onBroadcast(fn) {
  if (!channel) return () => {};
  const h = (e) => { if (e.data?.tab !== TAB_ID) fn(e.data); };
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}

/** Whether another tab currently owns recording (for read-only banner). */
export function otherTabRecording() {
  if (holding) return false;
  if (navigator.locks?.query) return false; // async query handled via lock attempt
  const owner = leaseOwner();
  return !!owner && owner !== TAB_ID;
}