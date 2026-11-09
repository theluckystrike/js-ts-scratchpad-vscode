'use strict';
// Pure text helpers for what the editor shows: the end-of-line text, the hover, the output panel and the
// Markdown copy. No VS Code here, so test/render.test.js can check them.

const nf = (n) => Number(n).toLocaleString('en-US');
function oneLine(s) { return String(s).replace(/\s*\n\s*/g, ' '); }
function cut(s, n) { return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; }

function itemText(it) {
  const t = oneLine(it.text);
  if (it.kind === 'value') {
    const v = it.resolved ? `Promise → ${t}` : t;
    return it.name ? `${it.name} = ${v}` : v;
  }
  return t;
}

/**
 * The text at the end of one line. entry = { items, count }.
 * @returns {{ text: string, kind: 'value'|'log'|'error' } | null}
 */
function lineText(entry, maxLen = 120) {
  if (!entry || !entry.items.length) {
    if (entry && entry.count) return { text: `ran ${nf(entry.count)} times`, kind: 'value' };
    return null;
  }
  const err = entry.items.find((i) => i.kind === 'error');
  if (err) return { text: `✖ ${cut(oneLine(err.text), maxLen)}`, kind: 'error' };
  const kind = entry.items.every((i) => i.kind === 'log') ? 'log' : 'value';
  const shown = entry.items.filter((i) => i.kind !== 'error');
  const more = Math.max(0, entry.count - shown.length);
  const tail = more ? ` (+${nf(more)} more)` : '';
  const prefix = kind === 'log' ? 2 : 0;
  const room = Math.max(10, maxLen - tail.length - prefix - 4); // 4: room for " · …"
  let text = '';
  let used = 0;
  // a declaration with several names shows each once; a loop line shows its values in order
  for (const it of shown) {
    const t = itemText(it);
    const next = text ? `${text} · ${t}` : t;
    if (next.length > room) {
      if (!text) text = cut(t, room);
      else text += ' · …';
      break;
    }
    text = next;
    used++;
  }
  if (used < shown.length && !text.endsWith('…') && !tail) text += ' …';
  return { text: (prefix ? '› ' : '') + text + tail, kind };
}

