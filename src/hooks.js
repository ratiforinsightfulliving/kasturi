// Lead sources and the public webhooks that feed ingestLead().
// Webhooks need no login: they are authenticated by a random key in the URL (plus google_key for
// Google Ads, and the X-Hub-Signature-256 HMAC with the Meta App Secret for Facebook/Instagram/WhatsApp).
import { json, fail, nowIST, str, int, oneOf, randomKey, hmac, timingSafeEq, getPath, toIST } from './lib.js';
import { requireAdmin } from './auth.js';
import { ingestLead } from './ingest.js';
import { loadConfig } from './settings.js';

export const SOURCE_TYPES = ['meta', 'google', 'gform', 'web', 'whatsapp', 'other'];

// ---------- Sources CRUD (admin) ----------
function maskSource(s) {
  const { page_token, ...rest } = s;
  return { ...rest, has_page_token: !!page_token };
}
export async function listSources(ctx) {
  // Counsellors only need names (for filters); admins get the full setup details.
  const rows = await ctx.db.all('SELECT * FROM sources ORDER BY id');
  if (ctx.user.role !== 'admin') return json({ items: rows.map((s) => ({ id: s.id, type: s.type, name: s.name })) });
  return json({ items: rows.map(maskSource) });
}
function sourceFields(b) {
  const f = {};
  const set = (k, v) => { if (k in b) f[k] = v; };
  set('name', str(b.name, 80));
  set('status', oneOf(b.status, ['active', 'paused'], 'active'));
  set('page_id', str(b.page_id, 40));
  set('form_ids', str(b.form_ids, 500));
  set('wa_phone_id', str(b.wa_phone_id, 40));
  if (b.page_token) f.page_token = str(b.page_token, 800);
  if (b.clear_page_token) f.page_token = null;
  return f;
}
export async function createSource(ctx) {
  requireAdmin(ctx);
  const b = await ctx.body();
  const type = oneOf(b.type, SOURCE_TYPES, null);
  if (!type) fail(400, 'Unknown source type');
  const f = sourceFields(b);
  if (!f.name) fail(400, 'Name required');
  const cols = Object.keys(f);
  const row = await ctx.db.first(`INSERT INTO sources (type,key,secret,created_at,${cols.join(',')}) VALUES (?,?,?,?,${cols.map(() => '?').join(',')}) RETURNING id`,
    type, randomKey(), type === 'google' ? randomKey(20) : null, nowIST(), ...Object.values(f));
  return json({ ok: true, id: row.id });
}
export async function updateSource(ctx) {
  requireAdmin(ctx);
  const b = await ctx.body();
  const f = sourceFields(b);
  if (b.rotate_key) f.key = randomKey();
  const cols = Object.keys(f);
  if (cols.length) await ctx.db.run(`UPDATE sources SET ${cols.map((k) => k + '=?').join(',')} WHERE id=?`, ...Object.values(f), int(ctx.params.id));
  return json({ ok: true });
}
export async function deleteSource(ctx) {
  requireAdmin(ctx);
  // Leads keep their source_id; the UI shows them as "(deleted source)".
  await ctx.db.run('DELETE FROM sources WHERE id=?', int(ctx.params.id));
  return json({ ok: true });
}
export async function testSource(ctx) {
  requireAdmin(ctx);
  const s = await ctx.db.first('SELECT * FROM sources WHERE id=?', int(ctx.params.id));
  if (!s) fail(404, 'Source not found');
  const n = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
  const r = await ingestLead(ctx.db, {
    sourceId: s.id, actorId: ctx.user.id,
    data: { name: `Test Lead ${n}`, phone: '90000' + n, email: `test${n}@example.com`, message: 'This is a test lead from the CRM.',
      interest: 'Test', campaign: 'Test campaign', _source_name: s.name, extra: { test: true } },
  });
  return json({ ok: true, lead: r });
}

