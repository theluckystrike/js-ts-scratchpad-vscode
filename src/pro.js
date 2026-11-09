'use strict';
// Zovo Pro for the JavaScript Playground. Built and wired, shipped switched off (PRO_ENABLED = false):
// every feature is free and no Pro text shows anywhere until the owner turns it on.
// If it is ever on: the Pro extras are the value history of a line, copying the code with its values as
// Markdown, and the "which lines ran" marks. Each has 3 free tries per computer (local counter, no network),
// then one modal, only when the user starts that feature. Inline values, console output, errors, TypeScript,
// the scratchpads, timeouts and every setting stay free, always.
const { createLicense } = require('./license');

const PRO_ENABLED = false; // false: every feature is free and no Pro text shows anywhere
const FREE_TRIES = 3;
const TRIES_KEY = 'zovo.jsScratchpad.proTries.v1';

const FEATURES = {
  history: { name: 'Value history', detail: 'Lists every value a line took (up to the per-line limit), for example each pass of a loop, and copies one.' },
  markdown: { name: 'Copy with values as Markdown', detail: 'Copies the file with each value as a comment at the end of its line, plus the console output, as Markdown.' },
  coverage: { name: 'Lines that ran', detail: 'Marks the lines that ran in the last run, and the ones that did not, in the editor margin.' },
};

const PRO_TEXT = 'Zovo Pro is USD 19 once on GitHub Sponsors and unlocks Pro in every Zovo extension. Bought it already, or sponsor monthly with USD 10 or more? Choose Unlock with GitHub Sponsors. Unlocking sends one question to GitHub, nothing else. Inline values, console output, errors and TypeScript stay free.';

function createPro({ vscode, context, license }) {
  const lic = license || (PRO_ENABLED ? createLicense({ vscode, context, sku: 'jsplayground-pro', name: 'Zovo', commandPrefix: 'jsScratchpad' }) : null);
  try { vscode.commands.executeCommand('setContext', 'jsScratchpad.proEnabled', !!PRO_ENABLED); } catch (_) { /* old host */ }
  if (!lic) {
    for (const c of ['getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) {
      context.subscriptions.push(vscode.commands.registerCommand(`jsScratchpad.${c}`, () => vscode.window.setStatusBarMessage('Everything in the JavaScript Playground is free.', 4000)));
    }
  }
  const tries = () => Object.assign({}, context.globalState.get(TRIES_KEY) || {});

  /** For a Pro feature the user started. Returns {ok, note}. */
  async function gate(feature) {
    if (!PRO_ENABLED || !lic) return { ok: true, note: '' };
    await lic.ready;
    if (lic.isPro()) { lic.refresh().catch(() => {}); return { ok: true, note: '' }; }
    const t = tries();
    const used = Number(t[feature]) || 0;
    if (used < FREE_TRIES) {
      t[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, t);
      return { ok: true, note: `${FEATURES[feature].name} is Pro: free try ${used + 1} of ${FREE_TRIES}.` };
    }
    const f = FEATURES[feature];
    const ok = await lic.requirePro(f.name, `${f.detail}\n\n${PRO_TEXT}`);
    return { ok: !!ok, note: '' };
  }

  return {
    gate,
    isPro: () => !PRO_ENABLED || !lic || lic.isPro(),
    triesLeft: (feature) => Math.max(0, FREE_TRIES - (Number(tries()[feature]) || 0)),
    license: lic,
  };
}

module.exports = { createPro, PRO_ENABLED, FREE_TRIES, FEATURES, TRIES_KEY, PRO_TEXT };
