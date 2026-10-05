/* Ledgerview backend.
 *
 * Serves the site and powers the dashboard builder, accounts and saved work:
 *   GET    /api/health                 -> { ok, ai }
 *   POST   /api/auth/signup            -> { token, user }
 *   POST   /api/auth/login             -> { token, user }
 *   POST   /api/auth/logout            -> { ok }
 *   GET    /api/auth/me                -> { user }
 *   GET    /api/workspace              -> { workspace }   last inputs + last dashboard (per user)
 *   PUT    /api/workspace              -> { ok }
 *   POST   /api/extract-image          -> { columns, rows, csv, notes }   (needs ANTHROPIC_API_KEY)
 *   POST   /api/organize               -> { columns, rows, csv, notes }   messy text -> tidy table
 *   POST   /api/dashboards/generate    -> { spec }        (mode: "data" | "prompt")
 *   GET    /api/dashboards             -> { dashboards }  (logged-in user's own)
 *   POST   /api/dashboards             -> { ok }
 *   DELETE /api/dashboards/:id         -> { ok }
 *   PUT    /api/account/profile        -> { user }        change name / company
 *   POST   /api/account/password       -> { ok }          change password (signs out other devices)
 *   PUT    /api/account/plan           -> { user }        switch subscription plan
 *   POST   /api/account/logout-all     -> { ok }          sign out of every device
 *   DELETE /api/account                -> { ok }          delete account + saved data (needs password)
 *
 * Storage is plain JSON files in ./data (users, sessions, dashboards) — fine for a demo or
 * small team; swap readJSON/writeJSON for a real database when you outgrow it.
 * Passwords are hashed with scrypt; session tokens are random and stored only as SHA-256 hashes.
 */
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LVO = require('./organizer');

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
const DASH_FILE = path.join(DATA_DIR, 'dashboards.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SESSION_MS = 30 * 24 * 3600 * 1000;

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '15mb' })); // images arrive as base64

/* Only serve the site's own files — never the whole folder (that would expose data/users.json and server.js). */
const PUBLIC_FILES = ['index.html', 'style.css', 'script.js', 'dashboard.js', 'auth.js', 'profile.js', 'organizer.js'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
PUBLIC_FILES.forEach((f) => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));

/* ---------------- storage ---------------- */

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/* ---------------- auth ---------------- */

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function verifyPassword(pw, user) {
  const a = Buffer.from(hashPassword(pw, user.salt), 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, company: u.company || '', plan: u.plan || 'Free', createdAt: u.createdAt || null, planSince: u.planSince || u.createdAt || null });

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const sessions = readJSON(SESSIONS_FILE, {});
  Object.keys(sessions).forEach((k) => { if (sessions[k].exp < now) delete sessions[k]; });
  sessions[sha(token)] = { userId, exp: now + SESSION_MS };
  writeJSON(SESSIONS_FILE, sessions);
  return token;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function userFromReq(req) {
  const t = bearer(req);
  if (!t) return null;
  const s = readJSON(SESSIONS_FILE, {})[sha(t)];
  if (!s || s.exp < Date.now()) return null;
  return readJSON(USERS_FILE, []).find((u) => u.id === s.userId) || null;
}
function requireAuth(req, res, next) {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  req.user = u;
  next();
}

const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests — please wait a bit and try again.' });
    arr.push(now); hits.set(k, arr);
    next();
  };
}

