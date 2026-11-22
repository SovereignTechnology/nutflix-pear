/**
 * Type-level tests for the protocol's exactness against contracts v4. They are checked by
 * `tsc -b` (this file is part of tsconfig.worker.json); the runtime assertions only keep vitest
 * honest about the constants.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { NetworkAdapter, PlaySession, Wallet, media } from '@sovit/core';

import {
  CHANNEL,
  ERROR_CODES,
  EXCLUDED_METHODS,
  IPC_V,
  LIMITS,
  MEDIA_ERROR_CODES,
  SHELL_ERROR_CODES,
  TOPIC_METHODS,
  TOPIC_NAMES,
} from '../protocol.js';
import type {
  AdapterMethod,
  AdapterMethodsOf,
  BridgedMethod,
  ErrorCode,
  ExcludedMethod,
  Method,
  MethodTable,
  PlaySessionWire,
  ProtocolAssertions,
  Rehydrated,
  ShellMethod,
  TopicName,
  UncoveredMethods,
  UploadInputWire,
} from '../protocol.js';
import { METHODS } from '../guards.js';

describe('MethodTable ⇔ NetworkAdapter (contracts v4)', () => {
  it('covers every adapter method except the listed exclusions and topics', () => {
    expectTypeOf<UncoveredMethods<NetworkAdapter>>().toBeNever();
    expectTypeOf<AdapterMethod>().toEqualTypeOf<BridgedMethod>();
    // ProtocolAssertions only compiles when every check in protocol.ts holds.
    expectTypeOf<ProtocolAssertions>().toEqualTypeOf<[never, never, never, never, never, never]>();
  });

  it('a v5 addition anywhere on the adapter surfaces as uncovered (so protocol.ts fails to compile)', () => {
    interface V5Adapter extends NetworkAdapter {
      seederAnnouncement(id: string): Promise<void>;
      readonly wallet: Wallet & { restore(): Promise<void> };
      readonly studio: NetworkAdapter['studio'] & { ffmpeg(): Promise<unknown> };
    }
    expectTypeOf<UncoveredMethods<V5Adapter>>().toEqualTypeOf<
      'seederAnnouncement' | 'wallet.restore' | 'studio.ffmpeg'
    >();
    expectTypeOf<AdapterMethodsOf<V5Adapter>>().toExtend<string>();
  });

  it('D3: wallet.send / wallet.receive are excluded, never methods', () => {
    expectTypeOf<'wallet.send'>().toExtend<ExcludedMethod>();
    expectTypeOf<'wallet.receive'>().toExtend<ExcludedMethod>();
    expectTypeOf<Extract<Method, 'wallet.send' | 'wallet.receive'>>().toBeNever();
    expect(Object.keys(EXCLUDED_METHODS).sort()).toEqual([
      'wallet.keyset',
      'wallet.p2pkPubkey',
      'wallet.receive',
      'wallet.send',
    ]);
  });

  it('callbacks are topics', () => {
    expect(TOPIC_METHODS).toEqual({
      'seeder.onStatus': 'seeder.status',
      notifications: 'notifications',
      'wallet.onChange': 'wallet.change',
    });
    expectTypeOf<(typeof TOPIC_NAMES)[number]>().toEqualTypeOf<TopicName>();
    // + `signer.status` (ADR 0013), a shell-only topic like the session and upload ones, and
    // `recovery.progress` (ADR 0016: a restore's progress — numbers and the user's mint URLs).
    expect(new Set(TOPIC_NAMES).size).toBe(8);
  });

  it('argument tuples equal the contract parameters', () => {
    expectTypeOf<MethodTable['comments'][0]>().toEqualTypeOf<
      Parameters<NetworkAdapter['comments']>
    >();
    expectTypeOf<MethodTable['wallet.melt'][0]>().toEqualTypeOf<Parameters<Wallet['melt']>>();
    expectTypeOf<MethodTable['library.savePlaylist'][0]>().toEqualTypeOf<
      Parameters<NetworkAdapter['library']['savePlaylist']>
    >();
  });

  it('Map results are WireMaps that rehydrate to the contract type', () => {
    expectTypeOf<Rehydrated<MethodTable['wallet.balances'][1]>>().toEqualTypeOf<
      Awaited<ReturnType<Wallet['balances']>>
    >();
    expectTypeOf<Rehydrated<MethodTable['seeder.status'][1]>>().toEqualTypeOf<
      Awaited<ReturnType<NetworkAdapter['seeder']['status']>>
    >();
  });

  it('play returns data only; the preload rebuilds a PlaySession around sid', () => {
    expectTypeOf<PlaySessionWire>().toExtend<
      Omit<
        PlaySession,
        keyof PlaySession &
          (
            | 'onPeers'
            | 'onSpend'
            | 'setPrefetchSeconds'
            | 'pause'
            | 'resume'
            | 'switchRendition'
            | 'close'
          )
      >
    >();
    expectTypeOf<Extract<Method, `session.${string}`>>().toEqualTypeOf<
      | 'session.pause'
      | 'session.resume'
      | 'session.setPrefetchSeconds'
      | 'session.switchRendition'
      | 'session.close'
      | 'session.stats'
      | 'session.addresses'
    >();
    expectTypeOf<ShellMethod>().toExtend<Method>();
  });

  it('SE-1: studio.upload takes a FileToken, never a path or a FileLike', () => {
    expectTypeOf<UploadInputWire['file']>().toEqualTypeOf<`nf-file:${string}`>();
    // @ts-expect-error — a path is not a FileToken
    const bad: UploadInputWire['file'] = '/home/u/.ssh/id_ed25519';
    expect(bad).toBeTypeOf('string');
  });

  it("ErrorCode includes core's MediaErrorCode", () => {
    expectTypeOf<media.MediaErrorCode>().toExtend<ErrorCode>();
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toEqual([...SHELL_ERROR_CODES, ...MEDIA_ERROR_CODES]);
    expect([...SHELL_ERROR_CODES.slice(0, 4)]).toEqual([
      'no-seeders',
      'no-balance',
      'no-signer',
      'relay-down',
    ]);
  });
});

describe('constants', () => {
  it('channels, version, limits', () => {
    expect(IPC_V).toBe(1);
    expect(CHANNEL).toEqual({
      call: 'nf:call',
      sub: 'nf:sub',
      event: 'nf:event',
      grant: 'nf:grant-file',
    });
    expect(LIMITS).toMatchObject({
      maxString: 4096,
      maxBody: 16384,
      maxArray: 256,
      inflightPerWc: 64,
      subsPerWc: 256,
    });
    expect(Object.isFrozen(METHODS)).toBe(true);
  });
});