// ---------- Field extraction for website forms and tools (Zapier, Pabbly, AiSensy, Interakt, WATI …) ----------
const ALIASES = {
  name: ['name', 'full_name', 'fullname', 'your_name', 'your-name', 'customer_name', 'lead_name', 'contact_name', 'sender_name', 'profile_name'],
  first_name: ['first_name', 'firstname', 'fname', 'given_name'],
  last_name: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
  phone: ['phone', 'mobile', 'phone_number', 'mobile_number', 'mobileno', 'contact_number', 'tel', 'telephone', 'whatsapp', 'whatsapp_number', 'wa_id', 'contact', 'your-phone'],
  email: ['email', 'email_address', 'e-mail', 'your_email', 'your-email'],
  city: ['city', 'location', 'town'],
  message: ['message', 'comments', 'comment', 'query', 'enquiry', 'inquiry', 'notes', 'your-message', 'description', 'text'],
  interest: ['interest', 'course', 'program', 'programme', 'service', 'interested_in', 'requirement'],
  campaign: ['campaign', 'campaign_name'], ad: ['ad', 'ad_name'], adset: ['adset', 'adset_name', 'ad_group'], form: ['form', 'form_name'],
  utm_source: ['utm_source'], utm_medium: ['utm_medium'], utm_campaign: ['utm_campaign'],
  landing_page: ['page_url', 'landing_page', 'url', 'page'],
  external_id: ['lead_id', 'external_id', 'leadid'],
  created_time: ['created_time', 'created_at', 'timestamp'],
};
const SKIP = new Set(['_hp', 'key', '_key', 'google_key']);
const lowerKeys = (o) => { const m = {}; for (const [k, v] of Object.entries(o || {})) m[k.toLowerCase().replace(/\s+/g, '_')] = v; return m; };

export function extractLead(payload, mapping = {}) {
  const roots = [payload];
  for (const k of ['lead', 'data', 'contact', 'customer', 'fields']) if (payload && typeof payload[k] === 'object' && !Array.isArray(payload[k])) roots.push(payload[k]);
  const flat = Object.assign({}, ...roots.slice().reverse().map(lowerKeys));
  const used = new Set();
  const out = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    let v;
    if (mapping[field]) v = getPath(payload, mapping[field]);
    if (v == null || v === '') for (const n of names) if (flat[n] != null && flat[n] !== '') { v = flat[n]; used.add(n); break; }
    if (v != null && v !== '') out[field] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (!out.name && (out.first_name || out.last_name)) out.name = [out.first_name, out.last_name].filter(Boolean).join(' ');
  delete out.first_name; delete out.last_name;
  const extra = {};
  let n = 0;
  for (const [k, v] of Object.entries(flat)) {
    if (used.has(k) || SKIP.has(k) || v == null || v === '' || typeof v === 'object' || n >= 40) continue;
    if (Object.values(ALIASES).some((a) => a.includes(k))) continue;
    extra[k] = String(v).slice(0, 500); n++;
  }
  out.extra = extra;
  return out;
}

async function parseBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) return await req.json();
  if (ct.includes('form')) {
    const fd = await req.formData();
    const o = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string') o[k] = v;
    return o;
  }
  const t = await req.text();
  try { return JSON.parse(t); } catch { return Object.fromEntries(new URLSearchParams(t)); }
}
async function sourceByKey(db, key, types) {
  const s = await db.first('SELECT * FROM sources WHERE key=?', String(key || '').slice(0, 64));
  if (!s || (types && !types.includes(s.type))) fail(404, 'Unknown webhook key');
  if (s.status !== 'active') fail(410, 'Source is paused');
  return s;
}
const setError = (db, sid, msg) => db.run('UPDATE sources SET last_error=?, last_error_at=? WHERE id=?', String(msg).slice(0, 500), nowIST(), sid);

