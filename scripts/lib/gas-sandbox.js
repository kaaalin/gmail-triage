'use strict';
/**
 * Loads src/Code.gs into a Node vm context with just enough Apps Script stubs to call its pure
 * functions (prompt, schema, validation, column K assembly, label names, request building).
 * Gmail, Sheets, locking and HTTP are NOT emulated here; tests/mock_tests.js does that.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CODE_PATH = path.join(ROOT, 'src', 'Code.gs');

function zoneParts(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return p;
}

/** Subset of Utilities.formatDate used by Code.gs. */
function formatDate(d, tz, fmt) {
  if (fmt === 'EEEE') return new Intl.DateTimeFormat('en-US', {timeZone: tz, weekday: 'long'}).format(d);
  if (fmt === 'yyyy-MM-dd HH:mm') {
    const p = zoneParts(d.getTime(), tz);
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }
  throw new Error('Unsupported date format in the sandbox: ' + fmt);
}

/** "2027-03-02 08:14" (wall-clock time in tz) -> epoch milliseconds. */
function zonedToEpochMs(str, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/.exec(String(str).trim());
  if (!m) throw new Error('Unrecognised received timestamp: ' + str);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(guess, tz);
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess = asUtc - (wall - Math.floor(guess / 1000) * 1000);
  }
  return guess;
}

function loadCode(options) {
  const tz = (options && options.timeZone) || 'Europe/Sofia';
  const sandbox = {
    console: {log() {}, warn() {}, error() {}},
    Utilities: {formatDate: formatDate, sleep() {}},
    Session: {getScriptTimeZone: function () { return tz; }},
    Gmail: {}, SpreadsheetApp: {}, LockService: {}, PropertiesService: {}, ScriptApp: {}, UrlFetchApp: {},
    TextDecoder, JSON, Math, Date, Map, Set, Object, Array, String, Number, Error, RegExp
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), sandbox, {filename: 'Code.gs'});
  return {
    sandbox: sandbox,
    timeZone: tz,
    /** Reads a top-level const or function declared in Code.gs (e.g. get('SYSTEM_PROMPT')). */
    get: function (name) { return vm.runInContext(name, sandbox); }
  };
}

module.exports = {ROOT, CODE_PATH, loadCode, formatDate, zonedToEpochMs};
