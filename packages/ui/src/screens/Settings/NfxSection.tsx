/**
 * Settings › NFX (contracts v10, ADR 0020): taking part in nfx's testnet. Off by default. On, the
 * catalogue lists the network's free videos beside the Nostr ones and a free upload's NFX
 * manifest also goes to the network's scoped relays (NFX-04), listed here: `wss://`, or `ws://`
 * to this computer only. Every change is one optimistic `updateSettings({ nfx })`.
 */
import { useState, type ReactElement, type SubmitEvent } from 'react';
import type { NfxSettings, RelayUrl, Settings } from '@sovit/core';
import { Button, IconButton } from '../../components/index.js';
import {
  FieldError,
  Note,
  SectionFrame,
  SwitchRow,
  useAlive,
  type SectionProps,
} from './controls.js';
import {
  UI_MAX_NFX_SCOPED_RELAYS,
  UI_NFX_NETWORK,
  normaliseRelayUrl,
  validateScopedRelayUrl,
} from './model.js';

const LABEL = 'the NFX settings';

/** `base.nfx`, or the network's starting point (off, no scoped relays). */
function nfxOf(base: Settings): NfxSettings {
  return (
    base.nfx ?? {
      enabled: false,
      network: UI_NFX_NETWORK as NfxSettings['network'],
      scopedRelays: [],
    }
  );
}

export function NfxSection({
  id,
  view,
  saved,
  pending,
  save,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  const alive = useAlive();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const nfx = nfxOf(view);
  const savedRelays = new Set(nfxOf(saved).scopedRelays);
  const full = nfx.scopedRelays.length >= UI_MAX_NFX_SCOPED_RELAYS;

  const update = (fn: (current: NfxSettings) => NfxSettings): Promise<boolean> =>
    save({ field: 'nfx', label: LABEL, patch: (base: Settings) => ({ nfx: fn(nfxOf(base)) }) });

  const toggle = (on: boolean): void => {
    void update((cur) => ({ ...cur, enabled: on }));
  };
  const remove = (url: RelayUrl): void => {
    void update((cur) => ({ ...cur, scopedRelays: cur.scopedRelays.filter((r) => r !== url) }));
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (full) {
      setError(`At most ${String(UI_MAX_NFX_SCOPED_RELAYS)} scoped relays.`);
      return;
    }
    const result = validateScopedRelayUrl(draft, nfx.scopedRelays);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const url = result.value;
    const submitted = draft;
    setError(null);
    setAdding(true);
    void update((cur) =>
      cur.scopedRelays.some((r) => normaliseRelayUrl(r) === url) ||
      cur.scopedRelays.length >= UI_MAX_NFX_SCOPED_RELAYS
        ? cur
        : { ...cur, scopedRelays: [...cur.scopedRelays, url] },
    ).then((ok) => {
      if (!alive.current) return;
      setAdding(false);
      if (ok) setDraft((cur) => (cur === submitted ? '' : cur));
      else setError('Not saved — the relay could not be added. Your address is kept; try again.');
    });
  };

  const inputId = `${id}-add`;

  return (
    <SectionFrame
      id={id}
      title="NFX network"
      description="NFX is an open protocol for paying-per-chunk video, spoken by other apps too. This build takes part in nfx's test network with free videos only."
      busy={pending.has('nfx')}
      headingRef={headingRef}
    >
      <SwitchRow
        id={`${id}-enabled`}
        label="Take part in the NFX testnet"
        description="Lists the network's free videos beside the Nostr ones, and sends a free upload's NFX announcement to the scoped relays below. Off: nothing is asked of or sent to NFX."
        checked={nfx.enabled}
        busy={pending.has('nfx')}
        onChange={toggle}
      />
      {nfx.scopedRelays.length === 0 ? (
        <Note>
          No scoped relays yet. The network&apos;s videos are still read from your relays; add the
          network&apos;s own relays for what your relays do not carry.
        </Note>
      ) : (
        <table className="nf-settings__table">
          <caption className="nf-settings__sr">Scoped relays</caption>
          <thead>
            <tr>
              <th scope="col">Scoped relay</th>
              <th scope="col" className="nf-settings__cell-action">
                <span className="nf-settings__sr">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {nfx.scopedRelays.map((url) => {
              const unsaved = !savedRelays.has(url);
              return (
                <tr key={url} className={unsaved ? 'nf-settings__row--pending' : undefined}>
                  <th scope="row" className="nf-settings__cell-url">
                    <span className="nf-settings__mono">{url}</span>
                    {unsaved ? <span className="nf-settings__saving"> Saving…</span> : null}
                  </th>
                  <td className="nf-settings__cell-action">
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Remove ${url}`}
                      onClick={() => {
                        remove(url);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <form className="nf-settings__add" onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId} className="nf-settings__label">
          Add a scoped relay
        </label>
        <div className="nf-settings__add-line">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="nf-settings__input nf-settings__mono"
            placeholder="wss://relay.example"
            value={draft}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? `${inputId}-error` : `${inputId}-hint`}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              if (error !== null) setError(null);
            }}
          />
          <Button type="submit" variant="secondary" loading={adding} disabled={full}>
            Add
          </Button>
        </div>
        {error !== null ? (
          <FieldError id={`${inputId}-error`}>{error}</FieldError>
        ) : (
          <p id={`${inputId}-hint`} className="nf-settings__desc">
            wss:// relays, or ws:// to a relay on this computer. At most {UI_MAX_NFX_SCOPED_RELAYS}.
          </p>
        )}
      </form>
    </SectionFrame>
  );
}
