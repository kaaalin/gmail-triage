#!/usr/bin/env node
'use strict';
/**
 * Runs the SAME prompt, tool schema and request body as the Apps Script against the Claude API, outside Google,
 * and writes the raw model decisions (record_triage tool inputs) to a JSON file that build-reference.js accepts.
 * Use it to reproduce the model's judgement on a CSV of emails without touching Gmail or Sheets.
 *
 *   ANTHROPIC_API_KEY=...  CLAUDE_MODEL=<model id>  node scripts/classify-with-api.js \
 *       [--input data/input/Practice_Mailbox_40.csv] [--out data/live/decisions.json] [--limit N]
 *
 * Optional: ANTHROPIC_BASE_URL (default https://api.anthropic.com), used by the offline test with a local mock.
 * The API key is read from the environment only and is never printed or written.
 * Requires Node 18+ (global fetch). Costs API credits.
 */
const fs = require('fs');
const path = require('path');
const {ROOT, loadCode, zonedToEpochMs} = require('./lib/gas-sandbox');
const csv = require('./lib/csv');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function callApi(baseUrl, key, version, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(baseUrl.replace(/\/+$/, '') + '/v1/messages', {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': version},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
      });
    } catch (e) {
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error('Network error calling the Claude API');
    }
    if (res.status === 200) return res.json();
    const text = await res.text();
    let info = '';
    try { const j = JSON.parse(text); info = j.error ? (j.error.type + ' ' + String(j.error.message).slice(0, 200)) : ''; } catch (e) { /* ignore */ }
    const transient = res.status === 429 || res.status === 529 || res.status >= 500;
    if (transient && attempt < 2) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 && ra <= 30 ? ra * 1000 : 1500 * (attempt + 1));
      continue;
    }
    const err = new Error('Claude API HTTP ' + res.status + (info ? ': ' + info : ''));
    err.fatal = !transient;   // 400/401/403/404 are setup problems (key, model, credits): stop, do not continue
    throw err;
  }
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL;
  if (!key || !model) { console.error('Set ANTHROPIC_API_KEY and CLAUDE_MODEL in the environment.'); process.exit(2); }
  const input = path.resolve(ROOT, arg('input', 'data/input/Practice_Mailbox_40.csv'));
  const out = path.resolve(ROOT, arg('out', 'data/live/decisions.json'));
  const limit = Number(arg('limit', '0')) || 0;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  const code = loadCode();
  const g = code.get;
  const version = g('CFG').API_VERSION;
  const rows = csv.parse(fs.readFileSync(input, 'utf8')).filter(function (r) { return r.length > 1; }).slice(1);
  const todo = limit ? rows.slice(0, limit) : rows;
  const decisions = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};   // resumable

  let done = 0;
  for (const r of todo) {
    const id = r[0];
    if (decisions[id]) continue;
    const msg = {id: id, receivedMs: zonedToEpochMs(r[1], code.timeZone), fromName: r[3], fromEmail: r[4], subject: r[5], body: r[6]};
    let decision = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && !decision; attempt++) {      // one extra try on invalid output, as in the script
      const data = await callApi(baseUrl, key, version, code.sandbox.buildRequest_(msg, {model: model}));
      try {
        const raw = code.sandbox.extractDecision_(data);
        code.sandbox.validateDecision_(raw);                           // same validation as the script
        decision = JSON.parse(JSON.stringify(raw));
      } catch (e) { lastErr = e; }
    }
    if (!decision) { console.error(id + ': invalid model output twice (' + lastErr.message + '); not saved'); continue; }
    decisions[id] = decision;
    done++;
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, JSON.stringify(decisions, null, 2) + '\n', 'utf8');
    console.log(id + ': ' + decision.category + ' / ' + decision.urgency + ' / ' + decision.owner);
  }
  console.log('Classified ' + done + ' new email(s); ' + Object.keys(decisions).length + ' decision(s) in ' + path.relative(ROOT, out));
}

main().catch(function (e) { console.error(e.message); process.exit(1); });
