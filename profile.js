/* Ledgerview profile page: details, subscription, saved data, login & security, delete account.
   Talks to the backend (or the localStorage fallback) only through window.LVAuth. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const fmtDateTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };

  const PLANS = [
    { name: 'Free', price: '₹0', rank: 0, points: ['Up to 3 sheets a month', 'Bar, line and pie charts', 'Export as an image'] },
    { name: 'Pro', price: '₹499', rank: 1, points: ['Unlimited sheets', 'Every chart type, no watermark', 'Saved dashboards across sessions'] },
    { name: 'Business', price: '₹1,499', rank: 2, points: ['Everything in Pro', 'Shared team workspace', 'Priority email support'] },
  ];

  let pendingPlan = '';   // set when someone clicks a plan button on the Pricing page while logged in
  let token = 0;          // discards stale async renders

  const isProfileRoute = () => location.hash === '#profile';

  function say(sel, text, isErr) {
    const el = $(sel);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-err', !!isErr);
  }
  function busy(btn, on) { if (btn) btn.disabled = on; }

  /* ---------------- rendering ---------------- */

  function renderHead(u) {
    const first = u.name.trim().split(/\s+/)[0] || '?';
    $('#pf-avatar').textContent = first.charAt(0).toUpperCase();
    $('#pf-name').textContent = u.name;
    $('#pf-email').textContent = u.email + (u.createdAt ? ' · member since ' + fmtDate(u.createdAt) : '');
    $('#pf-plan-chip').textContent = u.plan + ' plan';
  }

  function renderDetails(u) {
    $('#pf-in-name').value = u.name;
    $('#pf-in-email').value = u.email;
    $('#pf-in-company').value = u.company || '';
  }

  function renderPlans(u) {
    const cur = PLANS.find((p) => p.name === u.plan) || PLANS[0];
    const since = u.planSince ? ' since ' + fmtDate(u.planSince) : '';
    $('#pf-plan-line').textContent = 'You’re on the ' + cur.name + ' plan' + since + '.';
    $('#pf-plans').innerHTML = PLANS.map((p) => {
      const isCur = p.name === cur.name;
      const verb = p.rank > cur.rank ? 'Upgrade to ' : 'Switch to ';
      return `<article class="pf-plan${isCur ? ' is-current' : ''}${pendingPlan === p.name && !isCur ? ' is-pending' : ''}" data-plan="${esc(p.name)}">
        <h4>${esc(p.name)}</h4>
        <p class="pf-plan-price">${esc(p.price)}<span>/month</span></p>
        <ul>${p.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <button type="button" class="btn ${isCur ? 'btn-line' : 'btn-paper'} btn-full" data-pick="${esc(p.name)}" ${isCur ? 'disabled' : ''}>${isCur ? 'Current plan' : esc(verb + p.name)}</button>
      </article>`;
    }).join('');
    $('#pf-cancel-plan').hidden = cur.name === 'Free';
  }

  async function renderData() {
    const [list, ws] = await Promise.all([LVAuth.listDashboards(), LVAuth.getWorkspace()]);
    $('#pf-dash-count').textContent = list.length ? '(' + list.length + ')' : '';
    const listEl = $('#pf-dash-list');
    if (!list.length) {
      listEl.innerHTML = '<p class="pf-empty">No saved dashboards yet. Build one on the <a href="#dashboard" data-view="dashboard">Dashboard</a> page and press “Save dashboard”.</p>';
    } else {
      listEl.innerHTML = list.map((rec) => {
        const n = (rec.spec && rec.spec.charts ? rec.spec.charts.length : 0);
        return `<div class="pf-item" data-id="${esc(rec.id)}">
          <div class="pf-item-text">
            <strong>${esc(rec.spec && rec.spec.title ? rec.spec.title : 'Untitled dashboard')}</strong>
            <span>${n} chart${n === 1 ? '' : 's'} · saved ${esc(fmtDateTime(rec.createdAt))}</span>
          </div>
          <div class="pf-item-actions">
            <button type="button" data-open>Open</button>
            <button type="button" data-download>Download</button>
            <button type="button" data-delete>Delete</button>
          </div>
        </div>`;
      }).join('');
    }
    listEl._records = list;

    const bits = [];
    if (ws && ws.csv && String(ws.csv).trim()) bits.push('your last pasted data (' + String(ws.csv).trim().split('\n').length + ' lines)');
    if (ws && ws.prompt && String(ws.prompt).trim()) bits.push('your last prompt');
    if (ws && ws.spec && ws.spec.title) bits.push('your last dashboard (“' + ws.spec.title + '”)');
    $('#pf-session-line').textContent = bits.length
      ? 'Ledgerview remembers ' + bits.join(', ') + ', and restores it when you open the Dashboard page.'
      : 'Nothing is remembered right now. Your next pasted data, prompt or dashboard will be restored automatically.';
    $('#pf-clear-session').disabled = !bits.length;
    $('#pf-delete-all').disabled = !list.length;
    $('#pf-export').disabled = false;
  }

  function renderSecurity() {
    const be = LVAuth.backend;
    $('#pf-session-where').textContent = be
      ? 'You’re logged in on this device and stay logged in for up to 30 days. “Log out of all devices” ends every session, including this one.'
      : 'This account lives only in this browser (no backend detected), so there are no other devices to sign out.';
    $('#pf-logout-all').hidden = !be;
  }

  async function render() {
    const my = ++token;
    const u = LVAuth.user;
    $('#pf-guest').hidden = !!u;
    $('#pf-main').hidden = !u;
    if (!u) return;
    renderHead(u); renderDetails(u); renderPlans(u); renderSecurity();
    try { await renderData(); } catch (e) { console.error(e); }
    if (my !== token) return;
  }

  /* ---------------- actions ---------------- */

  function wireDetails() {
    $('#pf-details-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      busy(btn, true); say('#pf-details-msg', '');
      try {
        await LVAuth.updateProfile({ name: $('#pf-in-name').value, company: $('#pf-in-company').value });
        say('#pf-details-msg', 'Saved.');
      } catch (err) { say('#pf-details-msg', err.message, true); }
      finally { busy(btn, false); }
    });
  }

  async function switchPlan(name) {
    say('#pf-plan-msg', '');
    const cur = LVAuth.user.plan;
    const down = (PLANS.find((p) => p.name === name) || {}).rank < (PLANS.find((p) => p.name === cur) || {}).rank;
    if (down && !window.confirm('Switch from ' + cur + ' to ' + name + '? You’ll lose the ' + cur + ' features.')) return;
    try {
      await LVAuth.changePlan(name);
      pendingPlan = '';
      say('#pf-plan-msg', 'You’re now on the ' + name + ' plan.');
    } catch (err) { say('#pf-plan-msg', err.message, true); }
  }

  function wirePlans() {
    $('#pf-plans').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b && !b.disabled) switchPlan(b.dataset.pick);
    });
    $('#pf-cancel-plan').addEventListener('click', () => {
      if (window.confirm('Cancel your subscription and go back to the Free plan?')) switchPlan('Free');
    });

    // Pricing page buttons: when logged in, send people to their subscription instead of the sign-up form
    const pricing = $('#view-pricing');
    if (pricing) pricing.addEventListener('click', (e) => {
      const a = e.target.closest('.price-card a[data-view="signup"]');
      if (!a || !LVAuth.user) return;
      e.preventDefault();
      const h = a.closest('.price-card').querySelector('h3');
      pendingPlan = h ? h.textContent.trim() : '';
      if (isProfileRoute()) { render().then(scrollToPlans); } else location.hash = '#profile';
    });
  }

  function scrollToPlans() {
    const el = $('#pf-plan-card');
    if (el && pendingPlan) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSaved(spec) {
    location.hash = '#dashboard';
    // give the router two frames to swap views before rendering into the dashboard view
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('ledgerview:open-saved', { detail: spec }));
    }));
  }

  function wireData() {
    $('#pf-dash-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      const row = e.target.closest('.pf-item');
      if (!btn || !row) return;
      const rec = ($('#pf-dash-list')._records || []).find((r) => r.id === row.dataset.id);
      if (!rec) return;
      if (btn.hasAttribute('data-open')) openSaved(rec.spec);
      else if (btn.hasAttribute('data-download')) {
        const slug = String(rec.spec.title || 'dashboard').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dashboard';
        download('ledgerview-' + slug + '.json', rec);
      } else if (btn.hasAttribute('data-delete')) {
        if (!window.confirm('Delete “' + (rec.spec.title || 'this dashboard') + '”?')) return;
        try {
          await LVAuth.deleteDashboard(rec.id);
          window.dispatchEvent(new CustomEvent('ledgerview:dashboards-changed'));
          say('#pf-data-msg', 'Dashboard deleted.');
          await renderData();
        } catch (err) { say('#pf-data-msg', err.message || 'Couldn’t delete — try again.', true); }
      }
    });

    $('#pf-clear-session').addEventListener('click', async () => {
      if (!window.confirm('Forget your last pasted data, prompt and dashboard? Saved dashboards are not affected.')) return;
      try { await LVAuth.clearWorkspace(); say('#pf-data-msg', 'Remembered session cleared.'); await renderData(); }
      catch (err) { say('#pf-data-msg', err.message || 'Couldn’t clear — try again.', true); }
    });

    $('#pf-delete-all').addEventListener('click', async () => {
      const list = $('#pf-dash-list')._records || [];
      if (!list.length || !window.confirm('Delete all ' + list.length + ' saved dashboard' + (list.length === 1 ? '' : 's') + '? This can’t be undone.')) return;
      try {
        for (const rec of list) await LVAuth.deleteDashboard(rec.id);
        window.dispatchEvent(new CustomEvent('ledgerview:dashboards-changed'));
        say('#pf-data-msg', 'All saved dashboards deleted.');
        await renderData();
      } catch (err) { say('#pf-data-msg', err.message || 'Couldn’t delete — try again.', true); }
    });

    $('#pf-export').addEventListener('click', async () => {
      try {
        const [ws, dashboards] = await Promise.all([LVAuth.getWorkspace(), LVAuth.listDashboards()]);
        download('ledgerview-my-data.json', { exportedAt: new Date().toISOString(), account: LVAuth.user, workspace: ws, dashboards });
        say('#pf-data-msg', 'Downloaded.');
      } catch (err) { say('#pf-data-msg', 'Couldn’t export — try again.', true); }
    });
  }

  function wireSecurity() {
    $('#pf-pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      const cur = $('#pf-pw-current').value, next = $('#pf-pw-new').value, again = $('#pf-pw-confirm').value;
      say('#pf-pw-msg', '');
      if (!cur) return say('#pf-pw-msg', 'Enter your current password.', true);
      if (next.length < 8) return say('#pf-pw-msg', 'The new password needs at least 8 characters.', true);
      if (next !== again) return say('#pf-pw-msg', 'The two new passwords don’t match.', true);
      busy(btn, true);
      try {
        await LVAuth.changePassword(cur, next);
        e.target.reset();
        say('#pf-pw-msg', LVAuth.backend ? 'Password changed. Your other devices have been logged out.' : 'Password changed.');
      } catch (err) { say('#pf-pw-msg', err.message, true); }
      finally { busy(btn, false); }
    });

    $('#pf-logout').addEventListener('click', async () => { await LVAuth.logout(); location.hash = '#home'; });
    $('#pf-logout-all').addEventListener('click', async () => {
      if (!window.confirm('Log out of every device, including this one?')) return;
      await LVAuth.logoutAll(); location.hash = '#home';
    });

    $('#pf-delete-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      const pw = $('#pf-del-pw').value;
      say('#pf-del-msg', '');
      if (!pw) return say('#pf-del-msg', 'Enter your password to confirm.', true);
      if (!window.confirm('Permanently delete your account and all saved dashboards?')) return;
      busy(btn, true);
      try { await LVAuth.deleteAccount(pw); e.target.reset(); location.hash = '#home'; }
      catch (err) { say('#pf-del-msg', err.message, true); }
      finally { busy(btn, false); }
    });
  }

  /* ---------------- start ---------------- */

  function init() {
    if (!$('#view-profile') || !window.LVAuth) return;
    wireDetails(); wirePlans(); wireData(); wireSecurity();

    LVAuth.onChange(() => { render(); });
    LVAuth.ready.then(render);

    window.addEventListener('hashchange', () => {
      if (!isProfileRoute()) return;
      say('#pf-details-msg', ''); say('#pf-plan-msg', ''); say('#pf-data-msg', ''); say('#pf-pw-msg', ''); say('#pf-del-msg', '');
      render().then(() => { scrollToPlans(); pendingPlan = ''; });
    });
    if (isProfileRoute()) render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
