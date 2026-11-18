#!/usr/bin/env node
'use strict';
/**
 * Checks any 13-column triage CSV against the output contract: either the reference CSV in this repo or
 * the CSV you download from the Google Sheet after a live run.
 *
 *   node scripts/verify-output.js <file.csv>
 *
 * Exit code 1 if any hard rule is broken. Warnings do not fail the run.
 */
const fs = require('fs');
const path = require('path');
const {ROOT, loadCode} = require('./lib/gas-sandbox');
const csv = require('./lib/csv');

function verify(text) {
  const g = loadCode().get;
  const HEADERS = g('HEADERS'), CATEGORIES = g('CATEGORIES'), OWNERS = g('OWNERS'), URGENCIES = g('URGENCIES');
  const LANGUAGES = g('LANGUAGES'), CONFIDENCES = g('CONFIDENCES'), YES_NO = g('YES_NO');
  const SIG = g('SIGNATURE_TEAMS'), AIRPORT = g('AIRPORT_NAME'), CLOSING = g('CLOSING');

  const errors = [];
  const warnings = [];
  const rows = csv.parse(text).filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  if (!rows.length) return {errors: ['The file is empty'], warnings: warnings, rowCount: 0};
  if (rows[0].join('|') !== HEADERS.join('|')) {
    errors.push('Header row must be exactly: ' + HEADERS.join(', ') + '\n    found: ' + rows[0].join(', '));
  }
  const seen = new Set();
  rows.slice(1).forEach(function (r, i) {
    const n = 'row ' + (i + 2) + ' (' + (r[0] || 'no id') + ')';
    const bad = function (m) { errors.push(n + ': ' + m); };
    if (r.length !== 13) { bad('has ' + r.length + ' columns, expected 13'); return; }
    const [id, received, language, , fromEmail, subject, body, category, urgency, owner, action, confidence, escalate] = r;
    if (!id) bad('empty id'); else if (seen.has(id)) bad('duplicate id'); else seen.add(id);
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(received)) bad('received is not "yyyy-MM-dd HH:mm" text: ' + received);
    if (LANGUAGES.indexOf(language) < 0) bad('language must be EN or BG: ' + language);
    if (!fromEmail) bad('empty from_email');
    if (CATEGORIES.indexOf(category) < 0) bad('Category not approved: ' + category);
    if (URGENCIES.indexOf(urgency) < 0) bad('Urgency not approved: ' + urgency);
    if (OWNERS.indexOf(owner) < 0) bad('Owner not approved: ' + owner);
    if (CONFIDENCES.indexOf(confidence) < 0) bad('Confidence must be High/Medium/Low: ' + confidence);
    if (YES_NO.indexOf(escalate) < 0) bad('Escalate flag must be Yes/No: ' + escalate);
    if (confidence !== 'High' && escalate !== 'Yes') bad('Escalate flag must be Yes when confidence is ' + confidence);

    const k = String(action).replace(/\r\n?/g, '\n');
    if (!k.trim()) { bad('Proposed action is empty'); return; }
    const m = /\n\nDraft( to ICT)?:\n/.exec(k);
    if (m) {
      const draft = k.slice(m.index + m[0].length).split('\n');
      const sig = SIG[owner] && LANGUAGES.indexOf(language) >= 0 ? SIG[owner][language] + ', ' + AIRPORT[language] : null;
      if (sig) {
        if (draft[draft.length - 1] !== sig) bad('draft signature must be "' + sig + '"');
        if (draft[draft.length - 2] !== CLOSING[language]) bad('draft closing must be "' + CLOSING[language] + '"');
        if (!/Team|екип/i.test(sig)) bad('signature must include Team or екип');
      }
      if (!/^[^\n]+,$/.test(draft[0] || '')) bad('draft must start with a one-line greeting ending in a comma');
      if (draft[1] !== '') bad('draft needs a blank line after the greeting');
      if (m[1] && owner !== 'ICT') bad('"Draft to ICT:" requires owner ICT');
    } else if (/Draft/.test(k)) {
      warnings.push(n + ': proposed action mentions "Draft" but has no Draft: block');
    }
    if (/^[=+\-@]/.test(body) || /^[=+\-@]/.test(subject)) {
      warnings.push(n + ': subject/body starts with a formula character; it is stored as text, but open the CSV through an import wizard');
    }
  });
  return {errors: errors, warnings: warnings, rowCount: Math.max(0, rows.length - 1)};
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/verify-output.js <file.csv>'); process.exit(2); }
  const res = verify(fs.readFileSync(path.resolve(file), 'utf8'));
  res.warnings.forEach(function (w) { console.warn('warning: ' + w); });
  if (res.errors.length) {
    console.error(res.errors.length + ' problem(s) in ' + res.rowCount + ' rows:\n  ' + res.errors.join('\n  '));
    process.exit(1);
  }
  console.log('OK: ' + res.rowCount + ' rows, 13 columns, all values approved, escalation rule and drafts consistent.');
}

if (require.main === module) main();
module.exports = {verify};
