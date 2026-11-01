# Kasturi CRM

Lead and student management for **Kasturi by RATI for Insightful Living**: online meditation classes for IT professionals
(https://kasturi.ratiforinsightfulliving.com).

It has two parts. Both are served by the same Cloudflare Worker:

| Who | Address | What they do |
|---|---|---|
| Kasturi team | `https://<your-crm-address>/` | Receive leads, call, WhatsApp, follow up, enrol, share class links, post updates |
| Students | `https://<your-crm-address>/learn/` | Type their phone number (or tap the link from their welcome email) to see the class link, schedule, class notes, recordings and wellness tips |

---

## How the team uses it (day to day)

1. **Home** shows what to do now: *New — not called yet* and *Follow-ups today / overdue*.
2. **Leads**: every enquiry from Facebook, Instagram, Google Ads, the website Google Form, the website and WhatsApp arrives here automatically.
   New leads go to counsellors in turn (round-robin). If the same phone or email enquires again, it is added to the existing lead and does not create a duplicate.
3. Open a lead:
   - **Call** opens the phone dialer. After the call, pick how it went (Connected / No answer / …), write a note, set the next follow-up, and press **Save**.
   - **WhatsApp** opens a chat with a ready-made message (the wording can be changed in Settings → Message wording).
   - **Email** opens your email app.
4. **Follow-ups**: the overdue, today's and upcoming calls. No lead gets forgotten.
5. When someone pays, open the lead and press **Enrol**. Choose the course and the amount, and keep *Email the student their class page link* ticked.
   The student gets an email with their personal link. A **Send link on WhatsApp** button is shown too.
6. **Classes & updates**: set the Google Meet link and schedule for each course, and post class notes, recordings (Drive or YouTube links), wellness tips and announcements.
   Students see them on their page right away. Tick *Also email it* to email them as well.
7. **Students**: everyone enrolled, whether their link was emailed, and when they last opened their page. You can resend the link, add a course, or switch a student off.

**Roles:** *Admin* sees everything and manages Settings. *Counsellor* works the leads assigned to them. An admin can let counsellors see all leads in Settings → General.

## Student side

- No app, no password, no OTP. Students open `/learn/` and type the phone number they enrolled with, or they tap the personal link in their welcome email.
- They see: **Join class** button (Google Meet), the schedule, and all updates (filter by notes / recordings / wellness tips).
- On a phone they can use *Add to Home screen* to keep it like an app.
- Privacy note: anyone who knows an enrolled student's phone number could open that student's page. This is the simple, no-OTP design that was asked for.
  The page only shows the student's name, class link and updates, and phone lookups are limited to 15 tries per 15 minutes from one network.
  If a class link leaks, change the Meet link in the course, or press **New link** on a student.

## First-time setup (admin, about 30 minutes)

Once the CRM is deployed (see [DEPLOY.md](DEPLOY.md)):

1. Open the CRM address. The **first account created becomes the admin**, so do this immediately after deploying.
2. **Settings → Team**: add each counsellor. Share the login details shown on screen; they choose their own password at first login.
3. **Settings → General**: support WhatsApp number (shown to students), and the CRM's public address once you have a domain.
4. **Settings → Email (EmailJS)**: follow the 4 steps on screen, save, then press **Send test email to me**.
5. **Classes & updates**: open *Kasturi Meditation Classes* (already created at ₹3,000), press **Edit**, and add the Google Meet link and schedule.
6. **Settings → Lead sources → Connect a source**: each source shows its own step-by-step setup:
   - **Google Form** (the *Enquire / Register* form on the website): paste the Apps Script shown. Every new response becomes a lead.
   - **Facebook & Instagram Lead Ads**: needs a Meta developer app (App Secret + webhook) and a Page access token.
   - **Google Ads lead form**: paste the webhook URL and key into Google Ads.
   - **WhatsApp**: WhatsApp Cloud API (same Meta app), or a webhook from AiSensy / Interakt / WATI.
   - **Website form** and **Other tools** (Zapier, Pabbly, Make).
   Press **Send a test lead** to check each one.

## Costs

Everything runs on Cloudflare's free plan (Workers + D1): 100,000 requests a day, which is far more than needed.
EmailJS is free for 200 emails a month. WhatsApp buttons use normal WhatsApp (wa.me links), which is free.
