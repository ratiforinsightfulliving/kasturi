// Outgoing email through EmailJS (free: 200 emails/month).
// The EmailJS template must use {{to_email}} as "To", {{subject}} as subject and {{message}} as the body
// ({{from_name}} is optional). Server-side sending needs EmailJS → Account → Security →
// "Allow EmailJS API for non-browser applications" ON, plus the private key.
// Every attempt is written to email_log so admins can see what was sent.
import { nowIST } from './lib.js';

export function emailProvider(cfg) {
  return cfg.emailjs_service_id && cfg.emailjs_template_id && cfg.emailjs_public_key ? 'emailjs' : null;
}

async function deliver(cfg, to, subject, text) {
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: cfg.emailjs_service_id, template_id: cfg.emailjs_template_id, user_id: cfg.emailjs_public_key,
      accessToken: cfg.emailjs_private_key || undefined,
      template_params: { to_email: to, subject, message: text, from_name: cfg.email_from_name || cfg.brand_name || 'Kasturi' },
    }),
  });
  return { ok: r.ok, detail: r.ok ? `Sent to ${to}` : `EmailJS ${r.status}: ${(await r.text()).slice(0, 200)}` };
}

// Sends one email and logs it. Never throws: returns {ok, detail}. `cfg` comes from loadConfig().
export async function sendEmail(cfg, db, { to, subject, text, kind = 'other' }) {
  const provider = emailProvider(cfg);
  let res;
  if (!to) res = { ok: false, detail: 'No email address' };
  else if (!provider) res = { ok: false, detail: 'Email is not set up yet (Settings → Email)' };
  else {
    try { res = await deliver(cfg, to, subject, text); } catch (e) { res = { ok: false, detail: 'Email error: ' + e.message }; }
  }
  if (db) {
    await db.run('INSERT INTO email_log (to_email,subject,kind,provider,ok,detail,created_at) VALUES (?,?,?,?,?,?,?)',
      to || null, String(subject).slice(0, 200), kind, provider, res.ok ? 1 : 0, res.detail, nowIST()).catch(() => {});
  }
  return res;
}
