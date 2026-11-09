'use strict';
// Turns the text of a JavaScript or TypeScript file into code that reports its values.
// Rules: no newline is ever added or removed, so line N of the output is line N of the input. Values,
// console calls and errors therefore land on the line the user wrote them on.
// Pure: no VS Code, no file system. The runtime half is runtime.cjs (loaded into the child process).
const acorn = require('acorn');
const walk = require('acorn-walk');

const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']);
const BODY_PARENTS = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase']);
// A statement that is the whole body of one of these (no braces) still shows its value, but gets no coverage mark.
const SINGLE_PARENTS = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'LabeledStatement']);

function isTsName(name) { return /\.(ts|mts|cts)$/i.test(name || ''); }

/** Strip TypeScript types with sucrase. Sucrase keeps every line where it was (checked in test/instrument.test.js). */
function stripTypes(text) {
  // eslint-disable-next-line global-require
  const { transform } = require('sucrase');
  return transform(text, { transforms: ['typescript'], disableESTransforms: true, keepUnusedImports: false }).code;
}

function syntaxErrorFrom(e, text) {
  let line = 1; let col = 0;
  if (e && e.loc && typeof e.loc.line === 'number') { line = e.loc.line; col = e.loc.column || 0; }
  else {
    const m = /\((\d+):(\d+)\)/.exec(String(e && e.message));
    if (m) { line = Number(m[1]); col = Number(m[2]); }
    else if (e && typeof e.pos === 'number') {
      line = text.slice(0, e.pos).split('\n').length;
    }
  }
  const message = String(e && e.message || e).replace(/\s*\(\d+:\d+\)\s*$/, '');
  return { line, column: col, message: `SyntaxError: ${message}` };
}

function parse(code) {
  const base = { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true, locations: true };
  try {
    return { ast: acorn.parse(code, { ...base, sourceType: 'module' }), sourceType: 'module' };
  } catch (moduleErr) {
    try {
      // Sloppy-mode scripts (with, octal literals, implicit globals in odd places) still run as CommonJS.
      return { ast: acorn.parse(code, { ...base, sourceType: 'script' }), sourceType: 'script' };
    } catch (_) {
      throw moduleErr;
    }
  }
}

function patternNames(p, out) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p); break;
    case 'ObjectPattern': for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out); break;
    case 'ArrayPattern': for (const el of p.elements) patternNames(el, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
    default: break;
  }
  return out;
}

function hasTopLevelAwait(ast) {
  let found = false;
  walk.recursive(ast, null, {
    Function() { /* do not enter functions */ },
    Class(node, st, c) {
      // class bodies can hold static blocks and field initialisers; await there is not top-level
      if (node.superClass) c(node.superClass, st);
    },
    AwaitExpression() { found = true; },
    ForOfStatement(node, st, c) { if (node.await) found = true; c(node.left, st); c(node.right, st); c(node.body, st); },
  });
  return found;
}

/**
 * @param {string} text source text of the editor
 * @param {object} o { fileName, origPath, origDir, coverage, moduleType: 'auto'|'esm'|'cjs' }
 * @returns {{ok:true, code, moduleType, imports, statements} | {ok:false, error:{line,column,message}}}
 */
