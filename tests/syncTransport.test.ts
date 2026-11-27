import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceIdentity, createSyncInvite } from '../src/core/syncIdentity';
import { connectSyncPeer } from '../src/core/syncTransport';

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync transport pairing guards', () => {
  it('lets the initiator open its own invite', async () => {
    const identity = await createDeviceIdentity('Host');
    const invite = await createSyncInvite(identity);
    const controller = new AbortController();
    controller.abort();
    const error = await connectSyncPeer({
      invite, identity, role: 'initiator', signal: controller.signal
    }).catch((reason) => reason);
    expect(error.code).toBe('sync-aborted');
  });

  it('keeps rejecting a responder that pastes its own invite', async () => {
    const identity = await createDeviceIdentity('Host');
    const invite = await createSyncInvite(identity);
    const controller = new AbortController();
    controller.abort();
    const error = await connectSyncPeer({
      invite, identity, role: 'responder', signal: controller.signal
    }).catch((reason) => reason);
    expect(error.code).toBe('sync-self');
  });
});
