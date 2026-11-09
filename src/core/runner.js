'use strict';
// Runs one instrumented copy of a file in a fresh child process and collects what it reports.
// No VS Code here: test/runner.test.js drives it with plain Node.
// The extension host never waits on the child: everything is async, the child is killed at the time limit,
// and a new run of the same file kills the old one first.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

/**
 * Kills a run and every process it started. On macOS and Linux the run is the leader of its own process group
 * (spawned with detached), so one signal to -pid reaches its children and grandchildren too.
 * On Windows taskkill /T walks the tree.
 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (_) { /* gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* group gone */ }
  }
  try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
}
const { instrument, missingModuleLine } = require('./instrument');

const STD_CAP = 256 * 1024;
const WORKER_BYTES = 100 * 1024; // above this, parsing happens in a worker thread

function newState() {
  return {
    lines: new Map(), // line -> { items: [{kind:'value'|'log'|'error', text, name, method}], count }
    errors: [], // {line, message, stack}
    output: [], // panel lines: {line, method, text}
    outputDropped: 0,
    covered: new Set(),
    warnings: [],
    exit: null, // {code, line} when process.exit was called
    done: null, // {code, ms} when the process ended by itself
    node: '',
  };
}

function lineEntry(st, line) {
  let e = st.lines.get(line);
  if (!e) { e = { items: [], count: 0 }; st.lines.set(line, e); }
  return e;
}

/** Apply one event line from runtime.cjs to the state. */
function applyEvent(st, ev, imports) {
  switch (ev.t) {
    case 'v': {
      const e = lineEntry(st, ev.l);
      e.items.push({ kind: 'value', text: ev.s, name: ev.n, resolved: ev.k === 'resolved' });
      e.count = Math.max(e.count + 1, e.items.length);
      break;
    }
    case 'c': {
      if (ev.i && ev.l) {
        const e = lineEntry(st, ev.l);
        e.items.push({ kind: 'log', text: ev.s, method: ev.k });
        e.count = Math.max(e.count + 1, e.items.length);
      } else if (ev.l) {
        const e = lineEntry(st, ev.l);
        e.count += 1;
      }
      if (ev.p) st.output.push({ line: ev.l, method: ev.k, text: ev.s });
      break;
    }
    case 'n': lineEntry(st, ev.l).count = Math.max(lineEntry(st, ev.l).count, ev.c); break;
    case 'e': {
      let line = ev.l || 0;
      if (!line && imports) line = missingModuleLine(ev.m, imports);
      const err = { line, message: ev.m, stack: ev.st || '', rejected: ev.k === 'rejected', code: ev.code };
      st.errors.push(err);
      if (line) lineEntry(st, line).items.push({ kind: 'error', text: ev.m });
      break;
    }
    case 'r': for (const l of ev.l) st.covered.add(l); break;
    case 'x': st.exit = { code: ev.c, line: ev.l }; break;
    case 'd': st.done = { code: ev.code, ms: ev.ms }; break;
    case 'od': st.outputDropped += ev.c; break;
    case 'w': st.warnings.push(ev.m); break;
    case 's': st.node = ev.node; break;
    default: break;
  }
}

class Runner {
  /**
   * @param {object} o { tmpRoot, runtimePath, loaderPath }
   */
  constructor(o) {
    this.tmpRoot = o.tmpRoot;
    this.runtimePath = o.runtimePath;
    this.loaderPath = o.loaderPath;
    this.workerPath = o.workerPath || '';
    this.seq = 0;
    this.active = new Set();
  }

  /**
   * @param {object} job { text, fileName, origPath, origDir, wsDirs, typescript, execPath, electron (bool),
   *   timeoutMs, memoryMb, coverage, maxPerLine, onUpdate(state), cwd }
   * @returns {{ promise: Promise<object>, cancel: () => void }}
   */
  /** Instrument on this thread for small files, in a worker thread above WORKER_BYTES. */
  instrumentAsync(job, onWorker) {
    const opts = {
      fileName: job.fileName,
      typescript: job.typescript,
      origPath: job.origPath,
      origDir: job.origDir,
      origUrl: job.origPath ? require('url').pathToFileURL(job.origPath).href : '',
      coverage: !!job.coverage,
      moduleType: job.moduleType,
    };
    if (!this.workerPath || job.text.length < WORKER_BYTES) return Promise.resolve(instrument(job.text, opts));
    return new Promise((resolve) => {
      const { Worker } = require('worker_threads');
      let w;
      try { w = new Worker(this.workerPath); } catch (e) { resolve(instrument(job.text, opts)); return; }
      onWorker(w);
      let done = false;
      const end = (r) => { if (!done) { done = true; w.terminate().catch(() => {}); resolve(r); } };
      w.once('message', end);
      w.once('error', (e) => end({ ok: false, error: { line: 1, column: 0, message: `Could not prepare the file: ${e && e.message}` } }));
      w.once('exit', () => end({ ok: false, cancelled: true, error: { line: 1, column: 0, message: 'stopped' } }));
      w.postMessage({ text: job.text, opts });
    });
  }

  /**
   * @param {object} job { text, fileName, origPath, origDir, wsDirs, typescript, execPath, electron (bool),
   *   timeoutMs, memoryMb, coverage, maxPerLine, onUpdate(state), cwd }
   * @returns {{ promise: Promise<object>, cancel: () => void }}
   */
  run(job) {
    let cancelled = false;
    let worker = null;
    let inner = null;
    const started = Date.now();
    const promise = this.instrumentAsync(job, (w) => { worker = w; }).then((ins) => {
      worker = null;
      if (cancelled || ins.cancelled) return { status: 'cancelled', ms: Date.now() - started };
      if (!ins.ok) return { status: 'syntax', error: ins.error, ms: Date.now() - started };
      inner = this.spawnRun(job, ins, started);
      return inner.promise;
    });
    return { promise, cancel: () => { cancelled = true; if (worker) worker.terminate().catch(() => {}); if (inner) inner.cancel(); } };
  }

