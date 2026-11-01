// Home dashboard: today's work for the signed-in person + the numbers that matter for the business.
import { json, todayIST, addDays } from './lib.js';
import { isAdmin } from './auth.js';
import { counts } from './leads.js';
import { loadConfig } from './settings.js';

export async function dashboard(ctx) {
  const t = todayIST();
  const from = ctx.query.get('from') || addDays(t, -29);
  const to = ctx.query.get('to') || t;
  const cfg = await loadConfig(ctx);
  const mine = !isAdmin(ctx) && !cfg.counsellor_all;
  const own = mine ? ' AND l.owner_id=?' : '';
  const ownArgs = mine ? [ctx.user.id] : [];
  const [work, totals, bySource, byStage, byOwner, revenue, recent] = await Promise.all([
    counts(ctx),
    ctx.db.first(`SELECT COUNT(*) AS leads,
        SUM(CASE WHEN l.created_day=? THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN l.stage_id=5 THEN 1 ELSE 0 END) AS enrolled
      FROM leads l WHERE l.created_day BETWEEN ? AND ?${own}`, t, from, to, ...ownArgs),
    ctx.db.all(`SELECT COALESCE(s.name, CASE WHEN l.source_id IS NULL THEN 'Added manually' ELSE '(deleted source)' END) AS name, s.type,
        COUNT(*) AS n, SUM(CASE WHEN l.stage_id=5 THEN 1 ELSE 0 END) AS won
      FROM leads l LEFT JOIN sources s ON s.id=l.source_id WHERE l.created_day BETWEEN ? AND ?${own} GROUP BY l.source_id ORDER BY n DESC LIMIT 12`, from, to, ...ownArgs),
    ctx.db.all(`SELECT st.id, st.name, st.color, COUNT(l.id) AS n FROM stages st LEFT JOIN leads l ON l.stage_id=st.id${own} GROUP BY st.id ORDER BY st.sort`, ...ownArgs),
    isAdmin(ctx) ? ctx.db.all(`SELECT u.id, u.name, COUNT(l.id) AS leads, SUM(CASE WHEN l.stage_id=5 THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN l.last_contact_at IS NULL AND l.stage_id=1 THEN 1 ELSE 0 END) AS untouched
      FROM users u LEFT JOIN leads l ON l.owner_id=u.id AND l.created_day BETWEEN ? AND ? WHERE u.active=1 GROUP BY u.id ORDER BY leads DESC`, from, to) : [],
    isAdmin(ctx) ? ctx.db.first(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM enrollments WHERE substr(created_at,1,10) BETWEEN ? AND ? AND status<>'cancelled'`, from, to) : null,
    ctx.db.all(`SELECT l.id,l.name,l.phone,l.interest,l.stage_id,l.source_id,l.created_at FROM leads l WHERE 1=1${own} ORDER BY l.id DESC LIMIT 8`, ...ownArgs),
  ]);
  return json({ from, to, work, totals, bySource, byStage, byOwner, revenue, recent });
}
