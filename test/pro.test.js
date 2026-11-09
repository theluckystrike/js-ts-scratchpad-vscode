'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pro = require('../src/pro');
const pkg = require('../package.json');

function fakeVscode() {
  const cmds = new Map();
  return {
    cmds,
    commands: { registerCommand: (id, fn) => { cmds.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
    window: { setStatusBarMessage: () => ({ dispose() {} }) },
  };
}
const ctx = () => { const m = new Map(); return { subscriptions: [], globalState: { get: (k) => m.get(k), update: async (k, v) => m.set(k, v) } }; };

test('ships switched off: every feature is free, no Pro text', async () => {
  assert.equal(pro.PRO_ENABLED, false);
  const vs = fakeVscode();
  const p = pro.createPro({ vscode: vs, context: ctx() });
  for (const f of Object.keys(pro.FEATURES)) {
    for (let i = 0; i < 5; i++) assert.deepEqual(await p.gate(f), { ok: true, note: '' });
  }
  assert.equal(p.isPro(), true);
  for (const c of ['getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) assert.ok(vs.cmds.has(`jsScratchpad.${c}`));
});

test('when switched on: 3 free tries, then the license modal (fake license)', async () => {
  // simulate PRO_ENABLED = true by passing a license object
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pro.js'), 'utf8').replace('const PRO_ENABLED = false;', 'const PRO_ENABLED = true;');
  const tmp = path.join(__dirname, '..', 'src', '.pro-on.test.js');
  fs.writeFileSync(tmp, src);
  try {
    const on = require(tmp);
    let asked = 0;
    const lic = { ready: Promise.resolve(), isPro: () => false, refresh: async () => {}, requirePro: async () => { asked++; return false; } };
    const p = on.createPro({ vscode: fakeVscode(), context: ctx(), license: lic });
    for (let i = 1; i <= 3; i++) {
      const g = await p.gate('history');
      assert.equal(g.ok, true);
      assert.match(g.note, new RegExp(`free try ${i} of 3`));
    }
    assert.deepEqual(await p.gate('history'), { ok: false, note: '' });
    assert.equal(asked, 1);
  } finally { fs.unlinkSync(tmp); }
});

test('Pro commands hidden unless Pro is enabled; price USD 19, never 15', () => {
  for (const c of ['getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) {
    const e = pkg.contributes.menus.commandPalette.find((m) => m.command === `jsScratchpad.${c}`);
    assert.match(e.when, /jsScratchpad\.proEnabled/);
  }
  for (const f of ['package.json', 'README.md', 'src/pro.js']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /USD 15/, f);
  assert.match(pro.PRO_TEXT, /USD 19 once/);
});
