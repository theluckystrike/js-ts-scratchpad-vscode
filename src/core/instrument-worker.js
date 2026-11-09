'use strict';
// Worker thread for large files: parsing a few MB of code takes long enough that it must not run on the
// extension host thread. Receives { text, opts }, posts back the instrument() result.
const { parentPort } = require('worker_threads');
const { instrument } = require('./instrument');

parentPort.once('message', ({ text, opts }) => {
  let r;
  try { r = instrument(text, opts); } catch (e) { r = { ok: false, error: { line: 1, column: 0, message: `Could not prepare the file: ${e && e.message}` } }; }
  parentPort.postMessage(r);
});
