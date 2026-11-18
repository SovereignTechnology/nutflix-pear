/**
 * #89 (contracts v17, v18): what the host tells the worker about WebRTC. `rtc` only while the
 * worker has a helper, NFX and WebRTC are on, and there is a STUN server and a signaling relay;
 * never otherwise.
 */
import type { IrohRelayUrl, NfxSettings, RelayUrl, Settings, StunServer } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { nfxMeshRelays, nfxWorkerArgs } from '../adapter.js';
import { DEFAULT_NFX_MESH_RELAYS, DEFAULT_SETTINGS } from '../settings/settings.js';

const NFX = { enabled: true, network: 'nfx:testnet:1', scopedRelays: [] } as const;
const with_ = (nfx: NfxSettings): Settings => ({ ...DEFAULT_SETTINGS, nfx });

describe('nfxWorkerArgs (#89)', () => {
  it('runs no WebRTC side in a worker without a helper', () => {
    expect(nfxWorkerArgs(DEFAULT_SETTINGS, false)).toEqual({
      enabled: true,
      irohRelays: ['https://iroh.nutflix.xyz/'],
      rtc: null,
    });
  });

  it('with a helper: on by default at the network’s STUN; off by switch, NFX, no STUN or no signaling relay', () => {
    expect(nfxWorkerArgs(DEFAULT_SETTINGS, true).rtc).toEqual({ stun: ['web.nutflix.xyz:3478'] });
    // A stored v16 value: absent WebRTC is on, absent STUN and relays are the defaults.
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
    // Without a relay to signal on nobody could reach it: no helper process, no STUN asked.
    expect(nfxWorkerArgs(with_({ ...NFX, meshRelays: [] }), true).rtc).toBeNull();
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

  it('signals on the default list unless the user lists relays', () => {
    expect(DEFAULT_NFX_MESH_RELAYS).toHaveLength(3);
    expect(nfxMeshRelays(with_(NFX))).toEqual(DEFAULT_NFX_MESH_RELAYS);
    expect(nfxMeshRelays(DEFAULT_SETTINGS)).toEqual(DEFAULT_NFX_MESH_RELAYS);
    const meshRelays = ['wss://signal.test' as RelayUrl];
    expect(nfxMeshRelays(with_({ ...NFX, meshRelays }))).toEqual(meshRelays);
    expect(nfxMeshRelays(with_({ ...NFX, meshRelays: [] }))).toEqual([]);
  });
});