// ---------- Website forms (CORS open) ----------
export const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400',
};
export async function webHook(ctx) {
  const s = await sourceByKey(ctx.db, ctx.params.key, ['web']);
  const body = await parseBody(ctx.req).catch(() => ({}));
  if (body._hp) return json({ ok: true }, 200, CORS);          // honeypot filled = bot; pretend success
  const d = extractLead(body);
  if (!d.phone && !d.email) { await setError(ctx.db, s.id, 'Form post without phone or email'); fail(400, 'phone or email required'); }
  d._source_name = s.name;
  delete d.created_time;
  const r = await ingestLead(ctx.db, { sourceId: s.id, data: d });
  // Plain HTML forms (no JavaScript) can send the visitor back with ?redirect=https://…/thank-you
  const back = ctx.query.get('redirect');
  if (back && /^https?:\/\//.test(back)) return new Response(null, { status: 303, headers: { location: back, ...CORS } });
  return json({ ok: true, id: r.id }, 200, CORS);
}

// ---------- Google Forms (Apps Script), and any tool that can POST JSON: Zapier, Pabbly, Make, AiSensy, Interakt, WATI, Google Sheets scripts … ----------
export async function inHook(ctx) {
  const s = await sourceByKey(ctx.db, ctx.params.key, ['other', 'whatsapp', 'gform']);
  let body;
  try { body = await parseBody(ctx.req); } catch { await setError(ctx.db, s.id, 'Body is not JSON or form data'); fail(400, 'Bad body'); }
  const items = Array.isArray(body) ? body.slice(0, 5) : [body];
  const ids = [];
  for (const item of items) {
    const d = extractLead(item);
    if (!d.phone && !d.email) { await setError(ctx.db, s.id, 'Payload without phone or email: ' + JSON.stringify(item).slice(0, 200)); continue; }
    d._source_name = s.name;
    const createdAt = d.created_time ? toIST(d.created_time) : null;
    delete d.created_time;
    ids.push((await ingestLead(ctx.db, { sourceId: s.id, data: d, createdAt, kind: s.type === 'whatsapp' ? 'whatsapp' : 'system' })).id);
  }
  if (!ids.length) fail(400, 'phone or email required');
  return json({ ok: true, ids });
}

// ---------- Google Ads lead form webhook ----------
export async function googleHook(ctx) {
  const s = await sourceByKey(ctx.db, ctx.params.key, ['google']);
  const b = await ctx.req.json().catch(() => null);
  if (!b) fail(400, 'JSON body required');
  if (!s.secret || !timingSafeEq(String(b.google_key || ''), s.secret)) { await setError(ctx.db, s.id, 'Wrong google_key'); fail(401, 'Bad google_key'); }
  const cols = {};
  for (const c of b.user_column_data || []) cols[String(c.column_id || c.column_name || '').toUpperCase()] = c.string_value;
  const known = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'EMAIL', 'CITY'];
  const d = {
    name: cols.FULL_NAME || [cols.FIRST_NAME, cols.LAST_NAME].filter(Boolean).join(' ') || null,
    phone: cols.PHONE_NUMBER, email: cols.EMAIL, city: cols.CITY,
    external_id: b.lead_id ? 'g:' + b.lead_id : null,
    campaign: b.campaign_id ? String(b.campaign_id) : null, adset: b.adgroup_id ? String(b.adgroup_id) : null,
    ad: b.creative_id ? String(b.creative_id) : null, form: b.form_id ? String(b.form_id) : null, platform: 'google',
    _source_name: s.name,
  };
  const extra = {};
  for (const [k, v] of Object.entries(cols)) if (!known.includes(k)) extra[k.toLowerCase()] = v;
  if (b.is_test) { extra.test = true; d.name = (d.name || 'Google') + ' (test)'; }
  d.extra = extra;
  const r = await ingestLead(ctx.db, { sourceId: s.id, data: d });
  return json({ ok: true, id: r.id });
}

// ---------- Meta: Lead Ads (Facebook/Instagram) + WhatsApp Cloud API, one webhook URL ----------
export async function metaVerify(ctx) {
  const cfg = await loadConfig(ctx);
  const q = ctx.query;
  if (q.get('hub.mode') === 'subscribe' && cfg.meta_verify_token && q.get('hub.verify_token') === cfg.meta_verify_token)
    return new Response(q.get('hub.challenge') || '', { status: 200 });
  return new Response('Forbidden', { status: 403 });
}

// Always answers 200 so Meta doesn't switch the subscription off; errors are shown on the source in Settings.
export async function metaHook(ctx) {
  const cfg = await loadConfig(ctx);
  const raw = await ctx.req.text();
  const sig = ctx.req.headers.get('x-hub-signature-256') || '';
  if (!cfg.meta_app_secret) return json({ ok: false, error: 'Meta App Secret is not saved in Settings' });
  const expected = 'sha256=' + (await hmac(cfg.meta_app_secret, raw, 'hex'));
  if (!timingSafeEq(sig, expected)) return json({ ok: false, error: 'bad signature' });
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false }); }
  const db = ctx.db;
  let created = 0;
  for (const e of (body.entry || []).slice(0, 5)) {
    for (const c of (e.changes || []).slice(0, 5)) {
      if (db.n > 30) break; // stay well inside the per-request query budget
      if (c.field === 'leadgen' && c.value) created += await metaLead(ctx, c.value);
      else if (c.field === 'messages' && c.value?.messages) created += await waMessages(ctx, c.value);
    }
  }
  return json({ ok: true, created });
}

