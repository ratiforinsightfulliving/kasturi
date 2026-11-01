// Core UI kit: safe HTML templating, API client, toasts, modal, drawer, tables, form helpers, formatters.
// All interpolated values are HTML-escaped unless wrapped in raw().

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const rnd = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(rnd).join('') : esc(v));
export function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += rnd(vals[i]); });
  return new Raw(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function setHTML(el, tpl) { el.innerHTML = tpl instanceof Raw ? tpl.s : esc(tpl); return el; }
// Delegated events: on(root, 'click', '[data-x]', (e, el) => …)
export function on(root, type, sel, fn) {
  root.addEventListener(type, (e) => { const t = e.target.closest(sel); if (t && root.contains(t)) fn(e, t); });
}

// ---------- State ----------
export const state = { me: null, ws: {}, route: null };

// ---------- API ----------
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'x-requested-with': 'kx', ...headers } };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (rawBody) opts.body = rawBody;
  let r;
  try { r = await fetch('/api' + path, opts); } catch { throw new ApiError('Network error — check your connection', 0); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && !['/login', '/me', '/setup'].includes(path)) {
    state.me = null;
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new ApiError('Session ended — please log in again', 401);
  }
  if (!r.ok) throw new ApiError((data && data.error) || r.statusText, r.status);
  return data;
}
export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
export const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false)).toString(); return s ? '?' + s : ''; };

// ---------- Toast ----------
export function toast(msg, type = 'ok') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}
export const errToast = (e) => toast(e.message || String(e), 'err');

// ---------- Modal ----------
// modal({title, body, submit:'Save', onSubmit: async (data, form) => {…return false to keep open}, wide})
export function modal({ title, body, submit = 'Save', cancel = 'Cancel', onSubmit, wide, danger, onOpen }) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  setHTML(wrap, h`<form class="modal ${wide ? 'wide' : ''}" novalidate>
    <div class="modal-h"><h3>${title}</h3><button type="button" class="icon-btn" data-close aria-label="Close">${raw(icon('x'))}</button></div>
    <div class="modal-b">${body}<div class="form-err"></div></div>
    <div class="modal-f">${cancel ? h`<button type="button" class="btn ghost" data-close>${cancel}</button>` : ''}
      ${onSubmit ? h`<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${submit}</button>` : ''}</div>
  </form>`);
  document.body.appendChild(wrap);
  const form = $('form', wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  on(wrap, 'click', '[data-close]', close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = $('button[type=submit]', form);
    const err = $('.form-err', form);
    err.textContent = '';
    btn.disabled = true;
    try {
      const r = await onSubmit(formData(form), form);
      if (r !== false) close();
    } catch (ex) { err.textContent = ex.message || String(ex); } finally { btn.disabled = false; }
  });
  setTimeout(() => { const f = $('input:not([type=hidden]),select,textarea', form); if (f && !onOpen) f.focus(); }, 30);
  if (onOpen) onOpen(form, close);
  return { el: wrap, form, close };
}
export function confirmBox(message, { title = 'Are you sure?', ok = 'Confirm', danger = true } = {}) {
  return new Promise((res) => {
    const m = modal({ title, body: h`<p>${message}</p>`, submit: ok, danger, onSubmit: () => res(true) });
    on(m.el, 'click', '[data-close]', () => res(false));
  });
}
export function infoBox(title, body) { modal({ title, body, cancel: 'Close' }); }

// ---------- Drawer ----------
let drawerEl = null;
export function drawer({ title, onClose, wide }) {
  closeDrawer();
  const wrap = document.createElement('div');
  wrap.className = 'drawer-wrap';
  setHTML(wrap, h`<aside class="drawer ${wide ? 'wide' : ''}"><div class="drawer-h"><h3>${title}</h3>
    <button class="icon-btn" data-dclose aria-label="Close">${raw(icon('x'))}</button></div><div class="drawer-b"><div class="loading">Loading…</div></div></aside>`);
  document.body.appendChild(wrap);
  drawerEl = { wrap, onClose };
  on(wrap, 'click', '[data-dclose]', () => closeDrawer(true));
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeDrawer(true); });
  return { body: $('.drawer-b', wrap), title: $('.drawer-h h3', wrap), close: () => closeDrawer(true) };
}
export function closeDrawer(user) {
  if (!drawerEl) return;
  const d = drawerEl; drawerEl = null;
  d.wrap.remove();
  if (user && d.onClose) d.onClose();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerEl && !$('.overlay')) closeDrawer(true); });

