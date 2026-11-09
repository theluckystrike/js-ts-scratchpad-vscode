'use strict';
// JavaScript Playground & TypeScript Scratchpad: inline values for .js, .mjs, .cjs, .ts, .mts and .cts files.
// Each run is a fresh child process (VS Code's own runtime or the user's node), with a time limit and a memory
// limit. The extension makes no network call, shows no popup on its own and never opens a page by itself.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Runner } = require('./core/runner');
const render = require('./core/render');
const samples = require('./samples');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createPro } = require('./pro');

const PREFIX = 'jsScratchpad';
const EXT_ID = 'zovo.zovo-js-ts-scratchpad';
const LANGS = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
const EXT_RE = /\.(js|mjs|cjs|ts|mts|cts)$/i;
const LARGE_AUTO_BYTES = 512 * 1024;

let rating = { success() {}, failure() {} };
let pro = { gate: async () => ({ ok: true, note: '' }) };
let runner;
let tmpRoot;
let output;
let statusItem;
let types;
const sessions = new Map(); // uri string -> Session

const cfg = () => vscode.workspace.getConfiguration(PREFIX);

function isRunnable(doc) {
  if (!doc) return false;
  if (doc.uri.scheme === 'untitled') return LANGS.has(doc.languageId);
  if (doc.uri.scheme !== 'file') return false;
  return EXT_RE.test(doc.uri.fsPath) || (LANGS.has(doc.languageId) && !/\.(jsx|tsx)$/i.test(doc.uri.fsPath));
}
function isTs(doc) { return /typescript/.test(doc.languageId) || /\.(ts|mts|cts)$/i.test(doc.uri.fsPath || ''); }