function fence(s) {
  const longest = Math.max(2, ...(String(s).match(/`+/g) || ['']).map((x) => x.length));
  return '`'.repeat(longest + 1);
}

/** Hover markdown for one line (plain markdown text, trusted: false). */
function hoverText(entry, line, maxItems = 30) {
  if (!entry) return '';
  const shown = entry.items;
  const head = `**Line ${line}**: ${nf(entry.count || shown.length)} ${(entry.count || shown.length) === 1 ? 'result' : 'results'}`
    + (entry.count > shown.length ? `, the first ${nf(shown.length)} kept` : '');
  const body = shown.slice(0, maxItems).map((it) => {
    const label = it.kind === 'error' ? 'error' : it.kind === 'log' ? `console.${it.method || 'log'}` : (it.name || 'value');
    return `${label}: ${cut(String(it.text), 600)}`;
  }).join('\n');
  const extra = shown.length > maxItems ? `\n… ${nf(shown.length - maxItems)} more in "Show All Values of This Line"` : '';
  const f = fence(body);
  return `${head}\n\n${f}text\n${body}${extra}\n${f}`;
}

/** Lines for the output panel after a run. */
function outputText(res, label, timeoutMs) {
  const L = [];
  const st = res.state;
  const when = new Date().toLocaleTimeString('en-GB');
  if (res.status === 'syntax') {
    L.push(`${label}, ${when}: not run, ${res.error.message} (line ${res.error.line})`);
    return L.join('\n');
  }
  if (res.status === 'spawn') {
    L.push(`${label}, ${when}: could not start the runtime: ${res.message}`);
    return L.join('\n');
  }
  const mode = res.moduleType === 'esm' ? 'ES module' : 'CommonJS';
  L.push(`${label}, ${when}, ${mode}${st && st.node ? `, Node ${st.node}` : ''}, ${nf(res.ms)} ms`);
  if (st) {
    for (const w of st.warnings) L.push(`note: ${w}`);
    if (st.outputDropped) L.push(`Showing the first ${nf(st.output.length)} console lines; ${nf(st.outputDropped)} more console lines are not shown here (the panel keeps the first 2,000 lines of each run).`);
    for (const o of st.output) {
      const tag = o.method && o.method !== 'log' ? ` ${o.method}` : '';
      L.push(`[line ${o.line || '?'}${tag}] ${o.text}`);
    }
    if (st.outputDropped) L.push(`… ${nf(st.outputDropped)} more console lines not shown.`);
  }
  const extra = (res.stdout || '').trim();
  if (extra) L.push(extra.length > 20000 ? extra.slice(0, 20000) + '\n…' : extra);
  const err = String(res.stderr || '').split('\n').filter((l) => l && !/Node\.js environment variables are disabled/.test(l)).join('\n').trim();
  if (st) {
    for (const e of st.errors) {
      L.push(`${e.rejected ? 'Unhandled rejection' : 'Error'}${e.line ? ` on line ${e.line}` : ''}: ${e.message}`);
      if (e.stack) L.push(e.stack.split('\n').slice(1, 12).join('\n'));
      if (/Cannot find (module|package)/.test(e.message)) L.push('Tip: install it in the folder of this file or the workspace (npm install <name>).');
    }
    if (st.exit) L.push(`process.exit(${st.exit.code}) was called${st.exit.line ? ` on line ${st.exit.line}` : ''}.`);
  }
  if (res.status === 'timeout') L.push(`Stopped after ${nf((timeoutMs || res.timeoutMs || 5000) / 1000)} s: the code was still running (an endless loop, an open server or a timer). Change the limit in the setting jsScratchpad.timeoutSeconds.`);
  if (res.status === 'oom') L.push('Stopped: the code used more memory than the limit (setting jsScratchpad.memoryLimitMB).');
  if (res.status === 'crash') L.push(`The process ended with ${res.signal || `code ${res.exitCode}`}.`);
  if (err && (res.status === 'crash' || res.status === 'oom' || res.status === 'error' || !st || !st.errors.length)) {
    L.push(err.length > 4000 ? err.slice(0, 4000) + '\n…' : err);
  }
  return L.join('\n');
}

/** The status bar words for a finished run. */
function statusText(res, timeoutMs) {
  switch (res.status) {
    case 'done': return { text: `$(check) Values ${nf(res.ms)} ms`, warn: false };
    case 'exit': return { text: `$(check) process.exit(${res.state.exit.code})`, warn: false };
    case 'error': return { text: `$(error) Error on line ${res.state.errors[0].line || '?'}`, warn: true };
    case 'syntax': return { text: `$(error) Syntax error, line ${res.error.line}`, warn: true };
    case 'timeout': return { text: `$(watch) Stopped at ${nf((timeoutMs || res.timeoutMs || 5000) / 1000)} s`, warn: true };
    case 'oom': return { text: '$(warning) Memory limit', warn: true };
    case 'crash': return { text: '$(warning) Process ended', warn: true };
    case 'spawn': return { text: '$(warning) Runtime did not start', warn: true };
    default: return { text: '$(debug-stop) Stopped', warn: false };
  }
}

/** The file with each line's values as an end-of-line comment, as Markdown. */
function markdownCopy(text, res, lang, maxLen = 120) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const st = res && res.state;
  const out = lines.map((l, i) => {
    const e = st && st.lines.get(i + 1);
    const t = lineText(e, maxLen);
    return t ? `${l}  // ${t.text}` : l;
  });
  const body = out.join('\n');
  const f = fence(body);
  let md = `${f}${lang}\n${body}\n${f}\n`;
  if (st && st.output.length) {
    const o = st.output.slice(0, 200).map((x) => x.text).join('\n');
    const f2 = fence(o);
    md += `\nConsole output:\n\n${f2}text\n${o}${st.output.length > 200 ? '\n…' : ''}\n${f2}\n`;
  }
  return md;
}

module.exports = { lineText, hoverText, outputText, statusText, markdownCopy, itemText, nf };
