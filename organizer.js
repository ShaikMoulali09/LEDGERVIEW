/* Ledgerview organizer — cleans messy pasted/OCR'd tables and prompts.
   Works in the browser (window.LVOrganize) and in Node (require('./organizer')). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LVOrganize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthIdx = (s) => {
    const m = String(s).trim().toLowerCase().replace(/\./g, '').slice(0, 3);
    return /^[a-z]{3,9}$/i.test(String(s).trim().replace(/\./g, '')) ? MONTHS.indexOf(m) : -1;
  };
  const BLANKS = /^(n\/?a|na|nan|null|none|nil|-+|—|–|\?|tbd)$/i;

  /* ---------- value helpers ---------- */
  function parseNumber(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s || BLANKS.test(s)) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[₹$€£]|rs\.?|inr|usd|eur/gi, '').replace(/\s+/g, ' ').trim();
    let mult = 1;
    if (/%$/.test(s)) s = s.slice(0, -1);
    const suf = s.match(/\s*(k|m|mn|b|lakhs?|lacs?|crores?|cr)$/i);
    if (suf) {
      const t = suf[1].toLowerCase();
      mult = t === 'k' ? 1e3 : (t === 'm' || t === 'mn') ? 1e6 : t === 'b' ? 1e9 : /^(lakh|lac)/.test(t) ? 1e5 : 1e7;
      s = s.slice(0, suf.index);
    }
    s = s.replace(/,/g, '').trim();
    if (s.startsWith('-') && s.length > 1) { neg = !neg; s = s.slice(1); }
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
    const n = Number(s) * mult * (neg ? -1 : 1);
    return isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
  }

  function isDateLike(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return false;
    if (monthIdx(s) >= 0) return true;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-'\/.,]*\d{2,4}$/i.test(s)) return true;
    if (/^\d{4}[-\/.]\d{1,2}([-\/.]\d{1,2})?$/.test(s)) return true;
    if (/^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}$/.test(s)) return true;
    if (/^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s+\d{2,4})?$/i.test(s)) return true;
    if (/^q[1-4]([\s\-']*\d{2,4})?$/i.test(s)) return true;
    if (/^(w(eek)?\s*\d{1,2})$/i.test(s)) return true;
    return false;
  }

  function periodKey(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let m;
    if (monthIdx(s) >= 0) return monthIdx(s);
    if ((m = s.match(/^([a-z]{3,9})[\s\-'\/.,]*(\d{2,4})$/i)) && monthIdx(m[1]) >= 0) {
      let y = +m[2]; if (y < 100) y += 2000; return y * 12 + monthIdx(m[1]);
    }
    if ((m = s.match(/^q([1-4])(?:[\s\-']*(\d{2,4}))?$/i))) {
      let y = m[2] ? +m[2] : 0; if (y && y < 100) y += 2000; return y * 4 + (+m[1]) - 1;
    }
    if ((m = s.match(/^w(?:eek)?\s*(\d{1,2})$/i))) return +m[1];
    if (/^\d{4}[-\/.]\d{1,2}([-\/.]\d{1,2})?$/.test(s) || /^\d{1,2}\s+[a-z]{3,9}(\s+\d{2,4})?$/i.test(s)) {
      const t = Date.parse(s.replace(/\./g, '-')); return isNaN(t) ? null : t;
    }
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) {
      let y = +m[3]; if (y < 100) y += 2000; return Date.UTC(y, +m[2] - 1, +m[1]);
    }
    if (/^(19|20)\d{2}$/.test(s)) return +s;
    return null;
  }

  /* ---------- line / cell parsing ---------- */
  function splitQuoted(line, d) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === d) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  }
  function splitLine(line, d) {
    if (d === 'spaces') return line.trim().split(/\s{2,}|\t/).map((x) => x.trim());
    if (d === 'dash') { const m = line.match(/^(.+?)\s*[-–—:=]\s*([^\s].*)$/); return m ? [m[1].trim(), m[2].trim()] : [line.trim()]; }
    return splitQuoted(line, d);
  }
  const mode = (arr) => {
    const c = new Map(); arr.forEach((x) => c.set(x, (c.get(x) || 0) + 1));
    let best = null, bn = 0; c.forEach((n, k) => { if (n > bn || (n === bn && k > best)) { best = k; bn = n; } });
    return best;
  };

  function rejoinThousands(cells, want) {
    // "31,000" split by a comma delimiter -> 31 | 000. Merge 3-digit cells into the previous numeric cell.
    const out = [];
    for (const c of cells) {
      if (out.length && /^\d{3}$/.test(c) && /^[₹$€£]?\s*\d{1,3}(,\d{3})*$/.test(out[out.length - 1]) && cells.length - (cells.length - out.length) > 0) {
        out[out.length - 1] += ',' + c;
      } else out.push(c);
    }
    return out.length >= want ? out : cells;
  }

  function levenshtein1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
  }

  function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(columns, rows) {
    return [columns.map(csvCell).join(',')].concat(rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))).join('\n');
  }

  function numericShare(cells) {
    const f = cells.filter((x) => x !== '' && !BLANKS.test(x));
    if (!f.length) return 0;
    return f.filter((x) => parseNumber(x) !== null).length / f.length;
  }

  /* ---------- main: messy text -> tidy table ---------- */
  function organizeText(text, opts) {
    opts = opts || {};
    const notes = [];
    let raw = String(text == null ? '' : text).replace(/\r/g, '').replace(/^\uFEFF/, '');
    if (!raw.trim()) return { columns: [], rows: [], csv: '', notes, error: 'There’s no data to organize yet.' };

    let lines = raw.split('\n').map((l) => l.replace(/\u00a0/g, ' ').trimEnd()).filter((l) => l.trim());
    const before = lines.length;
    // dividers like ----, ====, |---|---|
    lines = lines.filter((l) => !/^[\s\-=_*+|:~.#]{3,}$/.test(l));
    // markdown tables: strip outer pipes
    let isMd = false;
    lines = lines.map((l) => { if (/^\s*\|.*\|\s*$/.test(l)) { isMd = true; return l.trim().slice(1, -1); } return l; });
    if (isMd) notes.push('Converted a markdown table.');
    if (before - lines.length > 0 && !isMd) notes.push('Removed ' + (before - lines.length) + ' divider line' + (before - lines.length === 1 ? '' : 's') + '.');

    // choose delimiter
    const cands = [[',', ','], ['\t', 'tab'], [';', 'semicolon'], ['|', 'pipe'], ['spaces', 'columns of spaces'], ['dash', 'dash/colon-separated pairs']];
    let best = null;
    for (const [d, label] of cands) {
      const counts = lines.map((l) => splitLine(l, d).length);
      const m = mode(counts.filter((c) => c > 1));
      if (!m) continue;
      const fit = counts.filter((c) => c === m).length;
      // commas inside thousands separators shouldn't win by being noisy
      const score = fit * 1000 + m;
      if (fit >= Math.max(2, Math.ceil(lines.length * 0.5)) && (!best || score > best.score)) best = { d, label, m, fit, score };
    }
    if (!best) {
      // single-column list? treat each line as a row with one text column
      return { columns: [], rows: [], csv: '', notes, error: 'Couldn’t find a table in that data — use one row per line, with columns separated by commas, tabs or spaces.' };
    }
    if (best.d !== ',') notes.push('Detected ' + best.label + ' as the column separator.');

    let grid = lines.map((l) => {
      let cells = splitLine(l, best.d);
      if (best.d === ',' && cells.length > best.m) { const r = rejoinThousands(cells, best.m); if (r.length === best.m) { cells = r; } }
      return cells;
    });
    const total = grid.length;
    grid = grid.filter((c) => c.length === best.m);
    if (total - grid.length > 0) notes.push('Removed ' + (total - grid.length) + ' title/footnote line' + (total - grid.length === 1 ? '' : 's') + ' that weren’t part of the table.');
    if (grid.length < 2 && !(grid.length === 1 && opts.ocr)) return { columns: [], rows: [], csv: '', notes, error: 'Couldn’t find enough rows to build a table.' };

    // header
    const first = grid[0];
    const firstIsHeader = first.filter((c) => c !== '' && parseNumber(c) === null).length >= Math.ceil(first.length * 0.6);
    let columns;
    if (firstIsHeader) { columns = first.map((c, i) => c.replace(/^["']|["']$/g, '').trim() || 'Column ' + (i + 1)); grid = grid.slice(1); }
    else { columns = first.map((_, i) => 'Column ' + (i + 1)); notes.push('No header row found, so columns were named Column 1, Column 2…'); }
    // unique column names
    const seen = new Map();
    columns = columns.map((c) => { const k = c.toLowerCase(); const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n > 1 ? c + ' ' + n : c; });

    // drop total / average rows
    const isTotalRow = (cells) => /^(grand\s+)?(total|subtotal|sum|average|avg|mean|overall)\b/i.test(cells.find((c) => c !== '') || '');
    const nTot = grid.filter(isTotalRow).length;
    if (nTot) { grid = grid.filter((c) => !isTotalRow(c)); notes.push('Dropped ' + nTot + ' total/average row' + (nTot === 1 ? '' : 's') + ' so nothing is counted twice.'); }

    // drop row-number column
    const dropIdx = [];
    columns.forEach((c, i) => {
      const vals = grid.map((r) => r[i]);
      const nums = vals.map((v) => (/^\d+\.?$/.test(v) ? parseInt(v, 10) : NaN));
      const seq = nums.length > 2 && nums.every((n, k) => n === nums[0] + k) && nums[0] <= 1;
      if (/^(#|no\.?|sr\.?(\s*no\.?)?|s\.?\s*no\.?|sl\.?(\s*no\.?)?|index|id|serial)$/i.test(c) && seq) dropIdx.push(i);
      else if (seq && i === 0 && columns.length > 2) dropIdx.push(i);
    });
    if (dropIdx.length) {
      notes.push('Removed the row-number column' + (dropIdx.length > 1 ? 's' : '') + ' (' + dropIdx.map((i) => columns[i]).join(', ') + ').');
      columns = columns.filter((_, i) => !dropIdx.includes(i));
      grid = grid.map((r) => r.filter((_, i) => !dropIdx.includes(i)));
    }

    // months as columns -> long form
    const monthCols = columns.map((c, i) => (monthIdx(c) >= 0 || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-'\/]*\d{2,4}$/i.test(c) ? i : -1)).filter((i) => i >= 0);
    if (monthCols.length >= 3 && monthCols.length >= columns.length - 3) {
      const idCols = columns.map((_, i) => i).filter((i) => !monthCols.includes(i));
      const idNames = idCols.map((i) => columns[i]);
      const longCols = idNames.concat(['Month', 'Value']);
      const longRows = [];
      grid.forEach((r) => monthCols.forEach((mi) => {
        const row = {}; idCols.forEach((ci) => { row[columns[ci]] = r[ci]; });
        row.Month = columns[mi]; row.Value = r[mi]; longRows.push(row);
      }));
      notes.push('Reshaped “months as columns” into one row per month.');
      columns = longCols;
      grid = longRows.map((o) => columns.map((c) => o[c]));
    }

    // numeric columns: parse
    const numericCol = columns.map((_, i) => numericShare(grid.map((r) => r[i])) >= 0.7);
    let cleanedNums = 0, blanked = 0;
    grid = grid.map((r) => r.map((v, i) => {
      v = v == null ? '' : String(v).trim();
      if (BLANKS.test(v)) { blanked++; return ''; }
      if (numericCol[i]) {
        const n = parseNumber(v);
        if (n === null) { if (v !== '') blanked++; return ''; }
        if (String(n) !== v) cleanedNums++;
        return String(n);
      }
      return v;
    }));
    if (cleanedNums) notes.push('Normalized ' + cleanedNums + ' number' + (cleanedNums === 1 ? '' : 's') + ' (symbols, commas, k/lakh, brackets).');
    if (blanked) notes.push('Cleared ' + blanked + ' blank marker' + (blanked === 1 ? '' : 's') + ' (N/A, -, …).');

    // merge case / near-duplicate spellings in text columns
    let merged = 0;
    columns.forEach((c, i) => {
      if (numericCol[i]) return;
      const vals = grid.map((r) => r[i]).filter((v) => v !== '');
      if (!vals.length || vals.filter(isDateLike).length / vals.length > 0.5) return;
      const freq = new Map(); vals.forEach((v) => freq.set(v, (freq.get(v) || 0) + 1));
      if (freq.size > 60) return;
      const uniq = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a));
      const canon = new Map();
      uniq.forEach((v) => {
        const lc = v.toLowerCase().replace(/\s+/g, ' ');
        let target = null;
        for (const [k, t] of canon) {
          if (k === lc || (lc.length >= 5 && k.length >= 5 && levenshtein1(k, lc))) { target = t; break; }
        }
        if (target === null) { canon.set(lc, v); target = v; }
        if (target !== v) { merged++; }
        canon.set('~' + v, target);
      });
      grid.forEach((r) => { if (r[i] !== '') { const lc = r[i].toLowerCase().replace(/\s+/g, ' '); const t = canon.get('~' + r[i]); if (t) r[i] = t; else if (canon.get(lc)) r[i] = canon.get(lc); } });
    });
    if (merged) notes.push('Merged ' + merged + ' spelling/case variant' + (merged === 1 ? '' : 's') + ' (e.g. “Delivry” → “Delivery”).');

    // drop fully empty rows
    grid = grid.filter((r) => r.some((v) => v !== ''));

    const rows = grid.map((r) => { const o = {}; columns.forEach((c, i) => { o[c] = r[i] == null ? '' : r[i]; }); return o; });
    if (opts.ocr) notes.push('Read from an image with on-device OCR — double-check the digits.');
    return { columns, rows, csv: toCsv(columns, rows), notes };
  }

  /* a table is "poor" if it has no rows or nothing numeric to chart */
  function isPoor(org) {
    if (!org || !org.rows || !org.rows.length || !org.columns || !org.columns.length) return true;
    return !org.columns.some((c) => numericShare(org.rows.map((r) => r[c])) >= 0.6);
  }

  /* ---------- prompts ---------- */
  const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  function normalizePromptText(t) {
    let s = String(t || '').trim().replace(/\s+/g, ' ');
    s = s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=\s+(?:months?|weeks?|years?|quarters?|days?|channels?|regions?|products?))/gi, (m) => String(WORD_NUM[m.toLowerCase()]));
    s = s.replace(/\bwks?\b/gi, 'weeks').replace(/\bmos?\b/gi, 'months').replace(/\byrs?\b/gi, 'years');
    s = s.replace(/[₹$€£]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|lakh|lakhs|cr|crore)?/gi, (m) => { const n = parseNumber(m); return n === null ? m : String(n); });
    s = s.replace(/\b(\d+(?:\.\d+)?)\s?k\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1000)));
    s = s.replace(/\b(\d+(?:\.\d+)?)\s?(?:lakh|lakhs|lac)\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1e5)));
    s = s.replace(/\(([^()]*\/[^()]*)\)/g, (_, inner) => '(' + inner.split('/').map((x) => x.trim()).filter(Boolean).join(', ') + ')');
    return s;
  }

  function organizePrompt(text) {
    const original = String(text || '').trim();
    const notes = [];

    // 1) multi-line pasted rows
    if (/\n/.test(original)) {
      const r = organizeText(original);
      if (!r.error && r.rows.length >= 2 && !isPoor(r)) { r.notes.unshift('Your prompt contained a table, so it was charted as real data.'); return Object.assign({ mode: 'data' }, r); }
    }
    // 2) inline "Jan 24000, Feb 31k, Mar 28,500"
    const body = original.replace(/^[^:]*?(?:data|numbers|sales|revenue)[^:]*:\s*/i, (m) => (/\d/.test(m) ? '' : m));
    const segs = body.split(/\s*[;,]\s*(?=[A-Za-z])|\s*\n\s*/).map((x) => x.trim()).filter(Boolean);
    const pairs = segs.map((sg) => {
      const m = sg.match(/^([A-Za-z][A-Za-z .&'\-]*?)\s*[:=\-–]?\s*((?:[₹$€£]\s?)?\(?\d[\d,]*(?:\.\d+)?\)?\s?(?:k|m|lakh|cr)?%?)\.?$/i);
      return m && parseNumber(m[2]) !== null ? [m[1].trim(), parseNumber(m[2])] : null;
    });
    if (segs.length >= 3 && pairs.every(Boolean)) {
      const label = pairs.every((p) => monthIdx(p[0]) >= 0) ? 'Month' : 'Label';
      const columns = [label, 'Value'];
      const rows = pairs.map((p) => ({ [label]: p[0], Value: String(p[1]) }));
      notes.push('Found ' + rows.length + ' data points inside your prompt and turned them into a table.');
      return { mode: 'data', columns, rows, csv: toCsv(columns, rows), notes };
    }

    // 3) plain-language description
    const prompt = normalizePromptText(original);
    if (prompt !== original) notes.push('Tidied shorthand in your prompt (numbers, units, lists).');
    return { mode: 'prompt', prompt, notes };
  }

  return { organizeText, organizePrompt, isPoor, isDateLike, periodKey, parseNumber };
});
