#!/usr/bin/env node
'use strict';
/**
 * Deterministic half of the pipeline, offline: takes the model's decisions (the record_triage tool inputs)
 * and builds columns H-M with the SAME functions the Apps Script uses (validateDecision_, which applies the
 * escalation rule, and buildColumnK_).
 *
 *   node scripts/build-reference.js [--input data/input/Practice_Mailbox_40.csv]
 *                                   [--decisions data/reference/decisions.json]
 *                                   [--out data/reference/Practice_Mailbox_40_classified.csv]
 *
 * The model's judgement is NOT reproduced here; it is whatever is in the decisions file.
 * Use scripts/classify-with-api.js to produce a decisions file from the live API.
 */
const fs = require('fs');
const path = require('path');
const {ROOT, loadCode} = require('./lib/gas-sandbox');
const csv = require('./lib/csv');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function build(inputPath, decisionsPath) {
  const code = loadCode();
  const rows = csv.parse(fs.readFileSync(inputPath, 'utf8')).filter(function (r) { return r.length > 1 || r[0] !== ''; });
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const header = rows[0].slice(0, 7).concat(['Category', 'Urgency', 'Owner or queue', 'Proposed action', 'Confidence', 'Escalate flag']);
  const out = [header];
  const problems = [];
  rows.slice(1).forEach(function (r) {
    const d = decisions[r[0]];
    if (!d) { problems.push(r[0] + ': no decision in ' + path.basename(decisionsPath)); return; }
    try {
      const v = code.sandbox.validateDecision_(d);
      out.push(r.slice(0, 7).concat([v.category, v.urgency, v.owner, code.sandbox.buildColumnK_(v), v.confidence, v.escalate]));
    } catch (e) {
      problems.push(r[0] + ': ' + e.message);
    }
  });
  return {rows: out, problems: problems};
}

function main() {
  const input = path.resolve(ROOT, arg('input', 'data/input/Practice_Mailbox_40.csv'));
  const decisions = path.resolve(ROOT, arg('decisions', 'data/reference/decisions.json'));
  const out = path.resolve(ROOT, arg('out', 'data/reference/Practice_Mailbox_40_classified.csv'));
  const res = build(input, decisions);
  if (res.problems.length) {
    console.error('Rejected by the script\'s validator:\n  ' + res.problems.join('\n  '));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, csv.stringify(res.rows), 'utf8');
  console.log('Wrote ' + (res.rows.length - 1) + ' rows x ' + res.rows[0].length + ' columns to ' + path.relative(ROOT, out));
}

if (require.main === module) main();
module.exports = {build};