  spawnRun(job, ins, started) {
    let cancelFn = () => {};
    const promise = new Promise((resolve) => {
      const id = ++this.seq;
      fs.mkdirSync(this.tmpRoot, { recursive: true });
      // the real path: on macOS the temp folder is behind a symlink (/var -> /private/var), and Node reports
      // the real path in stacks and module URLs
      const dir = path.join(fs.realpathSync.native(this.tmpRoot), `r${process.pid}-${id}`);
      fs.mkdirSync(dir, { recursive: true });
      const base = (path.basename(job.fileName || 'scratch').replace(/\.(m|c)?(j|t)s$/i, '') || 'scratch').replace(/[^\w.-]/g, '_');
      const tmpFile = path.join(dir, `${base}.${ins.moduleType === 'esm' ? 'mjs' : 'cjs'}`);
      const events = path.join(dir, 'events.ndjson');
      fs.writeFileSync(tmpFile, ins.code);
      fs.writeFileSync(events, '');

      const cfg = {
        events, tmpFile, origFile: job.origPath || '', origDir: job.origDir || '', wsDirs: job.wsDirs || [],
        loader: ins.moduleType === 'esm' ? this.loaderPath : '', maxPerLine: job.maxPerLine || 100,
      };
      const env = { ...process.env, ZOVO_JSTS_CFG: JSON.stringify(cfg) };
      if (job.electron) env.ELECTRON_RUN_AS_NODE = '1';
      const args = [`--max-old-space-size=${Math.max(64, job.memoryMb || 1024)}`, '--require', this.runtimePath, tmpFile];

      const st = newState();
      st.moduleType = ins.moduleType;
      st.statements = ins.statements;
      let stdout = '';
      let stderr = '';
      let offset = 0;
      let partial = '';
      let reason = '';
      let finished = false;
      let child;

      const readEvents = () => {
        let fd;
        try {
          fd = fs.openSync(events, 'r');
          const size = fs.fstatSync(fd).size;
          if (size > offset) {
            // read in chunks so a big burst never makes one huge buffer
            const CH = 1 << 20;
            while (offset < size) {
              const n = Math.min(CH, size - offset);
              const buf = Buffer.alloc(n);
              fs.readSync(fd, buf, 0, n, offset);
              offset += n;
              const text = partial + buf.toString('utf8');
              const parts = text.split('\n');
              partial = parts.pop();
              for (const p of parts) {
                if (!p) continue;
                try { applyEvent(st, JSON.parse(p), ins.imports); } catch (_) { /* half-written line */ }
              }
            }
          }
        } catch (_) { /* file gone */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
      };

      let lastUpdate = 0;
      const poll = setInterval(() => {
        readEvents();
        const now = Date.now();
        if (job.onUpdate && now - lastUpdate >= 150) { lastUpdate = now; try { job.onUpdate(st); } catch (_) { /* ui */ } }
      }, 100);

      const finish = (code, signal) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timer);
        this.active.delete(handle);
        readEvents();
        let status = 'done';
        if (reason === 'timeout') status = 'timeout';
        else if (reason === 'cancel') status = 'cancelled';
        else if (/heap out of memory|Reached heap limit/i.test(stderr)) status = 'oom';
        else if (st.errors.length) status = 'error';
        else if (!st.done && !st.exit && (signal || code)) status = 'crash';
        else if (st.exit && st.exit.code) status = 'exit';
        fs.rm(dir, { recursive: true, force: true }, () => {});
        resolve({
          status, state: st, ms: Date.now() - started, exitCode: code, signal, stdout, stderr,
          moduleType: ins.moduleType, imports: ins.imports, timeoutMs: job.timeoutMs,
        });
      };

      try {
        child = spawn(job.execPath || process.execPath, args, {
          cwd: job.cwd || job.origDir || this.tmpRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          detached: process.platform !== 'win32', // own process group: the time limit, a new edit and Stop end its children too
        });
      } catch (e) {
        clearInterval(poll);
        fs.rm(dir, { recursive: true, force: true }, () => {});
        resolve({ status: 'spawn', message: e.message, ms: Date.now() - started });
        return;
      }
      const handle = { kill: (why) => { reason = reason || why; killTree(child); } };
      this.active.add(handle);
      cancelFn = () => handle.kill('cancel');
      const timer = setTimeout(() => handle.kill('timeout'), Math.max(200, job.timeoutMs || 5000));
      child.stdout.on('data', (d) => { if (stdout.length < STD_CAP) stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (stderr.length < STD_CAP) stderr += d.toString('utf8'); });
      child.on('error', (e) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timer);
        this.active.delete(handle);
        fs.rm(dir, { recursive: true, force: true }, () => {});
        resolve({ status: 'spawn', message: e.message, ms: Date.now() - started });
      });
      // When the script itself ends, nothing it started may outlive the run: end its process group. A child that
      // escaped the group (its own setsid) and still holds stdout must not keep the run open either.
      child.on('exit', (code, signal) => {
        if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* group gone */ } }
        setTimeout(() => {
          if (finished) return;
          try { child.stdout.destroy(); child.stderr.destroy(); } catch (_) { /* closed */ }
          finish(code, signal);
        }, 1500);
      });
      child.on('close', finish);
    });
    return { promise, cancel: () => cancelFn() };
  }

  killAll() { for (const h of [...this.active]) h.kill('cancel'); }
}

module.exports = { killTree, Runner, applyEvent, newState };
