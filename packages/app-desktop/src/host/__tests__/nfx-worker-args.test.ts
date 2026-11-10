/**
 * #89 (contracts v17): what the host tells the worker about WebRTC. `rtc` only while NFX and
 * WebRTC are on, with a STUN server, and once this build can signal; never otherwise.
 */
import type { IrohRelayUrl, NfxSettings, Settings, StunServer } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { NFX_WEBRTC_SIGNALING, nfxWorkerArgs } from '../adapter.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';

const NFX = { enabled: true, network: 'nfx:testnet:1', scopedRelays: [] } as const;
const with_ = (nfx: NfxSettings): Settings => ({ ...DEFAULT_SETTINGS, nfx });

describe('nfxWorkerArgs (#89)', () => {
  it('runs no WebRTC side until this build can signal', () => {
    expect(NFX_WEBRTC_SIGNALING).toBe(false);
    expect(nfxWorkerArgs(DEFAULT_SETTINGS)).toEqual({
      enabled: true,
      irohRelays: ['https://iroh.nutflix.xyz/'],
      rtc: null,
    });
  });

  it('with signaling: on by default at the network’s STUN, off by switch, NFX or no STUN', () => {
    expect(nfxWorkerArgs(DEFAULT_SETTINGS, true).rtc).toEqual({ stun: ['web.nutflix.xyz:3478'] });
    // A stored v16 value: absent WebRTC is on, absent STUN is the network's default.
    expect(nfxWorkerArgs(with_(NFX), true)).toEqual({
      enabled: true,
      irohRelays: [],
      rtc: { stun: ['web.nutflix.xyz:3478'] },
    });
    const stunServers = ['stun.test:3478', '[2001:db8::1]:19302'] as StunServer[];
    expect(nfxWorkerArgs(with_({ ...NFX, stunServers }), true).rtc).toEqual({
      stun: stunServers,
    });
    expect(nfxWorkerArgs(with_({ ...NFX, webrtc: false }), true).rtc).toBeNull();
    expect(nfxWorkerArgs(with_({ ...NFX, stunServers: [] }), true).rtc).toBeNull();
    expect(nfxWorkerArgs(with_({ ...NFX, enabled: false }), true).rtc).toBeNull();
    const { nfx: _gone, ...noNfx } = DEFAULT_SETTINGS;
    expect(nfxWorkerArgs(noNfx as Settings, true)).toEqual({
      enabled: false,
      irohRelays: [],
      rtc: null,
    });
    const irohRelays = ['https://iroh.test/' as IrohRelayUrl];
    expect(nfxWorkerArgs(with_({ ...NFX, irohRelays }), true).irohRelays).toEqual(irohRelays);
  });
});
