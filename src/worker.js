// Kasturi CRM — Cloudflare Worker entry. Static files (team CRM at /, student portal at /learn/) are served
// by Workers assets; only /api/* reaches this code (run_worker_first in wrangler.toml).
import { Router, Db, HttpError, json, fail, setOffset } from './lib.js';
import * as auth from './auth.js';
import * as hooks from './hooks.js';
import * as leads from './leads.js';
import * as stu from './students.js';
import * as portal from './portal.js';
import * as reports from './reports.js';
import * as settings from './settings.js';

const QUERY_BUDGET = 45;
const r = new Router();
const PUBLIC = new Set();
const pub = (method, path, h) => { r.add(method, path, h); PUBLIC.add(h); };

// ---- public ----
pub('GET', '/api/health', () => json({ ok: true }));
pub('GET', '/api/setup-status', auth.setupStatus);
pub('POST', '/api/setup', auth.setup);
pub('POST', '/api/login', auth.login);
pub('POST', '/api/logout', auth.logout);
// ---- webhooks (key-authenticated, no session) ----
pub('GET', '/api/hook/meta', hooks.metaVerify);
pub('POST', '/api/hook/meta', hooks.metaHook);
pub('POST', '/api/hook/google/:key', hooks.googleHook);
pub('POST', '/api/hook/web/:key', hooks.webHook);
pub('POST', '/api/hook/in/:key', hooks.inHook);
// ---- student portal (token in x-student-token header) ----
pub('GET', '/api/portal/info', portal.portalInfo);
pub('POST', '/api/portal/login', portal.portalLogin);
pub('GET', '/api/portal/me', portal.portalMe);

// ---- team ----
r.get('/api/me', meta);
r.post('/api/me/password', auth.changePassword);
r.get('/api/dashboard', reports.dashboard);
r.get('/api/counts', async (ctx) => json(await leads.counts(ctx)));

r.get('/api/leads', leads.listLeads);
r.post('/api/leads', leads.createLead);
r.post('/api/leads/bulk', leads.bulkLeads);
r.post('/api/leads/import', leads.importLeads);
r.get('/api/leads/export', leads.exportLeads);
r.get('/api/leads/:id', leads.getLead);
r.patch('/api/leads/:id', leads.updateLead);
r.post('/api/leads/:id/log', leads.logActivity);
r.post('/api/leads/:id/enrol', stu.enrolLead);

r.get('/api/courses', stu.listCourses);
r.post('/api/courses', stu.saveCourse);
r.patch('/api/courses/:id', stu.saveCourse);
r.del('/api/courses/:id', stu.deleteCourse);
r.get('/api/students', stu.listStudents);
r.post('/api/students', stu.createStudent);
r.get('/api/students/:id', stu.getStudent);
r.patch('/api/students/:id', stu.updateStudent);
r.post('/api/students/:id/enrol', stu.addEnrollment);
r.post('/api/students/:id/resend', stu.resendLink);
r.patch('/api/enrollments/:id', stu.setEnrollment);
r.get('/api/updates', stu.listUpdates);
r.post('/api/updates', stu.createUpdate);
r.patch('/api/updates/:id', stu.editUpdate);
r.del('/api/updates/:id', stu.deleteUpdate);

r.get('/api/users', auth.listUsers);
r.post('/api/users', auth.createUser);
r.patch('/api/users/:id', auth.updateUser);
r.post('/api/users/:id/reset-password', auth.resetPassword);
r.get('/api/users/:id/password', auth.viewTempPassword);
r.get('/api/sources', hooks.listSources);
r.post('/api/sources', hooks.createSource);
r.patch('/api/sources/:id', hooks.updateSource);
r.del('/api/sources/:id', hooks.deleteSource);
r.post('/api/sources/:id/test', hooks.testSource);
r.get('/api/settings', settings.getSettings);
r.put('/api/settings', settings.saveSettings);
r.post('/api/settings/test-email', settings.testEmail);
r.get('/api/email-log', settings.emailLog);

// Everything the team app needs once after sign-in: who am I, stages, team, sources, courses, settings.
async function meta(ctx) {
  const cfg = await settings.loadConfig(ctx);
  const [stages, users, sources, courses] = await Promise.all([
    ctx.db.all('SELECT * FROM stages ORDER BY sort'),
    ctx.db.all('SELECT id,name,role,active FROM users ORDER BY name'),
    ctx.db.all('SELECT id,type,name FROM sources ORDER BY id'),
    ctx.db.all('SELECT id,name,price,active,class_link,schedule FROM courses ORDER BY active DESC, id DESC'),
  ]);
  const u = ctx.user;
  return json({ user: { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role }, must_change: !!u.must_change,
    stages, users, sources, courses, config: settings.publicConfig(cfg), outcomes: leads.OUTCOMES, update_kinds: stu.UPDATE_KINDS });
}

const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
const COOKIE_POSTS = new Set(['/api/setup', '/api/login', '/api/logout']);

async function handle(req, env, exec) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/hook/')) return new Response(null, { status: 204, headers: hooks.CORS });
  const m = r.match(req.method, url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  const db = new Db(env.DB);
  let bodyCache;
  const ctx = {
    req, env, exec, url, db, params: m.params, query: url.searchParams, user: null,
    body: async () => {
      if (bodyCache === undefined) { try { bodyCache = await req.json(); } catch { bodyCache = {}; } }
      return bodyCache || {};
    },
  };
  // CSRF: browsers can't add a custom header cross-site without a CORS preflight, which we never allow.
  const needsHeader = !PUBLIC.has(m.handler) || COOKIE_POSTS.has(url.pathname) || url.pathname === '/api/portal/login';
  if (req.method !== 'GET' && needsHeader && req.headers.get('x-requested-with') !== 'kx') fail(403, 'Missing X-Requested-With header');
  if (!PUBLIC.has(m.handler)) {
    ctx.user = await auth.loadSession(ctx);
    if (!ctx.user) fail(401, 'Not logged in');
    if (ctx.user.must_change && !['/api/me', '/api/me/password'].includes(url.pathname)) fail(403, 'Please choose your own password first');
  }
  const res = await m.handler(ctx);
  return { res, db };
}

export default {
  async fetch(req, env, exec) {
    setOffset(env.TIMEZONE_OFFSET_MIN);
    if (!env.SESSION_SECRET) return json({ error: 'SESSION_SECRET is not configured' }, 500);
    let res, db;
    try {
      const out = await handle(req, env, exec);
      if (out instanceof Response) res = out; else ({ res, db } = out);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else { console.error('Unhandled', req.method, req.url, e?.stack || e); res = json({ error: 'Server error' }, 500); }
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
    if (db) {
      h.set('x-queries', String(db.n));
      if (env.DEV) console.log(`[q=${db.n}${db.n > QUERY_BUDGET ? ' OVER BUDGET' : ''}] ${req.method} ${new URL(req.url).pathname}`);
    }
    return new Response(res.body, { status: res.status, headers: h });
  },
};
