// Screen Wake Lock with auto release on hidden / low battery.
import { get } from './settings';
import { emit } from './events';

let sentinel: WakeLockSentinel | null = null;
let wantActive = false;
let operationQueue: Promise<void> = Promise.resolve();

// Recorder and OLED lock share one sentinel. Serialize acquire/release so a
// release that is still settling cannot clear a newer acquisition.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function requestWakeLock(): Promise<boolean> {
  wantActive = true;
  return enqueue(async () => {
    if (!get('wakeLock') || !('wakeLock' in navigator) || !wantActive) return false;
    if (sentinel) return true;
    try {
      const acquired = await navigator.wakeLock.request('screen');
      if (!wantActive) {
        try { await acquired.release(); } catch { /* ignore */ }
        return false;
      }
      sentinel = acquired;
      acquired.addEventListener('release', () => {
        if (sentinel === acquired) sentinel = null;
      });
      emit('wakelock:changed', true);
      return true;
    } catch {
      emit('wakelock:changed', false);
      return false;
    }
  });
}

export function releaseWakeLock(): Promise<void> {
  wantActive = false;
  return enqueue(async () => {
    const acquired = sentinel;
    sentinel = null;
    if (acquired) { try { await acquired.release(); } catch { /* ignore */ } }
    emit('wakelock:changed', false);
  });
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wantActive) await requestWakeLock();
});

// low battery auto-release
if ((navigator as any).getBattery) {
  (navigator as any).getBattery().then((bat: any) => {
    const check = () => {
      if (!bat.charging && bat.level < 0.15 && sentinel) releaseWakeLock();
    };
    bat.addEventListener('levelchange', check);
    bat.addEventListener('chargingchange', check);
  }).catch(() => {});
}