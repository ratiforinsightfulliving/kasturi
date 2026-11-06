// Leads: list/filter, detail + timeline, manual add, edit, call/note logging, follow-ups, bulk actions, CSV import/export.
import { json, fail, forbid, nowIST, todayIST, str, int, oneOf, normPhone, normEmail, toIST, page, csvResponse, addDays } from './lib.js';
import { isAdmin } from './auth.js';
import { ingestLead } from './ingest.js';
import { loadConfig } from './settings.js';

export const OUTCOMES = ['connected', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'call_back'];
const ACT_TYPES = ['note', 'call', 'whatsapp', 'email'];

// Counsellors see only their own leads unless Settings → General allows all.
async function scope(ctx, alias = 'l') {
  if (isAdmin(ctx)) return { sql: '', args: [] };
  const cfg = await loadConfig(ctx);
  if (cfg.counsellor_all) return { sql: '', args: [] };
  return { sql: ` AND ${alias}.owner_id=?`, args: [ctx.user.id] };
}
async function loadLead(ctx, id) {
  const l = await ctx.db.first('SELECT * FROM leads WHERE id=?', int(id));
  if (!l) fail(404, 'Lead not found');
  const s = await scope(ctx);
  if (s.args.length && l.owner_id !== ctx.user.id) forbid('This lead is assigned to someone else');
  return l;
}

const LIST_COLS = `l.id,l.name,l.phone,l.email,l.city,l.interest,l.source_id,l.stage_id,l.owner_id,l.campaign,l.platform,l.enquiry_count,
  l.next_followup_at,l.last_contact_at,l.student_id,l.created_at,l.updated_at`;