function makeTypes() {
  const after = (color, extra = {}) => ({ after: { margin: '0 0 0 2.5em', color: new vscode.ThemeColor(color), ...extra } });
  return {
    value: vscode.window.createTextEditorDecorationType({ ...after('editorCodeLens.foreground', { fontStyle: 'italic' }), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
    log: vscode.window.createTextEditorDecorationType({ ...after('editorInfo.foreground'), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
    error: vscode.window.createTextEditorDecorationType({
      ...after('errorForeground'), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.errorForeground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    ran: vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.addedBackground') }),
    notRan: vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.deletedBackground') }),
  };
}

class Session {
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.key = doc.uri.toString();
    this.sample = !!opts.sample;
    this.sampleText = opts.sampleText || '';
    this.coverage = false;
    this.handle = null;
    this.timer = null;
    this.result = null; // last finished run
    this.live = null; // state while running
    this.syntax = null;
    this.note = null; // {line, text} shown instead of values (restricted mode, large file)
    this.running = false;
  }

  dispose() {
    clearTimeout(this.timer);
    if (this.handle) this.handle.cancel();
    this.handle = null;
    this.result = null;
    this.live = null;
    this.syntax = null;
    this.note = null;
    this.paint();
  }

  schedule(reason, editLine) {
    clearTimeout(this.timer);
    if (this.handle) { this.handle.cancel(); this.handle = null; } // a new edit kills the old run at once
    const runOn = cfg().get('runOn', 'change');
    if (reason === 'change' && runOn !== 'change') return;
    if (reason === 'change' && Buffer.byteLength(this.doc.getText(), 'utf8') > LARGE_AUTO_BYTES) {
      this.note = { line: editLine || 1, text: 'Large file: values update when you save (or run "Run Now").', kind: 'value' };
      this.paint();
      updateStatus();
      return;
    }
    const delay = reason === 'change' ? Math.max(0, Number(cfg().get('debounceMs', 300)) || 0) : 0;
    this.timer = setTimeout(() => { this.run().catch((e) => log(`internal error: ${e && e.stack || e}`)); }, delay);
  }

  async run() {
    const doc = this.doc;
    if (doc.isClosed) { stopSession(this.key); return; }
    if (!vscode.workspace.isTrusted) {
      this.note = { line: 1, text: 'Restricted Mode: code is not run in a folder you have not trusted. Trust the folder to see values.', kind: 'error' };
      this.result = null;
      this.paint();
      updateStatus();
      return;
    }
    this.note = null;
    const c = cfg();
    const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : '';
    const ws = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const ts = isTs(doc);
    const baseDir = file ? path.dirname(file) : (ws[0] || os.homedir());
    const origPath = file || path.join(baseDir, ts ? 'scratch.ts' : 'scratch.js');
    let execPath = process.execPath;
    let electron = true;
    if (c.get('runtime', 'vscode') === 'node') {
      execPath = String(c.get('nodePath', '') || '').trim() || 'node';
      electron = false;
    }
    const job = {
      text: doc.getText(),
      fileName: path.basename(origPath),
      typescript: ts,
      origPath,
      origDir: path.dirname(origPath),
      wsDirs: ws,
      execPath,
      electron,
      timeoutMs: Math.max(0.2, Number(c.get('timeoutSeconds', 5)) || 5) * 1000,
      memoryMb: Math.max(64, Number(c.get('memoryLimitMB', 1024)) || 1024),
      coverage: this.coverage,
      maxPerLine: Math.min(10000, Math.max(1, Number(c.get('maxValuesPerLine', 100)) || 100)),
      moduleType: c.get('moduleType', 'auto'),
      onUpdate: (st) => { if (this.handle === h) { this.live = st; this.paint(); } },
    };
    if (this.handle) this.handle.cancel();
    const version = doc.version;
    const h = runner.run(job);
    this.handle = h;
    this.running = true;
    updateStatus();
    let res = await h.promise;
    if (res.status === 'spawn' && !electron) {
      log(`Could not start "${execPath}" (${res.message}). Using the VS Code runtime instead. Set jsScratchpad.nodePath to the full path of node.`);
      const h2 = runner.run({ ...job, execPath: process.execPath, electron: true });
      this.handle = h2;
      res = await h2.promise;
      if (this.handle !== h2) return;
    } else if (this.handle !== h) return; // a newer run took over
    this.handle = null;
    this.running = false;
    this.live = null;
    if (res.status === 'cancelled') { updateStatus(); return; }
    if (res.status === 'syntax') {
      this.syntax = res.error; // keep the last values on the other lines while the user is typing
    } else {
      this.syntax = null;
      this.result = res;
      this.resultVersion = version;
    }
    this.lastStatus = res;
    this.paint();
    updateStatus();
    const label = doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri) : doc.uri.path;
    output.clear();
    output.appendLine(render.outputText(res, label, job.timeoutMs));
    if (res.status === 'spawn') rating.failure();
    else if (res.status === 'done') { // a run that threw, timed out, crashed or exited non-zero never leads to a rating ask
      const isSample = this.sample && doc.getText() === this.sampleText;
      rating.success(isSample ? { sample: true } : doc.uri);
    }
  }

  entries() {
    const merged = new Map();
    const st = this.live || (this.result && this.result.state);
    if (st) for (const [l, e] of st.lines) merged.set(l, e);
    if (this.result && this.result.status === 'timeout' && !this.live) {
      const lines = [...merged.keys()];
      const at = lines.length ? Math.max(...lines) : 1;
      const secs = render.nf((this.result.timeoutMs || 5000) / 1000);
      const e = merged.get(at) || { items: [], count: 0 };
      merged.set(at, { items: [...e.items, { kind: 'error', text: `Stopped after ${secs} s: still running (endless loop, server or timer). Setting: jsScratchpad.timeoutSeconds` }], count: e.count });
    }
    if (this.result && this.result.status === 'oom' && !this.live) {
      merged.set(1, { items: [{ kind: 'error', text: 'Stopped: memory limit reached (setting jsScratchpad.memoryLimitMB)' }], count: 0 });
    }
    if (this.result && this.result.state && this.result.state.exit && this.result.state.exit.line && !this.live) {
      const x = this.result.state.exit;
      const e = merged.get(x.line) || { items: [], count: 0 };
      merged.set(x.line, { items: [...e.items, { kind: x.code ? 'error' : 'log', text: `process.exit(${x.code}) ended the run here` }], count: e.count });
    }
    if (this.syntax) merged.set(this.syntax.line, { items: [{ kind: 'error', text: this.syntax.message }], count: 0 });
    if (this.note) merged.set(this.note.line, { items: [{ kind: this.note.kind || 'value', text: this.note.text }], count: 0 });
    return merged;
  }

  paint() {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === this.key);
    if (!editors.length) return;
    const maxLen = Math.max(20, Number(cfg().get('inlineMaxLength', 120)) || 120);
    const byKind = { value: [], log: [], error: [] };
    const doc = this.doc;
    const entries = this.entries();
    for (const [line, entry] of entries) {
      if (line < 1 || line > doc.lineCount) continue;
      const t = render.lineText(entry, maxLen);
      if (!t) continue;
      const end = doc.lineAt(line - 1).range.end;
      const hover = new vscode.MarkdownString(render.hoverText(entry, line));
      hover.isTrusted = false;
      byKind[t.kind].push({ range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: t.text } } });
    }
    const ran = [];
    const notRan = [];
    const st = this.result && this.result.state;
    if (this.coverage && st && !this.live) {
      for (const l of st.statements || []) {
        if (l < 1 || l > doc.lineCount) continue;
        (st.covered.has(l) ? ran : notRan).push(doc.lineAt(l - 1).range);
      }
    }
    for (const ed of editors) {
      ed.setDecorations(types.value, byKind.value);
      ed.setDecorations(types.log, byKind.log);
      ed.setDecorations(types.error, byKind.error);
      ed.setDecorations(types.ran, ran);
      ed.setDecorations(types.notRan, notRan);
    }
  }
}

function log(s) { if (output) output.appendLine(s); }

function startSession(doc, opts = {}) {
  let s = sessions.get(doc.uri.toString());
  if (!s) {
    s = new Session(doc, opts);
    sessions.set(s.key, s);
  }
  vscode.commands.executeCommand('setContext', 'jsScratchpad.activeHasValues', true);
  s.schedule('start');
  updateStatus();
  return s;
}

function stopSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  s.dispose();
  sessions.delete(key);
  updateStatus();
}

