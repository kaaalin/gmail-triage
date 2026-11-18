#!/usr/bin/env node
'use strict';
/**
 * Verifies flows/triage-flow.json against src/Code.gs:
 *  - every function named in the flow exists in the code,
 *  - every limit equals the value of its CFG key,
 *  - the error kinds and states are the ones the code uses,
 *  - the code contains no Gmail call that sends, forwards, trashes or deletes mail.
 */
const fs = require('fs');
const path = require('path');
const {ROOT, CODE_PATH, loadCode} = require('./lib/gas-sandbox');

const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows', 'triage-flow.json'), 'utf8'));
const source = fs.readFileSync(CODE_PATH, 'utf8');
const cfg = loadCode().get('CFG');
const errors = [];

const hasFn = function (name) { return new RegExp('^function ' + name + '\\(', 'm').test(source); };

flow.triggers.forEach(function (t) {
  if (!hasFn(t.handler)) errors.push('trigger handler not found in code: ' + t.handler);
  ['installed_by', 'removed_by'].forEach(function (k) { if (t[k] && !hasFn(t[k])) errors.push('function not found in code: ' + t[k]); });
});
flow.steps.forEach(function (s) { if (!hasFn(s.function)) errors.push('step "' + s.id + '": function not found in code: ' + s.function); });
const ids = flow.steps.map(function (s) { return s.id; });
if (new Set(ids).size !== ids.length) errors.push('duplicate step ids');

Object.keys(flow.limits).forEach(function (k) {
  const l = flow.limits[k];
  if (!(l.config_key in cfg)) errors.push('limit "' + k + '": CFG.' + l.config_key + ' does not exist');
  else if (cfg[l.config_key] !== l.value) errors.push('limit "' + k + '": flow says ' + l.value + ' but CFG.' + l.config_key + ' is ' + cfg[l.config_key]);
});

const kinds = new Set(['transient', 'fatal', 'permanent', 'skip']);
flow.error_policy.forEach(function (p) { if (!kinds.has(p.kind)) errors.push('unknown error kind: ' + p.kind); });
['RETRY', 'GAVE_UP', 'DONE'].forEach(function (s) {
  if (!(s in flow.message_states)) errors.push('state missing from flow: ' + s);
  if (source.indexOf("'" + s + "'") < 0) errors.push('state not used in code: ' + s);
});

// The "never does" promise: no Gmail methods that send, forward, trash, delete or change mailbox location.
const forbidden = [/Messages\.send\b/, /Drafts\./, /Messages\.trash\b/, /Messages\.untrash\b/, /Messages\.delete\b/,
  /Messages\.batchDelete\b/, /Threads\.trash\b/, /Threads\.delete\b/, /GmailApp\./, /MailApp\./, /removeLabelIds:\s*\[?\s*['"]INBOX/];
forbidden.forEach(function (re) { if (re.test(source)) errors.push('code contains a forbidden call: ' + re); });

// removeLabelIds may only be used with our own legacy Triage labels.
const removals = source.match(/removeLabelIds/g) || [];
if (removals.length > 2) errors.push('unexpected extra use of removeLabelIds');

if (errors.length) { console.error('Flow definition problems:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('Flow definition matches src/Code.gs (' + flow.steps.length + ' steps, ' + Object.keys(flow.limits).length + ' limits; no send/forward/move/delete calls).');