function instrument(text, o = {}) {
  const fileName = o.fileName || 'scratch.js';
  let code = text.replace(/\r\n?/g, '\n');
  if (o.typescript || isTsName(fileName)) {
    try { code = stripTypes(code); } catch (e) { return { ok: false, error: syntaxErrorFrom(e, code) }; }
  }
  let parsed;
  try { parsed = parse(code); } catch (e) { return { ok: false, error: syntaxErrorFrom(e, code) }; }
  const { ast } = parsed;

  // ESM or CommonJS
  let hasModuleSyntax = false;
  const topNames = new Set();
  for (const s of ast.body) {
    if (/^(Import|Export)/.test(s.type)) hasModuleSyntax = true;
    if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) topNames.add(sp.local.name);
    const decl = s.type.startsWith('Export') && s.declaration ? s.declaration : s;
    if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) for (const id of patternNames(d.id, [])) topNames.add(id.name);
    if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) topNames.add(decl.id.name);
  }
  let moduleType = o.moduleType && o.moduleType !== 'auto' ? o.moduleType : null;
  if (!moduleType) {
    if (/\.(mjs|mts)$/i.test(fileName)) moduleType = 'esm';
    else if (/\.(cjs|cts)$/i.test(fileName)) moduleType = 'cjs';
    else if (hasModuleSyntax || parsed.sourceType === 'module' && hasTopLevelAwait(ast)) moduleType = 'esm';
    else moduleType = 'cjs';
  }
  if (moduleType === 'cjs' && parsed.sourceType === 'module' && hasTopLevelAwait(ast)) moduleType = 'esm';
  if (moduleType === 'cjs' && hasModuleSyntax) moduleType = 'esm';

  const edits = []; // {pos, end?, text, rank}
  const ins = (pos, t, rank) => edits.push({ pos, end: pos, text: t, rank });
  const rep = (pos, end, t) => edits.push({ pos, end, text: t, rank: 3 });
  const imports = [];
  const statements = new Set();
  const line = (n) => n.loc.start.line;

  const visitStatement = (node, parentType) => {
    const inBody = BODY_PARENTS.has(parentType);
    if (!inBody && !(SINGLE_PARENTS.has(parentType) && node.type === 'ExpressionStatement')) return;
    const L = line(node);
    if (node.type === 'ExpressionStatement' && node.directive) return;
    if (node.type === 'ExpressionStatement') {
      const ex = node.expression;
      statements.add(L);
      if (o.coverage && inBody) ins(node.start, `__zr(${L});`, 1);
      const isConsoleCall = ex.type === 'CallExpression' && ex.callee.type === 'MemberExpression' && !ex.callee.computed
        && ex.callee.object.type === 'Identifier' && ex.callee.object.name === 'console';
      if (!isConsoleCall) {
        // a call whose result is undefined (foo();) shows nothing: that is noise, not information
        const inner = ex.type === 'AwaitExpression' ? ex.argument : ex;
        const quiet = ex.type === 'AwaitExpression' || inner.type === 'CallExpression' || (inner.type === 'ChainExpression' && inner.expression.type === 'CallExpression');
        ins(ex.start, `__zv(${L},(`, 2);
        ins(ex.end, quiet ? '),void 0,1)' : '))', 0);
      }
      return;
    }
    if (node.type === 'VariableDeclaration' || (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'VariableDeclaration')) {
      const decl = node.type === 'VariableDeclaration' ? node : node.declaration;
      statements.add(L);
      if (o.coverage) ins(node.start, `__zr(${L});`, 1);
      if (!/^(var|let|const)$/.test(decl.kind)) return;
      const calls = [];
      for (const d of decl.declarations) {
        if (!d.init) continue;
        for (const id of patternNames(d.id, [])) calls.push(`__zv(${id.loc.start.line},${id.name},${JSON.stringify(id.name)});`);
      }
      if (calls.length) ins(node.end, ';' + calls.join(''), 0);
      return;
    }
    if (o.coverage && !/^(FunctionDeclaration|ClassDeclaration|ImportDeclaration|Export\w+|EmptyStatement)$/.test(node.type)) {
      statements.add(L);
      ins(node.start, `__zr(${L});`, 1);
    }
  };

  const ts = !!(o.typescript || isTsName(fileName));
  // Code that sucrase wrote for a TypeScript enum or namespace, or for constructor parameter properties, is not
  // the user's code: no values there.
  const isEnumIife = (fn, call) => call && call.type === 'CallExpression' && call.callee === fn && call.arguments.length === 1
    && call.arguments[0].type === 'LogicalExpression' && call.arguments[0].operator === '||'
    && call.arguments[0].right.type === 'AssignmentExpression' && call.arguments[0].right.right.type === 'ObjectExpression';
  const generated = (node, ancestors) => {
    if (!ts) return false;
    if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
      && node.expression.callee.type === 'FunctionExpression' && isEnumIife(node.expression.callee, node.expression)) return true;
    for (let i = ancestors.length - 2; i > 0; i--) {
      if (ancestors[i].type === 'FunctionExpression' && isEnumIife(ancestors[i], ancestors[i - 1])) return true;
    }
    if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression'
      && node.expression.left.type === 'MemberExpression' && node.expression.left.object.type === 'ThisExpression'
      && node.expression.right.type === 'Identifier' && !node.expression.left.computed
      && node.expression.left.property.name === node.expression.right.name) {
      const fn = ancestors[ancestors.length - 3];
      const md = ancestors[ancestors.length - 4];
      if (fn && fn.type === 'FunctionExpression' && md && md.type === 'MethodDefinition' && md.kind === 'constructor') return true;
    }
    return false;
  };

  walk.ancestor(ast, {
    Statement(node, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (parent && !generated(node, ancestors)) visitStatement(node, parent.type);
    },
    ExportNamedDeclaration(node) {
      if (node.source) imports.push({ line: line(node), source: node.source.value });
    },
    ExportAllDeclaration(node) { imports.push({ line: line(node), source: node.source.value }); },
    ImportDeclaration(node) { imports.push({ line: line(node), source: node.source.value }); },
    ImportExpression(node) {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') imports.push({ line: line(node), source: node.source.value });
    },
    CallExpression(node) {
      const c = node.callee;
      if (c.type === 'Identifier' && c.name === 'require' && node.arguments[0] && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string') {
        imports.push({ line: line(node), source: node.arguments[0].value });
      }
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'console'
        && c.property.type === 'Identifier' && CONSOLE_METHODS.has(c.property.name)) {
        rep(c.start, c.end, `__zc(${line(node)},${JSON.stringify(c.property.name)})`);
      }
    },
    MetaProperty(node, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (o.origUrl && node.meta.name === 'import' && parent && parent.type === 'MemberExpression' && parent.object === node
        && !parent.computed && parent.property.name === 'url') {
        rep(parent.start, parent.end, JSON.stringify(o.origUrl));
      }
    },
  }, walk.base);

  // Prefix on line 1, after a hashbang and after the directive prologue (so "use strict" keeps working).
  let prefixPos = 0;
  if (code.startsWith('#!')) rep(0, 2, '//');
  for (const s of ast.body) {
    if (s.type === 'ExpressionStatement' && s.directive) prefixPos = s.end; else break;
  }
  const origPath = o.origPath || '';
  const origDir = o.origDir || '';
  let prefix = '';
  if (moduleType === 'cjs') {
    if (origPath) prefix = `__filename=${JSON.stringify(origPath)};__dirname=${JSON.stringify(origDir)};`;
  } else {
    prefix = 'import {createRequire as __zcreq} from "module";';
    if (origPath) {
      if (!topNames.has('require')) prefix += `const require=__zcreq(${JSON.stringify(origPath)});`;
      if (!topNames.has('__filename')) prefix += `const __filename=${JSON.stringify(origPath)};`;
      if (!topNames.has('__dirname')) prefix += `const __dirname=${JSON.stringify(origDir)};`;
    }
  }
  if (prefix) ins(prefixPos, prefix, prefixPos === 0 ? -1 : 0);

  edits.sort((a, b) => a.pos - b.pos || a.rank - b.rank);
  let out = '';
  let cur = 0;
  for (const e of edits) {
    if (e.pos < cur) continue; // inside a replaced range (cannot happen with the rules above, kept as a guard)
    out += code.slice(cur, e.pos) + e.text;
    cur = e.end;
  }
  out += code.slice(cur);
  return { ok: true, code: out, moduleType, imports, statements: [...statements].sort((a, b) => a - b), lineCount: code.split('\n').length };
}

/** Line of the import/require that names a module in a "Cannot find module/package 'x'" message, or 0. */
function missingModuleLine(message, imports) {
  const m = /Cannot find (?:module|package) '([^']+)'/.exec(String(message || ''));
  if (!m) return 0;
  const name = m[1];
  const hit = imports.find((i) => i.source === name)
    || imports.find((i) => name.endsWith(i.source.replace(/^\.\//, '')))
    || imports.find((i) => i.source.startsWith(name + '/') || name.startsWith(i.source + '/'));
  return hit ? hit.line : 0;
}

module.exports = { instrument, stripTypes, missingModuleLine, isTsName, CONSOLE_METHODS };
