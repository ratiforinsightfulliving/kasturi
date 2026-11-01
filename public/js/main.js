// Boot, hash router and the app shell. /api/me returns everything the screens need (team, stages, sources, courses).
import { h, raw, ic, $, $$, on, setHTML, state, get, post, toast, errToast, modal, input, closeDrawer } from './core.js';
import * as authV from './views/auth.js';
import * as homeV from './views/home.js';
import * as leadsV from './views/leads.js';
import * as stuV from './views/students.js';
import * as setV from './views/settings.js';

const routes = [
  ['/login', authV.login, { public: true }], ['/setup', authV.setup, { public: true }],
  ['/home', homeV.home], ['/leads', leadsV.leads], ['/leads/:id', leadsV.leads], ['/followups', leadsV.followups],
  ['/students', stuV.students], ['/students/:id', stuV.students], ['/classes', stuV.classes], ['/classes/:id', stuV.classes],
  ['/settings', setV.settings], ['/settings/:tab', setV.settings],
].map(([p, fn, o]) => {
  const keys = [];
  const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { re, keys, fn, ...(o || {}) };
});

function parseHash() {
  const r = location.hash.replace(/^#/, '') || '/';
  const [path, q] = r.split('?');
  return { path: path.replace(/\/$/, '') || '/', query: new URLSearchParams(q || '') };
}

// Re-read team/stages/sources/courses after settings change.
export async function reloadMeta() { state.me = await get('/me'); return state.me; }
export const isAdmin = () => state.me?.user.role === 'admin';
export const stageOf = (id) => state.me.stages.find((s) => s.id === id) || { name: '—', color: '#93a097' };
export const userName = (id) => state.me.users.find((u) => u.id === id)?.name || 'Unassigned';
export const sourceName = (id) => (id ? state.me.sources.find((s) => s.id === id)?.name || '(deleted source)' : 'Added manually');

let renderSeq = 0;
export async function render() {
  const { path, query } = parseHash();
  const seq = ++renderSeq;
  closeDrawer();
  $$('.overlay').forEach((o) => o.remove());
  const open = ['/login', '/setup'];
  if (!state.me && !open.includes(path)) {
    try { state.me = await get('/me'); } catch (e) {
      if (e.status === 401) {
        try { const s = await get('/setup-status'); location.hash = s.needsSetup ? '#/setup' : '#/login'; } catch { location.hash = '#/login'; }
        return;
      }
      setHTML($('#app'), h`<div class="boot"><div class="note err">Could not reach the server: ${e.message}. <a href="javascript:location.reload()">Retry</a></div></div>`);
      return;
    }
  }
  if (path === '/') return location.replace('#/home');
  const r = routes.find((x) => x.re.test(path));
  if (!r) return location.replace('#/home');
  const m = r.re.exec(path);
  const params = {};
  r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
  if (r.public) { await r.fn($('#app'), params, query); return; }
  if (state.me.must_change) { authV.mustChange($('#app')); return; }
  if (seq !== renderSeq) return;
  shell(path);
  state.route = { path, params, query };
  // Fresh container per route so delegated listeners from the previous page are dropped.
  const old = $('#view');
  const view = old.cloneNode(false);
  old.replaceWith(view);
  setHTML(view, h`<div class="loading">Loading…</div>`);
  try { await r.fn(view, params, query); }
  catch (e) {
    if (seq !== renderSeq) return;
    if (e.status !== 401) setHTML(view, h`<div class="note err">${e.status === 403 ? 'You do not have access to this page.' : e.message}</div>`);
  }
  refreshCounts();
}
window.addEventListener('hashchange', render);
export const refresh = () => render();

export function setTitle(t) { const el = $('#ptitle'); if (el) el.textContent = t; document.title = t + ' · Kasturi CRM'; }

// Follow-up badge in the sidebar.
export async function refreshCounts() {
  try {
    const c = await get('/counts');
    const el = $('#fu-count');
    if (el) { const n = c.overdue + c.today; el.textContent = n || ''; el.hidden = !n; }
    const f = $('#new-count');
    if (f) { f.textContent = c.fresh || ''; f.hidden = !c.fresh; }
  } catch { /* ignore */ }
}

// ---------- Shell ----------
const L = (path, href, label, iconName, extra = '') =>
  h`<a href="#${href}" class="${path === href || path.startsWith(href + '/') ? 'on' : ''}" title="${label}">${ic(iconName)}<span>${label}</span>${extra}</a>`;
const sec = (t) => h`<div class="nav-sec">${t}</div>`;

function shell(path) {
  const me = state.me;
  if ($('#view') && $('.app')) {
    // Only re-draw the nav (keeps sidebar scroll and theme state).
    setHTML($('#nav'), navHtml(path));
    return;
  }
  setHTML($('#app'), h`<div class="app ${localStorage.getItem('kx_side') === 'c' ? 'collapsed' : ''}">
    <aside class="side">
      <div class="side-logo"><img class="kx-logo" src="/img/logo.png" alt="Kasturi"><div class="names"><small>${me.config.tagline}</small></div></div>
      <div class="side-scroll"><nav class="nav" id="nav">${navHtml(path)}</nav></div>
      <div class="side-bottom">
        <a href="/learn/" target="_blank" rel="noopener" title="Student page">${ic('link')}<span>Student page</span></a>
        <button type="button" data-theme-toggle title="Light / dark">${ic('star')}<span>Light / dark</span></button>
        <button type="button" data-pw title="Change password">${ic('lock')}<span>Change password</span></button>
        <button type="button" data-logout title="Log out">${ic('logout')}<span>Log out · ${me.user.name}</span></button>
      </div>
    </aside>
    <div class="main">
      <header class="top"><button class="icon-btn burger" data-burger aria-label="Menu">${ic('menu')}</button><h1 id="ptitle"></h1><div class="sp"></div>
        <a class="btn primary" href="#/leads?add=1">${ic('plus')} Add lead</a></header>
      <main class="view" id="view"></main>
    </div>
  </div>`);
  const app = $('.app');
  on(app, 'click', '[data-burger]', () => app.classList.toggle('nav-open'));
  on(app, 'click', '.nav a', () => app.classList.remove('nav-open'));
  on(app, 'click', '[data-logout]', async () => { await post('/logout').catch(() => {}); state.me = null; location.hash = '#/login'; });
  on(app, 'click', '[data-theme-toggle]', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('kx_theme', next); } catch { /* ignore */ }
  });
  on(app, 'click', '[data-pw]', () => modal({
    title: 'Change password',
    body: h`${input('current', 'Current password', '', 'password', 'autocomplete="current-password" required')}${input('password', 'New password (min 8 characters)', '', 'password', 'autocomplete="new-password" minlength="8" required')}`,
    onSubmit: async (d) => { await post('/me/password', d); toast('Password changed'); },
  }));
}
function navHtml(path) {
  const out = [sec('Work'), L(path, '/home', 'Home', 'home'),
    L(path, '/leads', 'Leads', 'users', raw('<span class="cnt" id="new-count" hidden></span>')),
    L(path, '/followups', 'Follow-ups', 'clock', raw('<span class="cnt" id="fu-count" hidden></span>')),
    sec('Students'), L(path, '/students', 'Students', 'star'), L(path, '/classes', 'Classes & updates', 'calendar')];
  if (isAdmin()) out.push(sec('Admin'), L(path, '/settings', 'Settings', 'cog'));
  return h`${out}`;
}

window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status !== 401) errToast(e.reason || 'Something went wrong'); });
render();
