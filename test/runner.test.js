'use strict';
// Runs real child processes with this Node. Temp files go to os.tmpdir()/zovo-jsts-test-<pid> and are removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Runner } = require('../src/core/runner');

const root = path.join(__dirname, '..');
const tmpRoot = path.join(os.tmpdir(), `zovo-jsts-test-${process.pid}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-jsts-work-'));
const runner = new Runner({ tmpRoot, runtimePath: path.join(root, 'src/runtime/runtime.cjs'), loaderPath: path.join(root, 'src/runtime/loader.mjs'), workerPath: path.join(root, 'src/core/instrument-worker.js') });
test.after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); });

function run(text, fileName = 'a.js', extra = {}) {
  const origPath = path.join(work, fileName);
  return runner.run({ text, fileName, origPath, origDir: work, wsDirs: [work], timeoutMs: 5000, ...extra }).promise;
}
const first = (res, line) => { const e = res.state.lines.get(line); return e && e.items[0] && e.items[0].text; };

test('values, names and console output on their lines', async () => {
  const res = await run('const a = [3, 1, 2];\na.sort();\nconsole.log("n", a.length);\nconst m = new Map([[1, "x"]]);\nnew Set([1, 2]);\n');
  assert.equal(res.status, 'done');
  assert.equal(first(res, 1), '[ 3, 1, 2 ]');
  assert.equal(first(res, 2), '[ 1, 2, 3 ]');
  assert.equal(first(res, 3), 'n 3');
  assert.equal(res.state.lines.get(4).items[0].name, 'm');
  assert.equal(first(res, 5), 'Set(2) { 1, 2 }');
  assert.equal(res.state.output[0].text, 'n 3');
});

test('TypeScript with generics, enums, satisfies and top-level await', async () => {
  const res = await run('enum E { A = 2 }\ninterface P { x: number }\nconst p = { x: E.A } satisfies P;\nfunction id<T>(v: T): T { return v }\nawait Promise.resolve(id<number>(p.x * 10));\n', 'a.ts');
  assert.equal(res.status, 'done', JSON.stringify(res.state && res.state.errors));
  assert.equal(first(res, 3), '{ x: 2 }');
  assert.equal(first(res, 5), '20');
  assert.equal(res.state.lines.get(1), undefined);
});

test('a million console.log calls are throttled and fast', async () => {
  const res = await run('for (let i = 0; i < 1000000; i++) {\n  console.log("row", i);\n}\n');
  assert.equal(res.status, 'done');
  const e = res.state.lines.get(2);
  assert.equal(e.items.length, 100);
  assert.equal(e.count, 1000000);
  assert.equal(res.state.output.length, 2000);
  assert.equal(res.state.outputDropped, 998000);
  assert.ok(res.ms < 4000, `${res.ms} ms`);
});

test('a 5 MB object prints short', async () => {
  const res = await run('const big = Array.from({ length: 100000 }, (_, i) => ({ id: i, name: "item-" + i, tags: ["a", "b"] }));\nJSON.stringify(big).length;\nconst wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ["k" + i, i]));\n');
  assert.equal(res.status, 'done');
  assert.ok(first(res, 1).length <= 2001);
  assert.ok(Number(first(res, 2)) > 4500000);
  assert.match(first(res, 3), /4,950 more keys/);
});

test('endless loop is killed at the time limit', async () => {
  const t = Date.now();
  const res = await run('console.log("before");\nwhile (true) {}\n', 'a.js', { timeoutMs: 1000 });
  assert.equal(res.status, 'timeout');
  assert.ok(Date.now() - t < 4000);
  assert.equal(first(res, 1), 'before');
});

test('process.exit, a throw in a callback, a rejection', async () => {
  let res = await run('const a = 1;\nprocess.exit(3);\nconst b = 2;\n');
  assert.equal(res.status, 'exit');
  assert.deepEqual(res.state.exit, { code: 3, line: 2 });
  assert.equal(res.state.lines.get(3), undefined);
  res = await run('setTimeout(() => {\n  null.x;\n}, 5);\n');
  assert.equal(res.status, 'error');
  assert.equal(res.state.errors[0].line, 2);
  assert.match(res.state.errors[0].message, /TypeError/);
  assert.doesNotMatch(res.state.errors[0].stack, /zovo-jsts-test/); // temp path replaced by the real one
  res = await run('Promise.reject(new Error("nope"));\n');
  assert.equal(res.status, 'error');
  assert.equal(res.state.errors[0].line, 1);
});

test('missing modules point at their import line (ESM and CommonJS)', async () => {
  let res = await run('const a = 1;\nimport x from "no-such-pkg-zovo";\n', 'a.mjs');
  assert.equal(res.status, 'error');
  assert.equal(res.state.errors[0].line, 2);
  res = await run('const a = 1;\nconst x = require("no-such-pkg-zovo");\n');
  assert.equal(res.state.errors[0].line, 2);
});

test('syntax error does not start a process', async () => {
  const res = await run('const = 1;');
  assert.equal(res.status, 'syntax');
  assert.equal(res.error.line, 1);
});

test('imports resolve from the real file folder and node_modules (ESM and require)', async () => {
  const pk = path.join(work, 'node_modules', 'zpkg');
  fs.mkdirSync(pk, { recursive: true });
  fs.writeFileSync(path.join(pk, 'package.json'), JSON.stringify({ name: 'zpkg', exports: { import: './i.mjs', require: './r.cjs' } }));
  fs.writeFileSync(path.join(pk, 'i.mjs'), 'export default "esm";');
  fs.writeFileSync(path.join(pk, 'r.cjs'), 'module.exports = "cjs";');
  fs.writeFileSync(path.join(work, 'helper.js'), 'module.exports = { two: 2 };');
  let res = await run('import z from "zpkg";\nz;\nconst h = require("./helper.js");\n__dirname;\n', 'm.mjs');
  assert.equal(res.status, 'done', JSON.stringify(res.state.errors));
  assert.equal(first(res, 2), "'esm'");
  assert.equal(first(res, 3), '{ two: 2 }');
  assert.equal(first(res, 4), JSON.stringify(work).replace(/"/g, "'"));
  res = await run('const z = require("zpkg");\nrequire("./helper").two;\n__filename;\n', 'c.js');
  assert.equal(first(res, 1), "'cjs'");
  assert.equal(first(res, 2), '2');
  assert.equal(first(res, 3), `'${path.join(work, 'c.js')}'`);
});

test('fetch to a local server, value shows when the promise settles', async () => {
  const srv = http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await run(`const r = await fetch("http://127.0.0.1:${srv.address().port}/");\nawait r.json();\nPromise.resolve(5);\n`, 'f.mjs');
    assert.equal(res.status, 'done', JSON.stringify(res.state.errors));
    assert.equal(first(res, 2), '{ ok: true }');
    assert.equal(first(res, 3), '5');
    assert.equal(res.state.lines.get(3).items[0].resolved, true);
  } finally { srv.close(); }
});

test('cancel kills the run; the temp folder is removed', async () => {
  const h = runner.run({ text: 'while (true) {}', fileName: 'a.js', origPath: path.join(work, 'a.js'), origDir: work, timeoutMs: 30000 });
  setTimeout(() => h.cancel(), 200);
  const res = await h.promise;
  assert.equal(res.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [], []);
});

test('memory limit stops a runaway allocation', async () => {
  const res = await run('const a = [];\nwhile (true) a.push(new Array(1e6).fill(1));\n', 'a.js', { memoryMb: 128, timeoutMs: 20000 });
  assert.ok(['oom', 'crash'].includes(res.status), res.status);
});

test('a large file is parsed in a worker thread: this thread keeps running', async () => {
  const text = Array.from({ length: 20000 }, (_, i) => `const v${i} = ${i} * 2; v${i} + 1;`).join('\n') + '\nv19999;\n';
  assert.ok(text.length > 100 * 1024);
  let ticks = 0;
  let maxGap = 0;
  let last = Date.now();
  const iv = setInterval(() => { ticks++; const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
  const res = await run(text, 'big.js', { timeoutMs: 30000 });
  clearInterval(iv);
  assert.equal(res.status, 'done');
  assert.equal(res.state.lines.get(20001).items[0].text, '39998');
  assert.ok(ticks > 5, `ticks ${ticks}`);
  assert.ok(maxGap < 1000, `this thread was blocked for ${maxGap} ms`);
});

test('cancel while a large file is being parsed', async () => {
  const text = Array.from({ length: 40000 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const h = runner.run({ text, fileName: 'a.js', origPath: path.join(work, 'a.js'), origDir: work, timeoutMs: 30000 });
  setTimeout(() => h.cancel(), 20);
  const res = await h.promise;
  assert.equal(res.status, 'cancelled');
});

// Processes the scratchpad code starts must never outlive its run (VER15-R: they used to stay after the time
// limit, after an edit and after a normal end; a grandchild holding stdout kept the run open forever).
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const pidsIn = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\s+/).map(Number).filter(Boolean) : []);
const kidCode = (pf) => `const cp = require('child_process');\nconst fs = require('fs');\nconst c = cp.spawn(process.execPath, ['-e', ${JSON.stringify("const cp=require('child_process');const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').appendFileSync(process.argv[1],process.pid+' '+g.pid+' ');setInterval(()=>{},1000)")}, ${JSON.stringify(pf)}], { stdio: 'ignore' });\n`;
const settle = () => new Promise((r) => setTimeout(r, 700));
const cleanup = (p) => p.forEach((x) => { try { process.kill(x, 'SIGKILL'); } catch (_) { /* gone */ } });

test('the time limit ends the run with its child and grandchild', { skip: process.platform === 'win32' }, async () => {
  const pf = path.join(work, 'pids-timeout');
  const res = await run(kidCode(pf) + 'setInterval(() => {}, 1000);\n', 'k1.js', { timeoutMs: 1500 });
  await settle();
  const p = pidsIn(pf);
  cleanup(p);
  assert.equal(res.status, 'timeout');
  assert.equal(p.length, 2, String(p));
  assert.deepEqual(p.filter(alive), []);
});

test('a child still running when the script ends is ended with the run', { skip: process.platform === 'win32' }, async () => {
  const pf = path.join(work, 'pids-exit');
  const res = await run(kidCode(pf) + 'c.unref();\nawait new Promise((r) => setTimeout(r, 400));\n"done";\n', 'k2.mjs');
  await settle();
  const p = pidsIn(pf);
  cleanup(p);
  assert.equal(res.status, 'done', JSON.stringify(res.state.errors));
  assert.ok(p.length === 2, String(p));
  assert.deepEqual(p.filter(alive), []);
});

test('a grandchild that holds stdout does not keep the run open', { skip: process.platform === 'win32' }, async () => {
  const pf = path.join(work, 'pids-inherit');
  const t = Date.now();
  const res = await run(`const cp = require('child_process');\nconst g = cp.spawn('/bin/sleep', ['60'], { stdio: 'inherit' });\nrequire('fs').writeFileSync(${JSON.stringify(pf)}, String(g.pid));\ng.unref();\n1 + 1;\n`, 'k3.js', { timeoutMs: 20000 });
  await settle();
  const p = pidsIn(pf);
  cleanup(p);
  assert.ok(Date.now() - t < 6000, `${Date.now() - t} ms`);
  assert.equal(res.status, 'done');
  assert.deepEqual(p.filter(alive), []);
});

test('cancel (a new edit) ends the run with its children', { skip: process.platform === 'win32' }, async () => {
  const pf = path.join(work, 'pids-cancel');
  const h = runner.run({ text: kidCode(pf) + 'setInterval(() => {}, 1000);\n', fileName: 'k4.js', origPath: path.join(work, 'k4.js'), origDir: work, timeoutMs: 30000 });
  for (let i = 0; i < 50 && pidsIn(pf).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  h.cancel();
  const res = await h.promise;
  await settle();
  const p = pidsIn(pf);
  cleanup(p);
  assert.equal(res.status, 'cancelled');
  assert.equal(p.length, 2, String(p));
  assert.deepEqual(p.filter(alive), []);
});
