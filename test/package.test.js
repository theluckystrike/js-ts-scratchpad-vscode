'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('engines floor for Cursor and Windsurf', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
});

test('display name keeps the search phrases together', () => {
  for (const p of ['JavaScript Playground', 'TypeScript Scratchpad', 'Inline Values']) assert.ok(pkg.displayName.includes(p), p);
  assert.doesNotMatch(pkg.displayName, /TypeScript Playground|JavaScript REPL|Quokka|Console Ninja/);
});

test('every command in package.json is registered, and the other way round', () => {
  const ext = src('src/extension.js') + src('src/pro.js') + src('src/support.js');
  const declared = pkg.contributes.commands.map((c) => c.command);
  const reg = new Set([...ext.matchAll(/reg\('(\w+)'/g)].map((m) => `jsScratchpad.${m[1]}`));
  for (const c of ['supportDeveloper', 'moreViewers', 'getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) reg.add(`jsScratchpad.${c}`);
  for (const c of declared) assert.ok(reg.has(c), `not registered: ${c}`);
  for (const c of reg) assert.ok(declared.includes(c), `not declared: ${c}`);
});

test('no network code in the extension (only the user-started GitHub Sponsors unlock, switched off)', () => {
  for (const f of ['src/extension.js', 'src/core/runner.js', 'src/core/instrument.js', 'src/core/render.js', 'src/runtime/runtime.cjs', 'src/runtime/loader.mjs', 'src/support.js', 'src/rate.js']) {
    const t = src(f);
    assert.doesNotMatch(t, /require\(['"](https?|net|tls|dgram)['"]\)|\bfetch\(/, f);
  }
});

test('no notification is shown on activation or after a run', () => {
  const t = src('src/extension.js');
  // the only notifications: an error when a scratch folder cannot be created (user action)
  const calls = [...t.matchAll(/window\.show(Information|Warning|Error)Message/g)];
  assert.equal(calls.length, 1);
  assert.match(t, /Could not create a scratchpad/);
});

test('walkthrough files exist; Restricted Mode is limited support', () => {
  for (const s of pkg.contributes.walkthroughs[0].steps) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
});

test('shared license and rating modules are the factory copies', () => {
  const fac = path.join(root, '..', '..', 'sprint');
  if (!fs.existsSync(fac)) return; // outside the factory (the public repo)
  for (const f of ['index.js', 'license.js', 'sponsors.js']) assert.equal(src(`src/license/${f}`), fs.readFileSync(path.join(fac, 'license', f), 'utf8'), f);
  assert.equal(src('src/rate.js'), fs.readFileSync(path.join(fac, 'rating', 'rate.js'), 'utf8'));
});