function filters(ctx, q) {
  const w = [], a = [];
  const stage = int(q.get('stage'));
  if (stage) { w.push('l.stage_id=?'); a.push(stage); }
  const open = q.get('open');
  if (open === '1') w.push("l.stage_id IN (SELECT id FROM stages WHERE kind IN ('new','open'))");
  const src = q.get('source');
  if (src === '0') w.push('l.source_id IS NULL'); else if (int(src)) { w.push('l.source_id=?'); a.push(int(src)); }
  const owner = q.get('owner');
  if (owner === 'me') { w.push('l.owner_id=?'); a.push(ctx.user.id); }
  else if (owner === 'none') w.push('l.owner_id IS NULL');
  else if (int(owner)) { w.push('l.owner_id=?'); a.push(int(owner)); }
  const from = q.get('from'), to = q.get('to');
  if (from) { w.push('l.created_day>=?'); a.push(from.slice(0, 10)); }
  if (to) { w.push('l.created_day<=?'); a.push(to.slice(0, 10)); }
  const due = q.get('due');
  if (due === 'overdue') { w.push('l.next_followup_at<?'); a.push(todayIST() + ' 00:00:00'); }
  if (due === 'today') { w.push('l.next_followup_at>=? AND l.next_followup_at<=?'); a.push(todayIST() + ' 00:00:00', todayIST() + ' 23:59:59'); }
  if (due === 'upcoming') { w.push('l.next_followup_at>?'); a.push(todayIST() + ' 23:59:59'); }
  if (q.get('fresh') === '1') w.push('l.last_contact_at IS NULL AND l.stage_id=1');
  const s = str(q.get('q'), 80);
  if (s) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 4) { w.push('l.phone LIKE ?'); a.push('%' + digits.slice(-10) + '%'); }
    else { w.push('(l.name LIKE ? OR l.email LIKE ? OR l.city LIKE ? OR l.interest LIKE ?)'); a.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`); }
  }
  return { w, a };
}

export async function listLeads(ctx) {
  const q = ctx.query;
  const { w, a } = filters(ctx, q);
  const sc = await scope(ctx);
  const cur = int(q.get('cursor'));
  if (cur) { w.push('l.id<?'); a.push(cur); }
  const due = !!q.get('due');
  // Follow-up lists are sorted by time and returned in one page (max 200).
  const rows = await ctx.db.all(`SELECT ${LIST_COLS} FROM leads l WHERE 1=1 ${w.length ? 'AND ' + w.join(' AND ') : ''}${sc.sql}
    ORDER BY ${due ? 'l.next_followup_at, l.id DESC' : 'l.id DESC'} LIMIT ${due ? 200 : 51}`, ...a, ...sc.args);
  return json(due ? { items: rows, next: null } : page(rows, 50));
}

export async function counts(ctx) {
  const sc = await scope(ctx);
  const t = todayIST();
  const r = await ctx.db.first(`SELECT
      SUM(CASE WHEN l.next_followup_at < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN l.next_followup_at >= ? AND l.next_followup_at <= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN l.last_contact_at IS NULL AND l.stage_id=1 THEN 1 ELSE 0 END) AS fresh
    FROM leads l WHERE l.stage_id IN (SELECT id FROM stages WHERE kind IN ('new','open'))${sc.sql}`,
    t + ' 00:00:00', t + ' 00:00:00', t + ' 23:59:59', ...sc.args);
  return { overdue: r?.overdue || 0, today: r?.today || 0, fresh: r?.fresh || 0 };
}

export async function getLead(ctx) {
  const l = await loadLead(ctx, ctx.params.id);
  const [acts, student, others] = await Promise.all([
    ctx.db.all(`SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.lead_id=? ORDER BY a.id DESC LIMIT 100`, l.id),
    l.student_id ? ctx.db.first('SELECT id,name,phone,email,active,link_sent_at,last_seen_at FROM students WHERE id=?', l.student_id) : null,
    l.student_id ? ctx.db.all(`SELECT e.id,e.amount,e.status,e.created_at,c.name AS course FROM enrollments e JOIN courses c ON c.id=e.course_id
      WHERE e.student_id=? ORDER BY e.id DESC`, l.student_id) : [],
  ]);
  let extra = {};
  try { extra = l.extra ? JSON.parse(l.extra) : {}; } catch { /* ignore */ }
  return json({ lead: { ...l, extra }, activities: acts, student, enrollments: others });
}

export async function createLead(ctx) {
  const b = await ctx.body();
  if (!normPhone(b.phone) && !normEmail(b.email)) fail(400, 'Phone or email is required');
  const r = await ingestLead(ctx.db, {
    sourceId: int(b.source_id), actorId: ctx.user.id,
    data: { name: b.name, phone: b.phone, email: b.email, city: b.city, interest: b.interest, message: b.message,
      owner_id: isAdmin(ctx) ? int(b.owner_id) || ctx.user.id : ctx.user.id, _source_name: 'manual entry by ' + ctx.user.name },
  });
  return json({ ok: true, ...r });
}

async function stageName(db, id) { return (await db.first('SELECT name, kind FROM stages WHERE id=?', id)) || fail(400, 'Unknown stage'); }

export async function updateLead(ctx) {
  const l = await loadLead(ctx, ctx.params.id);
  const b = await ctx.body();
  const f = {};
  const notes = [];
  for (const k of ['name', 'city', 'interest']) if (k in b) f[k] = str(b[k], 200);
  if ('phone' in b) f.phone = normPhone(b.phone);
  if ('email' in b) f.email = normEmail(b.email);
  if ('next_followup_at' in b) f.next_followup_at = b.next_followup_at ? toIST(b.next_followup_at) : null;
  if ('owner_id' in b && int(b.owner_id) !== l.owner_id) {
    if (!isAdmin(ctx)) forbid('Only admins can reassign leads');
    f.owner_id = int(b.owner_id);
    const nm = f.owner_id ? await ctx.db.val('SELECT name FROM users WHERE id=?', f.owner_id) : null;
    notes.push(`Assigned to ${nm || 'nobody'}`);
  }
  if ('stage_id' in b && int(b.stage_id) !== l.stage_id) {
    const st = await stageName(ctx.db, int(b.stage_id));
    if (st.kind === 'won' && !l.student_id) fail(400, 'Use "Enrol" to mark a lead as enrolled');
    f.stage_id = int(b.stage_id);
    if (st.kind === 'lost') f.next_followup_at = null;
    notes.push(`Stage → ${st.name}${b.reason ? ' (' + str(b.reason, 200) + ')' : ''}`);
  }
  const cols = Object.keys(f);
  if (!cols.length) return json({ ok: true });
  const now = nowIST();
  await ctx.db.batch([
    ctx.db.stmt(`UPDATE leads SET ${cols.map((c) => c + '=?').join(',')}, updated_at=? WHERE id=?`, ...Object.values(f), now, l.id),
    ...notes.map((n) => ctx.db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,'stage',?,?)`, l.id, ctx.user.id, n, now)),
  ]);
  return json({ ok: true });
}

