// Student portal API (/learn/). No OTP and no password, by design:
//  - the emailed personal link carries a signed token (#t=…), or
//  - the student types the phone number they enrolled with.
// Phone lookups are rate-limited per IP so numbers can't be guessed in bulk.
import { json, fail, nowIST, normPhone, timingSafeEq, int, hmac } from './lib.js';
import { limit, clientIp } from './auth.js';
import { loadConfig } from './settings.js';
import { studentToken } from './students.js';

export async function portalInfo(ctx) {
  const cfg = await loadConfig(ctx);
  return json({ brand: cfg.brand_name, tagline: cfg.tagline, welcome: cfg.portal_welcome, support_phone: cfg.support_phone });
}

export async function portalLogin(ctx) {
  const b = await ctx.body();
  if (!(await limit(ctx.db, 'portal:' + clientIp(ctx), 15, 900))) fail(429, 'Too many tries. Please wait 15 minutes and try again.');
  const phone = normPhone(b.phone);
  if (!phone || phone.length < 8) fail(400, 'Enter the phone number you registered with');
  const s = await ctx.db.first('SELECT id, token, active FROM students WHERE phone=?', phone);
  if (!s || !s.active) {
    const cfg = await loadConfig(ctx);
    fail(404, `We couldn't find this number. Use the number you enrolled with${cfg.support_phone ? ', or WhatsApp us on ' + cfg.support_phone : ''}.`);
  }
  return json({ token: await studentToken(ctx.env, s) });
}

async function studentFromToken(ctx) {
  const t = ctx.req.headers.get('x-student-token') || '';
  const [id, sig] = t.split('.');
  if (!int(id) || !sig) fail(401, 'Please sign in');
  const s = await ctx.db.first('SELECT * FROM students WHERE id=?', int(id));
  if (!s || !s.active) fail(401, 'Please sign in again');
  const good = (await hmac(ctx.env.SESSION_SECRET, `stu:${s.id}:${s.token}`)).slice(0, 22);
  if (!timingSafeEq(sig, good)) fail(401, 'This link has expired. Please sign in with your phone number.');
  return s;
}

export async function portalMe(ctx) {
  const s = await studentFromToken(ctx);
  const cfg = await loadConfig(ctx);
  const courses = await ctx.db.all(`SELECT c.id, c.name, c.description, c.schedule, c.class_link, c.starts_on, e.status
    FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=? AND e.status IN ('active','completed') ORDER BY e.id DESC`, s.id);
  const ids = courses.filter((c) => c.status === 'active').map((c) => c.id);
  const updates = await ctx.db.all(`SELECT u.id, u.course_id, u.kind, u.title, u.body, u.link, u.pinned, u.created_at, c.name AS course
    FROM updates u LEFT JOIN courses c ON c.id=u.course_id
    WHERE u.course_id IS NULL ${ids.length ? `OR u.course_id IN (${ids.map(() => '?').join(',')})` : ''}
    ORDER BY u.pinned DESC, u.id DESC LIMIT 100`, ...ids);
  // Remember when the student last opened the page (at most once an hour).
  if (!s.last_seen_at || s.last_seen_at < nowIST(new Date(Date.now() - 3600e3))) ctx.exec.waitUntil(ctx.db.run('UPDATE students SET last_seen_at=? WHERE id=?', nowIST(), s.id));
  return json({
    student: { name: s.name, phone: s.phone, email: s.email },
    // Class links of finished courses are hidden.
    courses: courses.map((c) => (c.status === 'active' ? c : { ...c, class_link: null })),
    updates,
    brand: cfg.brand_name, tagline: cfg.tagline, welcome: cfg.portal_welcome, support_phone: cfg.support_phone,
  });
}
