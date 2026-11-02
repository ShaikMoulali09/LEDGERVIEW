/* Ledgerview dashboard builder.
   Two ways in: real data (CSV / pasted rows / an image of a table — all organized first) or a
   plain-language prompt (tidied first).
   Both paths produce the same "dashboard spec" — { title, stats[], charts[] } —
   which is what actually gets rendered as charts.

   This talks to the optional Express backend in server.js first (POST /api/dashboards/generate,
   /api/dashboards for saving). If that backend isn't running — e.g. you just opened index.html
   directly — every feature still works: the exact same logic runs in the browser instead, and
   saved dashboards live in localStorage. Run `node server.js` to get persistence across devices
   and, if ANTHROPIC_API_KEY is set, real AI-generated dashboards from the prompt tab instead of
   the rule-based generator described below. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const CHART_COLORS = ['#FF4B3E', '#5B8DEF', '#F2C94C', '#2FA88A', '#C792EA', '#E0A100', '#4FC1E9', '#C4589A', '#8FD694', '#7B6FE0'];

  let activeCharts = [];   // Chart.js instances currently on screen, so we can destroy before re-render
  let lastSpec = null;     // most recently built dashboard, for the Save button

  /* ================= column type detection ================= */

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function isNumericValue(v) {
    if (v === null || v === undefined || v === '') return false;
    const cleaned = String(v).replace(/[,₹$€£\s]/g, '');
    return cleaned !== '' && !isNaN(Number(cleaned)) && isFinite(Number(cleaned));
  }
  function toNumber(v) {
    return Number(String(v).replace(/[,₹$€£\s]/g, ''));
  }
  function isDateLikeValue(v) { return LVOrganize.isDateLike(v); }

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

  /* ================= aggregation helpers ================= */

  function monthSortIndex(label) {
    const s = String(label).trim().toLowerCase().slice(0, 3);
    const i = MONTHS.indexOf(s);
    return i === -1 ? 999 : i;
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
      const keyed = entries.map((e) => [e, LVOrganize.periodKey(e[0])]);
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

  function fmtNumber(n) {
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /* ================= build a dashboard spec from real rows ================= */

  function buildDashboardFromRows(columns, rows) {
    const types = detectColumnTypes(columns, rows);
    const numberCols = columns.filter((c) => types[c] === 'number');
    const dateCols = columns.filter((c) => types[c] === 'date');
    const categoryCols = columns.filter((c) => types[c] === 'category');

    if (numberCols.length === 0) {
      throw new Error('Couldn\u2019t find a numeric column to chart — add a column of numbers (revenue, count, etc).');
    }

    const primaryNum = numberCols[0];
    const charts = [];
    const insights = [];

    // line chart: first date column x primary number, summed per date
    let dateCol = null, dateSeries = null;
    if (dateCols.length > 0) {
      dateCol = dateCols[0];
      dateSeries = groupSum(rows, dateCol, primaryNum, { maxGroups: 24, sortMode: 'period' });
      charts.push({ type: 'line', title: `${primaryNum} over ${dateCol}`, labels: dateSeries.labels, series: [{ label: primaryNum, data: dateSeries.values }], wide: true });
    }

    // pick the lowest-cardinality category column for grouping
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
      if (labels.length <= 7) {
        charts.push({ type: 'doughnut', title: `Share of ${primaryNum} by ${groupCol}`, labels, series: [{ label: primaryNum, data: values }] });
      }
    } else if (numberCols.length > 1) {
      // no usable category column — compare the numeric columns against each other instead
      const labels = numberCols.slice(0, 6);
      const values = labels.map((c) => Math.round(rows.reduce((s, r) => s + (isNumericValue(r[c]) ? toNumber(r[c]) : 0), 0) * 100) / 100);
      charts.push({ type: 'bar', title: 'Totals by column', labels, series: [{ label: 'Total', data: values }] });
    }

    // a second, different category column — genuinely new information, not a repeat of the first breakdown
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

    let growthPct = null;
    if (dateSeries && dateSeries.values.length >= 2) {
      const first = dateSeries.values[0], last = dateSeries.values[dateSeries.values.length - 1];
      if (first !== 0) {
        growthPct = ((last - first) / Math.abs(first)) * 100;
        stats.push({ label: `${primaryNum} trend`, value: (growthPct >= 0 ? '+' : '') + growthPct.toFixed(1) + '%', trend: growthPct >= 0 ? 'up' : 'down' });
        insights.push(`${primaryNum} ${growthPct >= 0 ? 'grew' : 'declined'} ${Math.abs(growthPct).toFixed(1)}% from ${dateSeries.labels[0]} to ${dateSeries.labels[dateSeries.labels.length - 1]}.`);
      }
    }

    if (groupCol) {
      stats.push({ label: `Top ${groupCol}`, value: primaryGroupLabels[topIdx] });
      stats.push({ label: `Unique ${groupCol}`, value: String(groupCardinality) });
      const topShare = total !== 0 ? (primaryGroupValues[topIdx] / total) * 100 : 0;
      insights.push(`${groupCol} \u201c${primaryGroupLabels[topIdx]}\u201d leads with ${fmtNumber(primaryGroupValues[topIdx])} \u2014 about ${topShare.toFixed(0)}% of total ${primaryNum}.`);
      if (groupCardinality > 1) {
        insights.push(`\u201c${primaryGroupLabels[bottomIdx]}\u201d is the lowest ${groupCol}, at ${fmtNumber(primaryGroupValues[bottomIdx])}.`);
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

  /* ================= build a dashboard spec from a prompt (rule-based) ================= */

  const DEFAULT_CATEGORY_SETS = [
    { test: /channel/i, list: ['Dine-in', 'Takeaway', 'Delivery'] },
    { test: /region/i, list: ['North', 'South', 'East', 'West'] },
    { test: /product/i, list: ['Product A', 'Product B', 'Product C'] },
    { test: /(marketing|campaign)/i, list: ['Social', 'Search', 'Email', 'Referral'] },
    { test: /department|team/i, list: ['Sales', 'Marketing', 'Support', 'Engineering'] },
  ];

  function extractRange(prompt) {
    const m = prompt.match(/(\d[\d,]{2,})\s*(?:to|-|–|and)\s*(\d[\d,]{2,})/);
    if (m) {
      const a = Number(m[1].replace(/,/g, ''));
      const b = Number(m[2].replace(/,/g, ''));
      if (a && b) return [Math.min(a, b), Math.max(a, b)];
    }
    const single = prompt.match(/(?:around|about|roughly|~)\s*(\d[\d,]{2,})/i);
    if (single) {
      const v = Number(single[1].replace(/,/g, ''));
      if (v) return [Math.round(v * 0.7), Math.round(v * 1.3)];
    }
    return [1000, 10000];
  }

  function extractExplicitList(prompt) {
    // "by channel: dine-in, takeaway, delivery" or "categories: a, b, c"
    const m = prompt.match(/(?:by|categories?|channels?|breakdown of)\s*[a-z\s]*?:\s*([^.\n]+)/i);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 10) return parts.map(titleCase);
    return null;
  }

  function titleCase(s) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function extractTimeSeries(prompt) {
    const monthMatch = prompt.match(/(\d+)\s*month/i);
    const weekMatch = prompt.match(/(\d+)\s*week/i);
    const quarterHint = /quarter/i.test(prompt);
    const dayMatch = prompt.match(/(\d+)\s*day/i);

    if (/month/i.test(prompt)) {
      const n = Math.min(monthMatch ? Number(monthMatch[1]) : 6, 12);
      return Array.from({ length: n }, (_, i) => titleCase(MONTHS[i % 12]));
    }
    if (/week/i.test(prompt)) {
      const n = Math.min(weekMatch ? Number(weekMatch[1]) : 6, 12);
      return Array.from({ length: n }, (_, i) => `Week ${i + 1}`);
    }
    if (quarterHint) return ['Q1', 'Q2', 'Q3', 'Q4'];
    if (/day/i.test(prompt)) {
      const n = Math.min(dayMatch ? Number(dayMatch[1]) : 7, 14);
      return Array.from({ length: n }, (_, i) => `Day ${i + 1}`);
    }
    return null;
  }

  function randomWalk(n, [lo, hi]) {
    const vals = [];
    let cur = lo + Math.random() * (hi - lo);
    for (let i = 0; i < n; i++) {
      cur += (hi - lo) * (Math.random() - 0.35) * 0.25; // gentle upward-biased drift
      cur = Math.min(hi * 1.15, Math.max(lo * 0.6, cur));
      vals.push(Math.round(cur));
    }
    return vals;
  }

  function randomSplit(n, [lo, hi]) {
    return Array.from({ length: n }, () => Math.round(lo + Math.random() * (hi - lo)));
  }

  function buildDashboardFromPrompt(promptText) {
    const prompt = promptText.trim();
    if (prompt.length < 8) throw new Error('Add a bit more detail — what should this dashboard track?');

    const range = extractRange(prompt);
    const timeLabels = extractTimeSeries(prompt);
    let categories = extractExplicitList(prompt);
    if (!categories) {
      const preset = DEFAULT_CATEGORY_SETS.find((p) => p.test.test(prompt));
      categories = preset ? preset.list : null;
    }

    const charts = [];
    const wantsShare = /(share|breakdown|distribution|split)/i.test(prompt);
    const wantsTrend = /(trend|over time|growth|month|week|quarter|day)/i.test(prompt) || !!timeLabels;

    const metricMatch = prompt.match(/\b(revenue|sales|profit|users|signups|orders|spend|cost|expenses|traffic|leads)\b/i);
    const metric = metricMatch ? titleCase(metricMatch[1].toLowerCase()) : 'Value';

    if (wantsTrend) {
      const labels = timeLabels || Array.from({ length: 6 }, (_, i) => titleCase(MONTHS[i]));
      charts.push({ type: 'line', title: `${metric} over time`, labels, series: [{ label: metric, data: randomWalk(labels.length, range) }], wide: true });
    }

    if (categories) {
      const values = randomSplit(categories.length, range);
      charts.push({ type: 'bar', title: `${metric} by category`, labels: categories, series: [{ label: metric, data: values }] });
      if (categories.length <= 7 && (wantsShare || !wantsTrend)) {
        charts.push({ type: 'doughnut', title: `Share of ${metric}`, labels: categories, series: [{ label: metric, data: values }] });
      }
    }

    if (charts.length === 0) {
      // nothing specific detected — fall back to a generic 6-month trend so the tab always produces something
      const labels = Array.from({ length: 6 }, (_, i) => titleCase(MONTHS[i]));
      charts.push({ type: 'line', title: `${metric} over time`, labels, series: [{ label: metric, data: randomWalk(6, range) }], wide: true });
    }

    const primarySeries = charts[0].series[0].data;
    const total = primarySeries.reduce((s, v) => s + v, 0);
    const avg = total / primarySeries.length;
    const peakIndex = primarySeries.indexOf(Math.max(...primarySeries));

    const title = 'Dashboard: ' + (prompt.length > 60 ? prompt.slice(0, 57).trim() + '…' : prompt);

    const stats = [
      { label: `Total ${metric}`, value: fmtNumber(total) },
      { label: `Average ${metric}`, value: fmtNumber(avg) },
      { label: 'Peak point', value: charts[0].labels[peakIndex] },
    ];
    const insights = [];
    if (wantsTrend) {
      const first = primarySeries[0], last = primarySeries[primarySeries.length - 1];
      if (first) {
        const growthPct = ((last - first) / Math.abs(first)) * 100;
        stats.push({ label: `${metric} trend`, value: (growthPct >= 0 ? '+' : '') + growthPct.toFixed(1) + '%', trend: growthPct >= 0 ? 'up' : 'down' });
        insights.push(`${metric} ${growthPct >= 0 ? 'is trending up' : 'is trending down'} ${Math.abs(growthPct).toFixed(1)}% from ${charts[0].labels[0]} to ${charts[0].labels[charts[0].labels.length - 1]} in this illustrative run.`);
      }
    }
    if (categories) {
      const catChart = charts.find((c) => c.type === 'bar' && c.title.includes('by category'));
      if (catChart) {
        const topCatIdx = catChart.series[0].data.indexOf(Math.max(...catChart.series[0].data));
        stats.push({ label: 'Top category', value: catChart.labels[topCatIdx] });
        insights.push(`"${catChart.labels[topCatIdx]}" comes out on top for ${metric.toLowerCase()} in this example.`);
      }
    }

    return {
      title,
      source: 'prompt',
      disclaimer: 'These numbers are illustrative, generated from your description rather than real records.',
      stats: stats.slice(0, 6),
      charts: charts.slice(0, 4),
      insights: insights.slice(0, 2),
    };
  }

  /* ================= rendering ================= */

  function destroyCharts() {
    activeCharts.forEach((c) => c.destroy());
    activeCharts = [];
  }

  function renderSpec(spec, opts = {}) {
    lastSpec = spec;
    destroyCharts();

    $('#dash-output-title').textContent = spec.title;
    const statsWrap = $('#dash-stats');
    statsWrap.innerHTML = spec.stats.map((s) => `
      <div class="dash-stat">
        <span class="dash-stat-value${s.trend ? ' dash-stat-trend-' + s.trend : ''}">${escapeHtml(String(s.value))}${s.trend === 'up' ? ' \u25B2' : s.trend === 'down' ? ' \u25BC' : ''}</span>
        <span class="dash-stat-label">${escapeHtml(s.label)}</span>
      </div>`).join('');

    const insightsWrap = $('#dash-insights');
    if (insightsWrap) {
      if (spec.insights && spec.insights.length) {
        insightsWrap.hidden = false;
        insightsWrap.innerHTML = '<h3 class="dash-block-label">Highlights</h3><ul class="dash-insights-list">'
          + spec.insights.map((t) => `<li>${escapeHtml(t)}</li>`).join('') + '</ul>';
      } else {
        insightsWrap.hidden = true;
        insightsWrap.innerHTML = '';
      }
    }

    const notesWrap = $('#dash-notes');
    const orgNotes = (spec.organize && spec.organize.notes) || [];
    if (orgNotes.length) {
      notesWrap.hidden = false;
      notesWrap.innerHTML = '<h3 class="dash-block-label">How Ledgerview organized this</h3><ul>' + orgNotes.map((t) => `<li>${escapeHtml(t)}</li>`).join('') + '</ul>';
    } else { notesWrap.hidden = true; notesWrap.innerHTML = ''; }
    $('#dash-save-msg').innerHTML = '';

    const chartsWrap = $('#dash-charts');
    chartsWrap.innerHTML = '';
    if (spec.disclaimer) {
      const p = document.createElement('p');
      p.className = 'dash-mode-note';
      p.style.gridColumn = '1 / -1';
      p.style.textAlign = 'left';
      p.style.margin = '0 0 4px';
      p.textContent = spec.disclaimer;
      chartsWrap.appendChild(p);
    }

    spec.charts.forEach((chart, i) => {
      const card = document.createElement('div');
      card.className = 'dash-chart-card' + (chart.wide ? ' is-wide' : '');
      const titleEl = document.createElement('h3');
      titleEl.className = 'dash-chart-title';
      titleEl.textContent = chart.title;
      const canvas = document.createElement('canvas');
      card.appendChild(titleEl);
      card.appendChild(canvas);
      chartsWrap.appendChild(card);

      const colors = chart.labels.map((_, j) => CHART_COLORS[j % CHART_COLORS.length]);
      const cfg = {
        type: chart.type,
        data: {
          labels: chart.labels,
          datasets: chart.series.map((s) => ({
            label: s.label,
            data: s.data,
            backgroundColor: chart.type === 'line' ? 'rgba(255,75,62,0.12)' : colors,
            borderColor: chart.type === 'line' ? CHART_COLORS[0] : '#F0F0F0',
            borderWidth: (chart.type === 'pie' || chart.type === 'doughnut') ? 2 : (chart.type === 'line' ? 2.5 : 0),
            tension: 0.35,
            fill: chart.type === 'line',
            pointRadius: chart.type === 'line' ? 3 : 0,
            pointBackgroundColor: CHART_COLORS[0],
            borderRadius: chart.type === 'bar' ? 4 : 0,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          aspectRatio: chart.wide ? 2.6 : 1.4,
          indexAxis: chart.horizontal ? 'y' : 'x',
          plugins: {
            legend: { display: chart.type === 'pie' || chart.type === 'doughnut', labels: { color: 'rgba(13,13,15,.72)', font: { family: 'Getsy' }, usePointStyle: true } },
          },
          scales: (chart.type === 'pie' || chart.type === 'doughnut') ? {} : {
            x: { ticks: { color: 'rgba(13,13,15,.62)', font: { family: 'Liberation Sans', size: 10 } }, grid: { display: false } },
            y: { ticks: { color: 'rgba(13,13,15,.62)', font: { family: 'Liberation Sans', size: 10 } }, grid: { color: 'rgba(13,13,15,.08)' }, beginAtZero: true },
          },
        },
      };
      activeCharts.push(new Chart(canvas.getContext('2d'), cfg));
    });

    const tableWrap = $('#dash-table-wrap');
    if (tableWrap) {
      if (spec.table && Array.isArray(spec.table.rows) && spec.table.rows.length) {
        tableWrap.hidden = false;
        const cols = spec.table.columns;
        const shown = spec.table.rows.length;
        const totalRows = spec.table.totalRows || shown;
        const headHtml = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
        const bodyHtml = spec.table.rows.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');
        tableWrap.innerHTML = `
          <details class="dash-table-details">
            <summary>Raw data${totalRows > shown ? ` — showing ${shown} of ${totalRows} rows` : ` (${totalRows} rows)`}</summary>
            <div class="dash-table-scroll"><table class="dash-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>
          </details>`;
      } else {
        tableWrap.hidden = true;
        tableWrap.innerHTML = '';
      }
    }

    $('#dash-output').hidden = false;
    if (opts.scroll !== false) $('#dash-output').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================= remembered work + saved dashboards (per logged-in user) ================= */

  let workspace = {};   // { tab, csv, prompt, spec } — mirrored to the user's account
  let draftTimer = null;

  function remember(patch) {
    if (!LVAuth.user) return;
    Object.assign(workspace, patch);
    if (workspace.csv && workspace.csv.length > 200000) workspace.csv = workspace.csv.slice(0, 200000);
    LVAuth.saveWorkspace(workspace);
  }
  function rememberDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => remember({ csv: $('#dash-paste').value, prompt: $('#dash-prompt').value }), 800);
  }

  async function restoreWorkspace() {
    const ws = await LVAuth.getWorkspace();
    workspace = ws || {};
    if (!ws) return;
    if (ws.csv && !$('#dash-paste').value.trim()) $('#dash-paste').value = ws.csv;
    if (ws.prompt && !$('#dash-prompt').value.trim()) $('#dash-prompt').value = ws.prompt;
    if (ws.tab) switchTab(ws.tab);
    if (ws.spec && !lastSpec) { renderSpec(ws.spec, { scroll: false }); setStatus('Restored your last session.'); }
  }

  function clearUI() {
    workspace = {};
    destroyCharts();
    lastSpec = null;
    $('#dash-output').hidden = true;
    $('#dash-paste').value = '';
    $('#dash-prompt').value = '';
    $('#dash-prompt-note').textContent = '';
    setStatus('');
  }

  function setMsg(html, isErr) {
    const el = $('#dash-save-msg');
    el.innerHTML = html;
    el.style.color = isErr ? 'var(--accent)' : '';
  }

  async function saveCurrentDashboard() {
    if (!lastSpec) return;
    if (!LVAuth.user) {
      setMsg('<a href="#login" data-return="dashboard">Log in</a> or <a href="#signup" data-return="dashboard">sign up</a> to save dashboards — your work is then remembered on your account.', true);
      return;
    }
    try {
      await LVAuth.saveDashboard({ id: 'd_' + Date.now(), createdAt: new Date().toISOString(), spec: lastSpec });
      setMsg('Saved to your account.');
      await renderSavedList();
    } catch (err) { setMsg(escapeHtml(err.message), true); }
  }

  async function renderSavedList() {
    const wrap = $('#dash-saved-wrap');
    const listEl = $('#dash-saved-list');
    const list = LVAuth.user ? await LVAuth.listDashboards() : [];
    if (!list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    listEl.innerHTML = '';
    list.forEach((rec) => {
      const card = document.createElement('div');
      card.className = 'dash-saved-card';
      card.innerHTML = `
        <h3>${escapeHtml(rec.spec.title)}</h3>
        <p>${rec.spec.charts.length} chart${rec.spec.charts.length === 1 ? '' : 's'} · saved ${escapeHtml(new Date(rec.createdAt).toLocaleString())}</p>
        <div class="dash-saved-card-actions">
          <button type="button" data-open>Open</button>
          <button type="button" data-delete>Delete</button>
        </div>`;
      listEl.appendChild(card);
      card.querySelector('[data-open]').addEventListener('click', () => { renderSpec(rec.spec); remember({ spec: rec.spec }); });
      card.querySelector('[data-delete]').addEventListener('click', async () => { await LVAuth.deleteDashboard(rec.id); renderSavedList(); });
    });
  }

  /* ================= building (backend if present, otherwise in the browser) ================= */

  async function buildFromData(columns, rows) {
    if (LVAuth.backend) {
      const r = await LVAuth.api('/api/dashboards/generate', { method: 'POST', body: JSON.stringify({ mode: 'data', columns, rows }) });
      if (r.ok && r.data && r.data.spec) return r.data.spec;
    }
    return buildDashboardFromRows(columns, rows);
  }

  async function buildFromPrompt(promptText) {
    if (LVAuth.backend) {
      const r = await LVAuth.api('/api/dashboards/generate', { method: 'POST', body: JSON.stringify({ mode: 'prompt', prompt: promptText }) });
      if (r.ok && r.data && r.data.spec) return r.data.spec;
    }
    return buildDashboardFromPrompt(promptText);
  }

  /* ---- organizing messy text ---- */

  async function organize(text, { ocr = false } = {}) {
    let org = LVOrganize.organizeText(text, { ocr });
    if (LVOrganize.isPoor(org) && LVAuth.backend && LVAuth.ai) {
      setStatus('That data is messy — asking AI to restructure it…', true);
      const r = await LVAuth.api('/api/organize', { method: 'POST', body: JSON.stringify({ text }) });
      if (r.ok && r.data && r.data.rows && r.data.rows.length) org = r.data;
    }
    if (org.error || !org.rows.length) throw new Error(org.error || 'Couldn’t find a table in that data.');
    if (LVOrganize.isPoor(org)) throw new Error('Couldn’t find a numeric column to chart — add a column of numbers (revenue, count, etc).');
    return org;
  }

  async function specFromOrg(org, extraNotes) {
    $('#dash-paste').value = org.csv;   // show the organized table so it can be checked or edited
    const spec = await buildFromData(org.columns, org.rows);
    spec.organize = { notes: (extraNotes || []).concat(org.notes || []) };
    return spec;
  }

  function finish(spec, extra) {
    renderSpec(spec);
    remember(Object.assign({ spec, tab: currentTab(), csv: $('#dash-paste').value, prompt: $('#dash-prompt').value }, extra || {}));
  }

  /* ---- images ---- */

  const isImage = (f) => (f.type && f.type.startsWith('image/')) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '');

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Couldn’t open that image — try a PNG, JPG or WebP (HEIC photos need converting first).')); };
      img.src = url;
    });
  }

  // downscale for upload, or upscale + grayscale + contrast-stretch for on-device OCR
  async function prepImage(file, { maxDim, ocr }) {
    const img = await loadImage(file);
    const big = Math.max(img.naturalWidth, img.naturalHeight);
    let scale = Math.min(1, maxDim / big);
    if (ocr && big < 1400) scale = Math.min(2.5, 1400 / big);
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    if (ocr) {
      const d = ctx.getImageData(0, 0, w, h), px = d.data, hist = new Uint32Array(256);
      for (let i = 0; i < px.length; i += 4) { const g = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0; px[i] = px[i + 1] = px[i + 2] = g; hist[g]++; }
      const total = w * h; let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
      const span = Math.max(1, hi - lo);
      for (let i = 0; i < px.length; i += 4) { const g = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / span)); px[i] = px[i + 1] = px[i + 2] = g; }
      ctx.putImageData(d, 0, 0);
    }
    return canvas.toDataURL(ocr ? 'image/png' : 'image/jpeg', 0.85);
  }

  let tessPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tessPromise) {
      tessPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => { tessPromise = null; reject(new Error('Couldn’t load the on-device image reader — it needs an internet connection the first time. You can also paste the values as text.')); };
        document.head.appendChild(s);
      });
    }
    return tessPromise;
  }

  // rebuild rows from OCR word boxes: a wide gap between words becomes a tab, so columns survive
  function ocrToText(data) {
    const lines = data && data.lines;
    if (!lines || !lines.length) return (data && data.text) || '';
    return lines.map((l) => {
      const words = (l.words || []).filter((w) => w.text && w.text.trim());
      if (!words.length) return '';
      const hs = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
      const h = hs[Math.floor(hs.length / 2)] || 10;
      return words.reduce((out, w, i) => (i === 0 ? w.text : out + (w.bbox.x0 - words[i - 1].bbox.x1 > h * 1.0 ? '\t' : ' ') + w.text), '');
    }).join('\n');
  }

  async function readImage(file) {
    if (LVAuth.backend && LVAuth.ai) {
      setStatus('Reading your image with AI…', true);
      const image = await prepImage(file, { maxDim: 1800, ocr: false });
      const r = await LVAuth.api('/api/extract-image', { method: 'POST', body: JSON.stringify({ image }) });
      if (r.ok && r.data && r.data.rows) return r.data;
      if (r.status === 422) throw new Error((r.data && r.data.error) || 'No table found in that image.');
      // any other failure: fall through to on-device OCR
    }
    setStatus('Reading text from your image on this device… (the first run downloads the reader)', true);
    const T = await loadTesseract();
    const url = await prepImage(file, { maxDim: 2600, ocr: true });
    const { data } = await T.recognize(url, 'eng', {
      logger: (m) => { if (m.status === 'recognizing text') setStatus(`Reading text from your image… ${Math.round(m.progress * 100)}%`, true); },
    });
    setStatus('Organizing what was read…', true);
    const org = await organize(ocrToText(data), { ocr: true }).catch((err) => {
      throw new Error(err.message + ' Try a sharper, straight-on photo with the whole table in frame, or paste the values as text.');
    });
    return org;
  }

  /* ================= sample content ================= */

  const SAMPLE_CSV = `name,month,revenue,channel
Bakery A,Jan,24000,Dine-in
Bakery A,Feb,31000,Dine-in
Bakery A,Mar,28500,Dine-in
Bakery A,Jan,9000,Delivery
Bakery A,Feb,14500,Delivery
Bakery A,Mar,16200,Delivery
Bakery A,Jan,4200,Takeaway
Bakery A,Feb,5100,Takeaway
Bakery A,Mar,6300,Takeaway`;

  const SAMPLE_MESSY = `QUARTERLY SALES - BAKERY A
S.No ,Month, Revenue ,Channel
1, january , "₹24,000", dine-in
2, Feb, 31,000, DINE-IN
3, Mar , 28500, Dine-in
4, Jan, 9000, Delivry
5, Feb, 14500, Delivery
6, Mar, 16200, Delivery
7, Jan, 4200, Takeaway
8, Feb, N/A, Takeaway
9, Mar, 6300, Takeaway
Total,,"1,33,700",`;

  const SAMPLE_PROMPTS = [
    'Show 6 months of revenue for a coffee shop, roughly ₹40k to ₹90k, plus a breakdown of sales by channel: dine-in, takeaway, delivery.',
    'quarterly marketing spend between 20k-60k, by campaign (social / search / email / referral)',
    'Weekly signups for a new app over 8 wks, around 500 to 2k per week, channels north, south, east and west',
    'Here are my sales: Jan 24000, Feb 31k, Mar 28500, Apr 30000, May 35.5k',
  ];

  /* ================= wiring ================= */

  function setError(el, msg) { el.textContent = msg || ''; }
  function setStatus(msg, busy) {
    const el = $('#dash-status');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('is-busy', !!busy);
  }
  const currentTab = () => ($('.dash-tab.is-active') || {}).dataset ? $('.dash-tab.is-active').dataset.tab : 'data';

  function switchTab(name) {
    $$('.dash-tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $$('.dash-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  function initTabs() {
    $$('.dash-tab').forEach((tab) => tab.addEventListener('click', () => { switchTab(tab.dataset.tab); remember({ tab: tab.dataset.tab }); }));
  }

  function setBusy(btn, busy) { btn.disabled = busy; }

  async function handleFile(file) {
    if (!file) return;
    const errorEl = $('#dash-data-error');
    setError(errorEl, '');
    switchTab('data');
    try {
      let spec;
      if (isImage(file)) {
        spec = await specFromOrg(await readImage(file), ['Read the data from an image.']);
      } else if (/\.(csv|tsv|txt)$/i.test(file.name) || /^text\//.test(file.type)) {
        const text = await file.text();
        $('#dash-paste').value = text;
        setStatus('Organizing your data…', true);
        spec = await specFromOrg(await organize(text));
      } else {
        throw new Error('Use a .csv, .tsv or .txt file, or an image (PNG, JPG, WebP) of a table.');
      }
      finish(spec, { tab: 'data' });
    } catch (err) {
      setError(errorEl, err.message || 'Couldn’t read that file — try again.');
    } finally { setStatus(''); }
  }

  function initDataPanel() {
    const drop = $('#dash-drop');
    const fileInput = $('#dash-file');
    const paste = $('#dash-paste');
    const errorEl = $('#dash-data-error');

    $('#dash-browse').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener('change', () => { handleFile(fileInput.files[0]); fileInput.value = ''; });

    ['dragenter', 'dragover'].forEach((evt) => drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('is-dragover'); }));
    ['dragleave', 'drop'].forEach((evt) => drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('is-dragover'); }));
    drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files && e.dataTransfer.files[0]));

    // paste a screenshot straight from the clipboard
    document.addEventListener('paste', (e) => {
      if (location.hash !== '#dashboard') return;
      const item = Array.from((e.clipboardData && e.clipboardData.items) || []).find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); handleFile(item.getAsFile()); }
    });

    $('#dash-sample-data').addEventListener('click', () => { paste.value = SAMPLE_CSV; setError(errorEl, ''); rememberDraftSoon(); });
    $('#dash-sample-messy').addEventListener('click', () => { paste.value = SAMPLE_MESSY; setError(errorEl, ''); rememberDraftSoon(); });
    paste.addEventListener('input', rememberDraftSoon);

    const buildBtn = $('#dash-build-data');
    buildBtn.addEventListener('click', async () => {
      setError(errorEl, '');
      const text = paste.value.trim();
      if (!text) { setError(errorEl, 'Paste some rows, drop a file or an image, or load the sample data first.'); return; }
      setBusy(buildBtn, true);
      setStatus('Organizing your data…', true);
      try { finish(await specFromOrg(await organize(text))); }
      catch (err) { setError(errorEl, err.message || 'Couldn’t read that data.'); }
      finally { setBusy(buildBtn, false); setStatus(''); }
    });
  }

  function initPromptPanel() {
    const promptEl = $('#dash-prompt');
    const errorEl = $('#dash-prompt-error');
    const noteEl = $('#dash-prompt-note');
    let sampleIdx = 0;

    $('#dash-sample-prompt').addEventListener('click', () => {
      promptEl.value = SAMPLE_PROMPTS[sampleIdx % SAMPLE_PROMPTS.length];
      sampleIdx++;
      setError(errorEl, ''); noteEl.textContent = '';
      rememberDraftSoon();
    });
    promptEl.addEventListener('input', rememberDraftSoon);

    const buildBtn = $('#dash-build-prompt');
    buildBtn.addEventListener('click', async () => {
      setError(errorEl, ''); noteEl.textContent = '';
      const text = promptEl.value.trim();
      if (!text) { setError(errorEl, 'Describe the dashboard you want, or click “Use an example.”'); return; }
      setBusy(buildBtn, true);
      try {
        const org = LVOrganize.organizePrompt(text);   // tidy the prompt (or pull out data hidden in it) first
        let spec;
        if (org.mode === 'data') {
          spec = await specFromOrg(org);
          spec.title = `Dashboard — ${org.rows.length} data points from your prompt`;
        } else {
          if (org.prompt !== text) noteEl.textContent = 'Interpreted as: ' + org.prompt;
          spec = await buildFromPrompt(org.prompt);
          spec.organize = { notes: org.notes.concat((spec.organize && spec.organize.notes) || []) };
        }
        finish(spec, { tab: 'prompt' });
      } catch (err) {
        setError(errorEl, err.message || 'Couldn’t build a dashboard from that description — try adding a number range or a few category names.');
      } finally { setBusy(buildBtn, false); }
    });
  }

  function initOutputActions() {
    $('#dash-save').addEventListener('click', saveCurrentDashboard);
    $('#dash-new').addEventListener('click', () => {
      $('#dash-output').hidden = true;
      destroyCharts();
      lastSpec = null;
      setMsg('');
      remember({ spec: null });
    });
  }

  function updateModeNote() {
    const note = $('#dash-mode-note');
    if (!note) return;
    const u = LVAuth.user;
    const where = LVAuth.backend
      ? 'Connected to the Ledgerview backend' + (LVAuth.ai ? ', with AI image reading.' : ' — images are read with on-device OCR (set ANTHROPIC_API_KEY for AI reading).')
      : 'No backend detected — everything runs in your browser and images are read with on-device OCR. Run `node server.js` for accounts that work across devices.';
    note.innerHTML = escapeHtml(where) + ' ' + (u
      ? `Signed in as ${escapeHtml(u.name)} — your last session and saved dashboards are remembered.`
      : '<a href="#login" data-return="dashboard">Log in</a> to save dashboards and have your last data remembered.');
  }

  function onUserChange(user) {
    updateModeNote();
    if (user) restoreWorkspace(); else clearUI();
    renderSavedList();
  }

  /* ================= changes made on the Profile page ================= */

  window.addEventListener('ledgerview:session-cleared', clearUI);
  window.addEventListener('ledgerview:dashboards-changed', renderSavedList);
  window.addEventListener('ledgerview:open-saved', (e) => {
    if (!$('#view-dashboard') || !e.detail) return;
    renderSpec(e.detail);
    remember({ spec: e.detail });
  });

  /* ================= example dashboards (from the Solutions page) ================= */

  window.addEventListener('ledgerview:show-example', (e) => {
    if (!$('#view-dashboard') || !e.detail) return;
    renderSpec(e.detail);
  });

  function init() {
    if (!$('#view-dashboard')) return;
    initTabs();
    initDataPanel();
    initPromptPanel();
    initOutputActions();
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[data-return]');
      if (a) LVAuth.returnTo = a.dataset.return;
    });
    updateModeNote();
    LVAuth.onChange(onUserChange);
    if (LVAuth.backend !== null) onUserChange(LVAuth.user); // auth finished before we registered
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