async function metaLead(ctx, v) {
  const db = ctx.db;
  const srcs = await db.all("SELECT * FROM sources WHERE page_id=? AND type='meta' AND status='active'", String(v.page_id || ''));
  const src = srcs.find((s) => !s.form_ids || s.form_ids.split(/[\s,]+/).includes(String(v.form_id))) || null;
  if (!src) return 0;
  try {
    const d = await fetchMetaLead(ctx.env, src, v);
    const r = await ingestLead(db, { sourceId: src.id, data: d.data, createdAt: d.createdAt });
    return r.existing ? 0 : 1;
  } catch (err) {
    await setError(db, src.id, 'Meta: ' + (err.message || err));
    return 0;
  }
}

async function fetchMetaLead(env, src, v) {
  const id = String(v.leadgen_id);
  let g = env.DEV ? v._test_payload : null; // local tests only: skip the Graph call
  if (!g) {
    if (!src.page_token) throw new Error('No Page access token saved on this source');
    const ver = env.META_GRAPH_VERSION || 'v21.0';
    const url = `https://graph.facebook.com/${ver}/${encodeURIComponent(id)}?fields=field_data,created_time,ad_id,ad_name,adset_name,campaign_name,form_id,platform&access_token=${encodeURIComponent(src.page_token)}`;
    const res = await fetch(url);
    g = await res.json();
    if (!res.ok || g.error) throw new Error(g.error?.message || 'Graph API ' + res.status);
  }
  const f = {};
  for (const x of g.field_data || []) f[String(x.name).toLowerCase()] = (x.values || []).join(', ');
  const take = (...k) => { for (const n of k) if (f[n]) { const val = f[n]; delete f[n]; return val; } return null; };
  const name = take('full_name', 'name') || [take('first_name'), take('last_name')].filter(Boolean).join(' ') || null;
  const data = {
    name, phone: take('phone_number', 'phone', 'mobile_number', 'whatsapp_number'), email: take('email'), city: take('city'),
    campaign: g.campaign_name, adset: g.adset_name, ad: g.ad_name || (g.ad_id ? String(g.ad_id) : null),
    form: g.form_id ? String(g.form_id) : v.form_id ? String(v.form_id) : null, platform: g.platform || 'facebook',
    external_id: id, extra: f, _source_name: src.name,
  };
  // Other answers (e.g. "Are you an IT professional?") are kept in extra and shown on the lead.
  return { data, createdAt: g.created_time ? toIST(g.created_time) : null };
}

// WhatsApp Cloud API: a message from a new number becomes a lead; from a known number it goes on the lead's timeline.
async function waMessages(ctx, v) {
  const db = ctx.db;
  const pid = String(v.metadata?.phone_number_id || '');
  const src = await db.first("SELECT * FROM sources WHERE type='whatsapp' AND status='active' AND (wa_phone_id=? OR wa_phone_id IS NULL OR wa_phone_id='') ORDER BY wa_phone_id DESC LIMIT 1", pid);
  if (!src) return 0;
  const names = {};
  for (const c of v.contacts || []) names[c.wa_id] = c.profile?.name;
  let created = 0;
  for (const m of v.messages.slice(0, 5)) {
    const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title
      || (m.type ? `[${m.type}]` : '');
    try {
      const r = await ingestLead(db, {
        sourceId: src.id, kind: 'whatsapp',
        data: { name: names[m.from] || null, phone: '+' + String(m.from || ''), message: text, platform: 'whatsapp', _source_name: src.name,
          external_id: null },
        createdAt: m.timestamp ? toIST(Number(m.timestamp)) : null,
      });
      if (!r.existing) created++;
    } catch (err) { await setError(db, src.id, 'WhatsApp: ' + (err.message || err)); }
  }
  return created;
}
