/**
 * Settings screen (build-plan §6.1 row "Settings"): signer, relays, default mints (+ auto
 * top-up), the wallet's recovery phrase (ADR 0016, shell-provided), seeding on/off + disk cap,
 * data saver (prefetch depth, "buffer = money"), hover preview and theme — one page of sections
 * with a YouTube-style section nav on the left at wide widths.
 *
 * Talks ONLY to `NetworkAdapter` (`settings` / `updateSettings`, `signer`, `seeder.*`,
 * `wallet.mints|balances`, `profile`, `image`); renders ONLY `@sovit/ui` components + semantic
 * HTML. Every control saves on its own through an optimistic, serialised queue
 * (`useSettingsStore`): the change shows at once, a failure rolls that one change back and
 * raises a `Toast` with Retry, and typed input is never cleared by a failed save.
 *
 * The theme choice is only persisted here. Applying it to the document is the shell's job:
 * it reads `settings().theme` at boot and hears every confirmed change via `onSettingsChange`.
 * This screen never touches `document` / root attributes.
 *
 * ADR 0022: a shell picks the sections it offers (`sections`) and the parts of the NFX section
 * (`nfxParts`); without either, every section and the desktop app's NFX parts are shown. A section
 * not offered is not rendered, and the wallet and seeder behind it are never asked.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { Settings as SettingsData } from '@sovit/core';
import {
  ErrorState,
  Skeleton,
  SkeletonLines,
  ToastStack,
  cx,
  type ToastItem,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';
import { AppearanceSection, type AppearanceSectionParts } from './AppearanceSection.js';
import { PlaybackSection } from './PlaybackSection.js';
import { RecoverySection, type RecoveryControls } from './RecoverySection.js';
import type { TopUpHoldControls } from './TopUpHolds.js';
import { NfxSection, type NfxSectionParts } from './NfxSection.js';
import { RelaysSection } from './RelaysSection.js';
import { SeedingSection, useSeederStatus } from './SeedingSection.js';
import { SignerSection, useSigner } from './SignerSection.js';
import { WalletSection, useWalletMints } from './WalletSection.js';
import { describeLoadError, type SignerKind } from './model.js';
import { useSettingsStore, type FailureNotice } from './useSettingsStore.js';

export type SettingsSectionId =
  'account' | 'appearance' | 'playback' | 'relays' | 'mints' | 'recovery' | 'seeding' | 'nfx';

export const SETTINGS_SECTIONS: readonly {
  readonly id: SettingsSectionId;
  readonly label: string;
}[] = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'playback', label: 'Playback and performance' },
  { id: 'relays', label: 'Relays' },
  { id: 'mints', label: 'Mints and top-up' },
  { id: 'recovery', label: 'Recovery phrase' },
  { id: 'seeding', label: 'Seeding' },
  { id: 'nfx', label: 'NFX network' },
];

export interface SettingsProps extends ScreenProps {
  /**
   * ADR 0022: the sections this shell offers, shown in `SETTINGS_SECTIONS` order whatever the
   * order here. Absent: every section (the desktop app).
   */
  readonly sections?: readonly SettingsSectionId[] | undefined;
  /** ADR 0022: which parts of the NFX section to show. Absent: the desktop app's. */
  readonly nfxParts?: NfxSectionParts | undefined;
  /** ADR 0022: which parts of the Appearance section to show. Absent: all of them. */
  readonly appearanceParts?: AppearanceSectionParts | undefined;
  /**
   * Shell-owned signer flow (connect / switch), called with the signer type the viewer
   * picked. The v3 contract has no "change signer" method, so without this prop the choice
   * is shown read-only. Return a promise to have the screen re-read `adapter.signer()`
   * once the flow finishes.
   */
  readonly onChangeSigner?: ((kind: SignerKind) => void | Promise<void>) | undefined;
  /**
   * ADR 0016: the shell's recovery phrase flows (desktop). Each call names an action; the words
   * are shown and typed outside this screen. Without it the section says the phrase is not
   * available here (on the web: not covered).
   */
  readonly recovery?: RecoveryControls | undefined;
  /**
   * R5-R1: the shell's auto top-ups held back for a mint (desktop), each with a Resume confirmed
   * outside this screen. Without it nothing about holds is shown.
   */
  readonly topUpHolds?: TopUpHoldControls | undefined;
  /**
   * Called with the adapter-confirmed settings after every successful save — the shell
   * applies `theme` (and hands `hoverPreview` to Home) here. Also called for saves that
   * finish after the screen unmounted.
   */
  readonly onSettingsChange?: ((settings: SettingsData) => void) | undefined;
  /**
   * Hand toasts to the shell's `ToastStack` instead of rendering one here. Recommended: a
   * save that fails after the viewer navigated away still reaches them.
   */
  readonly onToast?: ((toast: ToastItem) => void) | undefined;
  /** Render this screen's own toast stack in flow (Storybook) instead of fixed. */
  readonly inlineToasts?: boolean | undefined;
  readonly className?: string | undefined;
}

