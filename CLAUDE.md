# Kasturi CRM — project guide

Single-business CRM for Kasturi (meditation classes by RATI for Insightful Living) on Cloudflare's free plan: one Worker + D1.
Built from the Gexart client-end CRM patterns (`D:\SOFTWARE DEVELOPMENT\gexart final crm client end`), simplified to one tenant.

## Layout
- `src/worker.js` — routes, CSRF header (`x-requested-with: kx`), session gate (must_change blocks everything but /me).
- `src/lib.js` — router, `Db` (counts statements), IST dates, phone/email normalisers, PBKDF2/HMAC/AES helpers, CSV (copied from Gexart).
- `src/auth.js` — sessions (signed cookie `kx_s`), roles admin/counsellor, team users, `limit()` rate limiter.
- `src/ingest.js` — `ingestLead()`: the ONLY way leads enter. Repeat phone/email → merged into the existing lead; round-robin owner.
- `src/hooks.js` — sources + webhooks: Meta Lead Ads & WhatsApp Cloud API (one `/api/hook/meta`, HMAC with Meta App Secret), Google Ads, Google Form (Apps Script → `/api/hook/in/:key`), website, other tools.
- `src/leads.js` — list/filters/follow-ups, call/WhatsApp/note logging, bulk, CSV import/export. Counsellors see only own leads unless `counsellor_all`.
- `src/students.js` — courses, enrol (lead → student, stage 5 Enrolled), students, updates; personal link token = `id.HMAC(SESSION_SECRET, stu:id:token)`.
- `src/portal.js` — student API for `/learn/` (phone lookup rate-limited, `x-student-token` header).
- `src/settings.js` — one JSON row `settings.config`; secrets sealed with SESSION_SECRET; env vars are fallbacks.
- `src/email.js` — EmailJS REST (template uses {{to_email}} {{subject}} {{message}} {{from_name}}), logged to `email_log`.
- `public/` — team SPA (vanilla ES modules, hash routes, `js/core.js` UI kit with auto-escaping `h```). `public/learn/` — student page.

## Rules
- Stage ids are fixed: 1 New, 2 Contacted, 3 Interested, 4 Follow-up, 5 Enrolled (only via enrol), 6 Not interested.
- ≤ 45 D1 statements per request (`x-queries` header; logged when DEV=1).
- Timestamps are IST strings `YYYY-MM-DD HH:MM:SS`.
- Drawer/section redraws must use a fresh container (cloneNode) so delegated listeners don't stack.
- New DB columns need a migration file + remote execute; `schema.sql` is idempotent CREATE only.

## Commands
`npm run db:local` · `npm run dev` (http://localhost:8787) · `node scripts/qa.mjs` (fresh local DB) · `npm run deploy` — see DEPLOY.md.
