/**
 * The shell sidebar (design §4 "Chrome"; moved into `@sovit/ui` from the desktop app, ADR 0022).
 * Plain navigation; the current section is marked with `aria-current="page"`. A shell lists the
 * sections it offers (`sections`); without the list every section shows, as on the desktop.
 */
import type { ReactElement } from 'react';
import { Icon, type IconName } from '../components/index.js';
import type { Route } from '../screens/index.js';

/** ADR 0022: the sidebar's sections, each one item. */
export type ShellSection =
  'home' | 'shorts' | 'subscriptions' | 'library' | 'studio' | 'wallet' | 'settings';

/** Every section, in the sidebar's order. */
export const SHELL_SECTIONS: readonly ShellSection[] = [
  'home',
  'shorts',
  'subscriptions',
  'library',
  'studio',
  'wallet',
  'settings',
];

/**
 * The section a route belongs to, or `null` for a route every shell offers (watch, channel,
 * search). Home's Subscriptions feed is the `subscriptions` section.
 */
export function routeSection(r: Route): ShellSection | null {
  switch (r.name) {
    case 'home':
      return r.tab === 'subscriptions' ? 'subscriptions' : 'home';
    case 'shorts':
    case 'library':
    case 'studio':
    case 'wallet':
    case 'settings':
      return r.name;
    case 'watch':
    case 'channel':
    case 'search':
      return null;
  }
}

interface Item {
  readonly section: ShellSection;
  readonly label: string;
  readonly icon: IconName;
  readonly to: Route;
  readonly active: (r: Route) => boolean;
}

const ITEMS: readonly (readonly Item[])[] = [
  [
    {
      section: 'home',
      label: 'Home',
      icon: 'playlist',
      to: { name: 'home' },
      active: (r) => r.name === 'home' && r.tab !== 'subscriptions',
    },
    {
      section: 'shorts',
      label: 'Shorts',
      icon: 'bolt',
      to: { name: 'shorts' },
      active: (r) => r.name === 'shorts',
    },
    {
      section: 'subscriptions',
      label: 'Subscriptions',
      icon: 'people',
      to: { name: 'home', tab: 'subscriptions' },
      active: (r) => r.name === 'home' && r.tab === 'subscriptions',
    },
  ],
  [
    {
      section: 'library',
      label: 'Library',
      icon: 'clock',
      to: { name: 'library' },
      active: (r) => r.name === 'library',
    },
    {
      section: 'studio',
      label: 'Studio',
      icon: 'seed',
      to: { name: 'studio' },
      active: (r) => r.name === 'studio',
    },
    {
      section: 'wallet',
      label: 'Wallet',
      icon: 'wallet',
      to: { name: 'wallet' },
      active: (r) => r.name === 'wallet',
    },
    {
      section: 'settings',
      label: 'Settings',
      icon: 'settings',
      to: { name: 'settings' },
      active: (r) => r.name === 'settings',
    },
  ],
];

export interface SidebarProps {
  readonly route: Route;
  readonly navigate: (to: Route) => void;
  /** ADR 0022: the sections this shell offers. Absent: every section (the desktop app). */
  readonly sections?: readonly ShellSection[] | undefined;
}

export function Sidebar({ route, navigate, sections }: SidebarProps): ReactElement {
  const groups = ITEMS.map((group) =>
    group.filter((item) => sections === undefined || sections.includes(item.section)),
  ).filter((group) => group.length > 0);
  return (
    <nav className="nf-shell__sidebar" aria-label="Main">
      {groups.map((group, i) => (
        <ul key={i} className="nf-shell__nav">
          {group.map((item) => {
            const current = item.active(route);
            return (
              <li key={item.label}>
                <button
                  type="button"
                  className="nf-shell__nav-item"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    navigate(item.to);
                  }}
                >
                  <Icon name={item.icon} size={20} />
                  <span>{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}