export function Settings({
  adapter,
  navigate,
  miniPlayer,
  sections,
  nfxParts,
  appearanceParts,
  onChangeSigner,
  recovery,
  topUpHolds,
  onSettingsChange,
  onToast,
  inlineToasts = false,
  className,
}: SettingsProps): ReactElement {
  const uid = useId();
  const sectionId = (s: SettingsSectionId): string => `${uid}-${s}`;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- toasts --------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const dismiss = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);
  const pushToast = useCallback((t: ToastItem): void => {
    const shell = onToastRef.current;
    if (shell) shell(t);
    else if (alive.current) setToasts((prev) => [...prev.filter((x) => x.id !== t.id), t]);
  }, []);
  const onFailure = useCallback(
    (n: FailureNotice): void => {
      pushToast({
        id: n.id,
        tone: 'error',
        title: n.title,
        description: n.description,
        action: {
          label: 'Retry',
          onClick: () => {
            dismiss(n.id);
            n.retry();
          },
        },
      });
    },
    [dismiss, pushToast],
  );

  // ---- the sections this shell offers (ADR 0022) ----------------------------------------------
  const shown =
    sections === undefined
      ? SETTINGS_SECTIONS
      : SETTINGS_SECTIONS.filter((s) => sections.includes(s.id));
  const offers = (s: SettingsSectionId): boolean => sections === undefined || sections.includes(s);

  // ---- data ------------------------------------------------------------------------------
  const store = useSettingsStore(adapter, { onSaved: onSettingsChange, onFailure });
  const signer = useSigner(adapter);
  const seeder = useSeederStatus(adapter, offers('seeding'));
  const wallet = useWalletMints(adapter, offers('mints'));

  // ---- section nav -------------------------------------------------------------------------
  const [active, setActive] = useState<SettingsSectionId>(() => shown[0]?.id ?? 'account');
  const headings = useRef(new Map<SettingsSectionId, HTMLHeadingElement>());
  const headingRef = useCallback(
    (s: SettingsSectionId) =>
      (el: HTMLHeadingElement | null): void => {
        if (el) headings.current.set(s, el);
        else headings.current.delete(s);
      },
    [],
  );
  const refs = useRef<Partial<Record<SettingsSectionId, (el: HTMLHeadingElement | null) => void>>>(
    {},
  );
  const refFor = (s: SettingsSectionId): ((el: HTMLHeadingElement | null) => void) =>
    (refs.current[s] ??= headingRef(s));

  const goTo = (s: SettingsSectionId): void => {
    setActive(s);
    const el = headings.current.get(s);
    if (!el) return;
    // Optional-call: jsdom (tests) and some embedded webviews lack scrollIntoView.
    (el.scrollIntoView as ((o?: ScrollIntoViewOptions) => void) | undefined)?.call(el, {
      block: 'start',
    });
    el.focus({ preventScroll: true });
  };

  // Scroll-spy: highlight the section whose heading most recently crossed the top third.
  const ready = store.status === 'ready';
  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const s = SETTINGS_SECTIONS.find((x) => headings.current.get(x.id) === hit?.target);
        if (s) setActive(s.id);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    for (const el of headings.current.values()) io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [ready]);

  // ---- render ----------------------------------------------------------------------------
  const saving = store.pending.size > 0;
  const statusText = saving
    ? 'Saving…'
    : store.lastOutcome === 'failed'
      ? 'Last change not saved'
      : store.lastOutcome === 'saved'
        ? 'All changes saved'
        : 'Changes save automatically';

  const renderLoadError = (): ReactElement => {
    const e = describeLoadError(store.error);
    return (
      <ErrorState
        className="nf-settings__load-error"
        title={e.title}
        description={e.description}
        detail={e.detail}
        onRetry={() => {
          store.reload();
          signer.refresh();
        }}
      />
    );
  };

  const renderBody = (): ReactElement => {
    const view = store.view;
    const saved = store.saved;
    if (store.status === 'loading' || view === undefined || saved === undefined) {
      return (
        <div className="nf-settings__loading" aria-hidden="true">
          {shown.map((s) => (
            <div key={s.id} className="nf-settings__section nf-settings__section--skeleton">
              <Skeleton variant="text" width="30%" />
              <SkeletonLines lines={3} />
            </div>
          ))}
        </div>
      );
    }
    const common = { view, saved, pending: store.pending, save: store.save };
    return (
      <>
        {offers('account') ? (
          <SignerSection
            id={sectionId('account')}
            signer={signer}
            onChangeSigner={onChangeSigner}
            onChangePicture={async (image) => {
              await adapter.setProfilePicture(image);
              signer.refresh();
            }}
            headingRef={refFor('account')}
          />
        ) : null}
        {offers('appearance') ? (
          <AppearanceSection
            id={sectionId('appearance')}
            {...common}
            parts={appearanceParts}
            headingRef={refFor('appearance')}
          />
        ) : null}
        {offers('playback') ? (
          <PlaybackSection id={sectionId('playback')} {...common} headingRef={refFor('playback')} />
        ) : null}
        {offers('relays') ? (
          <RelaysSection
            id={sectionId('relays')}
            {...common}
            signedOut={signer.signedOut}
            headingRef={refFor('relays')}
          />
        ) : null}
        {offers('mints') ? (
          <WalletSection
            id={sectionId('mints')}
            {...common}
            wallet={wallet}
            signedIn={signer.signedIn}
            signedOut={signer.signedOut}
            navigate={navigate}
            headingRef={refFor('mints')}
            topUpHolds={topUpHolds}
          />
        ) : null}
        {offers('recovery') ? (
          <RecoverySection
            id={sectionId('recovery')}
            adapter={adapter}
            recovery={recovery}
            signedIn={signer.signedIn}
            headingRef={refFor('recovery')}
          />
        ) : null}
        {offers('seeding') ? (
          <SeedingSection
            id={sectionId('seeding')}
            {...common}
            adapter={adapter}
            seeder={seeder}
            navigate={navigate}
            headingRef={refFor('seeding')}
          />
        ) : null}
        {offers('nfx') ? (
          <NfxSection
            id={sectionId('nfx')}
            {...common}
            parts={nfxParts}
            headingRef={refFor('nfx')}
          />
        ) : null}
      </>
    );
  };

  return (
    <section className={cx('nf-settings', className)} aria-labelledby={`${uid}-title`}>
      <header className="nf-settings__head">
        <h1 id={`${uid}-title`} className="nf-settings__title">
          Settings
        </h1>
        {ready ? (
          <p
            className={cx(
              'nf-settings__status',
              saving && 'nf-settings__status--saving',
              !saving && store.lastOutcome === 'failed' && 'nf-settings__status--failed',
            )}
            role="status"
          >
            {statusText}
          </p>
        ) : null}
      </header>
      {store.status === 'error' ? (
        renderLoadError()
      ) : (
        <div className="nf-settings__layout">
          <nav className="nf-settings__nav" aria-label="Settings sections">
            <ul className="nf-settings__nav-list">
              {shown.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cx(
                      'nf-settings__nav-item',
                      active === s.id && 'nf-settings__nav-item--active',
                    )}
                    aria-current={active === s.id ? 'true' : undefined}
                    aria-controls={sectionId(s.id)}
                    disabled={!ready}
                    onClick={() => {
                      goTo(s.id);
                    }}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="nf-settings__body" aria-busy={!ready}>
            {renderBody()}
          </div>
        </div>
      )}
      {onToast ? null : (
        <ToastStack
          toasts={toasts}
          onDismiss={dismiss}
          inline={inlineToasts}
          className="nf-settings__toasts"
        />
      )}
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-settings__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
