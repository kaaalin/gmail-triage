'use strict';
/**
 * Minimal RFC 4180 CSV reader/writer with no dependencies.
 * Handles quoted cells, doubled quotes, embedded line breaks, CRLF or LF, and a UTF-8 BOM.
 */

function parse(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (c === '\r' && s[i + 1] === '\n') i++;
      i++; continue;
    }
    cell += c; i++;
  }
  if (inQuotes) throw new Error('CSV ends inside a quoted cell');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function quote(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** UTF-8 with BOM (Excel opens Bulgarian text correctly) and CRLF row endings. */
function stringify(rows) {
  return '﻿' + rows.map(function (r) { return r.map(quote).join(','); }).join('\r\n') + '\r\n';
}

module.exports = {parse, stringify};
