/**
 * Settings › NFX (contracts v10, ADR 0020): taking part in nfx's testnet. Off by default. On, the
 * catalogue lists the network's free videos beside the Nostr ones and a free upload's NFX
 * manifest also goes to the network's scoped relays (NFX-04), listed here: `wss://`, or `ws://`
 * to this computer only. Below them, the network's own iroh relays (contracts v12, NFX-06 §1):
 * `https://`, or `http://` to this computer only. Every change is one optimistic
 * `updateSettings({ nfx })`.
 */
import { useState, type ReactElement, type ReactNode, type SubmitEvent } from 'react';
import type { IrohRelayUrl, NfxSettings, RelayUrl, Settings } from '@sovit/core';
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
  UI_MAX_NFX_IROH_RELAYS,
  UI_MAX_NFX_SCOPED_RELAYS,
  UI_NFX_NETWORK,
  normaliseIrohRelayUrl,
  normaliseRelayUrl,
  validateIrohRelayUrl,
  validateScopedRelayUrl,
  type Validation,
} from './model.js';

const LABEL = 'the NFX settings';

/** `base.nfx`, or the network's starting point (off, no scoped relays). */
function nfxOf(base: Settings): NfxSettings {
  return (
    base.nfx ?? {
      enabled: false,
      network: UI_NFX_NETWORK,
      scopedRelays: [],
    }
  );
}

interface RelayListProps<T extends string> {
  /** The add field's id; its hint and error ids are derived from it. */
  readonly inputId: string;
  /** The list's heading and the table's caption. */
  readonly title: string;
  readonly description?: ReactNode;
  /** The table's column header for one relay. */
  readonly column: string;
  readonly relays: readonly T[];
  /** The relays already saved; any other is shown as "Saving…". */
  readonly saved: ReadonlySet<string>;
  readonly max: number;
  /** Shown when the list is empty. */
  readonly empty: ReactNode;
  readonly addLabel: string;
  readonly placeholder: string;
  readonly hint: ReactNode;
  /** The error when the list already holds `max`. */
  readonly fullError: string;
  readonly validate: (draft: string, existing: readonly T[]) => Validation<T>;
  /** Saves `url` into the list (unless it is there or full by then); false when not saved. */
  readonly add: (url: T) => Promise<boolean>;
  readonly remove: (url: T) => void;
}

/** One relay list of the section: the table, its remove buttons and the add form. */
function RelayList<T extends string>({
  inputId,
  title,
  description,
  column,
  relays,
  saved,
  max,
  empty,
  addLabel,
  placeholder,
  hint,
  fullError,
  validate,
  add,
  remove,
}: RelayListProps<T>): ReactElement {
  const alive = useAlive();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const full = relays.length >= max;

  const onSubmit = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (full) {
      setError(fullError);
      return;
    }
    const result = validate(draft, relays);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const submitted = draft;
    setError(null);
    setAdding(true);
    void add(result.value).then((ok) => {
      if (!alive.current) return;
      setAdding(false);
      if (ok) setDraft((cur) => (cur === submitted ? '' : cur));
      else setError('Not saved — the relay could not be added. Your address is kept; try again.');
    });
  };

  return (
    <div className="nf-settings__group">
      <h3 className="nf-settings__group-title">{title}</h3>
      {description !== undefined ? <p className="nf-settings__desc">{description}</p> : null}
      {relays.length === 0 ? (
        <Note>{empty}</Note>
      ) : (
        <table className="nf-settings__table">
          <caption className="nf-settings__sr">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{column}</th>
              <th scope="col" className="nf-settings__cell-action">
                <span className="nf-settings__sr">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {relays.map((url) => {
              const unsaved = !saved.has(url);
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
          {addLabel}
        </label>
        <div className="nf-settings__add-line">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="nf-settings__input nf-settings__mono"
            placeholder={placeholder}
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
            {hint}
          </p>
        )}
      </form>
    </div>
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
  const nfx = nfxOf(view);
  const savedNfx = nfxOf(saved);
  const irohRelays = nfx.irohRelays ?? [];

  const update = (fn: (current: NfxSettings) => NfxSettings): Promise<boolean> =>
    save({ field: 'nfx', label: LABEL, patch: (base: Settings) => ({ nfx: fn(nfxOf(base)) }) });

  const toggle = (on: boolean): void => {
    void update((cur) => ({ ...cur, enabled: on }));
  };

  const addScoped = (url: RelayUrl): Promise<boolean> =>
    update((cur) =>
      cur.scopedRelays.some((r) => normaliseRelayUrl(r) === url) ||
      cur.scopedRelays.length >= UI_MAX_NFX_SCOPED_RELAYS
        ? cur
        : { ...cur, scopedRelays: [...cur.scopedRelays, url] },
    );
  const removeScoped = (url: RelayUrl): void => {
    void update((cur) => ({ ...cur, scopedRelays: cur.scopedRelays.filter((r) => r !== url) }));
  };

  const addIroh = (url: IrohRelayUrl): Promise<boolean> =>
    update((cur) => {
      const list = cur.irohRelays ?? [];
      return list.some((r) => normaliseIrohRelayUrl(r) === url) ||
        list.length >= UI_MAX_NFX_IROH_RELAYS
        ? cur
        : { ...cur, irohRelays: [...list, url] };
    });
  const removeIroh = (url: IrohRelayUrl): void => {
    void update((cur) => ({
      ...cur,
      irohRelays: (cur.irohRelays ?? []).filter((r) => r !== url),
    }));
  };

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
      <RelayList
        inputId={`${id}-add`}
        title="Scoped relays"
        column="Scoped relay"
        relays={nfx.scopedRelays}
        saved={new Set<string>(savedNfx.scopedRelays)}
        max={UI_MAX_NFX_SCOPED_RELAYS}
        empty={
          <>
            No scoped relays yet. The network&apos;s videos are still read from your relays; add the
            network&apos;s own relays for what your relays do not carry.
          </>
        }
        addLabel="Add a scoped relay"
        placeholder="wss://relay.example"
        hint={
          <>
            wss:// relays, or ws:// to a relay on this computer. At most {UI_MAX_NFX_SCOPED_RELAYS}.
          </>
        }
        fullError={`At most ${String(UI_MAX_NFX_SCOPED_RELAYS)} scoped relays.`}
        validate={validateScopedRelayUrl}
        add={addScoped}
        remove={removeScoped}
      />
      <RelayList
        inputId={`${id}-iroh-add`}
        title="iroh relays"
        description="The network's own iroh relays: the only relays this app uses to reach NFX seeders over iroh, and the only ones its announcements name."
        column="iroh relay"
        relays={irohRelays}
        saved={new Set<string>(savedNfx.irohRelays ?? [])}
        max={UI_MAX_NFX_IROH_RELAYS}
        empty="No iroh relays yet: iroh then connects only directly."
        addLabel="Add an iroh relay"
        placeholder="https://relay.example/"
        hint={
          <>
            https:// relays, or http:// to a relay on this computer. At most{' '}
            {UI_MAX_NFX_IROH_RELAYS}.
          </>
        }
        fullError={`At most ${String(UI_MAX_NFX_IROH_RELAYS)} iroh relays.`}
        validate={validateIrohRelayUrl}
        add={addIroh}
        remove={removeIroh}
      />
    </SectionFrame>
  );
}
