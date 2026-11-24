import { describe, expect, it } from 'vitest';
import { buildIceServers } from '../src/core/webrtcConfig';
import { DEFAULT_MEET_STUN } from '../src/core/settings';

describe('WebRTC ICE configuration', () => {
  it('uses the bundled CN/global STUN pool by default', () => {
    expect(buildIceServers()).toEqual([{ urls: DEFAULT_MEET_STUN }]);
    expect(DEFAULT_MEET_STUN).toHaveLength(3);
  });

  it('parses custom STUN/TURN lists and rejects unsafe or malformed URLs', () => {
    const servers = buildIceServers({
      stun: 'stun:one.example:3478\nstuns:two.example:5349, https://not-stun.example',
      turnUrl: 'turn:relay.example:3478\nturns:secure.example:5349',
      turnUser: 'user', turnPass: 'secret'
    });
    expect(servers).toEqual([
      { urls: ['stun:one.example:3478', 'stuns:two.example:5349'] },
      { urls: ['turn:relay.example:3478', 'turns:secure.example:5349'], username: 'user', credential: 'secret' }
    ]);
    expect(buildIceServers({ stun: 'javascript:alert(1)' })).toEqual([{ urls: DEFAULT_MEET_STUN }]);
  });

  it('accepts TURN transport queries and rejects unsupported query parameters', () => {
    expect(buildIceServers({
      turnUrl: 'turn:relay.example:3478?transport=tcp\nturns:secure.example:5349?transport=udp'
    })).toEqual([
      { urls: DEFAULT_MEET_STUN },
      { urls: ['turn:relay.example:3478?transport=tcp', 'turns:secure.example:5349?transport=udp'] }
    ]);
    for (const turnUrl of [
      'turn:relay.example:3478?transport=tls',
      'turn:relay.example:3478?transport=tcp&transport=udp',
      'turn:relay.example:3478?transport=tcp&foo=bar',
      'turn:user@relay.example:3478?transport=tcp',
      'turn:relay.example:3478/path?transport=tcp',
      'turn:relay.example:3478?transport=tcp#fragment'
    ]) {
      expect(buildIceServers({ turnUrl })).toEqual([{ urls: DEFAULT_MEET_STUN }]);
    }
  });
});
