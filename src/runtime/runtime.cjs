'use strict';
// Loaded with --require into the child process that runs the user's code (never into the extension host).
// It defines the hooks the instrumented code calls (__zv value, __zc console, __zr line ran), catches errors,
// and writes one JSON line per event to a file the extension reads. Throttled: at most maxPerLine values per
// line are kept; after that only a count, so a loop of a million logs costs a counter, not a million messages.
const fs = require('fs');
const util = require('util');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');

const CFG = JSON.parse(process.env.ZOVO_JSTS_CFG || '{}');
delete process.env.ZOVO_JSTS_CFG;
const MAX_PER_LINE = CFG.maxPerLine || 100;
const VALUE_CHARS = CFG.valueChars || 2000;
const OUT_LINES = CFG.outLines || 2000;
const OUT_BYTES = CFG.outBytes || 1000000;
const TMP = CFG.tmpFile || '';
const TMP_URL = TMP ? pathToFileURL(TMP).href : '';
const t0 = Date.now();

let fd = -1;
try { fd = fs.openSync(CFG.events, 'a'); } catch (_) { /* no events file: values are lost, the code still runs */ }
function emit(o) {
  if (fd < 0) return;
  try { fs.writeSync(fd, JSON.stringify(o) + '\n'); } catch (_) { /* disk full or closed */ }
}

// ---- formatting -------------------------------------------------------------------------------------------
const INSPECT = { depth: 2, colors: false, breakLength: Infinity, compact: 3, maxArrayLength: 50, maxStringLength: 1000, getters: false };
function shrink(v) {
  try {
    if (v && typeof v === 'object' && !Array.isArray(v) && !util.types.isProxy(v) && Object.getPrototypeOf(v) === Object.prototype) {
      const keys = Object.keys(v);
      if (keys.length > 200) {
        const o = {};
        for (const k of keys.slice(0, 50)) o[k] = v[k];
        o['…'] = `${(keys.length - 50).toLocaleString('en-US')} more keys`;
        return o;
      }
    }
  } catch (_) { /* keep v */ }
  return v;
}
function cut(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function fmt(v) {
  try { return cut(util.inspect(shrink(v), INSPECT), VALUE_CHARS); } catch (e) { return `[value could not be shown: ${e && e.message}]`; }
}
function fmtArgs(args, opts) {
  try {
    return util.formatWithOptions(opts, ...args.map(shrink));
  } catch (e) { return `[could not format: ${e && e.message}]`; }
}

// ---- per-line throttle --------------------------------------------------------------------------------------
const counts = new Map();
const dirty = new Set();
function bump(line) {
  const c = (counts.get(line) || 0) + 1;
  counts.set(line, c);
  if (c > MAX_PER_LINE) {
    dirty.add(line);
    if (c === 1000 || c === 10000 || c % 100000 === 0) flushCounts(); // a loop that never yields still reports progress
  }
  return c;
}
function flushCounts() {
  for (const l of dirty) emit({ t: 'n', l, c: counts.get(l) });
  dirty.clear();
}

function record(line, v, name, kind) {
  const c = bump(line);
  if (c <= MAX_PER_LINE) emit({ t: 'v', l: line, s: fmt(v), n: name || undefined, k: kind || undefined });
}

const SKIP_CTOR = new Set(['Timeout', 'Immediate']);
globalThis.__zv = function __zv(line, v, name, quiet) {
  if (quiet && v === undefined) return v;
  if (quiet && v && typeof v === 'object' && v.constructor && SKIP_CTOR.has(v.constructor.name)) return v;
  if (util.types.isPromise(v)) {
    v.then((r) => record(line, r, name, 'resolved'), (e) => {
      // the user's code did not handle this rejection on this line: show it there, as Node would print it
      emitError(e, line, 'rejected');
    });
    return v;
  }
  record(line, v, name);
  return v;
};

const covered = new Set();
let covDirty = false;
globalThis.__zr = function __zr(line) { if (!covered.has(line)) { covered.add(line); covDirty = true; } };

// ---- console ---------------------------------------------------------------------------------------------------
let outLines = 0;
let outBytes = 0;
let outDropped = 0;
function consoleCall(line, method, args) {
  const c = line ? bump(line) : 0;
  const inline = line && c <= MAX_PER_LINE;
  const panel = outLines < OUT_LINES && outBytes < OUT_BYTES;
  if (!inline && !panel) { outDropped++; return; }
  let text;
  if (method === 'dir') text = fmt(args[0]);
  else if (method === 'table') text = fmtArgs(args, { depth: 3, colors: false });
  else text = fmtArgs(args, { depth: 2, colors: false, maxArrayLength: 100 });
  if (method === 'trace') text = 'Trace: ' + text + '\n' + cleanStack(new Error().stack).split('\n').slice(2).join('\n');
  const ev = { t: 'c', l: line || 0, k: method, s: cut(text, panel ? 20000 : VALUE_CHARS) };
  if (inline) ev.i = 1;
  if (panel) { ev.p = 1; outLines += 1 + (text.match(/\n/g) || []).length; outBytes += text.length; } else outDropped++;
  emit(ev);
}
globalThis.__zc = function __zc(line, method) { return (...args) => consoleCall(line, method, args); };
for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) {
  // calls that were not rewritten (a library, `const log = console.log`) find their line from the stack
  console[m] = (...args) => consoleCall(lineFromStack(new Error().stack), m, args);
}

