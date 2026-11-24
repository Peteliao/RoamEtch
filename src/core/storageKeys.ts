export function migrateLegacyKey(legacyKey: string, key: string) {
  try {
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
  } catch { /* storage unavailable */ }
}
