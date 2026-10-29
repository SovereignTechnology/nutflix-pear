// The Bare smoke test's boot module (spike S-D): bare-encoding's globals first (D6, as
// packages/app-desktop/src/worker/__tests__/helpers/bare.ts does), then the bundled smoke test,
// copied beside it as ./smoke.mjs. A load failure is written to the progress file, so a smoke
// test that never ran cannot pass for one that ran and printed nothing.
import 'bare-encoding/global';
import fs from 'bare-fs';

const progress = `${Bare.argv[Bare.argv.length - 1]}.progress`;
fs.appendFileSync(progress, `${Date.now()} boot\n`);
import('./smoke.mjs').catch((e) => {
  fs.appendFileSync(progress, `${Date.now()} boot: ${e instanceof Error ? e.stack : String(e)}\n`);
  Bare.exit(3);
});
