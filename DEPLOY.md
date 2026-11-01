# Deploying Kasturi CRM to Cloudflare (free plan)

You need a Cloudflare account (free) and Node.js 20+ on the computer. Run every command in this folder.

## 1. Install and log in
```bash
npm install
```
```bash
npx wrangler login
```
A browser opens. Log in to **Kasturi's Cloudflare account** and click **Allow**.

## 2. Create the database
```bash
npx wrangler d1 create kasturi-crm
```
It prints a `database_id`. Open `wrangler.toml` and paste it in place of `00000000-0000-0000-0000-000000000000`.

## 3. Create the tables
```bash
npm run db:remote
```

## 4. Session secret (required)
Paste a long random string when asked (40+ characters, e.g. from a password manager). Keep it safe: changing it signs everyone out and changes every student's personal link.
```bash
npx wrangler secret put SESSION_SECRET
```

## 5. Deploy
```bash
npm run deploy
```
It prints the address, e.g. `https://kasturi-crm.<account>.workers.dev`.
**Open it straight away and create the admin account.** The first account becomes the admin.

Everything else (Meta App Secret, EmailJS keys, WhatsApp) is entered inside the CRM under **Settings**. See [README.md](README.md) → First-time setup.

## 6. Own domain (optional, e.g. crm.ratiforinsightfulliving.com)
The domain's DNS must be on Cloudflare. Then either uncomment and edit the `routes` line in `wrangler.toml` and run `npm run deploy` again,
or go to Cloudflare dashboard → Workers & Pages → kasturi-crm → Settings → Domains & Routes → Add → Custom domain.
Afterwards set **Settings → General → Public address** in the CRM, so student links use the new domain.

## Updating later
```bash
npm run deploy
```
Database changes: add a file in `migrations/` (e.g. `0001_add_column.sql` with an `ALTER TABLE`) and run
`npx wrangler d1 execute kasturi-crm --remote --file migrations/0001_add_column.sql`. `schema.sql` only creates missing tables.

**Backup:** `npx wrangler d1 export kasturi-crm --remote --output backup.sql` · **Undo a bad deploy:** `npx wrangler rollback`

## Local development
```bash
cp .dev.vars.example .dev.vars
```
```bash
npm run db:local
```
```bash
npm run dev
```
Open http://localhost:8787. Checks: with the dev server running on a fresh local database, run `node scripts/qa.mjs`
(local test admin `admin@kasturi.test` / `LocalDev-2026`, created by the script only on your machine).