// ---- errors ----------------------------------------------------------------------------------------------------
Error.stackTraceLimit = Math.max(Error.stackTraceLimit || 10, 30);
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const FRAME_RES = TMP ? [new RegExp(escapeRe(TMP) + ':(\\d+):(\\d+)'), new RegExp(escapeRe(TMP_URL) + ':(\\d+):(\\d+)')] : [];
function lineFromStack(stack) {
  const s = String(stack || '');
  let best = 0;
  let at = Infinity;
  for (const re of FRAME_RES) {
    const m = re.exec(s);
    if (m && m.index < at) { at = m.index; best = Number(m[1]); }
  }
  return best;
}
function cleanStack(stack) {
  let s = String(stack || '');
  if (TMP && CFG.origFile) s = s.split(TMP_URL).join(pathToFileURL(CFG.origFile).href).split(TMP).join(CFG.origFile);
  // drop frames from this runtime file
  return s.split('\n').filter((l) => !l.includes('runtime.cjs')).join('\n');
}
let errorsShown = 0;
function emitError(e, fallbackLine, kind) {
  if (errorsShown++ > 50) return;
  let msg;
  let stack = '';
  if (e instanceof Error || (e && typeof e === 'object' && 'message' in e && 'stack' in e)) {
    msg = `${e.name || 'Error'}: ${e.message}`;
    stack = String(e.stack || '');
    if (e.code && /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/.test(e.code)) msg = String(e.message).split('\n')[0];
  } else {
    msg = `Uncaught ${fmt(e)}`;
  }
  const line = lineFromStack(stack) || fallbackLine || 0;
  emit({ t: 'e', l: line, m: cut(msg, 2000), st: cut(cleanStack(stack), 20000), k: kind || undefined, code: e && e.code || undefined });
}
const realExit = process.exit.bind(process);
process.on('uncaughtException', (e) => { emitError(e, 0); realExit(1); });
process.on('unhandledRejection', (e) => { emitError(e, 0, 'rejected'); realExit(1); });
process.exit = function exit(code) {
  emit({ t: 'x', c: code === undefined ? (process.exitCode || 0) : code, l: lineFromStack(new Error().stack) });
  return realExit(code);
};

function flushAll() {
  flushCounts();
  if (covDirty) { emit({ t: 'r', l: [...covered] }); covDirty = false; }
}
setInterval(flushAll, 200).unref();
process.on('exit', (code) => {
  flushAll();
  if (outDropped) emit({ t: 'od', c: outDropped });
  emit({ t: 'd', code, ms: Date.now() - t0 });
});

// ---- module resolution: the instrumented copy lives in a temp folder, imports resolve from the real file ------
const wsModules = (CFG.wsDirs || []).map((d) => path.join(d, 'node_modules'));
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (parent && TMP && parent.filename === TMP && !isMain && CFG.origFile) {
    const fake = new Module(CFG.origFile, null);
    fake.filename = CFG.origFile;
    fake.paths = Module._nodeModulePaths(CFG.origDir).concat(wsModules);
    return origResolve.call(this, request, fake, isMain, options);
  }
  return origResolve.call(this, request, parent, isMain, options);
};
if (CFG.loader && typeof Module.register === 'function' && CFG.origFile) {
  try {
    Module.register(pathToFileURL(CFG.loader).href, {
      data: {
        tmpUrl: TMP_URL,
        origUrl: pathToFileURL(CFG.origFile).href,
        wsUrls: (CFG.wsDirs || []).map((d) => pathToFileURL(path.join(d, '__zovo__.mjs')).href),
      },
    });
  } catch (e) { emit({ t: 'w', m: `ESM imports resolve from the temp folder: ${e.message}` }); }
} else if (CFG.loader && typeof Module.register !== 'function') {
  emit({ t: 'w', m: `This Node ${process.version} has no module.register, so ESM imports of packages may not resolve. Node 20.6 or newer fixes it.` });
}
emit({ t: 's', node: process.version, pid: process.pid });
