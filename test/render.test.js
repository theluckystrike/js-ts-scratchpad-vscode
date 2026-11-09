'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/core/render');

test('one value, a named value, a resolved promise', () => {
  assert.deepEqual(r.lineText({ items: [{ kind: 'value', text: '42' }], count: 1 }), { text: '42', kind: 'value' });
  assert.equal(r.lineText({ items: [{ kind: 'value', text: '1', name: 'a' }, { kind: 'value', text: '2', name: 'b' }], count: 2 }).text, 'a = 1 · b = 2');
  assert.equal(r.lineText({ items: [{ kind: 'value', text: '42', resolved: true }], count: 1 }).text, 'Promise → 42');
});

test('a loop line shows the first values and a count, within the length', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ kind: 'log', text: `row ${i}`, method: 'log' }));
  const t = r.lineText({ items, count: 1000000 }, 120);
  assert.equal(t.kind, 'log');
  assert.ok(t.text.length <= 125, t.text);
  assert.match(t.text, /^› row 0 · row 1/);
  assert.match(t.text, /\(\+999,9\d\d more\)$/);
});

test('an error wins over values on the same line', () => {
  const t = r.lineText({ items: [{ kind: 'value', text: '1' }, { kind: 'error', text: 'TypeError: x is not a function' }], count: 1 });
  assert.deepEqual(t, { text: '✖ TypeError: x is not a function', kind: 'error' });
});

test('multi-line values become one line and long ones are cut', () => {
  const t = r.lineText({ items: [{ kind: 'value', text: 'a\n  b\n' + 'x'.repeat(500) }], count: 1 }, 50);
  assert.ok(!t.text.includes('\n'));
  assert.ok(t.text.length <= 50);
});

test('hover is a fenced block that cannot be broken by backticks', () => {
  const h = r.hoverText({ items: [{ kind: 'value', text: '```evil```' }], count: 1 }, 3);
  assert.match(h, /^\*\*Line 3\*\*/);
  assert.match(h, /````text/);
});

test('markdown copy adds values as comments and the console output', () => {
  const st = { lines: new Map([[2, { items: [{ kind: 'value', text: '3' }], count: 1 }]]), output: [{ line: 3, text: 'hi' }] };
  const md = r.markdownCopy('const a = 1;\na + 2;\nconsole.log("hi")', { state: st }, 'js');
  assert.match(md, /a \+ 2;  \/\/ 3/);
  assert.match(md, /Console output/);
});

test('output text for a timeout and dropped lines', () => {
  const st = { warnings: [], output: [{ line: 1, text: 'x' }], outputDropped: 998000, errors: [], exit: null, node: 'v20' };
  const t = r.outputText({ status: 'timeout', state: st, ms: 5000, moduleType: 'cjs', stderr: '' }, 'a.js', 5000);
  assert.match(t, /998,000 more console lines/);
  assert.match(t, /Stopped after 5 s/);
});
