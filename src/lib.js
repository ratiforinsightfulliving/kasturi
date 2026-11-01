// Kasturi CRM shared helpers (from the Gexart CRM): errors, JSON, router, DB wrapper with query counting, IST dates,
// phone normalisation, crypto (PBKDF2 / HMAC), CSV and small utilities.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const forbid = (msg = 'Forbidden') => fail(403, msg);

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// ---------- Router ----------
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

// ---------- D1 wrapper: counts every statement so we can enforce the ≤45 budget ----------
const clean = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export class Db {
  constructor(raw) { this.raw = raw; this.n = 0; }
  stmt(sql, ...args) { return this.raw.prepare(sql).bind(...clean(args)); }
  async all(sql, ...args) { this.n++; return (await this.stmt(sql, ...args).all()).results || []; }
  async first(sql, ...args) { this.n++; return await this.stmt(sql, ...args).first(); }
  async val(sql, ...args) { const r = await this.first(sql, ...args); return r ? Object.values(r)[0] : null; }
  async run(sql, ...args) { this.n++; return await this.stmt(sql, ...args).run(); }
  async batch(stmts) {
    stmts = stmts.filter(Boolean);
    if (!stmts.length) return [];
    this.n += stmts.length;
    return await this.raw.batch(stmts);
  }
}

// ---------- IST date helpers (TIMEZONE_OFFSET_MIN = 330) ----------
let OFFSET = 330;
export const setOffset = (m) => { if (m) OFFSET = Number(m) || 330; };
const pad = (n) => String(n).padStart(2, '0');
const shifted = (d = new Date()) => new Date(d.getTime() + OFFSET * 60000);
export function nowIST(d) {
  const s = shifted(d);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}`;
}
export const todayIST = (d) => nowIST(d).slice(0, 10);
export const hourIST = () => shifted().getUTCHours();
export function addDays(day, n) {
  const d = new Date(day.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function addMonths(day, n) {
  const d = new Date(day.slice(0, 10) + 'T00:00:00Z');
  const target = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(target, last));
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
// IST local string -> epoch ms
export const istToMs = (s) => Date.parse(s.slice(0, 19).replace(' ', 'T') + 'Z') - OFFSET * 60000;
export const minutesBetween = (a, b) => Math.max(0, Math.round((istToMs(b) - istToMs(a)) / 60000));
// Accepts ISO with zone, epoch seconds, or IST local -> IST local string
export function toIST(v) {
  if (!v) return nowIST();
  if (typeof v === 'number') return nowIST(new Date(v < 1e12 ? v * 1000 : v));
  const s = String(v);
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) { const d = new Date(s); if (!isNaN(d)) return nowIST(d); }
  const m = /^(\d{4}-\d\d-\d\d)(?:[ T](\d\d:\d\d)(:\d\d)?)?/.exec(s);
  if (m) return `${m[1]} ${m[2] || '00:00'}${m[3] || ':00'}`;
  return nowIST();
}
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);
export const monthOf = (day) => day.slice(0, 7);

// ---------- Normalisers ----------
// "+91 98765-43210" / "098765 43210" / "919876543210" -> "9876543210"
export function normPhone(p) {
  if (p == null) return null;
  let d = String(p).replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('+')) {
    d = d.slice(1);
    if (d.startsWith('91') && d.length === 12) return d.slice(2);
    return d.replace(/\D/g, '') || null;
  }
  d = d.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  if (d.length === 13 && d.startsWith('091')) return d.slice(3);
  return d || null;
}
export function normEmail(e) {
  if (e == null) return null;
  const s = String(e).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
export const str = (v, max = 500) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
export const int = (v, d = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
export const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);
export const oneOf = (v, list, d) => (list.includes(v) ? v : d);

// ---------- Crypto ----------
const enc = new TextEncoder();
export function b64url(buf) {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function randomKey(len = 24) {
  const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}
export function tempPassword() { return randomKey(4) + '-' + randomKey(4) + '-' + randomKey(2); }

const ITER = 30000; // CPU budget on the free plan (~10 ms)
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, ITER);
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(bits)}`;
}
export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2') return false;
  const bits = b64url(await pbkdf2(password, fromB64url(salt), parseInt(iter, 10)));
  return timingSafeEq(bits, hash);
}
export function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Reversible encryption for default (temporary) passwords only. Key = SHA-256(SESSION_SECRET + label).
async function vaultKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret + '|gx-password-vault'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealText(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(secret), enc.encode(text));
  return b64url(iv) + '.' + b64url(ct);
}
export async function openText(secret, sealed) {
  try {
    const [iv, ct] = String(sealed).split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await vaultKey(secret), fromB64url(ct));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function hmac(secret, data, encoding = 'b64url') {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data);
  if (encoding === 'hex') return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return b64url(sig);
}

// ---------- Misc ----------
export function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCSV = (rows) => rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
export function csvResponse(name, rows) {
  return new Response('\ufeff' + toCSV(rows), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` },
  });
}
export function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export const placeholders = (n) => Array(n).fill('?').join(',');
export function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}
export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
// cursor pagination helper: rows fetched with LIMIT n+1
export function page(rows, n = 50, key = 'id') {
  const more = rows.length > n;
  const items = more ? rows.slice(0, n) : rows;
  return { items, next: more ? items[items.length - 1][key] : null };
}
