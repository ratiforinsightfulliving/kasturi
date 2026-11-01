// Team sign-in, sessions, roles, team users and rate limits.
// Roles: admin (everything) and counsellor (works leads; sees only their own unless Settings allows all).
import {
  fail, forbid, json, hmac, timingSafeEq, hashPassword, verifyPassword, normEmail, normPhone, nowIST, str, int, bool, oneOf,
  tempPassword, sealText, openText,
} from './lib.js';

const COOKIE = 'kx_s';
const SESSION_DAYS = 30;
export const ROLES = ['admin', 'counsellor'];

export const isAdmin = (ctx) => ctx.user?.role === 'admin';
export function requireAdmin(ctx) { if (!isAdmin(ctx)) forbid('Only admins can do this'); }

// ---------- Rate limit: fixed window per key. Returns false when over the limit. ----------
export async function limit(db, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.first(`INSERT INTO rate_limits (key,n,until) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET n=CASE WHEN until<? THEN 1 ELSE n+1 END, until=CASE WHEN until<? THEN excluded.until ELSE until END
    RETURNING n`, key, now + windowSec, now, now);
  return (row?.n || 1) <= max;
}
export const clientIp = (ctx) => ctx.req.headers.get('cf-connecting-ip') || 'local';

// ---------- Sessions: signed cookie "uid.tokenVer.exp.sig", 1 PK read per request ----------
async function sessionCookie(ctx, u) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${u.id}.${u.token_ver}.${exp}`;
  const sig = await hmac(ctx.env.SESSION_SECRET, 'team:' + payload);
  const secure = ctx.url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
function clearCookie(ctx) {
  const secure = ctx.url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
export async function loadSession(ctx) {
  const raw = (ctx.req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [uid, ver, exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!sig || Number(exp) < Date.now() / 1000) return null;
  const good = await hmac(ctx.env.SESSION_SECRET, `team:${uid}.${ver}.${exp}`);
  if (!timingSafeEq(sig, good)) return null;
  const u = await ctx.db.first('SELECT id,name,email,phone,role,must_change,token_ver,active FROM users WHERE id=?', int(uid));
  if (!u || !u.active || String(u.token_ver) !== ver) return null;
  return u;
}
const meJson = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, must_change: !!u.must_change });

// ---------- Public: first-run setup, login, logout ----------
export async function setupStatus(ctx) {
  const n = await ctx.db.val('SELECT COUNT(*) FROM users');
  return json({ needsSetup: !n });
}
export async function setup(ctx) {
  if (await ctx.db.val('SELECT COUNT(*) FROM users')) fail(403, 'Setup is already done');
  const b = await ctx.body();
  const email = normEmail(b.email);
  const name = str(b.name, 80);
  if (!name || !email) fail(400, 'Name and a valid email are required');
  if (String(b.password || '').length < 8) fail(400, 'Password must be at least 8 characters');
  const u = await ctx.db.first(`INSERT INTO users (name,email,role,pass_hash,must_change,created_at) VALUES (?,?, 'admin', ?, 0, ?)
    RETURNING id,name,email,phone,role,must_change,token_ver`, name, email, await hashPassword(String(b.password)), nowIST());
  return json({ ok: true, me: meJson(u) }, 200, { 'set-cookie': await sessionCookie(ctx, u) });
}
export async function login(ctx) {
  const b = await ctx.body();
  const email = normEmail(b.email);
  if (!email || !b.password) fail(400, 'Email and password are required');
  if (!(await limit(ctx.db, 'login:' + email, 8, 900)) || !(await limit(ctx.db, 'loginip:' + clientIp(ctx), 30, 900)))
    fail(429, 'Too many attempts. Please wait 15 minutes.');
  const u = await ctx.db.first('SELECT * FROM users WHERE email=?', email);
  if (!u || !(await verifyPassword(String(b.password), u.pass_hash))) fail(401, 'Wrong email or password');
  if (!u.active) fail(403, 'This account is switched off. Ask your admin.');
  await ctx.db.run('UPDATE users SET last_login_at=? WHERE id=?', nowIST(), u.id);
  return json({ ok: true, me: meJson(u) }, 200, { 'set-cookie': await sessionCookie(ctx, u) });
}
export function logout(ctx) { return json({ ok: true }, 200, { 'set-cookie': clearCookie(ctx) }); }

// ---------- Session ----------
export async function changePassword(ctx) {
  const b = await ctx.body();
  const pw = String(b.password || '');
  if (pw.length < 8) fail(400, 'Password must be at least 8 characters');
  const u = await ctx.db.first('SELECT pass_hash, must_change FROM users WHERE id=?', ctx.user.id);
  if (!u.must_change && !(await verifyPassword(String(b.current || ''), u.pass_hash))) fail(400, 'Current password is wrong');
  const row = await ctx.db.first(`UPDATE users SET pass_hash=?, temp_pass=NULL, must_change=0, token_ver=token_ver+1 WHERE id=?
    RETURNING id,token_ver`, await hashPassword(pw), ctx.user.id);
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(ctx, row) });
}

// ---------- Team users (admin) ----------
export async function listUsers(ctx) {
  // Everyone can see the team list (needed for "assign to"); only admins see emails/phones of others.
  const rows = await ctx.db.all(`SELECT u.id,u.name,u.email,u.phone,u.role,u.active,u.in_rotation,u.last_login_at,u.must_change,
    (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.stage_id IN (SELECT id FROM stages WHERE kind IN ('new','open'))) AS open_leads
    FROM users u ORDER BY u.active DESC, u.name`);
  const admin = isAdmin(ctx);
  return json({ items: rows.map((r) => (admin ? r : { id: r.id, name: r.name, role: r.role, active: r.active })) });
}
export async function createUser(ctx) {
  requireAdmin(ctx);
  const b = await ctx.body();
  const email = normEmail(b.email);
  const name = str(b.name, 80);
  if (!name || !email) fail(400, 'Name and a valid email are required');
  if (await ctx.db.val('SELECT id FROM users WHERE email=?', email)) fail(400, 'Someone already uses this email');
  const pw = tempPassword();
  await ctx.db.run(`INSERT INTO users (name,email,phone,role,pass_hash,temp_pass,must_change,in_rotation,created_at) VALUES (?,?,?,?,?,?,1,?,?)`,
    name, email, normPhone(b.phone), oneOf(b.role, ROLES, 'counsellor'), await hashPassword(pw),
    await sealText(ctx.env.SESSION_SECRET, pw), b.in_rotation === undefined ? 1 : bool(b.in_rotation), nowIST());
  return json({ ok: true, password: pw });
}
export async function updateUser(ctx) {
  requireAdmin(ctx);
  const id = int(ctx.params.id);
  const b = await ctx.body();
  const f = {};
  if ('name' in b) f.name = str(b.name, 80) || fail(400, 'Name required');
  if ('phone' in b) f.phone = normPhone(b.phone);
  if ('role' in b) f.role = oneOf(b.role, ROLES, 'counsellor');
  if ('active' in b) f.active = bool(b.active);
  if ('in_rotation' in b) f.in_rotation = bool(b.in_rotation);
  if (id === ctx.user.id && (f.role === 'counsellor' || f.active === 0)) fail(400, 'You cannot remove your own admin access');
  if (f.active === 0) f.token_ver = (await ctx.db.val('SELECT token_ver FROM users WHERE id=?', id)) + 1;
  const cols = Object.keys(f);
  if (cols.length) await ctx.db.run(`UPDATE users SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...Object.values(f), id);
  return json({ ok: true });
}
export async function resetPassword(ctx) {
  requireAdmin(ctx);
  const id = int(ctx.params.id);
  const pw = tempPassword();
  await ctx.db.run('UPDATE users SET pass_hash=?, temp_pass=?, must_change=1, token_ver=token_ver+1 WHERE id=?',
    await hashPassword(pw), await sealText(ctx.env.SESSION_SECRET, pw), id);
  return json({ ok: true, password: pw });
}
// Admins can look up a temporary password again until the user has chosen their own.
export async function viewTempPassword(ctx) {
  requireAdmin(ctx);
  const t = await ctx.db.val('SELECT temp_pass FROM users WHERE id=?', int(ctx.params.id));
  if (!t) fail(404, 'This user has already set their own password. Use "Reset password" instead.');
  return json({ password: await openText(ctx.env.SESSION_SECRET, t) });
}
