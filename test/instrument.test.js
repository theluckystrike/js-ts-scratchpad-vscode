'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { instrument, stripTypes, missingModuleLine } = require('../src/core/instrument');

const lines = (s) => s.split('\n').length;

test('keeps every line in place (JS)', () => {
  const src = 'const a = 1;\nconst b = {\n  x: 2,\n};\na + b.x;\nconsole.log(a)\n';
  const r = instrument(src, { fileName: 'a.js' });
  assert.equal(r.ok, true);
  assert.equal(lines(r.code), lines(src));
  assert.match(r.code.split('\n')[4], /__zv\(5,\(a \+ b\.x\)\)/);
  assert.match(r.code.split('\n')[5], /__zc\(6,"log"\)\(a\)/);
});

test('TypeScript: types removed, lines kept, enum and parameter properties not instrumented', () => {
  const src = 'enum C {\n  A,\n  B = 5,\n}\ninterface P { x: number }\nclass K { constructor(private a: number) {} }\nconst p = { x: 1 } satisfies P;\nfunction id<T>(v: T): T { return v }\nid<string>("x");\n';
  const out = stripTypes(src);
  assert.equal(lines(out), lines(src));
  const r = instrument(src, { fileName: 'a.ts' });
  assert.equal(r.ok, true);
  assert.equal(lines(r.code), lines(src));
  const l = r.code.split('\n');
  assert.doesNotMatch(l[0], /__zv/); // the enum IIFE
  assert.doesNotMatch(l[5], /__zv/); // this.a = a
  assert.match(l[6], /__zv\(7,p,"p"\)/);
  assert.match(l[8], /__zv\(9,\(id\("x"\)\),void 0,1\)/);
});

test('module type: import/export or top-level await is ESM, otherwise CommonJS; extension wins', () => {
  assert.equal(instrument('import fs from "fs";\nfs;', { fileName: 'a.js' }).moduleType, 'esm');
  assert.equal(instrument('await 1;', { fileName: 'a.js' }).moduleType, 'esm');
  assert.equal(instrument('const x = require("fs");', { fileName: 'a.js' }).moduleType, 'cjs');
  assert.equal(instrument('1;', { fileName: 'a.mjs' }).moduleType, 'esm');
  assert.equal(instrument('1;', { fileName: 'a.cjs' }).moduleType, 'cjs');
  assert.equal(instrument('async function f() { await 1 }\nf();', { fileName: 'a.js' }).moduleType, 'cjs');
});

test('ESM gets require, __filename and __dirname unless the file declares them', () => {
  const r = instrument('import x from "y";\nx;', { fileName: 'a.mjs', origPath: '/w/a.mjs', origDir: '/w' });
  assert.match(r.code.split('\n')[0], /createRequire as __zcreq/);
  assert.match(r.code, /const require=__zcreq\("\/w\/a.mjs"\)/);
  const r2 = instrument('import { createRequire } from "module";\nconst require = createRequire(import.meta.url);', { fileName: 'a.mjs', origPath: '/w/a.mjs', origDir: '/w' });
  assert.doesNotMatch(r2.code, /const require=__zcreq/);
});

test('hashbang and "use strict" keep working', () => {
  const r = instrument('#!/usr/bin/env node\n"use strict";\nx = 1;', { fileName: 'a.js', origPath: '/w/a.js', origDir: '/w' });
  const l = r.code.split('\n');
  assert.ok(l[0].startsWith('//'));
  assert.ok(l[1].startsWith('"use strict";'));
  assert.equal(lines(r.code), 3);
});

test('syntax error reports its line and column', () => {
  const r = instrument('const a = 1;\nconst b = ;\n', { fileName: 'a.js' });
  assert.equal(r.ok, false);
  assert.equal(r.error.line, 2);
  assert.match(r.error.message, /^SyntaxError/);
  const t = instrument('const a: number = 1;\nlet b: = 2;\n', { fileName: 'a.ts' });
  assert.equal(t.ok, false);
  assert.equal(t.error.line, 2);
});

test('statements without braces still show values; coverage marks never change control flow', () => {
  const r = instrument('let n = 0;\nfor (let i = 0; i < 3; i++) n += i;\nif (n) n * 2; else n;\n', { fileName: 'a.js', coverage: true });
  const l = r.code.split('\n');
  assert.match(l[1], /for \(let i = 0; i < 3; i\+\+\) __zv\(2,\(n \+= i\)\);/);
  assert.match(l[2], /^__zr\(3\);if \(n\) __zv\(3,\(n \* 2\)\); else __zv\(3,\(n\)\);/);
});

test('import.meta.url points at the real file', () => {
  const r = instrument('import.meta.url;', { fileName: 'a.mjs', origUrl: 'file:///w/a.mjs' });
  assert.match(r.code, /"file:\/\/\/w\/a.mjs"/);
});

test('missing module maps to the import line', () => {
  const r = instrument('const a = 1;\nimport x from "left-pad";\nconst y = require("./nope");', { fileName: 'a.mjs' });
  assert.equal(missingModuleLine("Cannot find package 'left-pad' imported from /x", r.imports), 2);
  assert.equal(missingModuleLine("Cannot find module '/w/nope' imported from /x", r.imports), 3);
  assert.equal(missingModuleLine('other error', r.imports), 0);
});

test('a 2 MB file instruments in reasonable time', () => {
  const src = Array.from({ length: 60000 }, (_, i) => `const v${i} = ${i} * 2; v${i} + 1;`).join('\n');
  const t = Date.now();
  const r = instrument(src, { fileName: 'big.js' });
  assert.equal(r.ok, true);
  assert.equal(lines(r.code), 60000);
  assert.ok(Date.now() - t < 60000, `took ${Date.now() - t} ms`); // runs in a worker thread in the extension (runner.test.js)
});