// ---------- Forms ----------
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { if (el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked ? 1 : 0; }
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type === 'file') o[el.name] = el.files[0] || null;
    else o[el.name] = el.value;
  }
  return o;
}
export function field(label, control, hint) {
  return h`<label class="field"><span>${label}</span>${control}${hint ? h`<small>${hint}</small>` : ''}</label>`;
}
export const input = (name, label, value = '', type = 'text', attrs = '') =>
  field(label, raw(`<input name="${esc(name)}" type="${type}" value="${esc(value ?? '')}" ${attrs}>`));
export const textarea = (name, label, value = '', attrs = 'rows="3"') =>
  field(label, raw(`<textarea name="${esc(name)}" ${attrs}>${esc(value ?? '')}</textarea>`));
export function options(list, value, blank) {
  const opts = list.map((o) => (Array.isArray(o) ? o : typeof o === 'object' ? [o.id ?? o.value, o.name ?? o.label] : [o, o]));
  return (blank != null ? `<option value="">${esc(blank)}</option>` : '') +
    opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
export const select = (name, label, list, value, blank, attrs = '') =>
  field(label, raw(`<select name="${esc(name)}" ${attrs}>${options(list, value, blank)}</select>`));
export const check = (name, label, checked, attrs = '') =>
  h`<label class="check"><input type="checkbox" name="${name}" ${checked ? raw('checked') : ''} ${raw(attrs)}> <span>${label}</span></label>`;

// ---------- Tables ----------
// cols: [{label, cell: row => html|string, cls}]
export function table(cols, rows, { empty = 'Nothing here yet', rowAttr } = {}) {
  if (!rows.length) return emptyState(empty);
  return h`<div class="table-wrap"><table class="tbl"><thead><tr>${cols.map((c) => h`<th class="${c.cls || ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => h`<tr ${raw(rowAttr ? rowAttr(r) : '')}>${cols.map((c) => h`<td class="${c.cls || ''}">${c.cell(r)}</td>`)}</tr>`)}</tbody></table></div>`;
}
export function emptyState(msg, action) {
  return h`<div class="empty">${raw(icon('inbox'))}<p>${msg}</p>${action || ''}</div>`;
}
// Paged list with "Load more": loader(cursor) -> {items, next}; render(items) -> rows html (tbody content)
export async function pagedTable(container, { cols, loader, empty, rowAttr, onRows }) {
  let all = [];
  let next = null;
  const draw = () => {
    setHTML(container, h`${table(cols, all, { empty, rowAttr })}${next ? h`<div class="more"><button class="btn ghost" data-more>Load more</button></div>` : ''}`);
    onRows && onRows(all);
  };
  const load = async (cursor) => {
    const r = await loader(cursor);
    all = cursor ? all.concat(r.items) : r.items;
    next = r.next;
    draw();
  };
  container.onclick = async (e) => {
    const b = e.target.closest('[data-more]');
    if (!b) return;
    b.disabled = true; b.textContent = 'Loading…';
    try { await load(next); } catch (ex) { errToast(ex); }
  };
  setHTML(container, h`<div class="loading">Loading…</div>`);
  await load(null);
  return { reload: () => load(null), rows: () => all };
}

// ---------- Small widgets ----------
export const badge = (text, color, cls = '') => h`<span class="badge ${cls}" style="${color ? raw(`--b:${esc(color)}`) : ''}">${text}</span>`;
export function tabs(items, active, attr = 'data-tab') {
  return h`<div class="tabs">${items.map(([k, label, count]) => h`<button class="tab ${k === active ? 'on' : ''}" ${raw(attr)}="${k}">${label}${count != null ? h` <b>${count}</b>` : ''}</button>`)}</div>`;
}
export function linkTabs(items, active) {
  return h`<div class="tabs">${items.map(([k, label, href]) => h`<a class="tab ${k === active ? 'on' : ''}" href="${href}">${label}</a>`)}</div>`;
}
export function stat(label, value, sub, tone) {
  return h`<div class="stat ${tone || ''}"><div class="stat-l">${label}</div><div class="stat-v">${value}</div>${sub ? h`<div class="stat-s">${sub}</div>` : ''}</div>`;
}
export function progressBar(p) { const v = Math.max(0, Math.min(100, Number(p) || 0)); return h`<div class="pbar"><i style="width:${v}%"></i></div>`; }

// ---------- Dates & formats (IST) ----------
const IST = 330 * 60000;
const pad = (n) => String(n).padStart(2, '0');
export function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + IST + offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function nowLocal() { const d = new Date(Date.now() + IST); return d.toISOString().slice(0, 16).replace('T', ' '); }
export function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function monthStart(day = todayStr()) { return day.slice(0, 8) + '01'; }
export function monthEnd(m) { return new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10); }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fdate(s) { if (!s) return '—'; const [y, m, d] = s.slice(0, 10).split('-'); return `${+d} ${MON[+m - 1]}${y !== todayStr().slice(0, 4) ? ' ' + y : ''}`; }
export function fdt(s) {
  if (!s) return '—';
  const day = s.slice(0, 10);
  const t = s.slice(11, 16);
  const today = todayStr();
  const label = day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : day === addDays(today, 1) ? 'Tomorrow' : fdate(day);
  return t ? `${label}, ${fmtTime(t)}` : label;
}
export function fmtTime(t) { let [hh, mm] = t.split(':').map(Number); const ap = hh >= 12 ? 'pm' : 'am'; hh = hh % 12 || 12; return `${hh}:${pad(mm)} ${ap}`; }
export function fmonth(m) { return `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`; }
export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const num = (n) => Number(n || 0).toLocaleString('en-IN');
export const pct = (x) => (x == null ? '—' : Math.round(x * 1000) / 10 + '%');
export const mins = (m) => (m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 144) / 10} days`);
export const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const phoneFmt = (p) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p || '');

// Date-range picker with presets. onChange({from,to})
export function rangePicker(from, to) {
  return h`<div class="range"><select data-preset>${raw(options([['', 'Custom'], ['today', 'Today'], ['7d', 'Last 7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']], ''))}</select>
    <input type="date" data-from value="${from}"><span>→</span><input type="date" data-to value="${to}"></div>`;
}
export function bindRange(root, cb) {
  const f = $('[data-from]', root), t = $('[data-to]', root), p = $('[data-preset]', root);
  const fire = () => cb({ from: f.value, to: t.value });
  p.onchange = () => {
    const today = todayStr();
    const m = { today: [today, today], '7d': [addDays(today, -6), today], month: [monthStart(), today], '30d': [addDays(today, -29), today], '90d': [addDays(today, -89), today] };
    if (p.value === 'lastmonth') { const e = addDays(monthStart(), -1); m.lastmonth = [monthStart(e), e]; }
    if (m[p.value]) { [f.value, t.value] = m[p.value]; fire(); }
  };
  f.onchange = t.onchange = () => { p.value = ''; if (f.value && t.value) fire(); };
}

export function downloadText(name, text, type = 'text/csv') {
  const blob = new Blob(['﻿' + text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const csvCell = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); }
  catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
}
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------- Icons (inline SVG, stroke-based) ----------
const P = {
  x: 'M6 6l12 12M18 6L6 18', menu: 'M4 6h16M4 12h16M4 18h16', bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7', inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5', check: 'M5 12l5 5L20 7',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2', users: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a4 4 0 100-8 4 4 0 000 8M22 19v-1a4 4 0 00-3-3.9M16 2.1a4 4 0 010 7.8',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', report: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 13h8M8 17h5',
  cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  briefcase: 'M3 7h18v13H3zM8 7V4h8v3M3 12h18', rupee: 'M6 4h12M6 9h12M14 4c3 0 4 2.5 4 5s-2 5-6 5H7l8 7', calendar: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
  pulse: 'M3 12h4l3-8 4 16 3-8h4', phone: 'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z',
  chat: 'M21 12a8 8 0 01-11.6 7.1L3 21l1.9-6.4A8 8 0 1121 12z', plus: 'M12 5v14M5 12h14', back: 'M15 18l-6-6 6-6', copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16', download: 'M12 4v12M7 11l5 5 5-5M4 20h16', logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z', trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15', link: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
  up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M19 12l-7 7-7-7', clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2', progress: 'M4 19h16M4 15l4-4 4 3 7-8',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 118 0v4', star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  bag: 'M6 8h12l1 13H5zM9 8a3 3 0 016 0', building: 'M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3M3 21h18', panel: 'M3 4h18v16H3zM9 4v16',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', home: 'M3 11l9-8 9 8M5 9v12h14V9', search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
};
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || P.inbox}"/></svg>`;
}
export const ic = (n, c) => raw(icon(n, c));
