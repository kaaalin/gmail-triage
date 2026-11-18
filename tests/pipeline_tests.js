'use strict';
/**
 * Offline tests for the scripts around the Apps Script code:
 *  - the reference CSV rebuilds byte-for-byte from the recorded decisions,
 *  - the output verifier accepts it and rejects broken files,
 *  - scripts/classify-with-api.js works against a local mock of the Claude API
 *    (success, retry on 429, retry on invalid output, fatal on 401), and its decisions rebuild the same CSV.
 * No network access, no API key.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const csv = require('../scripts/lib/csv');
const {build} = require('../scripts/build-reference');
const {verify} = require('../scripts/verify-output');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = function (c, m) { if (c) pass++; else { fail++; console.log('FAIL: ' + m); } };
const eq = function (a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' | got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };

const inputPath = path.join(ROOT, 'data/input/Practice_Mailbox_40.csv');
const decisionsPath = path.join(ROOT, 'data/reference/decisions.json');
const refCsvPath = path.join(ROOT, 'data/reference/Practice_Mailbox_40_classified.csv');
const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));

// ---- csv helper
eq(csv.parse('a,"b,c","d ""q""\nline2"\r\ne,f,g'), [['a', 'b,c', 'd "q"\nline2'], ['e', 'f', 'g']], 'csv parse quotes and newlines');
eq(csv.parse(csv.stringify([['x', 'y\nz', 'q"r', 'Здравей']])), [['x', 'y\nz', 'q"r', 'Здравей']], 'csv round trip');

// ---- reference rebuild
const built = build(inputPath, decisionsPath);
eq(built.problems, [], 'all recorded decisions pass the validator');
eq(built.rows.length, 41, '40 rows + header');
ok(csv.stringify(built.rows) === fs.readFileSync(refCsvPath, 'utf8'), 'reference CSV rebuilds byte-for-byte from decisions.json');
const input = csv.parse(fs.readFileSync(inputPath, 'utf8'));
ok(built.rows.every(function (r, i) { return r.slice(0, 7).join('\u0001') === input[i].join('\u0001'); }), 'original columns A-G unchanged');

// ---- verifier
const refText = fs.readFileSync(refCsvPath, 'utf8');
const good = verify(refText);
eq(good.errors, [], 'verifier accepts the reference CSV'); eq(good.rowCount, 40, 'verifier row count');
const mutate = function (fn) { const rows = csv.parse(refText); fn(rows); return verify(csv.stringify(rows)).errors.length; };
ok(mutate(function (r) { r[1][7] = 'Airlines and Handlers'; }) > 0, 'rejects an unapproved category');
ok(mutate(function (r) { r[1][9] = 'Airlines and Handlers'; }) > 0, 'rejects the retired owner');
ok(mutate(function (r) { r[19][11] = 'Medium'; r[19][12] = 'No'; }) > 0, 'rejects Medium confidence with Escalate No');
ok(mutate(function (r) { r[1][10] = r[1][10].replace('Finance Team', 'Legal Team'); }) > 0, 'rejects a signature that does not match the owner');
ok(mutate(function (r) { r[1][10] = r[1][10].replace('Kind regards,', 'Best,'); }) > 0, 'rejects a wrong closing');
ok(mutate(function (r) { r[2].pop(); }) > 0, 'rejects a short row');
ok(mutate(function (r) { r[2][0] = r[1][0]; }) > 0, 'rejects a duplicate id');
ok(mutate(function (r) { r[0][10] = 'Action'; }) > 0, 'rejects wrong header');

// ---- classify-with-api.js against a local mock of the API
function startMock(behaviour) {
  const bySubject = new Map(input.slice(1).map(function (r) { return [r[5], r[0]]; }));
  const state = {calls: 0, seen: [], keyHeaders: []};
  const server = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      state.calls++;
      state.keyHeaders.push(req.headers['x-api-key']);
      const mode = behaviour(state.calls);
      if (mode === '401') { res.writeHead(401, {'content-type': 'application/json'}); return res.end(JSON.stringify({error: {type: 'authentication_error', message: 'bad key'}})); }
      if (mode === '429') { res.writeHead(429, {'content-type': 'application/json', 'retry-after': '0'}); return res.end(JSON.stringify({error: {type: 'rate_limit_error', message: 'slow down'}})); }
      const payload = JSON.parse(body);
      state.seen.push(payload);
      const content = payload.messages[0].content;
      const subject = JSON.parse(content.split('<untrusted_email>\n')[1].split('\n</untrusted_email>')[0]).subject;
      const id = bySubject.get(subject);
      const decision = mode === 'invalid' ? Object.assign({}, decisions[id], {category: 'Not a category'}) : decisions[id];
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({stop_reason: 'tool_use', content: [{type: 'tool_use', name: 'record_triage', input: decision}]}));
    });
  });
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { resolve({server: server, state: state, url: 'http://127.0.0.1:' + server.address().port}); }); });
}
function runCli(args, env) {
  return new Promise(function (resolve) {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts/classify-with-api.js')].concat(args), {env: Object.assign({}, process.env, env), cwd: ROOT});
    let out = '', err = '';
    p.stdout.on('data', function (d) { out += d; }); p.stderr.on('data', function (d) { err += d; });
    p.on('close', function (code) { resolve({code: code, out: out, err: err}); });
  });
}

(async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  const env = function (url) { return {ANTHROPIC_API_KEY: 'not-a-real-key-for-tests', CLAUDE_MODEL: 'test-model', ANTHROPIC_BASE_URL: url}; };

  // success + one 429 + one invalid output
  let m = await startMock(function (n) { return n === 1 ? '429' : (n === 3 ? 'invalid' : 'ok'); });
  const outFile = path.join(tmp, 'decisions.json');
  let r = await runCli(['--out', outFile], env(m.url));
  m.server.close();
  eq(r.code, 0, 'classify CLI exit code 0');
  const got = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  eq(Object.keys(got).length, 40, 'classify CLI saved 40 decisions');
  eq(got, decisions, 'decisions equal what the mock returned (the CLI stores the raw model input)');
  eq(m.state.calls, 42, 'exactly 40 calls + 1 retry after 429 + 1 retry after invalid output');
  const req = m.state.seen[0];
  eq([req.model, req.tool_choice, req.tools[0].name, req.system[0].type], ['test-model', {type: 'auto'}, 'record_triage', 'text'], 'request uses the same model/tool settings as the script');
  ok(req.system[0].text === fs.readFileSync(path.join(ROOT, 'prompts/system_prompt.txt'), 'utf8').replace(/\n$/, ''), 'request system prompt equals prompts/system_prompt.txt');
  ok(!(r.out + r.err).includes('not-a-real-key-for-tests'), 'the API key is never printed');
  ok(m.state.keyHeaders.every(function (k) { return k === 'not-a-real-key-for-tests'; }), 'key sent only in the x-api-key header');
  const rebuilt = build(inputPath, outFile);
  ok(csv.stringify(rebuilt.rows) === fs.readFileSync(refCsvPath, 'utf8'), 'live-CLI decisions rebuild the identical CSV');

  // resumable: a second run makes no calls
  m = await startMock(function () { return 'ok'; });
  r = await runCli(['--out', outFile], env(m.url)); m.server.close();
  eq([r.code, m.state.calls], [0, 0], 'second run is a no-op (resumable)');

  // limit
  m = await startMock(function () { return 'ok'; });
  const lim = path.join(tmp, 'limit.json');
  r = await runCli(['--out', lim, '--limit', '3'], env(m.url)); m.server.close();
  eq([r.code, Object.keys(JSON.parse(fs.readFileSync(lim, 'utf8'))).length], [0, 3], '--limit 3');

  // fatal 401 stops immediately and saves nothing
  m = await startMock(function () { return '401'; });
  const f401 = path.join(tmp, 'f401.json');
  r = await runCli(['--out', f401], env(m.url)); m.server.close();
  ok(r.code === 1 && m.state.calls === 1 && !fs.existsSync(f401), '401 is fatal: exit 1, one call, nothing saved');
  ok(/HTTP 401/.test(r.err), '401 message names the status');

  // missing environment
  r = await runCli([], {ANTHROPIC_API_KEY: '', CLAUDE_MODEL: ''});
  eq(r.code, 2, 'missing key/model exits with 2');

  fs.rmSync(tmp, {recursive: true, force: true});
  console.log('\nPASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
