import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDatabaseMigrationLock, withDatabaseWrite } from '../src/core/locks';

type Waiter = { mode: 'shared' | 'exclusive'; resolve: () => void };

let shared = 0;
let exclusive = false;
let waiters: Waiter[] = [];
const requests: string[] = [];

function canAcquire(mode: 'shared' | 'exclusive') {
  return mode === 'shared' ? !exclusive : !exclusive && shared === 0;
}

function acquire(mode: 'shared' | 'exclusive') {
  if (mode === 'shared') shared++;
  else exclusive = true;
}

function release(mode: 'shared' | 'exclusive') {
  if (mode === 'shared') shared = Math.max(0, shared - 1);
  else exclusive = false;
}

function drain() {
  for (;;) {
    const index = waiters.findIndex((waiter) => canAcquire(waiter.mode));
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    acquire(waiter.mode);
    waiter.resolve();
  }
}

const locks = {
  request: vi.fn(async (_name: string, options: { mode: 'shared' | 'exclusive' }, callback: (lock: any) => Promise<any>) => {
    const mode = options.mode;
    requests.push(mode);
    if (!canAcquire(mode)) await new Promise<void>((resolve) => waiters.push({ mode, resolve }));
    else acquire(mode);
    try { return await callback({ name: _name, mode }); }
    finally { release(mode); drain(); }
  })
};

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

beforeEach(() => {
  shared = 0;
  exclusive = false;
  waiters = [];
  requests.length = 0;
  locks.request.mockClear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
});

afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else delete (navigator as any).locks;
});

describe('cross-tab database write isolation', () => {
  it('allows ordinary writes to share the database lock', async () => {
    let active = 0;
    let peak = 0;
    await Promise.all([withDatabaseWrite, withDatabaseWrite].map(async (run) => run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    })));
    expect(peak).toBe(2);
    expect(requests).toEqual(['shared', 'shared']);
  });

  it('waits for active writes before an exclusive migration starts', async () => {
    let releaseWrite!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const write = withDatabaseWrite(async () => {
      markStarted();
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
    });
    await started;
    let migrationStarted = false;
    const migration = withDatabaseMigrationLock(async () => { migrationStarted = true; });
    await Promise.resolve();
    expect(migrationStarted).toBe(false);
    releaseWrite();
    await Promise.all([write, migration]);
    expect(migrationStarted).toBe(true);
    expect(requests).toEqual(['shared', 'exclusive']);
  });

  it('prevents new writes while an exclusive migration is active', async () => {
    let releaseMigration!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const migration = withDatabaseMigrationLock(async () => {
      markStarted();
      await new Promise<void>((resolve) => { releaseMigration = resolve; });
    });
    await started;
    let writeStarted = false;
    const write = withDatabaseWrite(async () => { writeStarted = true; });
    await Promise.resolve();
    expect(writeStarted).toBe(false);
    releaseMigration();
    await Promise.all([migration, write]);
    expect(writeStarted).toBe(true);
    expect(requests).toEqual(['exclusive', 'shared']);
  });
});
