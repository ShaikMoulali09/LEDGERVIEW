/* Ledgerview marketing site: routing, scroll reveal, swipe-up titles,
   solutions filter and FAQ accordion. (Accounts live in auth.js.) */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const VIEWS = ['home', 'features', 'solutions', 'pricing', 'dashboard', 'signup', 'profile', 'about'];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================= routing ================= */

  function currentView() {
    let v = (location.hash || '#home').slice(1);
    if (v === 'login') v = 'signup'; // log in shares the account page with sign up
    return VIEWS.includes(v) ? v : 'home';
  }

  function route() {
    const v = currentView();
    document.body.dataset.route = v;

    VIEWS.forEach((name) => {
      const el = $('#view-' + name);
      if (!el) return;
      if (name === v) {
        el.hidden = false;
        // restart the swipe-up animation on every visit
        el.classList.remove('is-active');
        // force reflow so the transition replays even on repeat visits
        void el.offsetWidth;
        requestAnimationFrame(() => el.classList.add('is-active'));
      } else {
        el.hidden = true;
        el.classList.remove('is-active');
      }
    });

    $$('.nav-link').forEach((a) => a.classList.toggle('is-current', a.dataset.view === v));
    closeNav();
    window.scrollTo(0, 0);
    observeReveals();
  }

  window.addEventListener('hashchange', route);

  /* ================= mobile nav ================= */

  const navPanel = $('#nav-panel');
  const navToggle = $('#nav-toggle');

  function closeNav() {
    navPanel.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  }
  navToggle.addEventListener('click', () => {
    const open = navPanel.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
  // delegated, so links that auth.js re-renders (Log in / Sign up / Profile) also close the menu
  navPanel.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && navPanel.classList.contains('is-open')) { closeNav(); navToggle.focus(); } });
  document.addEventListener('click', (e) => {
    if (navPanel.classList.contains('is-open') && !e.target.closest('.hdr')) closeNav();
  });
  window.matchMedia('(min-width: 861px)').addEventListener('change', closeNav);

  /* ================= scroll reveal ================= */

  let revealObserver;
  function observeReveals() {
    if (reduceMotion) {
      $$('.reveal').forEach((el) => el.classList.add('in-view'));
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    }
    $$('.reveal:not(.in-view)').forEach((el) => revealObserver.observe(el));
  }

  /* ================= home: decorative bar chart + live counter ================= */

  function buildHeroBars() {
    const g = $('#hero-bars');
    if (!g) return;

    const n = 14;
    const cx = 110, cy = 110;
    const baseline = 220;
    const w = 220 / n;
    const hMin = 25, hMax = 150;
    const rMin = 22, rMax = 95;
    const deg2rad = (d) => (d * Math.PI) / 180;
    const mapRange = (v, a1, a2, b1, b2) => b1 + ((v - a1) / (a2 - a1)) * (b2 - b1);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const fx = (v) => v.toFixed(1);

    // One base "value" per mark drives all three views (bar height, pie-wedge
    // radius, line-graph y) so it reads as the same dataset, just re-shaped.
    const baseValues = Array.from({ length: n }, (_, i) => {
      const raw = 30 + Math.sin(i * 0.6) * 35 + Math.random() * 35 + 35;
      return clamp(Math.round(raw), hMin, hMax);
    });

    if (reduceMotion) {
      let staticHtml = '';
      baseValues.forEach((h, i) => {
        const x = i * w, y = baseline - h;
        staticHtml += `<rect x="${fx(x)}" y="${fx(y)}" width="${fx(w - 2)}" height="${fx(h)}" rx="1.5" fill="url(#barGradient)" opacity="0.95"/>`;
      });
      g.innerHTML = staticHtml;
      return;
    }

    // --- shape builders: given a mark index and a height/value, return the
    // quad path for that mark in each of the three views (angle/x position
    // is fixed per index; only the value changes) ---
    function barPath(i, h) {
      const bx = i * w, bw = w - 2, by = baseline - h;
      return `M${fx(bx)},${baseline} L${fx(bx + bw)},${baseline} L${fx(bx + bw)},${fx(by)} L${fx(bx)},${fx(by)} Z`;
    }
    function piePath(i, h) {
      const radius = mapRange(h, hMin, hMax, rMin, rMax);
      const angStart = deg2rad((i / n) * 360 - 90);
      const angEnd = deg2rad(((i + 1) / n) * 360 - 90);
      const angMid = (angStart + angEnd) / 2;
      const p1 = [cx + radius * Math.cos(angStart), cy + radius * Math.sin(angStart)];
      const p2 = [cx + radius * Math.cos(angMid), cy + radius * Math.sin(angMid)];
      const p3 = [cx + radius * Math.cos(angEnd), cy + radius * Math.sin(angEnd)];
      return `M${fx(cx)},${fx(cy)} L${fx(p1[0])},${fx(p1[1])} L${fx(p2[0])},${fx(p2[1])} L${fx(p3[0])},${fx(p3[1])} Z`;
    }
    function linePath(i, h) {
      const lx = i * w + (w - 2) / 2, ly = baseline - h, s = 3;
      return `M${fx(lx - s)},${fx(ly - s)} L${fx(lx + s)},${fx(ly - s)} L${fx(lx + s)},${fx(ly + s)} L${fx(lx - s)},${fx(ly + s)} Z`;
    }

    // --- shared timeline, built from segment durations so hold/transition
    // lengths are easy to tune. Transitions are short relative to holds;
    // each hold is split in half so every mark drifts to its own wiggle
    // value at the midpoint, then eases back to the shared base value
    // right before the next transform — individual motion within a
    // synchronized transform. ---
    const HOLD = 2.2;   // seconds spent as each shape
    const TRANS = 0.85; // seconds morphing between shapes
    const segDurs = [HOLD / 2, HOLD / 2, TRANS, HOLD / 2, HOLD / 2, TRANS, HOLD / 2, HOLD / 2, TRANS];
    const tSec = [0];
    segDurs.forEach((d) => tSec.push(tSec[tSec.length - 1] + d));
    const dur = tSec[tSec.length - 1];
    const keyTimes = tSec.map((t) => (t / dur).toFixed(4)).join(';');
    const keySplines = Array(segDurs.length).fill('0.4 0 0.2 1').join(';');
    const phaseAtKey = ['bar', 'bar', 'bar', 'pie', 'pie', 'pie', 'line', 'line', 'line', 'bar'];
    const WIGGLE = 35; // how far each mark can individually drift from its base value

    let marksHtml = '';
    const linePointsAtKey = phaseAtKey.map(() => []); // [keyIndex][markIndex] -> "x,y"

    baseValues.forEach((baseH, i) => {
      const wiggle = () => clamp(baseH + (Math.random() - 0.5) * 2 * WIGGLE, hMin, hMax);
      // value at each of the 10 keyframes: base, individual wiggle, base — per phase
      const hAtKey = [baseH, wiggle(), baseH, baseH, wiggle(), baseH, baseH, wiggle(), baseH, baseH];

      const dValues = hAtKey.map((h, k) => {
        const p = phaseAtKey[k];
        return p === 'bar' ? barPath(i, h) : p === 'pie' ? piePath(i, h) : linePath(i, h);
      }).join(';');

      hAtKey.forEach((h, k) => {
        const lx = i * w + (w - 2) / 2, ly = baseline - h;
        linePointsAtKey[k].push(`${fx(lx)},${fx(ly)}`);
      });

      marksHtml += `<path d="${barPath(i, baseH)}" fill="url(#barGradient)" opacity="0.95">
        <animate attributeName="d" values="${dValues}" keyTimes="${keyTimes}" dur="${dur}s" begin="0s" repeatCount="indefinite" calcMode="spline" keySplines="${keySplines}"/>
      </path>`;
    });

    // Ring that fades in only while the shapes are wedges, to read clearly as a pie.
    const ringOpacity = phaseAtKey.map((p) => (p === 'pie' ? 1 : 0)).join(';');
    const ring = `<circle cx="${cx}" cy="${cy}" r="${rMax}" fill="none" stroke="rgba(240,240,240,.28)" stroke-width="1" opacity="0">
      <animate attributeName="opacity" values="${ringOpacity}" keyTimes="${keyTimes}" dur="${dur}s" begin="0s" repeatCount="indefinite"/>
    </circle>`;

    // Connecting line: its points track the same per-mark values every keyframe
    // (so it wiggles in step with the markers) but only shows up during the
    // line-graph phase.
    const polyPoints = linePointsAtKey.map((pts) => pts.join(' ')).join(';');
    const polyOpacity = phaseAtKey.map((p) => (p === 'line' ? 1 : 0)).join(';');
    const polyline = `<polyline points="${linePointsAtKey[0].join(' ')}" fill="none" stroke="#F0F0F0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0">
      <animate attributeName="points" values="${polyPoints}" keyTimes="${keyTimes}" dur="${dur}s" begin="0s" repeatCount="indefinite" calcMode="spline" keySplines="${keySplines}"/>
      <animate attributeName="opacity" values="${polyOpacity}" keyTimes="${keyTimes}" dur="${dur}s" begin="0s" repeatCount="indefinite"/>
    </polyline>`;

    g.innerHTML = ring + marksHtml + polyline;
  }

  function runRowsCounter() {
    const el = $('#hero-rows');
    if (!el) return;
    const target = 4128 + Math.floor(Math.random() * 900);
    if (reduceMotion) { el.textContent = target.toLocaleString('en-IN'); return; }
    const start = performance.now();
    const dur = 1400;
    function tick(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target).toLocaleString('en-IN');
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ================= solutions ================= */

  const SOLUTIONS = [
    { name: 'Sales pipeline overview', role: 'sales', industry: 'saas', desc: 'Deals by stage, win rate and this month\u2019s closed revenue, from a CRM export.', bars: [40, 65, 30, 80, 50] },
    { name: 'Marketing campaign ROI', role: 'marketing', industry: 'saas', desc: 'Spend versus signups per channel, so the next budget is easier to defend.', bars: [55, 30, 70, 45, 60] },
    { name: 'Founder\u2019s weekly snapshot', role: 'founder', industry: 'saas', desc: 'Revenue, active users and burn on one screen, built from your billing export.', bars: [70, 55, 80, 40, 65] },
    { name: 'Store performance tracker', role: 'sales', industry: 'retail', desc: 'Footfall, basket size and top sellers by outlet, from a weekly sales sheet.', bars: [45, 60, 35, 75, 50] },
    { name: 'Client billing summary', role: 'finance', industry: 'agency', desc: 'Who\u2019s paid, who\u2019s overdue, and hours billed against hours worked.', bars: [60, 40, 70, 55, 35] },
    { name: 'Attendance and grades', role: 'founder', industry: 'education', desc: 'A class roster turned into attendance trends and grade distribution.', bars: [50, 65, 55, 70, 45] },
    { name: 'Expense and runway tracker', role: 'finance', industry: 'saas', desc: 'Monthly burn against cash on hand, projected forward automatically.', bars: [35, 55, 65, 45, 75] },
    { name: 'Campaign reach by channel', role: 'marketing', industry: 'retail', desc: 'Impressions and conversions side by side for every channel you run.', bars: [65, 45, 55, 35, 70] },
  ];
  const ROLE_CHIPS = [['all', 'All roles'], ['founder', 'Founder'], ['marketing', 'Marketing'], ['sales', 'Sales'], ['finance', 'Finance']];
  const INDUSTRY_CHIPS = [['all', 'All industries'], ['saas', 'SaaS'], ['retail', 'Retail'], ['agency', 'Agency'], ['education', 'Education']];

  // One full example dashboard per sub-category (role and industry). These use the exact
  // same spec shape — { title, stats[], charts[], insights[] } — that a real CSV upload or
  // prompt produces, so "View example dashboard" opens the real Dashboard view rendering,
  // not a mock-up.
  const SOLUTION_EXAMPLES = {
    founder: {
      title: 'Example: Founder\u2019s weekly snapshot',
      disclaimer: 'Illustrative numbers for a SaaS founder\u2019s weekly review, not real data.',
      stats: [
        { label: 'MRR', value: '9,42,000' },
        { label: 'Active users', value: '3,180' },
        { label: 'Monthly burn', value: '6,10,000' },
        { label: 'Runway', value: '11 months' },
        { label: 'MRR trend', value: '+18.4%', trend: 'up' },
      ],
      charts: [
        { type: 'line', title: 'MRR over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'MRR', data: [640000, 705000, 742000, 810000, 875000, 942000] }], wide: true },
        { type: 'bar', title: 'Spend by category', labels: ['Payroll', 'Infra', 'Marketing', 'Tools', 'Other'], series: [{ label: 'Spend', data: [320000, 120000, 95000, 45000, 30000] }] },
        { type: 'doughnut', title: 'Users by plan', labels: ['Starter', 'Pro', 'Business'], series: [{ label: 'Users', data: [1800, 1100, 280] }] },
      ],
      insights: [
        'MRR grew 18.4% from Jan to Jun.',
        'Payroll is the largest cost, at just over half of monthly burn.',
        'At the current burn rate, runway sits at roughly 11 months.',
      ],
    },
    marketing: {
      title: 'Example: Marketing campaign ROI',
      disclaimer: 'Illustrative numbers for a marketing spend review, not real data.',
      stats: [
        { label: 'Total spend', value: '4,80,000' },
        { label: 'Total signups', value: '2,860' },
        { label: 'Cost per signup', value: '168' },
        { label: 'Best channel', value: 'Search' },
        { label: 'Signups trend', value: '+22.1%', trend: 'up' },
      ],
      charts: [
        { type: 'line', title: 'Signups over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'Signups', data: [320, 360, 410, 470, 520, 780] }], wide: true },
        { type: 'bar', title: 'Spend by channel', labels: ['Search', 'Social', 'Email', 'Referral'], series: [{ label: 'Spend', data: [190000, 150000, 70000, 70000] }] },
        { type: 'doughnut', title: 'Signups by channel', labels: ['Search', 'Social', 'Email', 'Referral'], series: [{ label: 'Signups', data: [1150, 900, 460, 350] }] },
      ],
      insights: [
        'Signups grew 22.1% from Jan to Jun, with June\u2019s push driving most of the jump.',
        'Search leads every channel, at about 40% of total signups for 40% of spend.',
        'Referral is the cheapest channel per signup, worth a bigger budget test.',
      ],
    },
    sales: {
      title: 'Example: Sales pipeline overview',
      disclaimer: 'Illustrative numbers for a CRM pipeline review, not real data.',
      stats: [
        { label: 'Open deals', value: '64' },
        { label: 'Pipeline value', value: '38,50,000' },
        { label: 'Win rate', value: '31%' },
        { label: 'Avg deal size', value: '2,10,000' },
      ],
      charts: [
        { type: 'bar', title: 'Deals by stage', labels: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed won'], series: [{ label: 'Deals', data: [80, 65, 30, 22, 18] }] },
        { type: 'line', title: 'Closed revenue over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'Revenue', data: [520000, 610000, 480000, 705000, 690000, 890000] }], wide: true },
        { type: 'doughnut', title: 'Deals by stage', labels: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed won'], series: [{ label: 'Deals', data: [80, 65, 30, 22, 18] }] },
      ],
      insights: [
        'Closed revenue grew 71.2% from Jan to Jun.',
        'Most open deals are still early-stage — Lead and Qualified make up nearly two-thirds of the pipeline.',
        'Win rate holds steady at 31% across the period.',
      ],
    },
    finance: {
      title: 'Example: Expense and runway tracker',
      disclaimer: 'Illustrative numbers for a monthly finance review, not real data.',
      stats: [
        { label: 'Total expenses', value: '21,40,000' },
        { label: 'Monthly burn', value: '3,80,000' },
        { label: 'Cash on hand', value: '42,00,000' },
        { label: 'Runway', value: '11 months' },
        { label: 'Burn trend', value: '-6.2%', trend: 'down' },
      ],
      charts: [
        { type: 'line', title: 'Burn over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'Burn', data: [410000, 405000, 395000, 388000, 382000, 380000] }], wide: true },
        { type: 'bar', title: 'Expenses by category', labels: ['Payroll', 'Rent', 'Software', 'Travel', 'Other'], series: [{ label: 'Expenses', data: [1180000, 320000, 280000, 180000, 180000] }] },
        { type: 'doughnut', title: 'Expense share by category', labels: ['Payroll', 'Rent', 'Software', 'Travel', 'Other'], series: [{ label: 'Expenses', data: [1180000, 320000, 280000, 180000, 180000] }] },
      ],
      insights: [
        'Monthly burn declined 6.2% from Jan to Jun as costs were trimmed.',
        'Payroll is by far the largest expense line, at roughly 55% of the total.',
        'At the current burn rate, cash on hand covers about 11 more months.',
      ],
    },
    saas: {
      title: 'Example: SaaS metrics snapshot',
      disclaimer: 'Illustrative numbers for a SaaS metrics review, not real data.',
      stats: [
        { label: 'MRR', value: '9,42,000' },
        { label: 'Active subscriptions', value: '3,180' },
        { label: 'Churn rate', value: '2.4%' },
        { label: 'ARPU', value: '296' },
        { label: 'MRR trend', value: '+18.4%', trend: 'up' },
      ],
      charts: [
        { type: 'line', title: 'MRR over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'MRR', data: [640000, 705000, 742000, 810000, 875000, 942000] }], wide: true },
        { type: 'bar', title: 'Subscriptions by plan', labels: ['Starter', 'Pro', 'Business'], series: [{ label: 'Subscriptions', data: [1800, 1100, 280] }] },
        { type: 'doughnut', title: 'MRR share by plan', labels: ['Starter', 'Pro', 'Business'], series: [{ label: 'MRR', data: [270000, 440000, 232000] }] },
      ],
      insights: [
        'MRR grew 18.4% from Jan to Jun despite a modest 2.4% churn rate.',
        'The Pro plan drives the largest share of revenue even though Starter has more subscribers.',
      ],
    },
    retail: {
      title: 'Example: Store performance tracker',
      disclaimer: 'Illustrative numbers for a multi-outlet retail review, not real data.',
      stats: [
        { label: 'Total revenue', value: '18,60,000' },
        { label: 'Footfall', value: '24,300' },
        { label: 'Avg basket size', value: '766' },
        { label: 'Top outlet', value: 'MG Road' },
        { label: 'Revenue trend', value: '+14.7%', trend: 'up' },
      ],
      charts: [
        { type: 'line', title: 'Revenue over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'Revenue', data: [265000, 278000, 290000, 305000, 320000, 304000] }], wide: true },
        { type: 'bar', title: 'Revenue by outlet', labels: ['MG Road', 'Whitefield', 'Indiranagar', 'Koramangala'], series: [{ label: 'Revenue', data: [620000, 480000, 410000, 350000] }] },
        { type: 'doughnut', title: 'Sales share by category', labels: ['Apparel', 'Footwear', 'Accessories'], series: [{ label: 'Sales', data: [980000, 560000, 320000] }] },
      ],
      insights: [
        'Revenue grew 14.7% from Jan to Jun.',
        'MG Road is the top-performing outlet, contributing about a third of total revenue.',
        'Apparel remains the biggest category, more than double Accessories.',
      ],
    },
    agency: {
      title: 'Example: Client billing summary',
      disclaimer: 'Illustrative numbers for an agency billing review, not real data.',
      stats: [
        { label: 'Billed this month', value: '14,20,000' },
        { label: 'Hours billed', value: '1,860' },
        { label: 'Overdue invoices', value: '4' },
        { label: 'Utilization rate', value: '78%' },
      ],
      charts: [
        { type: 'bar', title: 'Billed by client', labels: ['Client A', 'Client B', 'Client C', 'Client D', 'Client E'], series: [{ label: 'Billed', data: [420000, 350000, 280000, 220000, 150000] }] },
        { type: 'line', title: 'Billed hours over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'Hours', data: [1520, 1610, 1580, 1700, 1750, 1860] }], wide: true },
        { type: 'doughnut', title: 'Invoice status', labels: ['Paid', 'Pending', 'Overdue'], series: [{ label: 'Invoices', data: [22, 6, 4] }] },
      ],
      insights: [
        'Billed hours grew steadily, up 22.4% from Jan to Jun.',
        'Client A is the largest account, close to a third of this month\u2019s billing.',
        '4 invoices are currently overdue and worth following up on.',
      ],
    },
    education: {
      title: 'Example: Attendance and grades',
      disclaimer: 'Illustrative numbers for a classroom review, not real data.',
      stats: [
        { label: 'Avg attendance', value: '89%' },
        { label: 'Avg grade', value: '76%' },
        { label: 'Students at risk', value: '6' },
        { label: 'Top class', value: 'Grade 10-A' },
      ],
      charts: [
        { type: 'line', title: 'Attendance over 6 months', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ label: 'Attendance %', data: [92, 90, 88, 85, 87, 89] }], wide: true },
        { type: 'bar', title: 'Average grade by class', labels: ['10-A', '10-B', '10-C', '10-D'], series: [{ label: 'Avg grade', data: [82, 76, 74, 71] }] },
        { type: 'doughnut', title: 'Grade distribution', labels: ['A', 'B', 'C', 'D'], series: [{ label: 'Students', data: [28, 46, 32, 14] }] },
      ],
      insights: [
        'Attendance dipped mid-year before recovering slightly by June.',
        'Grade 10-A leads on average grade, well ahead of 10-D.',
        '6 students are flagged as at-risk based on attendance and grades combined.',
      ],
    },
  };

  let solGroup = 'role';
  let solChip = 'all';

  function renderChips() {
    const list = solGroup === 'role' ? ROLE_CHIPS : INDUSTRY_CHIPS;
    if (!list.some(([v]) => v === solChip)) solChip = 'all';
    $('#sol-chips').innerHTML = list.map(([val, label]) =>
      `<button type="button" class="sol-chip ${val === solChip ? 'is-active' : ''}" data-chip="${val}">${label}</button>`
    ).join('');
  }

  function renderSolutions() {
    const grid = $('#sol-grid');
    const filtered = SOLUTIONS.filter((s) => solChip === 'all' || s[solGroup] === solChip);
    grid.innerHTML = filtered.map((s) => {
      const exampleKey = s[solGroup]; // whichever sub-category is currently being browsed
      return `
      <article class="sol-card is-shown">
        <div class="sol-bars" aria-hidden="true">
          ${s.bars.map((h, i) => `<span style="height:${h}%;background:${['#ff1100', '#fdf900', '#009dff', '#F0F0F0', '#fc594d'][i % 5]}"></span>`).join('')}
        </div>
        <h3>${s.name}</h3>
        <p>${s.desc}</p>
        <div class="sol-tags">
          <span class="sol-tag">${s.role}</span>
          <span class="sol-tag">${s.industry}</span>
        </div>
        ${SOLUTION_EXAMPLES[exampleKey] ? `<button type="button" class="btn btn-line sol-view-btn" data-example="${exampleKey}">View example dashboard \u2192</button>` : ''}
      </article>`;
    }).join('') || '<p style="color:var(--muted-on-dark)">No templates match this filter yet.</p>';
  }

  function openExampleDashboard(key) {
    const spec = SOLUTION_EXAMPLES[key];
    if (!spec) return;
    location.hash = '#dashboard';
    // give the hashchange/route handler two frames to swap views in before rendering into them
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('ledgerview:show-example', { detail: spec }));
    }));
  }

  $$('.sol-toggle').forEach((btn) => btn.addEventListener('click', () => {
    $$('.sol-toggle').forEach((b) => b.classList.toggle('is-active', b === btn));
    solGroup = btn.dataset.group;
    solChip = 'all';
    renderChips();
    renderSolutions();
  }));

  $('#sol-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.sol-chip');
    if (!btn) return;
    solChip = btn.dataset.chip;
    renderChips();
    renderSolutions();
  });

  $('#sol-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.sol-view-btn');
    if (!btn) return;
    openExampleDashboard(btn.dataset.example);
  });

  /* ================= FAQ accordion ================= */

  $('#faq-list').addEventListener('click', (e) => {
    const q = e.target.closest('.faq-q');
    if (!q) return;
    const item = q.closest('.faq-item');
    const answer = $('.faq-a', item);
    const open = q.getAttribute('aria-expanded') === 'true';
    q.setAttribute('aria-expanded', String(!open));
    answer.style.maxHeight = open ? '0px' : answer.scrollHeight + 'px';
  });

  /* ================= trailing cursor dot ================= */

  function initCursorDot() {
    const dot = $('#cursor-dot');
    if (!dot) return;
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches) return;
    if (reduceMotion) return;

    const HOVER_SELECTOR = 'a, button, input, textarea, select, .sol-chip, [role="button"]';

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let x = targetX;
    let y = targetY;
    let raf = null;

    function tick() {
      // ease toward the pointer instead of snapping to it, so the dot trails
      x += (targetX - x) * 0.18;
      y += (targetY - y) * 0.18;
      dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      raf = requestAnimationFrame(tick);
    }

    window.addEventListener('pointermove', (e) => {
      targetX = e.clientX;
      targetY = e.clientY;
      dot.classList.add('is-visible');
      if (!raf) { x = targetX; y = targetY; raf = requestAnimationFrame(tick); }
    }, { passive: true });

    window.addEventListener('pointerdown', () => dot.classList.add('is-down'));
    window.addEventListener('pointerup', () => dot.classList.remove('is-down'));
    window.addEventListener('blur', () => dot.classList.remove('is-visible'));
    document.addEventListener('mouseleave', () => dot.classList.remove('is-visible'));
    document.addEventListener('mouseenter', () => dot.classList.add('is-visible'));

    document.addEventListener('pointerover', (e) => {
      if (e.target.closest(HOVER_SELECTOR)) dot.classList.add('is-hover');
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target.closest(HOVER_SELECTOR)) dot.classList.remove('is-hover');
    });
  }

  /* ================= live clock (home hero) ================= */

  function initHeroClock() {
    const el = $('#hero-clock');
    if (!el) return;

    // Label the reading with whatever place name the visitor's own
    // timezone implies, e.g. "Asia/Kolkata" -> "KOLKATA" — no fixed city.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const place = (zone.split('/').pop() || 'LOCAL').replace(/_/g, ' ').toUpperCase();

    function tick() {
      const now = new Date();
      const time = now.toLocaleTimeString('en-GB', { hour12: false });
      el.textContent = `${place}  ${time}`;
    }

    tick();
    setInterval(tick, 1000);
  }

  /* ================= footer year ================= */

  function initFooterYear() {
    const el = $('#footer-year');
    if (el) el.textContent = String(new Date().getFullYear());
  }

  /* ================= start ================= */

  buildHeroBars();
  renderChips();
  renderSolutions();
  route();
  runRowsCounter();
  initCursorDot();
  initHeroClock();
  initFooterYear();
})();
