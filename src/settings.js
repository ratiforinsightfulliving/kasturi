// App settings: one JSON row in `settings` (key 'config'). Secret values are sealed with SESSION_SECRET
// so the database alone never reveals them. Admins edit everything in Settings; nobody needs wrangler.
import { json, fail, str, bool, randomKey, sealText, openText } from './lib.js';
import { requireAdmin } from './auth.js';
import { emailProvider, sendEmail } from './email.js';

export const DEFAULTS = {
  brand_name: 'Kasturi',
  tagline: 'by RATI for Insightful Living',
  support_phone: '',
  app_url: '',                      // public address used in student links; blank = the address the CRM is opened on
  counsellor_all: 0,                // 1 = counsellors see every lead, 0 = only leads assigned to them
  followup_hours: 24,               // default next follow-up after a call
  portal_welcome: 'Your space to pause. Your class link, class notes and wellness updates are all here.',
  wa_first: 'Namaste {name} 🙏 This is {user} from {brand}. Thank you for your interest in the Kasturi meditation classes. When is a good time for a quick call?',
  wa_followup: 'Namaste {name}, {user} from {brand} here. Just following up on your enquiry — shall we schedule a quick call?',
  wa_link: 'Namaste {name} 🙏 Welcome to {brand}! Your class link, notes and updates are here: {link}\nOpen it and enter your phone number {phone}.',
  welcome_subject: 'Welcome to {brand} — your class link',
  welcome_body: `Namaste {name},

Thank you for joining {course}. We are happy to have you with us.

Your personal student page has your class link, schedule, class notes and wellness updates:
{link}

You can also open {portal} any time and enter your phone number ({phone}).

{schedule_line}
With warmth,
Team {brand}`,
  // Integrations
  meta_verify_token: '',
  meta_app_secret: '',
  emailjs_service_id: '', emailjs_template_id: '', emailjs_public_key: '', emailjs_private_key: '',
  email_from_name: '',
};
const SECRETS = ['meta_app_secret', 'emailjs_private_key'];
const NUMS = ['counsellor_all', 'followup_hours'];

export async function loadConfig(ctx) {
  if (ctx._cfg) return ctx._cfg;
  const v = await ctx.db.val("SELECT value FROM settings WHERE key='config'");
  let saved = {};
  try { saved = v ? JSON.parse(v) : {}; } catch { saved = {}; }
  const cfg = { ...DEFAULTS, ...saved };
  for (const k of SECRETS) cfg[k] = saved[k] ? (await openText(ctx.env.SESSION_SECRET, saved[k])) || '' : '';
  // Worker secrets still work as a fallback (npx wrangler secret put META_APP_SECRET …).
  const env = ctx.env;
  cfg.meta_app_secret ||= env.META_APP_SECRET || '';
  cfg.meta_verify_token ||= env.META_VERIFY_TOKEN || '';
  cfg.emailjs_service_id ||= env.EMAILJS_SERVICE_ID || '';
  cfg.emailjs_template_id ||= env.EMAILJS_TEMPLATE_ID || '';
  cfg.emailjs_public_key ||= env.EMAILJS_PUBLIC_KEY || '';
  cfg.emailjs_private_key ||= env.EMAILJS_PRIVATE_KEY || '';
  ctx._cfg = cfg;
  return cfg;
}
export const appUrl = (ctx, cfg) => (cfg.app_url || ctx.url.origin).replace(/\/+$/, '');
export const portalUrl = (ctx, cfg) => appUrl(ctx, cfg) + '/learn/';

// Values safe for any signed-in user (no secrets).
export function publicConfig(cfg) {
  const o = {};
  for (const k of ['brand_name', 'tagline', 'support_phone', 'counsellor_all', 'followup_hours', 'wa_first', 'wa_followup', 'wa_link']) o[k] = cfg[k];
  return o;
}

export async function getSettings(ctx) {
  requireAdmin(ctx);
  const cfg = await loadConfig(ctx);
  const out = { ...cfg };
  for (const k of SECRETS) { out['has_' + k] = !!cfg[k]; delete out[k]; }
  out.email_provider = emailProvider(cfg);
  out.default_app_url = ctx.url.origin;
  out.meta_webhook_url = ctx.url.origin + '/api/hook/meta';
  return json(out);
}

export async function saveSettings(ctx) {
  requireAdmin(ctx);
  const b = await ctx.body();
  const v = await ctx.db.val("SELECT value FROM settings WHERE key='config'");
  let saved = {};
  try { saved = v ? JSON.parse(v) : {}; } catch { saved = {}; }
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in b)) continue;
    if (SECRETS.includes(k)) {
      if (b[k]) saved[k] = await sealText(ctx.env.SESSION_SECRET, String(b[k]).trim().slice(0, 500));
      continue;
    }
    if (NUMS.includes(k)) { saved[k] = k === 'counsellor_all' ? bool(b[k]) : Math.max(1, Math.min(720, parseInt(b[k], 10) || 24)); continue; }
    const max = ['welcome_body', 'portal_welcome', 'wa_first', 'wa_followup', 'wa_link'].includes(k) ? 3000 : 300;
    const val = str(b[k], max);
    if (val == null) delete saved[k]; else saved[k] = val;
  }
  for (const k of SECRETS) if (b['clear_' + k]) delete saved[k];
  if (b.rotate_verify_token || !saved.meta_verify_token) saved.meta_verify_token = 'kasturi-' + randomKey(16);
  if (saved.app_url && !/^https?:\/\/[^\s]+$/.test(saved.app_url)) fail(400, 'App address must start with https://');
  await ctx.db.run("INSERT INTO settings (key,value) VALUES ('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(saved));
  ctx._cfg = null;
  return getSettings(ctx);
}

export async function testEmail(ctx) {
  requireAdmin(ctx);
  const b = await ctx.body();
  const cfg = await loadConfig(ctx);
  const to = str(b.to, 200) || ctx.user.email;
  const r = await sendEmail(cfg, ctx.db, { to, subject: `${cfg.brand_name} CRM — test email`, text: `This is a test email from the ${cfg.brand_name} CRM. If you can read this, email is working.`, kind: 'test' });
  if (!r.ok) fail(400, r.detail);
  return json({ ok: true, detail: r.detail });
}

export async function emailLog(ctx) {
  requireAdmin(ctx);
  const items = await ctx.db.all('SELECT * FROM email_log ORDER BY id DESC LIMIT 50');
  return json({ items });
}
