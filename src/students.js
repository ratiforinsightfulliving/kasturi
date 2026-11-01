// Courses, enrolment (lead → student), students, and the updates students see in their portal.
// Enrolling a lead creates the student (keyed by phone), adds the course, marks the lead Enrolled and
// emails the personal portal link through EmailJS.
import { json, fail, nowIST, str, int, num, bool, oneOf, normPhone, normEmail, randomKey, hmac, fillTemplate, page } from './lib.js';
import { requireAdmin, isAdmin } from './auth.js';
import { loadConfig, portalUrl } from './settings.js';
import { sendEmail } from './email.js';

export const UPDATE_KINDS = ['class', 'notes', 'recording', 'wellness', 'announcement'];

// ---------- Personal portal link ----------
// Token = "<studentId>.<sig>", sig = HMAC(SESSION_SECRET, id + student.token). Rotating student.token revokes old links.
export async function studentToken(env, s) {
  return `${s.id}.${(await hmac(env.SESSION_SECRET, `stu:${s.id}:${s.token}`)).slice(0, 22)}`;
}
export async function studentLink(ctx, cfg, s) { return `${portalUrl(ctx, cfg)}#t=${await studentToken(ctx.env, s)}`; }

function welcomeVars(cfg, s, course, link, portal) {
  return {
    name: (s.name || '').split(' ')[0] || 'there', full_name: s.name, brand: cfg.brand_name, course: course?.name || 'your program',
    link, portal, phone: s.phone, schedule: course?.schedule || '', class_link: course?.class_link || '',
    schedule_line: course?.schedule ? `Class timings: ${course.schedule}\n` : '',
  };
}
async function sendWelcome(ctx, cfg, s, course) {
  const link = await studentLink(ctx, cfg, s);
  const vars = welcomeVars(cfg, s, course, link, portalUrl(ctx, cfg));
  const r = await sendEmail(cfg, ctx.db, { to: s.email, subject: fillTemplate(cfg.welcome_subject, vars), text: fillTemplate(cfg.welcome_body, vars), kind: 'welcome' });
  if (r.ok) await ctx.db.run('UPDATE students SET link_sent_at=? WHERE id=?', nowIST(), s.id);
  return r;
}
async function waText(ctx, cfg, s) {
  const link = await studentLink(ctx, cfg, s);
  return fillTemplate(cfg.wa_link, { name: (s.name || '').split(' ')[0], brand: cfg.brand_name, link, phone: s.phone });
}