function activeSession() {
  const ed = vscode.window.activeTextEditor;
  return ed ? sessions.get(ed.document.uri.toString()) : undefined;
}

function updateStatus() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isRunnable(ed.document)) {
    statusItem.hide();
    vscode.commands.executeCommand('setContext', 'jsScratchpad.activeHasValues', false);
    return;
  }
  const s = sessions.get(ed.document.uri.toString());
  vscode.commands.executeCommand('setContext', 'jsScratchpad.activeHasValues', !!s);
  statusItem.backgroundColor = undefined;
  if (!s) {
    statusItem.text = '$(play) Inline Values';
    statusItem.tooltip = 'Start Inline Values: run this file and show each value at the end of its line';
    statusItem.command = `${PREFIX}.start`;
  } else if (!vscode.workspace.isTrusted) {
    statusItem.text = '$(shield) Restricted Mode';
    statusItem.tooltip = 'Code is not run in a folder you have not trusted.';
    statusItem.command = 'workbench.trust.manage';
  } else if (s.running) {
    statusItem.text = '$(sync~spin) Running…';
    statusItem.tooltip = 'Running in a separate process. Click to show the output.';
    statusItem.command = `${PREFIX}.showOutput`;
  } else if (s.note) {
    statusItem.text = '$(info) Runs on save';
    statusItem.tooltip = s.note.text;
    statusItem.command = `${PREFIX}.runNow`;
  } else if (s.lastStatus) {
    const t = render.statusText(s.lastStatus, s.lastStatus.timeoutMs);
    statusItem.text = t.text;
    statusItem.tooltip = 'Inline values are on. Click to show the console output and errors.';
    statusItem.command = `${PREFIX}.showOutput`;
    if (t.warn) statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusItem.text = '$(sync~spin) Starting…';
    statusItem.command = `${PREFIX}.showOutput`;
  }
  statusItem.show();
}

async function newScratchpad(kind) {
  const ts = kind === 'ts';
  const text = ts ? samples.TS : samples.JS;
  const folderSetting = String(cfg().get('scratchFolder', '') || '').trim();
  let doc;
  if (folderSetting) {
    const ws = (vscode.workspace.workspaceFolders || [])[0];
    let dir = folderSetting.replace(/^~(?=$|[\\/])/, os.homedir());
    if (ws) dir = dir.replace(/\$\{workspaceFolder\}/g, ws.uri.fsPath);
    if (!path.isAbsolute(dir)) dir = ws ? path.join(ws.uri.fsPath, dir) : path.join(os.homedir(), dir);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(dir, `scratch-${stamp}.${ts ? 'ts' : 'mjs'}`);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file, text, { flag: 'wx' });
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    } catch (e) {
      vscode.window.showErrorMessage(`Could not create a scratchpad in ${dir}: ${e.message}`);
      return;
    }
  } else {
    doc = await vscode.workspace.openTextDocument({ language: ts ? 'typescript' : 'javascript', content: text });
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  startSession(doc, { sample: true, sampleText: text });
}

async function withLine(fn) {
  const ed = vscode.window.activeTextEditor;
  const s = activeSession();
  if (!ed || !s) { vscode.window.setStatusBarMessage('Start Inline Values first (status bar: Inline Values).', 4000); return; }
  await fn(ed, s);
}

