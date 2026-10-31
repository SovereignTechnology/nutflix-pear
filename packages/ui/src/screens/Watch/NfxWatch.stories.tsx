/**
 * Screens/NfxWatch — the watch page of a free NFX video (contracts v9, ADR 0020), one story per
 * state against `MockNetworkAdapter` with its NFX fixtures. Nothing on it plays or pays.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, NfxAddress } from '@sovit/core';
import { CHANNELS, NOW, avatar, nfxVideoAt } from '../../../.storybook/fixtures.js';
import { NfxWatch } from './NfxWatch.js';
import './Watch.css';

const { MockNetworkAdapter } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

/** The NFX-listing mock, with avatars answered by inline SVG so they render offline. */
function storyAdapter(opts: Options = {}): NetworkAdapter {
  const a = new MockNetworkAdapter({ nfx: true, ...opts });
  const byAvatar = new Map<string, string>();
  for (const c of CHANNELS)
    if (c.profile.picture) byAvatar.set(c.profile.picture, avatar(c.pubkey));
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byAvatar.get(url) ?? url, sha256);
  return a;
}

const meta = {
  title: 'Screens/NfxWatch',
  component: NfxWatch,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof NfxWatch>;
export default meta;
type Story = StoryObj<typeof meta>;

const navigate = (): void => undefined;
const video = nfxVideoAt(0);

export const Populated: Story = {
  name: "Populated (free, can't play yet)",
  args: { adapter: storyAdapter(), navigate, videoId: video.id, now: NOW },
};

export const Loading: Story = {
  name: 'Loading (skeletons)',
  args: { adapter: storyAdapter({ latencyMs: 5000 }), navigate, videoId: video.id, now: NOW },
};

export const NotFound: Story = {
  name: 'Empty — not on your relays, deleted or not free',
  args: {
    adapter: storyAdapter(),
    navigate,
    videoId: `38504:${video.author}:nfx:testnet:1:missing-video` as NfxAddress,
    now: NOW,
  },
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  args: {
    adapter: storyAdapter({ failWith: 'relay-down' }),
    navigate,
    videoId: video.id,
    now: NOW,
  },
};