// ---------- Courses ----------
export async function listCourses(ctx) {
  const items = await ctx.db.all(`SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id AND e.status='active') AS students
    FROM courses c ORDER BY c.active DESC, c.id DESC`);
  return json({ items });
}
export async function saveCourse(ctx) {
  requireAdmin(ctx);
  const b = await ctx.body();
  const f = {
    name: str(b.name, 120) || fail(400, 'Course name required'), description: str(b.description, 3000), schedule: str(b.schedule, 300),
    class_link: str(b.class_link, 800), starts_on: str(b.starts_on, 10), price: Math.round(num(b.price, 0)), active: b.active === undefined ? 1 : bool(b.active),
  };
  if (f.class_link && !/^https?:\/\//.test(f.class_link)) fail(400, 'Class link must start with https://');
  const id = int(ctx.params.id);
  if (id) await ctx.db.run(`UPDATE courses SET ${Object.keys(f).map((k) => k + '=?').join(',')} WHERE id=?`, ...Object.values(f), id);
  else await ctx.db.run(`INSERT INTO courses (${Object.keys(f).join(',')},created_at) VALUES (${Object.keys(f).map(() => '?').join(',')},?)`, ...Object.values(f), nowIST());
  return json({ ok: true });
}
export async function deleteCourse(ctx) {
  requireAdmin(ctx);
  const id = int(ctx.params.id);
  if (await ctx.db.val('SELECT COUNT(*) FROM enrollments WHERE course_id=?', id)) fail(400, 'Students are enrolled in this course. Switch it off instead of deleting it.');
  await ctx.db.batch([ctx.db.stmt('DELETE FROM updates WHERE course_id=?', id), ctx.db.stmt('DELETE FROM courses WHERE id=?', id)]);
  return json({ ok: true });
}

// ---------- Enrol ----------
async function upsertStudent(ctx, { name, phone, email, leadId }) {
  let s = await ctx.db.first('SELECT * FROM students WHERE phone=?', phone);
  if (s) {
    if ((email && email !== s.email) || !s.active || (leadId && !s.lead_id)) {
      s = await ctx.db.first('UPDATE students SET email=COALESCE(?,email), active=1, lead_id=COALESCE(lead_id,?) WHERE id=? RETURNING *', email, leadId, s.id);
    }
    return s;
  }
  return ctx.db.first('INSERT INTO students (lead_id,name,phone,email,token,created_at) VALUES (?,?,?,?,?,?) RETURNING *',
    leadId, name, phone, email, randomKey(16), nowIST());
}
async function enrol(ctx, s, b) {
  const course = await ctx.db.first('SELECT * FROM courses WHERE id=?', int(b.course_id));
  if (!course) fail(400, 'Choose a course');
  const amount = Math.round(num(b.amount, course.price));
  await ctx.db.run(`INSERT INTO enrollments (student_id,course_id,amount,enrolled_by,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(student_id,course_id) DO UPDATE SET status='active', amount=excluded.amount`, s.id, course.id, amount, ctx.user.id, nowIST());
  return { course, amount };
}
async function enrolResult(ctx, cfg, s, course, sendMail) {
  const email = sendMail && s.email ? await sendWelcome(ctx, cfg, s, course) : { ok: false, detail: s.email ? 'Email not sent (unticked)' : 'No email address' };
  return { ok: true, student_id: s.id, link: await studentLink(ctx, cfg, s), wa_text: await waText(ctx, cfg, s), email };
}

export async function enrolLead(ctx) {
  const l = await ctx.db.first('SELECT * FROM leads WHERE id=?', int(ctx.params.id));
  if (!l) fail(404, 'Lead not found');
  const cfg = await loadConfig(ctx);
  if (!isAdmin(ctx) && !cfg.counsellor_all && l.owner_id !== ctx.user.id) fail(403, 'This lead is assigned to someone else');
  const b = await ctx.body();
  const phone = normPhone(b.phone || l.phone);
  if (!phone) fail(400, 'A phone number is needed — students sign in to their page with it');
  const email = normEmail(b.email || l.email);
  const s = await upsertStudent(ctx, { name: str(b.name || l.name, 120) || 'Student', phone, email, leadId: l.id });
  const { course, amount } = await enrol(ctx, s, b);
  const now = nowIST();
  await ctx.db.batch([
    ctx.db.stmt(`UPDATE leads SET stage_id=5, student_id=?, next_followup_at=NULL, email=COALESCE(email,?), phone=COALESCE(phone,?), updated_at=? WHERE id=?`, s.id, email, phone, now, l.id),
    ctx.db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,'stage',?,?)`, l.id, ctx.user.id,
      `Enrolled in ${course.name}${amount ? ' · ₹' + amount.toLocaleString('en-IN') : ''}`, now),
  ]);
  return json(await enrolResult(ctx, cfg, s, course, b.send_email !== 0 && b.send_email !== false));
}

// Add a student directly (walk-in, existing student, paid outside the CRM).
export async function createStudent(ctx) {
  const b = await ctx.body();
  const phone = normPhone(b.phone);
  if (!phone) fail(400, 'Phone number required');
  const cfg = await loadConfig(ctx);
  const s = await upsertStudent(ctx, { name: str(b.name, 120) || 'Student', phone, email: normEmail(b.email), leadId: null });
  const { course } = await enrol(ctx, s, b);
  return json(await enrolResult(ctx, cfg, s, course, b.send_email !== 0 && b.send_email !== false));
}

// ---------- Students ----------
export async function listStudents(ctx) {
  const q = ctx.query;
  const w = [], a = [];
  const cid = int(q.get('course'));
  if (cid) { w.push("s.id IN (SELECT student_id FROM enrollments WHERE course_id=? AND status='active')"); a.push(cid); }
  const s = str(q.get('q'), 80);
  if (s) { const d = s.replace(/\D/g, ''); if (d.length >= 4) { w.push('s.phone LIKE ?'); a.push(`%${d.slice(-10)}%`); } else { w.push('(s.name LIKE ? OR s.email LIKE ?)'); a.push(`%${s}%`, `%${s}%`); } }
  if (q.get('inactive') !== '1') w.push('s.active=1');
  const cur = int(q.get('cursor'));
  if (cur) { w.push('s.id<?'); a.push(cur); }
  const rows = await ctx.db.all(`SELECT s.id,s.name,s.phone,s.email,s.active,s.link_sent_at,s.last_seen_at,s.created_at,s.lead_id,
      (SELECT GROUP_CONCAT(c.name, ', ') FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=s.id AND e.status='active') AS courses,
      (SELECT COALESCE(SUM(e.amount),0) FROM enrollments e WHERE e.student_id=s.id) AS paid
    FROM students s ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 51`, ...a);
  return json(page(rows, 50));
}
export async function getStudent(ctx) {
  const s = await ctx.db.first('SELECT * FROM students WHERE id=?', int(ctx.params.id));
  if (!s) fail(404, 'Student not found');
  const cfg = await loadConfig(ctx);
  const enrollments = await ctx.db.all(`SELECT e.*, c.name AS course, c.schedule, c.class_link FROM enrollments e JOIN courses c ON c.id=e.course_id
    WHERE e.student_id=? ORDER BY e.id DESC`, s.id);
  const { token, ...rest } = s;
  return json({ student: rest, enrollments, link: await studentLink(ctx, cfg, s), wa_text: await waText(ctx, cfg, s) });
}
export async function updateStudent(ctx) {
  const id = int(ctx.params.id);
  const b = await ctx.body();
  const f = {};
  if ('name' in b) f.name = str(b.name, 120) || fail(400, 'Name required');
  if ('email' in b) f.email = normEmail(b.email);
  if ('phone' in b) {
    f.phone = normPhone(b.phone) || fail(400, 'Phone number required');
    if (await ctx.db.val('SELECT id FROM students WHERE phone=? AND id<>?', f.phone, id)) fail(400, 'Another student already has this phone number');
  }
  if ('active' in b) { requireAdmin(ctx); f.active = bool(b.active); }
  if (b.new_link) { requireAdmin(ctx); f.token = randomKey(16); } // old personal links stop working
  const cols = Object.keys(f);
  if (cols.length) await ctx.db.run(`UPDATE students SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...Object.values(f), id);
  return json({ ok: true });
}
export async function setEnrollment(ctx) {
  const b = await ctx.body();
  const f = {};
  if ('status' in b) f.status = oneOf(b.status, ['active', 'completed', 'cancelled'], 'active');
  if ('amount' in b) f.amount = Math.round(num(b.amount, 0));
  const cols = Object.keys(f);
  if (cols.length) await ctx.db.run(`UPDATE enrollments SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...Object.values(f), int(ctx.params.id));
  return json({ ok: true });
}
export async function addEnrollment(ctx) {
  const s = await ctx.db.first('SELECT * FROM students WHERE id=?', int(ctx.params.id));
  if (!s) fail(404, 'Student not found');
  const b = await ctx.body();
  const cfg = await loadConfig(ctx);
  const { course } = await enrol(ctx, s, b);
  return json(await enrolResult(ctx, cfg, s, course, !!b.send_email));
}
export async function resendLink(ctx) {
  const s = await ctx.db.first('SELECT * FROM students WHERE id=?', int(ctx.params.id));
  if (!s) fail(404, 'Student not found');
  if (!s.email) fail(400, 'Add the student\'s email first');
  const cfg = await loadConfig(ctx);
  const course = await ctx.db.first(`SELECT c.* FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=? AND e.status='active' ORDER BY e.id DESC LIMIT 1`, s.id);
  const r = await sendWelcome(ctx, cfg, s, course);
  if (!r.ok) fail(400, r.detail);
  return json({ ok: true, detail: r.detail });
}

// ---------- Updates (class notes, recordings, wellness tips, announcements) ----------
export async function listUpdates(ctx) {
  const cid = ctx.query.get('course');
  const w = [], a = [];
  if (cid === '0') w.push('u.course_id IS NULL'); else if (int(cid)) { w.push('u.course_id=?'); a.push(int(cid)); }
  const cur = int(ctx.query.get('cursor'));
  if (cur) { w.push('u.id<?'); a.push(cur); }
  const rows = await ctx.db.all(`SELECT u.*, c.name AS course, us.name AS by_name FROM updates u LEFT JOIN courses c ON c.id=u.course_id
    LEFT JOIN users us ON us.id=u.created_by ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY u.id DESC LIMIT 51`, ...a);
  return json(page(rows, 50));
}
function updateFields(b) {
  const f = {
    course_id: int(b.course_id) || null, kind: oneOf(b.kind, UPDATE_KINDS, 'announcement'),
    title: str(b.title, 200) || fail(400, 'Title required'), body: str(b.body, 8000), link: str(b.link, 1000), pinned: bool(b.pinned),
  };
  if (f.link && !/^https?:\/\//.test(f.link)) fail(400, 'Link must start with https://');
  return f;
}
export async function createUpdate(ctx) {
  const b = await ctx.body();
  const f = updateFields(b);
  await ctx.db.run(`INSERT INTO updates (course_id,kind,title,body,link,pinned,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    f.course_id, f.kind, f.title, f.body, f.link, f.pinned, ctx.user.id, nowIST());
  let emailed = 0, failed = 0, capped = false;
  if (b.email_students) {
    // EmailJS free = 200/month and a Worker request can make only ~50 outgoing calls, so one post emails at most 35 students.
    const cfg = await loadConfig(ctx);
    const rows = await ctx.db.all(`SELECT * FROM students WHERE active=1 AND email IS NOT NULL
      ${f.course_id ? "AND id IN (SELECT student_id FROM enrollments WHERE course_id=? AND status='active')" : ''} ORDER BY id LIMIT 36`, ...(f.course_id ? [f.course_id] : []));
    capped = rows.length > 35;
    for (const s of rows.slice(0, 35)) {
      const link = await studentLink(ctx, cfg, s);
      const text = `Namaste ${(s.name || '').split(' ')[0]},\n\n${f.title}\n\n${f.body || ''}${f.link ? '\n\n' + f.link : ''}\n\nSee all your updates: ${link}\n\nTeam ${cfg.brand_name}`;
      const r = await sendEmail(cfg, null, { to: s.email, subject: `${cfg.brand_name}: ${f.title}`, text, kind: 'update' });
      if (r.ok) emailed++; else failed++;
    }
    await ctx.db.run('INSERT INTO email_log (to_email,subject,kind,provider,ok,detail,created_at) VALUES (?,?,?,?,?,?,?)',
      `${emailed + failed} students`, f.title.slice(0, 200), 'update', 'emailjs', failed ? 0 : 1, `${emailed} sent, ${failed} failed${capped ? ', capped at 35' : ''}`, nowIST());
  }
  return json({ ok: true, emailed, failed, capped });
}
export async function editUpdate(ctx) {
  const f = updateFields(await ctx.body());
  await ctx.db.run(`UPDATE updates SET ${Object.keys(f).map((k) => k + '=?').join(',')} WHERE id=?`, ...Object.values(f), int(ctx.params.id));
  return json({ ok: true });
}
export async function deleteUpdate(ctx) {
  await ctx.db.run('DELETE FROM updates WHERE id=?', int(ctx.params.id));
  return json({ ok: true });
}