function registerCommands(context) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${id}`, fn));
  reg('newJavaScript', () => newScratchpad('js'));
  reg('newTypeScript', () => newScratchpad('ts'));
  reg('start', async (uri) => {
    let doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    if (uri instanceof vscode.Uri) doc = await vscode.workspace.openTextDocument(uri);
    if (!doc || !isRunnable(doc)) {
      vscode.window.setStatusBarMessage('Open a .js, .mjs, .cjs, .ts, .mts or .cts file first.', 5000);
      return;
    }
    if (!vscode.window.visibleTextEditors.some((e) => e.document === doc)) await vscode.window.showTextDocument(doc);
    startSession(doc);
  });
  reg('stop', () => { const s = activeSession(); if (s) stopSession(s.key); });
  reg('toggle', () => {
    const s = activeSession();
    if (s) stopSession(s.key); else vscode.commands.executeCommand(`${PREFIX}.start`);
  });
  reg('runNow', () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isRunnable(ed.document)) return;
    const s = sessions.get(ed.document.uri.toString()) || startSession(ed.document);
    s.note = null;
    s.schedule('now');
  });
  reg('clearValues', () => { const s = activeSession(); if (s) { s.result = null; s.syntax = null; s.note = null; s.paint(); } });
  reg('showOutput', () => output.show(true));
  reg('openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#jsScratchpad.start`, false));
  reg('valueHistory', () => withLine(async (ed, s) => {
    const g = await pro.gate('history');
    if (!g.ok) return;
    const line = ed.selection.active.line + 1;
    const st = s.result && s.result.state;
    const e = st && st.lines.get(line);
    if (!e || !e.items.length) { vscode.window.setStatusBarMessage(`Line ${line} has no values yet.`, 4000); return; }
    const items = e.items.map((it, i) => ({ label: `#${i + 1}`, description: render.itemText(it).slice(0, 200), detail: it.kind === 'error' ? 'error' : it.kind === 'log' ? `console.${it.method || 'log'}` : undefined, it }));
    const more = e.count > e.items.length ? ` ${render.nf(e.count - e.items.length)} more ran and were only counted.` : '';
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Line ${line}: ${render.nf(e.count)} results.${more} Pick one to copy it.${g.note ? ' ' + g.note : ''}`, matchOnDescription: true });
    if (pick) { await vscode.env.clipboard.writeText(pick.it.text); vscode.window.setStatusBarMessage('Copied the value.', 3000); }
  }));
  reg('copyMarkdown', () => withLine(async (ed, s) => {
    const g = await pro.gate('markdown');
    if (!g.ok) return;
    const md = render.markdownCopy(ed.document.getText(), s.result, isTs(ed.document) ? 'ts' : 'js', Number(cfg().get('inlineMaxLength', 120)) || 120);
    await vscode.env.clipboard.writeText(md);
    vscode.window.setStatusBarMessage(`Copied the code with its values as Markdown.${g.note ? ' ' + g.note : ''}`, 4000);
  }));
  reg('toggleCoverage', () => withLine(async (ed, s) => {
    if (!s.coverage) {
      const g = await pro.gate('coverage');
      if (!g.ok) return;
      if (g.note) vscode.window.setStatusBarMessage(g.note, 4000);
    }
    s.coverage = !s.coverage;
    s.schedule('now');
  }));
}

function activate(context) {
  tmpRoot = path.join(os.tmpdir(), `zovo-jsts-${process.pid}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const rt = path.join(context.extensionPath, 'dist', 'runtime');
  runner = new Runner({ tmpRoot, runtimePath: path.join(rt, 'runtime.cjs'), loaderPath: path.join(rt, 'loader.mjs'), workerPath: path.join(context.extensionPath, 'dist', 'instrument-worker.js') });
  output = vscode.window.createOutputChannel('JavaScript Playground');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  types = makeTypes();
  context.subscriptions.push(output, statusItem, ...Object.values(types));

  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'JavaScript Playground' });
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  registerCommands(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const s = sessions.get(e.document.uri.toString());
      if (s && e.contentChanges.length) s.schedule('change', e.contentChanges[0].range.start.line + 1 + (e.contentChanges[0].text.match(/\n/g) || []).length);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const s = sessions.get(doc.uri.toString());
      if (s && (cfg().get('runOn', 'change') === 'save' || s.note)) { s.note = null; s.schedule('save'); }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => stopSession(doc.uri.toString())),
    vscode.window.onDidChangeVisibleTextEditors(() => { for (const s of sessions.values()) s.paint(); }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { for (const s of sessions.values()) s.schedule('now'); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(PREFIX)) for (const s of sessions.values()) { s.paint(); }
    }),
    { dispose: () => { for (const k of [...sessions.keys()]) stopSession(k); runner.killAll(); } },
  );
  updateStatus();
  return { sessions, runner }; // for tests
}

function deactivate() {
  try { for (const k of [...sessions.keys()]) stopSession(k); } catch (_) { /* closing */ }
  try { if (runner) runner.killAll(); } catch (_) { /* closing */ }
  try { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* closing */ }
}

module.exports = { activate, deactivate };
