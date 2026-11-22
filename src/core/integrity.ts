// Deterministic JSON and SHA-256 helpers shared by backup integrity checks.

function encode(data) {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = normalize(value[key]);
    }
    return out;
  }
  if (typeof value === 'number' && !isFinite(value)) return null;
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalize(value));
}

export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', encode(data));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
