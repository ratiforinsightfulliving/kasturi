// ingestLead(): the ONLY way a lead enters the CRM (Meta, Google, website, WhatsApp, manual add, CSV import, tests).
// A repeat enquiry (same phone or email) never makes a second lead: it is added to the existing lead's
// timeline, its enquiry count goes up, and it moves to the top of the list.
// File imports pass onRepeat:'skip' for rows without an id, so re-uploading the same sheet adds nothing.
import { nowIST, normPhone, normEmail, str } from './lib.js';

const LEAD_COLS = ['name', 'city', 'message', 'interest', 'campaign', 'adset', 'ad', 'form', 'platform',
  'utm_source', 'utm_medium', 'utm_campaign', 'landing_page'];
const LOST_STAGES = "SELECT id FROM stages WHERE kind IN ('lost')";

export async function ingestLead(db, { sourceId = null, data, createdAt = null, actorId = null, kind = 'system', onRepeat = 'merge' }) {
  const phone = normPhone(data.phone);
  const email = normEmail(data.email);
  const externalId = str(data.external_id, 120);
  const now = nowIST();
  const created = createdAt || now;
  const srcName = data._source_name || 'manual entry';

  // 1) Same Meta leadgen_id / Google lead_id twice -> ignore. Ids merged into an older lead live in lead_ext_ids.
  if (externalId) {
    const ex = await db.val(`SELECT id FROM leads WHERE external_id=? UNION ALL SELECT lead_id FROM lead_ext_ids WHERE external_id=? LIMIT 1`, externalId, externalId);
    if (ex) return { id: ex, existing: true };
  }

  // 2) Repeat enquiry by phone or email -> add to the existing lead.
  if (phone || email) {
    const parts = [], args = [];
    if (phone) { parts.push('SELECT id, owner_id, stage_id FROM (SELECT * FROM leads WHERE phone=? ORDER BY id LIMIT 1)'); args.push(phone); }
    if (email) { parts.push('SELECT id, owner_id, stage_id FROM (SELECT * FROM leads WHERE email=? ORDER BY id LIMIT 1)'); args.push(email); }
    const m = await db.first(`${parts.join(' UNION ALL ')} ORDER BY id LIMIT 1`, ...args);
    if (m && onRepeat === 'skip') return { id: m.id, existing: true };
    if (m) {
      const note = kind === 'whatsapp'
        ? `WhatsApp: ${str(data.message, 3000) || '(no text)'}`
        : `Enquired again via ${srcName}${data.message ? ': ' + str(data.message, 2000) : ''}${data.interest ? ' · ' + data.interest : ''}`;
      await db.batch([
        // A "Not interested" lead that writes again is worth another try: back to New.
        db.stmt(`UPDATE leads SET enquiry_count=enquiry_count+?, updated_at=?, name=COALESCE(name,?), email=COALESCE(email,?), phone=COALESCE(phone,?),
          stage_id=CASE WHEN stage_id IN (${LOST_STAGES}) THEN 1 ELSE stage_id END WHERE id=?`,
          kind === 'whatsapp' ? 0 : 1, now, str(data.name, 120), email, phone, m.id),
        db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,?,?,?)`, m.id, actorId, kind === 'whatsapp' ? 'whatsapp' : 'system', note, now),
        sourceId && db.stmt('UPDATE sources SET lead_count=lead_count+1, last_lead_at=?, last_error=NULL WHERE id=?', now, sourceId),
        externalId && db.stmt('INSERT OR IGNORE INTO lead_ext_ids (external_id,lead_id) VALUES (?,?)', externalId, m.id),
      ]);
      return { id: m.id, existing: true, repeat: true, owner_id: m.owner_id };
    }
  }

  // 3) Owner: chosen by the person adding it, else round-robin among active team members in rotation.
  let owner = data.owner_id || null;
  if (!owner) owner = await db.val(`SELECT id FROM users WHERE active=1 AND in_rotation=1 ORDER BY COALESCE(last_assigned_at,''), id LIMIT 1`);

  const extra = data.extra && Object.keys(data.extra).length ? JSON.stringify(data.extra).slice(0, 8000) : null;
  const vals = LEAD_COLS.map((k) => str(data[k], k === 'message' ? 4000 : k === 'landing_page' ? 1000 : 300));
  const row = await db.first(
    `INSERT INTO leads (source_id,stage_id,owner_id,phone,email,extra,external_id,created_at,created_day,updated_at,${LEAD_COLS.join(',')})
     VALUES (?,1,?,?,?,?,?,?,?,?,${LEAD_COLS.map(() => '?').join(',')}) RETURNING id`,
    sourceId, owner, phone, email, extra, externalId, created, created.slice(0, 10), now, ...vals);
  const id = row.id;
  await db.batch([
    db.stmt(`INSERT INTO activities (lead_id,user_id,type,note,created_at) VALUES (?,?,?,?,?)`, id, actorId,
      kind === 'whatsapp' ? 'whatsapp' : 'system', kind === 'whatsapp' ? `WhatsApp: ${str(data.message, 3000) || '(no text)'}` : `Lead received via ${srcName}`, now),
    sourceId && db.stmt('UPDATE sources SET lead_count=lead_count+1, last_lead_at=?, last_error=NULL WHERE id=?', now, sourceId),
    owner && db.stmt('UPDATE users SET last_assigned_at=? WHERE id=?', now, owner),
  ]);
  return { id, owner_id: owner };
}