/* ---------------- shared helpers (mirrors dashboard.js) ---------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isNumericValue(v) {
  if (v === null || v === undefined || v === '') return false;
  const cleaned = String(v).replace(/[,₹$€£\s]/g, '');
  return cleaned !== '' && !isNaN(Number(cleaned)) && isFinite(Number(cleaned));
}
function toNumber(v) { return Number(String(v).replace(/[,₹$€£\s]/g, '')); }
function isDateLikeValue(v) { return LVO.isDateLike(v); }

function detectColumnTypes(columns, rows) {
  const types = {};
  columns.forEach((col) => {
    const sample = rows.slice(0, 30).map((r) => r[col]).filter((v) => v !== '' && v != null);
    if (sample.length === 0) { types[col] = 'category'; return; }
    const numericCount = sample.filter(isNumericValue).length;
    const dateCount = sample.filter(isDateLikeValue).length;
    if (/^(?:year|yr|fy|period)$/i.test(col) && numericCount === sample.length && sample.every((v) => /^(19|20)\d{2}$/.test(String(v).trim()))) types[col] = 'date';
    else if (numericCount / sample.length >= 0.8) types[col] = 'number';
    else if (dateCount / sample.length >= 0.6) types[col] = 'date';
    else types[col] = 'category';
  });
  return types;
}

function groupSum(rows, catField, numField, { maxGroups = 10, sortMode = 'value' } = {}) {
  const totals = new Map();
  rows.forEach((r) => {
    const key = (r[catField] ?? '').toString().trim() || '(blank)';
    const val = isNumericValue(r[numField]) ? toNumber(r[numField]) : 0;
    totals.set(key, (totals.get(key) || 0) + val);
  });
  let entries = Array.from(totals.entries());
  if (sortMode === 'period') {
    const keyed = entries.map((e) => [e, LVO.periodKey(e[0])]);
    if (keyed.every((k) => k[1] !== null)) entries = keyed.sort((x, y) => x[1] - y[1]).map((k) => k[0]);
  } else {
    entries.sort((x, y) => y[1] - x[1]);
  }
  if (entries.length > maxGroups) {
    const head = entries.slice(0, maxGroups - 1);
    const restTotal = entries.slice(maxGroups - 1).reduce((s, [, v]) => s + v, 0);
    entries = [...head, ['Other', restTotal]];
  }
  return { labels: entries.map((e) => e[0]), values: entries.map((e) => Math.round(e[1] * 100) / 100) };
}

function fmtNumber(n) { return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildDashboardFromRows(columns, rows) {
  const types = detectColumnTypes(columns, rows);
  const numberCols = columns.filter((c) => types[c] === 'number');
  const dateCols = columns.filter((c) => types[c] === 'date');
  const categoryCols = columns.filter((c) => types[c] === 'category');
  if (numberCols.length === 0) throw new Error('No numeric column found to chart.');

  const primaryNum = numberCols[0];
  const charts = [];
  const insights = [];

  let dateSeries = null;
  if (dateCols.length > 0) {
    const dateCol = dateCols[0];
    dateSeries = groupSum(rows, dateCol, primaryNum, { maxGroups: 24, sortMode: 'period' });
    charts.push({ type: 'line', title: `${primaryNum} over ${dateCol}`, labels: dateSeries.labels, series: [{ label: primaryNum, data: dateSeries.values }], wide: true });
  }

  let groupCol = null, groupCardinality = Infinity;
  categoryCols.forEach((c) => {
    const uniq = new Set(rows.map((r) => (r[c] ?? '').toString().trim())).size;
    if (uniq >= 2 && uniq <= 15 && uniq < groupCardinality) { groupCol = c; groupCardinality = uniq; }
  });

  let primaryGroupLabels = null, primaryGroupValues = null, topIdx = -1, bottomIdx = -1;
  if (groupCol) {
    const { labels, values } = groupSum(rows, groupCol, primaryNum, { maxGroups: 10 });
    primaryGroupLabels = labels; primaryGroupValues = values;
    topIdx = values.indexOf(Math.max(...values));
    bottomIdx = values.indexOf(Math.min(...values));
    charts.push({ type: 'bar', title: `${primaryNum} by ${groupCol}`, labels, series: [{ label: primaryNum, data: values }] });
    if (labels.length <= 7) charts.push({ type: 'doughnut', title: `Share of ${primaryNum} by ${groupCol}`, labels, series: [{ label: primaryNum, data: values }] });
  }

  let secondGroupCol = null, secondGroupCardinality = Infinity;
  categoryCols.forEach((c) => {
    if (c === groupCol) return;
    const uniq = new Set(rows.map((r) => (r[c] ?? '').toString().trim())).size;
    if (uniq >= 2 && uniq <= 10 && uniq < secondGroupCardinality) { secondGroupCol = c; secondGroupCardinality = uniq; }
  });
  if (secondGroupCol) {
    const { labels, values } = groupSum(rows, secondGroupCol, primaryNum, { maxGroups: 8 });
    charts.push({ type: 'bar', title: `${primaryNum} by ${secondGroupCol}`, labels, series: [{ label: primaryNum, data: values }], horizontal: true });
  }

  const numericValues = rows.map((r) => (isNumericValue(r[primaryNum]) ? toNumber(r[primaryNum]) : 0));
  const total = numericValues.reduce((s, v) => s + v, 0);
  const avg = total / rows.length;
  const med = median(numericValues);
  const minVal = Math.min(...numericValues);
  const maxVal = Math.max(...numericValues);

  const stats = [
    { label: 'Rows', value: String(rows.length) },
    { label: `Total ${primaryNum}`, value: fmtNumber(total) },
    { label: `Average ${primaryNum}`, value: fmtNumber(avg) },
    { label: `Median ${primaryNum}`, value: fmtNumber(med) },
  ];

  if (dateSeries && dateSeries.values.length >= 2) {
    const first = dateSeries.values[0], last = dateSeries.values[dateSeries.values.length - 1];
    if (first !== 0) {
      const growthPct = ((last - first) / Math.abs(first)) * 100;
      stats.push({ label: `${primaryNum} trend`, value: (growthPct >= 0 ? '+' : '') + growthPct.toFixed(1) + '%', trend: growthPct >= 0 ? 'up' : 'down' });
      insights.push(`${primaryNum} ${growthPct >= 0 ? 'grew' : 'declined'} ${Math.abs(growthPct).toFixed(1)}% from ${dateSeries.labels[0]} to ${dateSeries.labels[dateSeries.labels.length - 1]}.`);
    }
  }

  if (groupCol) {
    stats.push({ label: `Top ${groupCol}`, value: primaryGroupLabels[topIdx] });
    stats.push({ label: `Unique ${groupCol}`, value: String(groupCardinality) });
    const topShare = total !== 0 ? (primaryGroupValues[topIdx] / total) * 100 : 0;
    insights.push(`${groupCol} "${primaryGroupLabels[topIdx]}" leads with ${fmtNumber(primaryGroupValues[topIdx])} — about ${topShare.toFixed(0)}% of total ${primaryNum}.`);
    if (groupCardinality > 1) {
      insights.push(`"${primaryGroupLabels[bottomIdx]}" is the lowest ${groupCol}, at ${fmtNumber(primaryGroupValues[bottomIdx])}.`);
    }
  }
  insights.push(`${primaryNum} per row ranges from ${fmtNumber(minVal)} to ${fmtNumber(maxVal)}, averaging ${fmtNumber(avg)}.`);

  return {
    title: `Dashboard — ${rows.length} rows`,
    source: 'data',
    stats: stats.slice(0, 7),
    charts: charts.slice(0, 5),
    insights: insights.slice(0, 3),
    table: { columns, rows: rows.slice(0, 10), totalRows: rows.length },
  };
}

function ruleBasedFromPrompt(promptText) {
  const prompt = String(promptText || '').trim();
  if (prompt.length < 8) throw new Error('Prompt is too short to build anything from.');

  const rangeMatch = prompt.match(/(\d[\d,]{2,})\s*(?:to|-|–|and)\s*(\d[\d,]{2,})/);
  let range = [1000, 10000];
  if (rangeMatch) {
    const a = Number(rangeMatch[1].replace(/,/g, '')), b = Number(rangeMatch[2].replace(/,/g, ''));
    if (a && b) range = [Math.min(a, b), Math.max(a, b)];
  }

  const listMatch = prompt.match(/(?:by|categories?|channels?|breakdown of)\s*[a-z\s]*?:\s*([^.\n]+)/i);
  const categories = listMatch
    ? listMatch[1].split(',').map((s) => s.trim().replace(/\b\w/g, (c) => c.toUpperCase())).filter(Boolean).slice(0, 10)
    : ['Category A', 'Category B', 'Category C'];

  const n = /month/i.test(prompt) ? 6 : /week/i.test(prompt) ? 8 : /quarter/i.test(prompt) ? 4 : 6;
  const timeLabels = /quarter/i.test(prompt) ? ['Q1', 'Q2', 'Q3', 'Q4'] : Array.from({ length: n }, (_, i) => (/week/i.test(prompt) ? `Week ${i + 1}` : MONTHS[i % 12]));

  const metricMatch = prompt.match(/\b(revenue|sales|profit|users|signups|orders|spend|cost|expenses|traffic|leads)\b/i);
  const metric = metricMatch ? metricMatch[1][0].toUpperCase() + metricMatch[1].slice(1).toLowerCase() : 'Value';

  const trendData = timeLabels.map(() => Math.round(range[0] + Math.random() * (range[1] - range[0])));
  const catData = categories.map(() => Math.round(range[0] + Math.random() * (range[1] - range[0])));

  const charts = [
    { type: 'line', title: `${metric} over time`, labels: timeLabels, series: [{ label: metric, data: trendData }], wide: true },
    { type: 'bar', title: `${metric} by category`, labels: categories, series: [{ label: metric, data: catData }] },
  ];
  if (categories.length <= 7) charts.push({ type: 'doughnut', title: `Share of ${metric}`, labels: categories, series: [{ label: metric, data: catData }] });

  const total = trendData.reduce((s, v) => s + v, 0);
  const topCatIdx = catData.indexOf(Math.max(...catData));
  const first = trendData[0], last = trendData[trendData.length - 1];
  const stats = [
    { label: `Total ${metric}`, value: fmtNumber(total) },
    { label: `Average ${metric}`, value: fmtNumber(total / trendData.length) },
    { label: 'Categories', value: String(categories.length) },
    { label: 'Top category', value: categories[topCatIdx] },
  ];
  const insights = [`"${categories[topCatIdx]}" comes out on top for ${metric.toLowerCase()} in this illustrative example.`];
  if (first) {
    const growthPct = ((last - first) / Math.abs(first)) * 100;
    stats.push({ label: `${metric} trend`, value: (growthPct >= 0 ? '+' : '') + growthPct.toFixed(1) + '%', trend: growthPct >= 0 ? 'up' : 'down' });
    insights.unshift(`${metric} ${growthPct >= 0 ? 'trends up' : 'trends down'} ${Math.abs(growthPct).toFixed(1)}% from ${timeLabels[0]} to ${timeLabels[timeLabels.length - 1]} in this illustrative run.`);
  }

  return {
    title: 'Dashboard: ' + (prompt.length > 60 ? prompt.slice(0, 57).trim() + '…' : prompt),
    source: 'prompt',
    disclaimer: 'These numbers are illustrative, generated from your description rather than real records.',
    stats: stats.slice(0, 6),
    charts,
    insights: insights.slice(0, 2),
  };
}

/* ---------------- optional real-AI generation via Claude ---------------- */

