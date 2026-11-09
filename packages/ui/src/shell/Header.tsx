/**
 * The shell header (design §4 "Chrome"): back/forward, the brand (→ Home), search (→ the
 * `search` route on submit), the `WalletChip` (total from `wallet.balances` + `onChange`,
 * streaming rate from the playback coordinator; click → Wallet) and the viewer's avatar
 * (→ their channel; signed out → Settings to connect a signer). ADR 0013: with the desktop
 * signer flow, "Unlock" while the signer is locked, "Lock" and "Sign out" while it is not (main
 * asks before signing out; every secret is typed in main's own prompt window).
 */
import { useEffect, useState, type ReactElement, type SyntheticEvent } from 'react';
import type { Sats } from '@sovit/core';
import { Avatar, Button, IconButton, shortPubkey } from '../components/index.js';
import { WalletChip, type Route } from '../screens/index.js';
import type { Identity } from './hooks.js';

export interface HeaderProps {
  readonly route: Route;
  readonly navigate: (to: Route) => void;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly identity: Identity;
  /** Wallet total; `undefined` while loading. */
  readonly balance: Sats | undefined;
  /** sats/min of the session that is paying now; 0 = none. */
  readonly ratePerMin: number;
  /** ADR 0022: offer "Connect signer" while signed out. Default: yes (the desktop app). */
  readonly signIn?: boolean | undefined;
  /** ADR 0013: the signer actions, when the host offers the flow. */
  readonly signer?:
    | {
        readonly unlock: () => Promise<void>;
        readonly lock: () => Promise<void>;
        readonly signOut: () => Promise<void>;
      }
    | undefined;
}

export function Header(props: HeaderProps): ReactElement {
  const { route, navigate, identity } = props;
  const routeQ = route.name === 'search' ? route.q : '';
  const [q, setQ] = useState(routeQ);
  useEffect(() => {
    setQ(routeQ);
  }, [routeQ]);

  const submit = (e: SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const text = q.trim();
    if (text !== '') navigate({ name: 'search', q: text });
  };

  return (
    <header className="nf-shell__header">
      <div className="nf-shell__header-start">
        <IconButton
          icon="chevronLeft"
          label="Back"
          disabled={!props.canBack}
          onClick={props.onBack}
        />
        <IconButton
          icon="chevronRight"
          label="Forward"
          disabled={!props.canForward}
          onClick={props.onForward}
        />
        <button
          type="button"
          className="nf-shell__brand"
          onClick={() => {
            navigate({ name: 'home' });
          }}
        >
          Nutflix
        </button>
      </div>
      <form className="nf-shell__search" role="search" onSubmit={submit}>
        <input
          className="nf-shell__search-input"
          type="search"
          aria-label="Search videos"
          placeholder="Search"
          maxLength={256}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
          }}
        />
        <IconButton icon="search" label="Search" type="submit" />
      </form>
      <div className="nf-shell__header-end">
        {identity.status === 'signed-in' ? (
          <>
            {props.signer !== undefined && identity.locked === true ? (
              <Button
                variant="accent"
                size="sm"
                icon="key"
                onClick={() => void props.signer?.unlock()}
              >
                Unlock
              </Button>
            ) : null}
            <WalletChip
              balance={props.balance}
              satsPerMin={props.ratePerMin > 0 ? props.ratePerMin : undefined}
              onClick={() => {
                navigate({ name: 'wallet' });
              }}
            />
            <button
              type="button"
              className="nf-shell__avatar"
              aria-label="Your channel"
              onClick={() => {
                navigate({ name: 'channel', pubkey: identity.pubkey });
              }}
            >
              <Avatar
                seed={identity.pubkey}
                name={
                  identity.profile?.displayName ??
                  identity.profile?.name ??
                  shortPubkey(identity.pubkey)
                }
                src={identity.avatarSrc}
                size="sm"
              />
            </button>
            {props.signer !== undefined ? (
              <>
                {identity.locked !== true ? (
                  <IconButton
                    icon="lock"
                    label="Lock signer"
                    onClick={() => void props.signer?.lock()}
                  />
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => void props.signer?.signOut()}>
                  Sign out
                </Button>
              </>
            ) : null}
          </>
        ) : identity.status === 'signed-out' && props.signIn !== false ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              navigate({ name: 'settings' });
            }}
          >
            Connect signer
          </Button>
        ) : null}
      </div>
    </header>
  );
}
