// Sanitized diagnostic ring buffer for debug log export.
const MAX = 500;
const entries = [];

export function diag(category, message, data: any = {}) {
  const safe = { ...data };
  // sanitize: coarse coordinates only (~1 km), no names / no media
  if (typeof safe.lat === 'number') safe.lat = Math.round(safe.lat * 100) / 100;
  if (typeof safe.lon === 'number') safe.lon = Math.round(safe.lon * 100) / 100;
  delete safe.name;
  entries.push({ ts: new Date().toISOString(), category, message, data: safe });
  if (entries.length > MAX) entries.shift();
}

export function exportDiagLog() {
  const payload = {
    app: 'TrackMint', version: '1.4.0', exportedAt: new Date().toISOString(),
    ua: navigator.userAgent, lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine, entries
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

// capture uncaught errors
window.addEventListener('error', (e) => diag('error', String(e.message), { src: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => diag('error', 'unhandledrejection: ' + String(e.reason)));