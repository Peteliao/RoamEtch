import { DEFAULT_MEET_STUN } from './settings';

function parseUrls(value: string, schemes: string[], limit: number, fallback = false) {
  const parts = String(value || '').split(/[\s,]+/).map((part) => part.trim()).filter(Boolean).slice(0, limit);
  const urls: string[] = [];
  for (const part of parts) {
    const match = /^([A-Za-z]+):(?:\/\/([^/?#\s]+)|([^/?#\s]+))(\?[^#\s]+)?$/i.exec(part);
    if (!match || !schemes.includes(`${match[1].toLowerCase()}:`)) continue;
    const authority = match[2] || match[3];
    if (!authority || authority.includes('@')) continue;
    const params = new URLSearchParams(match[4] || '');
    const transports = params.getAll('transport');
    if ([...params.keys()].some((key) => key !== 'transport')
      || transports.length > 1
      || (transports.length === 1 && !['udp', 'tcp'].includes(transports[0].toLowerCase()))) continue;
    try {
      const url = new URL(`https://${authority}`);
      if (!url.hostname) continue;
      urls.push(part);
    } catch {
      continue;
    }
  }
  return urls.length || !fallback ? urls : [...DEFAULT_MEET_STUN];
}

export function buildIceServers({ stun = '', turnUrl = '', turnUser = '', turnPass = '' } = {}) {
  const servers: RTCIceServer[] = [];
  const stunUrls = parseUrls(stun || DEFAULT_MEET_STUN.join('\n'), ['stun:', 'stuns:'], 8, true);
  if (stunUrls.length) servers.push({ urls: stunUrls });
  const turnUrls = parseUrls(turnUrl, ['turn:', 'turns:'], 4);
  if (turnUrls.length) {
    const username = String(turnUser || '').trim().slice(0, 256);
    const credential = String(turnPass || '').trim().slice(0, 1024);
    servers.push({
      urls: turnUrls,
      ...(username || credential ? { username, credential } : {})
    });
  }
  return servers;
}