// Log a call / WhatsApp / email / note, optionally move the stage and set the next follow-up in one go.
export async function logActivity(ctx) {
  const l = await loadLead(ctx, ctx.params.id);
  const b = await ctx.body();
  const type = oneOf(b.type, ACT_TYPES, 'note');
  const outcome = type === 'call' ? oneOf(b.outcome, OUTCOMES, null) : null;
  const note = str(b.note, 3000);
  if (type === 'note' && !note) fail(400, 'Write a note');
  const now = nowIST();
  const set = ['updated_at=?'], args = [now];
  if (type !== 'note') { set.push('last_contact_at=?'); args.push(now); }
  if ('next_followup_at' in b) { set.push('next_followup_at=?'); args.push(b.next_followup_at ? toIST(b.next_followup_at) : null); }
  const stmts = [];
  const stageId = int(b.stage_id);
  if (stageId && stageId !== l.stage_id) {
    const st = await stageName(ctx.db, stageId);
    if (st.kind === 'won') fail(400, 'Use "Enrol" to mark a lead as enrolled');
    set.push('stage_id=?'); args.push(stageId);
    if (st.kind === 'lost') set.push('next_followup_at=NULL');
    stmts.push(ctx.db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,'stage',?,?)`, l.id, ctx.user.id, `Stage → ${st.name}`, now));
  } else if (l.stage_id === 1 && type !== 'note' && outcome !== 'wrong_number') {
    // First real contact moves a New lead to Contacted automatically.
    set.push('stage_id=2');
  }
  await ctx.db.batch([
    ctx.db.stmt(`INSERT INTO activities (lead_id,user_id,type,outcome,note,created_at) VALUES (?,?,?,?,?,?)`, l.id, ctx.user.id, type, outcome, note, now),
    ctx.db.stmt(`UPDATE leads SET ${set.join(',')} WHERE id=?`, ...args, l.id),
    ...stmts,
  ]);
  return json({ ok: true });
}

export async function bulkLeads(ctx) {
  const b = await ctx.body();
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => int(x)).filter(Boolean).slice(0, 200);
  if (!ids.length) fail(400, 'Select leads first');
  const ph = ids.map(() => '?').join(',');
  const sc = await scope(ctx);
  const now = nowIST();
  if (b.action === 'assign') {
    if (!isAdmin(ctx)) forbid('Only admins can reassign leads');
    const owner = int(b.owner_id);
    const nm = owner ? await ctx.db.val('SELECT name FROM users WHERE id=?', owner) : null;
    await ctx.db.batch([
      ctx.db.stmt(`UPDATE leads SET owner_id=?, updated_at=? WHERE id IN (${ph})`, owner, now, ...ids),
      ...ids.map((id) => ctx.db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,'stage',?,?)`, id, ctx.user.id, `Assigned to ${nm || 'nobody'}`, now)),
    ]);
  } else if (b.action === 'stage') {
    const st = await stageName(ctx.db, int(b.stage_id));
    if (st.kind === 'won') fail(400, 'Enrol leads one by one so each student gets their link');
    await ctx.db.batch([
      ctx.db.stmt(`UPDATE leads SET stage_id=?, updated_at=? WHERE id IN (${ph})${sc.sql.replace('l.', '')}`, int(b.stage_id), now, ...ids, ...sc.args),
      ...ids.map((id) => ctx.db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,'stage',?,?)`, id, ctx.user.id, `Stage → ${st.name}`, now)),
    ]);
  } else if (b.action === 'delete') {
    if (!isAdmin(ctx)) forbid('Only admins can delete leads');
    await ctx.db.batch([
      ctx.db.stmt(`DELETE FROM activities WHERE lead_id IN (${ph})`, ...ids),
      ctx.db.stmt(`DELETE FROM leads WHERE id IN (${ph})`, ...ids),
    ]);
  } else fail(400, 'Unknown action');
  return json({ ok: true, n: ids.length });
}

// File import (Meta Leads Center ZIP/CSV, Excel, any sheet): the browser reads the file and sends rows as objects
// ({external_id, created_time, name, phone, email, city, interest, message, campaign, adset, ad, form, platform, extra}).
// Rows with a Meta lead id are matched on that id; rows without one are skipped when the phone/email already exists,
// so the same full export can be uploaded every day and only new people are added.
const IMPORT_COLS = ['name', 'phone', 'email', 'city', 'interest', 'message', 'campaign', 'adset', 'ad', 'form', 'platform'];
export async function importLeads(ctx) {
  if (!isAdmin(ctx)) forbid('Only admins can import');
  const b = await ctx.body();
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5) : []; // the browser sends 5 rows per request (D1 query budget)
  const srcName = (int(b.source_id) && (await ctx.db.val('SELECT name FROM sources WHERE id=?', int(b.source_id)))) || 'file import';
  let added = 0, repeat = 0, existing = 0, skipped = 0;
  for (const r of rows) {
    if (!r || (!normPhone(r.phone) && !normEmail(r.email))) { skipped++; continue; }
    const data = { owner_id: int(b.owner_id) || null, _source_name: srcName + ' (file)' };
    for (const k of IMPORT_COLS) if (r[k] != null && r[k] !== '') data[k] = String(r[k]);
    const ext = str(r.external_id, 120);
    if (ext) data.external_id = ext;
    if (r.extra && typeof r.extra === 'object') {
      data.extra = {};
      for (const [k, v] of Object.entries(r.extra).slice(0, 40)) if (v != null && v !== '') data.extra[String(k).slice(0, 80)] = String(v).slice(0, 500);
    }
    const out = await ingestLead(ctx.db, { sourceId: int(b.source_id), actorId: ctx.user.id, data,
      createdAt: r.created_time ? toIST(r.created_time) : null, onRepeat: ext ? 'merge' : 'skip' });
    if (out.repeat) repeat++; else if (out.existing) existing++; else added++;
  }
  return json({ ok: true, added, repeat, existing, skipped });
}

// Before importing: which of these Meta lead ids / phones / emails are already in the CRM? (lets the browser send only new rows)
export async function importCheck(ctx) {
  if (!isAdmin(ctx)) forbid('Only admins can import');
  const b = await ctx.body();
  const take = (arr, fn) => [...new Set((Array.isArray(arr) ? arr : []).map(fn).filter(Boolean))].slice(0, 450);
  const ids = take(b.ids, (x) => str(x, 120)), phones = take(b.phones, normPhone), emails = take(b.emails, normEmail);
  const known = { ids: [], phones: [], emails: [] };
  const chunks = (arr) => { const o = []; for (let i = 0; i < arr.length; i += 90) o.push(arr.slice(i, i + 90)); return o; };
  for (const c of chunks(ids)) {
    const ph = c.map(() => '?').join(',');
    const rows = await ctx.db.all(`SELECT external_id AS v FROM leads WHERE external_id IN (${ph}) UNION SELECT external_id FROM lead_ext_ids WHERE external_id IN (${ph})`, ...c, ...c);
    known.ids.push(...rows.map((x) => x.v));
  }
  for (const c of chunks(phones)) known.phones.push(...(await ctx.db.all(`SELECT DISTINCT phone AS v FROM leads WHERE phone IN (${c.map(() => '?').join(',')})`, ...c)).map((x) => x.v));
  for (const c of chunks(emails)) known.emails.push(...(await ctx.db.all(`SELECT DISTINCT email AS v FROM leads WHERE email IN (${c.map(() => '?').join(',')})`, ...c)).map((x) => x.v));
  return json(known);
}

export async function exportLeads(ctx) {
  if (!isAdmin(ctx)) forbid('Only admins can export');
  const { w, a } = filters(ctx, ctx.query);
  const rows = await ctx.db.all(`SELECT l.*, s.name AS stage, so.name AS source, u.name AS owner FROM leads l
    LEFT JOIN stages s ON s.id=l.stage_id LEFT JOIN sources so ON so.id=l.source_id LEFT JOIN users u ON u.id=l.owner_id
    WHERE 1=1 ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY l.id DESC LIMIT 5000`, ...a);
  const head = ['ID', 'Created', 'Name', 'Phone', 'Email', 'City', 'Interest', 'Message', 'Stage', 'Source', 'Owner', 'Campaign', 'Ad', 'Next follow-up', 'Last contact', 'Enquiries'];
  // Neutralise spreadsheet formulas in user-supplied text.
  const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v);
  return csvResponse(`kasturi-leads-${todayIST()}.csv`, [head, ...rows.map((r) => [r.id, r.created_at, r.name, r.phone, r.email, r.city, r.interest, r.message,
    r.stage, r.source, r.owner, r.campaign, r.ad, r.next_followup_at, r.last_contact_at, r.enquiry_count].map(safe))]);
}

export { addDays };
