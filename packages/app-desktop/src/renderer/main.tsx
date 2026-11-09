/**
 * Renderer entry (bundled to `dist/renderer/app.js` by scripts/bundle.ts; loaded by the static
 * `index.html` with `<script type="module" src="app.js">` under a CSP with no inline anything).
 *
 * `window.nutflix` (the preload's bridge) → rehydrating adapter → the ONE playback coordinator
 * wrap → the shell (`@sovit/ui`'s, since ADR 0022; the desktop offers every section). No network
 * from here: `connect-src 'none'`; everything goes over the bridge.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  adapterFromBridge,
  recoveryFromBridge,
  topUpHoldsFromBridge,
} from './adapter/rehydrate.js';
import { Shell, createShellModel, type SignerFlow } from '@sovit/ui';
import type { NutflixBridge } from './bridge-types.js';

function boot(root: HTMLElement): void {
  const bridge = (window as unknown as { nutflix?: NutflixBridge }).nutflix;
  if (bridge === undefined) {
    root.textContent = 'Nutflix could not start: the desktop bridge is missing.';
    return;
  }
  const model = createShellModel(adapterFromBridge(bridge));
  const s = bridge.desktop.signer;
  const signerFlow: SignerFlow = {
    info: () => s.info(),
    connect: (kind) => s.connect({ kind }),
    unlock: () => s.unlock(),
    lock: () => s.lock(),
    signOut: () => s.signOut(),
    onChange: (cb) =>
      s.onStatus(() => {
        cb();
      }),
  };
  createRoot(root).render(
    <StrictMode>
      <Shell
        adapter={model.adapter}
        coordinator={model.coordinator}
        router={model.router}
        probeFfmpeg={(recheck) => bridge.desktop.ffmpeg({ recheck })}
        signerFlow={signerFlow}
        recovery={recoveryFromBridge(bridge.desktop.wallet.recovery)}
        topUpHolds={topUpHoldsFromBridge(bridge.desktop.wallet.topUp)}
      />
    </StrictMode>,
  );
}

const root = document.getElementById('root');
if (root !== null) boot(root);
