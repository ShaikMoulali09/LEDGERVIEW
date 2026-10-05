/* Ledgerview accounts + remembered work.
   Exposes window.LVAuth. With the Express backend running, accounts, sessions, dashboards and the
   "last session" live on the server. Without it, the same API is served from localStorage, so the
   site still works when index.html is opened directly (accounts then live in this browser only). */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const K = { users: 'lv_users', session: 'lv_session', token: 'lv_token' };

  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
  const safeDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };
  const readJSON = (k, fb) => { try { return JSON.parse(safeGet(k) || 'null') ?? fb; } catch { return fb; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = { backend: null, ai: false, user: null, token: safeGet(K.token) || '', tab: 'signup', justSignedUp: false, returnTo: '' };
  const listeners = [];
  const emit = () => listeners.forEach((fn) => { try { fn(S.user); } catch (e) { console.error(e); } });

  /* ---------------- http ---------------- */

  async function api(path, opts = {}) {
    try {
      const headers = Object.assign({}, opts.headers || {});
      if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      if (S.token) headers.Authorization = 'Bearer ' + S.token;
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null }; // no server, or opened via file://
    }
  }

  /* ---------------- local accounts (no-backend mode) ---------------- */

  const localUsers = () => readJSON(K.users, {});
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, company: u.company || '', plan: u.plan || 'Free', createdAt: u.createdAt || null, planSince: u.planSince || u.createdAt || null });
  const rid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'u_' + Date.now() + Math.random().toString(36).slice(2));

  async function hashPw(pw, salt) {
    if (window.crypto && crypto.subtle) {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
      return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381; const s = salt + pw; // very old browsers only — not secure, demo fallback
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'weak' + h;
  }

  /* ---------------- account actions ---------------- */

  function setUser(user, token) {
    S.user = user;
    if (S.backend) { S.token = token || ''; safeSet(K.token, S.token); }
    else safeSet(K.session, user.email);
    renderNav(); renderAuthView(); emit();
  }

  async function signup({ name, email, company, plan, password }) {
    email = String(email).trim().toLowerCase();
    if (!String(name).trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || String(password).length < 8)
      throw new Error('Fill in your name, a valid email and a password of at least 8 characters.');
    S.justSignedUp = true;
    if (S.backend) {
      const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, company, plan, password }) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t create the account — try again.');
      return setUser(r.data.user, r.data.token);
    }
    const all = localUsers();
    if (all[email]) throw new Error('An account with that email already exists — log in instead.');
    const salt = rid();
    const rec = { id: rid(), name: String(name).trim(), email, company: String(company || '').trim(), plan: plan || 'Free', salt, hash: await hashPw(password, salt), createdAt: new Date().toISOString() };
    all[email] = rec;
    if (!safeSet(K.users, JSON.stringify(all))) throw new Error('This browser is blocking storage, so an account can’t be saved here.');
    setUser(pub(rec));
  }

  async function login({ email, password }) {
    email = String(email).trim().toLowerCase();
    S.justSignedUp = false;
    if (S.backend) {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t log in — try again.');
      return setUser(r.data.user, r.data.token);
    }
    const rec = localUsers()[email];
    if (!rec || (await hashPw(password, rec.salt)) !== rec.hash) throw new Error('Incorrect email or password.');
    setUser(pub(rec));
  }

  function clearSession() {
    S.token = ''; S.user = null; S.justSignedUp = false;
    safeDel(K.token); safeDel(K.session);
    renderNav(); renderAuthView(); emit();
  }

  async function logout() {
    if (S.backend && S.token) await api('/api/auth/logout', { method: 'POST' });
    clearSession();
  }

  /* ---------------- profile page actions ---------------- */

  function saveLocalUser(rec) {
    const all = localUsers();
    all[rec.email] = rec;
    if (!safeSet(K.users, JSON.stringify(all))) throw new Error('This browser is blocking storage, so the change can’t be saved.');
    S.user = pub(rec);
    renderNav(); renderAuthView(); emit();
    return S.user;
  }

  async function updateProfile({ name, company }) {
    if (!S.user) throw new Error('Log in first.');
    if (!String(name).trim()) throw new Error('Your name can’t be empty.');
    if (S.backend) {
      const r = await api('/api/account/profile', { method: 'PUT', body: JSON.stringify({ name, company }) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t save — try again.');
      S.user = r.data.user; renderNav(); renderAuthView(); emit();
      return S.user;
    }
    const rec = localUsers()[S.user.email];
    return saveLocalUser(Object.assign({}, rec, { name: String(name).trim(), company: String(company || '').trim() }));
  }

  async function changePassword(current, next) {
    if (!S.user) throw new Error('Log in first.');
    if (String(next).length < 8) throw new Error('The new password needs at least 8 characters.');
    if (S.backend) {
      const r = await api('/api/account/password', { method: 'POST', body: JSON.stringify({ current, next }) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t change the password — try again.');
      return;
    }
    const rec = localUsers()[S.user.email];
    if ((await hashPw(current, rec.salt)) !== rec.hash) throw new Error('Your current password is incorrect.');
    const salt = rid();
    saveLocalUser(Object.assign({}, rec, { salt, hash: await hashPw(next, salt) }));
  }

  async function changePlan(plan) {
    if (!S.user) throw new Error('Log in first.');
    if (S.backend) {
      const r = await api('/api/account/plan', { method: 'PUT', body: JSON.stringify({ plan }) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t change the plan — try again.');
      S.user = r.data.user; renderNav(); renderAuthView(); emit();
      return S.user;
    }
    const rec = localUsers()[S.user.email];
    if ((rec.plan || 'Free') === plan) return S.user;
    return saveLocalUser(Object.assign({}, rec, { plan, planSince: new Date().toISOString() }));
  }

  async function logoutAll() {
    if (S.backend && S.token) await api('/api/account/logout-all', { method: 'POST' });
    clearSession();
  }

  async function deleteAccount(password) {
    if (!S.user) throw new Error('Log in first.');
    const id = S.user.id, email = S.user.email;
    if (S.backend) {
      const r = await api('/api/account', { method: 'DELETE', body: JSON.stringify({ password }) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t delete the account — try again.');
    } else {
      const all = localUsers(), rec = all[email];
      if (!rec || (await hashPw(password, rec.salt)) !== rec.hash) throw new Error('Incorrect password.');
      delete all[email];
      safeSet(K.users, JSON.stringify(all));
      safeDel('lv_ws_' + id); safeDel('lv_dash_' + id);
    }
    clearSession();
  }

  async function clearWorkspace() {
    if (!S.user) return;
    await saveWorkspace({});
    window.dispatchEvent(new CustomEvent('ledgerview:session-cleared'));
  }

  /* ---------------- remembered work (per user) ---------------- */

  async function getWorkspace() {
    if (!S.user) return null;
    if (S.backend) { const r = await api('/api/workspace'); return r.ok ? r.data.workspace : null; }
    return readJSON('lv_ws_' + S.user.id, null);
  }

  async function saveWorkspace(ws) {
    if (!S.user) return;
    if (S.backend) { await api('/api/workspace', { method: 'PUT', body: JSON.stringify({ workspace: ws }) }); return; }
    if (!safeSet('lv_ws_' + S.user.id, JSON.stringify(ws))) {
      const slim = Object.assign({}, ws, { csv: '' });
      safeSet('lv_ws_' + S.user.id, JSON.stringify(slim)); // storage full: keep the dashboard, drop the raw text
    }
  }

  async function listDashboards() {
    if (!S.user) return [];
    if (S.backend) { const r = await api('/api/dashboards'); return r.ok ? r.data.dashboards : []; }
    return readJSON('lv_dash_' + S.user.id, []);
  }

  async function saveDashboard(rec) {
    if (!S.user) throw new Error('Log in to save dashboards.');
    if (S.backend) {
      const r = await api('/api/dashboards', { method: 'POST', body: JSON.stringify(rec) });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Couldn’t save — try again.');
      return;
    }
    const list = readJSON('lv_dash_' + S.user.id, []);
    list.unshift(rec);
    if (!safeSet('lv_dash_' + S.user.id, JSON.stringify(list.slice(0, 30)))) throw new Error('This browser’s storage is full — delete a saved dashboard and try again.');
  }

  async function deleteDashboard(id) {
    if (!S.user) return;
    if (S.backend) { await api('/api/dashboards/' + encodeURIComponent(id), { method: 'DELETE' }); return; }
    safeSet('lv_dash_' + S.user.id, JSON.stringify(readJSON('lv_dash_' + S.user.id, []).filter((r) => r.id !== id)));
  }

  /* ---------------- UI ---------------- */

  function renderNav() {
    const el = $('#nav-auth');
    if (!el) return;
    if (S.user) {
      const first = S.user.name.trim().split(/\s+/)[0] || 'Me';
      const cur = (location.hash === '#profile') ? ' is-current' : '';
      el.innerHTML = `<a class="nav-link nav-profile${cur}" data-view="profile" href="#profile" aria-label="Your profile"><span class="nav-avatar" aria-hidden="true">${esc(first.charAt(0).toUpperCase())}</span><span class="nav-profile-name">${esc(first)}</span></a>`;
    } else {
      el.innerHTML = '<a class="nav-link" data-view="signup" href="#login">Log in</a><a class="nav-cta" data-view="signup" href="#signup">Sign up</a>';
    }
  }

  function renderAuthView() {
    if (!$('#signup-form')) return;
    const inn = !!S.user;
    $('#auth-tabs').hidden = inn;
    $('#signup-form').hidden = inn || S.tab !== 'signup';
    $('#login-form').hidden = inn || S.tab !== 'login';
    $('#signup-success').hidden = !inn;
    $$('.auth-tab').forEach((t) => {
      const on = t.dataset.authTab === S.tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (inn) {
      $('#success-greet').textContent = S.justSignedUp ? 'You’re set' : 'Welcome back';
      $('#success-name').textContent = S.user.name.split(' ')[0];
      $('#success-plan').textContent = S.user.plan;
      $('#success-msg').textContent = S.justSignedUp
        ? 'Drop in a CSV, a photo of a table, or a description — Ledgerview will tidy it up and build the dashboard.'
        : 'Your saved dashboards and your last session are waiting on the Dashboard page.';
    }
    const note = $('#auth-note');
    if (note) note.textContent = S.backend
      ? 'Your account and saved dashboards are stored on this Ledgerview server. Passwords are hashed, never stored in plain text.'
      : 'No backend detected — this account and your saved work live only in this browser. Run `node server.js` for accounts that work across devices.';
  }

  function syncTabFromHash() {
    if (location.hash === '#login') S.tab = 'login';
    else if (location.hash === '#signup') S.tab = 'signup';
    renderAuthView();
  }

  function afterAuth() {
    const dest = S.returnTo;
    S.returnTo = '';
    if (dest) location.hash = '#' + dest;
  }

  function initForms() {
    if (!$('#signup-form')) return;
    $$('.auth-tab').forEach((t) => t.addEventListener('click', () => {
      S.tab = t.dataset.authTab;
      history.replaceState(null, '', '#' + S.tab);
      $('#su-error').textContent = ''; $('#li-error').textContent = '';
      renderAuthView();
    }));

    const run = (form, errEl, fn) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      errEl.textContent = '';
      btn.disabled = true;
      try { await fn(); form.reset(); afterAuth(); }
      catch (err) { errEl.textContent = err.message || 'Something went wrong — try again.'; }
      finally { btn.disabled = false; }
    });

    const sf = $('#signup-form');
    run(sf, $('#su-error'), () => signup({
      name: $('#su-name').value, email: $('#su-email').value, company: $('#su-company').value,
      password: $('#su-password').value, plan: sf.querySelector('input[name="plan"]:checked').value,
    }));
    run($('#login-form'), $('#li-error'), () => login({ email: $('#li-email').value, password: $('#li-password').value }));
    $('#auth-logout').addEventListener('click', logout);
    window.addEventListener('hashchange', syncTabFromHash);
  }

  /* ---------------- start ---------------- */

  async function start() {
    initForms();
    syncTabFromHash();
    const h = await api('/api/health');
    S.backend = !!(h.ok && h.data && h.data.ok);
    S.ai = !!(h.data && h.data.ai);
    if (S.backend && S.token) {
      const me = await api('/api/auth/me');
      if (me.ok) S.user = me.data.user;
      else if (me.status === 401) { S.token = ''; safeDel(K.token); }
    } else if (!S.backend) {
      const em = safeGet(K.session);
      const rec = em && localUsers()[em];
      if (rec) S.user = pub(rec);
    }
    renderNav(); renderAuthView(); emit();
  }

  const ready = start();

  window.LVAuth = {
    ready, api, signup, login, logout, getWorkspace, saveWorkspace, listDashboards, saveDashboard, deleteDashboard,
    updateProfile, changePassword, changePlan, logoutAll, deleteAccount, clearWorkspace,
    onChange: (fn) => listeners.push(fn),
    get backend() { return S.backend; }, get ai() { return S.ai; }, get user() { return S.user; },
    set returnTo(v) { S.returnTo = v; },
  };
  renderNav();
})();