async function claudeFromPrompt(promptText) {
  const systemPrompt = `You turn a short business description (which may be informal, messy or full of shorthand) into a dashboard spec. Respond with ONLY valid JSON, no prose, no markdown fences, matching exactly this shape:
{
  "title": string,
  "stats": [{"label": string, "value": string, "trend": "up"|"down" (optional)}]  (3-6 items — include at least one trend/growth stat when there's a time series),
  "charts": [
    {"type": "bar"|"line"|"pie"|"doughnut", "title": string, "labels": string[], "series": [{"label": string, "data": number[]}], "wide": boolean}
  ] (2-4 items, "wide" true only for the line chart if present). Prefer "doughnut" over "pie" for share breakdowns.
  "insights": string[] (1-3 short one-sentence takeaways about the numbers, e.g. growth, a leading category)
}
Use realistic-looking numbers consistent with anything the user specifies (ranges, time periods, category names). Keep labels short.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: promptText }],
    }),
  });
  if (!res.ok) throw new Error('Claude API request failed: ' + res.status);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  const spec = JSON.parse(cleaned);
  spec.source = 'prompt';
  return spec;
}

/* ---------------- Claude helpers (optional) ---------------- */

async function callClaude({ system, content, max_tokens = 1500 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens, system, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error('Claude API request failed: ' + res.status);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

const TABLE_SYSTEM = `You extract or restructure tabular data. Respond with ONLY valid JSON, no prose, no fences:
{"columns": string[], "rows": string[][], "notes": string}
Rules: exactly one header row; every row has the same number of cells as columns; copy values exactly as they appear (keep digits, do not round or invent anything); ignore titles, page furniture, footnotes and total/average rows; if the input has no usable table, return {"columns": [], "rows": [], "notes": "why"}.`;

function claudeTableToText(t) {
  if (!t || !Array.isArray(t.columns) || !t.columns.length || !Array.isArray(t.rows) || !t.rows.length) return '';
  const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [t.columns.map(q).join(',')].concat(t.rows.map((r) => t.columns.map((_, i) => q(r[i])).join(','))).join('\n');
}

/* ---------------- routes ---------------- */

app.get('/api/health', (req, res) => res.json({ ok: true, ai: !!ANTHROPIC_API_KEY }));

/* accounts */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/signup', limit('signup', 10, 3600e3), (req, res) => {
  const { name, email, company, plan, password } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!String(name || '').trim() || !EMAIL_RE.test(e) || String(password || '').length < 8)
    return res.status(400).json({ error: 'Enter your name, a valid email and a password of at least 8 characters.' });
  const users = readJSON(USERS_FILE, []);
  if (users.some((u) => u.email === e)) return res.status(409).json({ error: 'An account with that email already exists — log in instead.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(), name: String(name).trim().slice(0, 80), email: e, company: String(company || '').trim().slice(0, 80),
    plan: ['Free', 'Pro', 'Business'].includes(plan) ? plan : 'Free', salt, hash: hashPassword(String(password), salt),
    createdAt: new Date().toISOString(), workspace: null,
  };
  users.push(user);
  writeJSON(USERS_FILE, users);
  res.json({ token: newSession(user.id), user: publicUser(user) });
});

app.post('/api/auth/login', limit('login', 20, 900e3), (req, res) => {
  const { email, password } = req.body || {};
  const user = readJSON(USERS_FILE, []).find((u) => u.email === String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user)) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ token: newSession(user.id), user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const t = bearer(req);
  if (t) { const s = readJSON(SESSIONS_FILE, {}); delete s[sha(t)]; writeJSON(SESSIONS_FILE, s); }
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

/* remembered work: last inputs + last dashboard */
app.get('/api/workspace', requireAuth, (req, res) => res.json({ workspace: req.user.workspace || null }));

app.put('/api/workspace', requireAuth, (req, res) => {
  const ws = (req.body || {}).workspace;
  if (!ws || typeof ws !== 'object') return res.status(400).json({ error: 'workspace is required.' });
  if (JSON.stringify(ws).length > 2e6) return res.status(413).json({ error: 'Workspace too large.' });
  const users = readJSON(USERS_FILE, []);
  const u = users.find((x) => x.id === req.user.id);
  u.workspace = ws;
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

/* image -> table (needs a Claude key; the browser falls back to on-device OCR otherwise) */
app.post('/api/extract-image', limit('extract', 15, 600e3), async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(501).json({ error: 'AI image reading is not configured on this server.' });
  const m = String((req.body || {}).image || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Send the image as a base64 data URL (jpeg, png, webp or gif).' });
  try {
    const t = await callClaude({
      system: TABLE_SYSTEM, max_tokens: 4000,
      content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: 'Extract the data table from this image.' }],
    });
    const text = claudeTableToText(t);
    if (!text) return res.status(422).json({ error: t && t.notes ? String(t.notes) : 'No table found in that image.' });
    const r = LVO.organizeText(text);
    if (r.error || !r.rows.length) return res.status(422).json({ error: r.error || 'No table found in that image.' });
    r.notes.unshift('Read the table from your image with Claude, then organized it.');
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: 'Couldn’t read that image right now.' });
  }
});

/* messy text -> tidy table */
app.post('/api/organize', limit('organize', 30, 600e3), async (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 500000);
  let r = LVO.organizeText(text);
  if (LVO.isPoor(r) && ANTHROPIC_API_KEY) {
    try {
      const t = await callClaude({ system: TABLE_SYSTEM, max_tokens: 4000, content: 'Restructure this messy data into a clean table:\n\n' + text.slice(0, 30000) });
      const r2 = LVO.organizeText(claudeTableToText(t));
      if (!LVO.isPoor(r2)) { r2.notes.unshift('Your data was messy, so Claude restructured it into a table first.'); r = r2; }
    } catch { /* keep the rule-based result */ }
  }
  if (r.error || !r.rows.length) return res.status(422).json({ error: r.error || 'Couldn’t find a table in that data.' });
  res.json(r);
});

/* dashboards */
app.post('/api/dashboards/generate', async (req, res) => {
  try {
    const { mode, columns, rows, prompt } = req.body || {};
    if (mode === 'data') {
      if (!Array.isArray(columns) || !Array.isArray(rows)) return res.status(400).json({ error: 'columns and rows are required for mode "data".' });
      return res.json({ spec: buildDashboardFromRows(columns, rows.slice(0, 20000)) });
    }
    if (mode === 'prompt') {
      if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt is required for mode "prompt".' });
      const org = LVO.organizePrompt(prompt);
      if (org.mode === 'data') {
        const spec = buildDashboardFromRows(org.columns, org.rows);
        spec.organize = { notes: org.notes };
        return res.json({ spec });
      }
      let spec = null;
      if (ANTHROPIC_API_KEY) { try { spec = await claudeFromPrompt(org.prompt); } catch { /* fall back below */ } }
      if (!spec) spec = ruleBasedFromPrompt(org.prompt);
      spec.organize = { notes: org.notes };
      return res.json({ spec });
    }
    return res.status(400).json({ error: 'mode must be "data" or "prompt".' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/dashboards', requireAuth, (req, res) => {
  const list = readJSON(DASH_FILE, []).filter((d) => d.userId === req.user.id).map(({ userId, ...d }) => d);
  res.json({ dashboards: list });
});

app.post('/api/dashboards', requireAuth, (req, res) => {
  const { id, createdAt, spec } = req.body || {};
  if (!spec) return res.status(400).json({ error: 'spec is required.' });
  const all = readJSON(DASH_FILE, []);
  const mine = all.filter((d) => d.userId === req.user.id);
  const others = all.filter((d) => d.userId !== req.user.id);
  mine.unshift({ id: id || crypto.randomUUID(), userId: req.user.id, createdAt: createdAt || new Date().toISOString(), spec });
  writeJSON(DASH_FILE, others.concat(mine.slice(0, 50)));
  res.json({ ok: true });
});

app.delete('/api/dashboards/:id', requireAuth, (req, res) => {
  writeJSON(DASH_FILE, readJSON(DASH_FILE, []).filter((d) => !(d.id === req.params.id && d.userId === req.user.id)));
  res.json({ ok: true });
});

/* account management (profile page) */
const PLANS = ['Free', 'Pro', 'Business'];

function updateUser(id, fn) {
  const users = readJSON(USERS_FILE, []);
  const u = users.find((x) => x.id === id);
  if (!u) return null;
  fn(u);
  writeJSON(USERS_FILE, users);
  return u;
}
function dropSessions(userId, keepHash) {
  const sessions = readJSON(SESSIONS_FILE, {});
  Object.keys(sessions).forEach((k) => { if (sessions[k].userId === userId && k !== keepHash) delete sessions[k]; });
  writeJSON(SESSIONS_FILE, sessions);
}

app.put('/api/account/profile', requireAuth, (req, res) => {
  const { name, company } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Your name can’t be empty.' });
  const u = updateUser(req.user.id, (x) => { x.name = String(name).trim().slice(0, 80); x.company = String(company || '').trim().slice(0, 80); });
  res.json({ user: publicUser(u) });
});

app.post('/api/account/password', requireAuth, limit('password', 10, 900e3), (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user)) return res.status(401).json({ error: 'Your current password is incorrect.' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'The new password needs at least 8 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  updateUser(req.user.id, (x) => { x.salt = salt; x.hash = hashPassword(String(next), salt); });
  dropSessions(req.user.id, sha(bearer(req))); // every other device must log in again
  res.json({ ok: true });
});

app.put('/api/account/plan', requireAuth, (req, res) => {
  const plan = String((req.body || {}).plan || '');
  if (!PLANS.includes(plan)) return res.status(400).json({ error: 'Unknown plan.' });
  const u = updateUser(req.user.id, (x) => { if ((x.plan || 'Free') !== plan) { x.plan = plan; x.planSince = new Date().toISOString(); } });
  res.json({ user: publicUser(u) });
});

app.post('/api/account/logout-all', requireAuth, (req, res) => {
  dropSessions(req.user.id, null);
  res.json({ ok: true });
});

app.delete('/api/account', requireAuth, limit('delete', 5, 900e3), (req, res) => {
  if (!verifyPassword(String((req.body || {}).password || ''), req.user)) return res.status(401).json({ error: 'Incorrect password.' });
  dropSessions(req.user.id, null);
  writeJSON(USERS_FILE, readJSON(USERS_FILE, []).filter((u) => u.id !== req.user.id));
  writeJSON(DASH_FILE, readJSON(DASH_FILE, []).filter((d) => d.userId !== req.user.id));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Ledgerview running at http://localhost:${PORT}`);
  console.log(ANTHROPIC_API_KEY
    ? 'AI (image reading, prompt generation, messy-data restructuring): ON'
    : 'AI: OFF — images are read by in-browser OCR and prompts by the rule-based generator. Set ANTHROPIC_API_KEY to enable Claude.');
});
