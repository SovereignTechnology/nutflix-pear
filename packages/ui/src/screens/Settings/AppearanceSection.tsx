/**
 * Settings › Appearance: light / dark / follow the device (ADR 0005 — "system" is the
 * default). The screen only persists the choice through `updateSettings({ theme })`; applying
 * it to the document is the shell's job (it hears the confirmed value via `onSettingsChange`).
 *
 * Also "Load images from any website" (security review F18, default off): off, only images whose
 * hash the publisher signed are shown — an arbitrary image URL is a tracking pixel. ADR 0022: a
 * shell that never loads such images (the web client) leaves the switch out (`parts`).
 */
import type { ReactElement } from 'react';
import type { Settings } from '@sovit/core';
import { cx } from '../../components/index.js';
import { useResolvedTheme } from '../../tokens/index.js';
import { SectionFrame, SwitchRow, type SectionProps } from './controls.js';

type Theme = Settings['theme'];

export const THEME_OPTIONS: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: 'system', label: 'Use device theme' },
  { value: 'dark', label: 'Dark theme' },
  { value: 'light', label: 'Light theme' },
];

/** ADR 0022: the parts of the section a shell shows; each absent part takes its default. */
export interface AppearanceSectionParts {
  /** "Load images from any website". Default: shown. */
  readonly remoteImages?: boolean | undefined;
}

export function AppearanceSection({
  id,
  view,
  pending,
  save,
  parts,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly parts?: AppearanceSectionParts | undefined;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  // Reads `prefers-color-scheme` only — never writes to the document.
  const deviceTheme = useResolvedTheme('system');
  const choose = (theme: Theme): void => {
    void save({ field: 'theme', label: 'your theme', patch: () => ({ theme }) });
  };
  return (
    <SectionFrame
      id={id}
      title="Appearance"
      description="Applies to Nutflix on this device."
      busy={pending.has('theme') || pending.has('loadRemoteImages')}
      headingRef={headingRef}
    >
      <fieldset className="nf-settings__fieldset">
        <legend className="nf-settings__legend">Theme</legend>
        <div className="nf-settings__choices nf-settings__choices--compact">
          {THEME_OPTIONS.map((o) => {
            const inputId = `${id}-theme-${o.value}`;
            const selected = view.theme === o.value;
            return (
              <label
                key={o.value}
                htmlFor={inputId}
                className={cx('nf-settings__choice', selected && 'nf-settings__choice--selected')}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-theme`}
                  value={o.value}
                  checked={selected}
                  onChange={() => {
                    choose(o.value);
                  }}
                />
                <span className="nf-settings__choice-text">
                  <span className="nf-settings__choice-title">{o.label}</span>
                  {o.value === 'system' ? (
                    <span className="nf-settings__desc">
                      Follows your device — currently {deviceTheme}.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
        {pending.has('theme') ? <span className="nf-settings__saving">Saving…</span> : null}
      </fieldset>

      {parts?.remoteImages === false ? null : (
        <SwitchRow
          id={`${id}-remote-images`}
          label="Load images from any website"
          description="Off: only thumbnails and pictures whose fingerprint the publisher signed are shown; the rest stay as placeholders. On: every image loads, and each website that hosts one sees your IP address."
          checked={view.loadRemoteImages}
          busy={pending.has('loadRemoteImages')}
          onChange={(on) => {
            void save({
              field: 'loadRemoteImages',
              label: 'image loading',
              patch: () => ({ loadRemoteImages: on }),
            });
          }}
        />
      )}
    </SectionFrame>
  );
}
