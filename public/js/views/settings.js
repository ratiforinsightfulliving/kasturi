// Settings (admins): team, lead sources (Meta, Google Ads, Google Form, website, WhatsApp, other tools), email, message wording, general.
import {
  h, raw, ic, $, on, setHTML, state, get, post, patch, put, del, toast, errToast, modal, input, textarea, select, check, table, badge, fdt, cap,
  copyText, confirmBox, emptyState, esc,
} from '../core.js';
import { setTitle, isAdmin, reloadMeta } from '../main.js';

const TABS = [['team', 'Team'], ['sources', 'Lead sources'], ['email', 'Email (EmailJS)'], ['messages', 'Message wording'], ['general', 'General']];
const shead = (title, action, sub) => h`<div class="shead"><h2>${title}</h2><div class="sp"></div>${action || ''}${sub ? h`<p>${sub}</p>` : ''}</div>`;
const SRC = {
  meta: ['Facebook & Instagram Lead Ads', 'Leads from your Meta instant forms arrive in seconds.'],
  google: ['Google Ads lead form', 'Leads from Google Ads lead form assets.'],
  gform: ['Google Form', 'The enquiry form on the website (forms.gle) — sends every new response here.'],
  web: ['Website form', 'Any form on your own website.'],
  whatsapp: ['WhatsApp', 'New WhatsApp chats become leads (WhatsApp Cloud API, AiSensy, Interakt, WATI …).'],
  other: ['Other tool (Zapier, Pabbly, Make …)', 'Anything that can send a webhook.'],
};
const copyBtn = (text) => h`<button type="button" class="btn xs ghost" data-copy="${text}">${ic('copy')} Copy</button>`;
// Each section re-renders into a fresh element so delegated listeners never pile up.
const fresh = (box) => { const n = box.cloneNode(false); box.replaceWith(n); return n; };
const codeBox = (text) => h`<div class="linkbox"><code style="white-space:pre-wrap">${text}</code>${copyBtn(text)}</div>`;

export async function settings(view, params) {
  if (!isAdmin()) { setHTML(view, h`<div class="note err">Only admins can open Settings.</div>`); return; }
  const tab = params.tab || 'team';
  setTitle('Settings');
  setHTML(view, h`<div class="settings-wrap"><nav class="snav"><h2>Settings</h2>${TABS.map(([k, l]) => h`<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`)}</nav><div id="sbox"></div></div>`);
  const box = $('#sbox', view);
  on(view, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy));
  await ({ team, sources, email, messages, general }[tab] || team)(box);
}

// ---------- Team ----------
async function team(box) {
  box = fresh(box);
  const r = await get('/users');
  setHTML(box, h`${shead('Team', h`<button class="btn primary" data-new>${ic('plus')} Add team member</button>`,
    'Admins see everything and manage settings. Counsellors work the leads assigned to them. "Gets new leads" = included in the automatic round-robin.')}
    <div class="scard">${table([
      { label: 'Name', cell: (u) => h`<div class="cell-main">${u.name}${u.active ? '' : h` <span class="flag">off</span>`}</div><div class="cell-sub">${u.email}${u.phone ? ' · ' + u.phone : ''}</div>` },
      { label: 'Role', cell: (u) => cap(u.role) },
      { label: 'Gets new leads', cell: (u) => (u.in_rotation && u.active ? 'Yes' : 'No') },
      { label: 'Open leads', cls: 'num', cell: (u) => u.open_leads },
      { label: 'Last login', cell: (u) => (u.last_login_at ? fdt(u.last_login_at) : u.must_change ? h`<span class="late">Not yet</span>` : '—') },
      { label: '', cls: 'num', cell: (u) => h`<button class="btn xs ghost" data-edit="${u.id}">Edit</button>` },
    ], r.items)}</div>`);
  const showPw = (u, pw) => modal({ title: 'Login details', cancel: 'Done',
    body: h`<p>Share these with ${u.name}. They will choose their own password at first login.</p>
      ${codeBox(`Login: ${location.origin}\nEmail: ${u.email}\nTemporary password: ${pw}`)}` });
  on(box, 'click', '[data-new]', () => modal({
    title: 'Add team member',
    body: h`${input('name', 'Name', '', 'text', 'required')}${input('email', 'Email (used to log in)', '', 'email', 'required')}${input('phone', 'Phone')}
      ${select('role', 'Role', [['counsellor', 'Counsellor'], ['admin', 'Admin']], 'counsellor')}${check('in_rotation', 'Gets new leads automatically', true)}`,
    onSubmit: async (d) => { const res = await post('/users', d); await reloadMeta(); team(box); showPw(d, res.password); },
  }));
  on(box, 'click', '[data-edit]', (e, b) => {
    const u = r.items.find((x) => x.id === Number(b.dataset.edit));
    const m = modal({
      title: 'Edit ' + u.name,
      body: h`${input('name', 'Name', u.name)}${input('phone', 'Phone', u.phone)}${select('role', 'Role', [['counsellor', 'Counsellor'], ['admin', 'Admin']], u.role)}
        ${check('in_rotation', 'Gets new leads automatically', u.in_rotation)}${check('active', 'Account active (can log in)', u.active)}
        <div class="row" style="margin-top:8px"><button type="button" class="btn sm ghost" data-reset>Reset password</button>${u.must_change ? h`<button type="button" class="btn sm ghost" data-view>Show temporary password</button>` : ''}</div>`,
      onSubmit: async (d) => { await patch('/users/' + u.id, d); await reloadMeta(); toast('Saved'); team(box); },
    });
    on(m.el, 'click', '[data-reset]', async () => { if (!(await confirmBox(`${u.name} will be signed out and must use a new temporary password.`, { ok: 'Reset' }))) return; const res = await post(`/users/${u.id}/reset-password`); m.close(); showPw(u, res.password); });
    on(m.el, 'click', '[data-view]', async () => { try { const res = await get(`/users/${u.id}/password`); m.close(); showPw(u, res.password); } catch (ex) { errToast(ex); } });
  });
}

// ---------- Lead sources ----------
async function sources(box) {
  box = fresh(box);
  const [r, cfg] = await Promise.all([get('/sources'), get('/settings')]);
  const o = location.origin;
  setHTML(box, h`${shead('Lead sources', h`<button class="btn primary" data-new>${ic('plus')} Connect a source</button>`,
    'Every source has its own private web address. Leads arrive in the Leads inbox, are given to the next counsellor automatically, and repeat enquiries are merged.')}
    <div class="scard"><div class="sbody stack"><h3>Meta app connection <small class="muted">(for Facebook/Instagram Lead Ads and WhatsApp Cloud API)</small></h3>
      <p class="muted">In your Meta developer app → Webhooks, use this callback URL and verify token. Subscribe the <b>Page</b> object to <b>leadgen</b>, and (for WhatsApp) the <b>WhatsApp Business Account</b> object to <b>messages</b>.</p>
      <div class="fgrid"><div><small class="muted">Callback URL</small>${codeBox(cfg.meta_webhook_url)}</div><div><small class="muted">Verify token</small>${codeBox(cfg.meta_verify_token)}</div></div>
      <form class="row" data-secret style="align-items:flex-end"><div style="flex:1">${input('meta_app_secret', `Meta App Secret ${cfg.has_meta_app_secret ? '(saved ✓ — type to replace)' : '(not saved yet)'}`, '', 'password', 'autocomplete="new-password" data-lpignore="true" placeholder="App settings → Basic → App secret"')}</div>
        <button class="btn">Save</button></form></div></div>
    <div class="scard">${r.items.length ? table([
      { label: 'Source', cell: (s) => h`<div class="cell-main">${s.name}${s.status === 'paused' ? h` <span class="flag">paused</span>` : ''}</div><div class="cell-sub">${SRC[s.type]?.[0] || s.type}</div>` },
      { label: 'Leads', cls: 'num', cell: (s) => s.lead_count },
      { label: 'Last lead', cell: (s) => (s.last_lead_at ? fdt(s.last_lead_at) : h`<span class="muted">None yet</span>`) },
      { label: 'Status', cell: (s) => (s.last_error ? h`<span class="late" title="${s.last_error}">⚠ ${s.last_error.slice(0, 60)}</span>` : badge('OK', '#15803d')) },
      { label: '', cls: 'num', cell: (s) => h`<button class="btn xs ghost" data-setup="${s.id}">Setup</button>` },
    ], r.items) : emptyState('No sources yet. Connect Facebook/Instagram, Google, the website Google Form or WhatsApp.')}</div>`);

  on(box, 'submit', '[data-secret]', async (e) => { e.preventDefault(); const v = e.target.meta_app_secret.value.trim(); if (!v) return; await put('/settings', { meta_app_secret: v }); toast('Saved'); sources(box); });
  on(box, 'click', '[data-new]', () => modal({
    title: 'Connect a source',
    body: h`<div class="stack">${Object.entries(SRC).map(([k, [t, d]]) => h`<label class="check" style="align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:12px">
      <input type="radio" name="type" value="${k}" ${k === 'meta' ? raw('checked') : ''}> <span><b>${t}</b><br><small class="muted">${d}</small></span></label>`)}
      ${input('name', 'Name (shown on each lead)', '', 'text', 'placeholder="e.g. Instagram — Kasturi Nov campaign"')}</div>`,
    submit: 'Continue',
    onSubmit: async (d) => {
      d.name ||= SRC[d.type][0];
      const res = await post('/sources', d);
      await reloadMeta();
      const list = await get('/sources');
      sources(box);
      setup(list.items.find((x) => x.id === res.id));
    },
  }));
  on(box, 'click', '[data-setup]', (e, b) => setup(r.items.find((x) => x.id === Number(b.dataset.setup))));

  function setup(s) {
    const hookIn = `${o}/api/hook/in/${s.key}`;
    const guides = {
      meta: h`<ol class="steps"><li>Save the <b>Meta App Secret</b> and set up the webhook (callback URL + verify token) shown on the Lead sources page.</li>
        <li>In Meta Business Settings, create a <b>System User</b> with access to the Page, and generate a token with <code>leads_retrieval</code>, <code>pages_manage_metadata</code>, <code>pages_show_list</code>, <code>pages_read_engagement</code>. Paste it below as the Page access token.</li>
        <li>Subscribe the Page to the app (Graph API: <code>POST /{page-id}/subscribed_apps?subscribed_fields=leadgen</code>) and give the app access under Business Settings → Integrations → Leads access.</li>
        <li>Test with Meta's <a href="https://developers.facebook.com/tools/lead-ads-testing" target="_blank" rel="noopener">Lead Ads Testing Tool</a>. The lead should appear here within seconds.</li></ol>
        <div class="fgrid">${input('page_id', 'Facebook Page ID', s.page_id)}${input('form_ids', 'Only these form IDs (optional, comma separated)', s.form_ids)}
        <div class="full">${input('page_token', `Page access token ${s.has_page_token ? '(saved ✓ — type to replace)' : ''}`, '', 'password', 'autocomplete="new-password" data-lpignore="true"')}</div></div>`,
      google: h`<ol class="steps"><li>Google Ads → your lead form asset → <b>Lead delivery</b> → Webhook integration.</li><li>Paste this <b>Webhook URL</b> and <b>Key</b>, then click <b>Send test data</b>.</li></ol>
        <small class="muted">Webhook URL</small>${codeBox(`${o}/api/hook/google/${s.key}`)}<small class="muted">Key</small>${codeBox(s.secret || '')}`,
      gform: h`<ol class="steps"><li>Open the enquiry Google Form → ⋮ → <b>Script editor</b> (Apps Script).</li><li>Replace everything with the code below and click <b>Save</b>.</li>
        <li>Left menu → <b>Triggers</b> → Add trigger → function <code>sendToCRM</code>, event source <b>From form</b>, event type <b>On form submit</b> → Save and allow access.</li>
        <li>Submit a test response — it appears in Leads. Name the questions like "Name", "Phone", "Email", "City"; every other question is saved on the lead too.</li></ol>
        ${codeBox(`function sendToCRM(e) {
  var data = {};
  e.response.getItemResponses().forEach(function (r) {
    var a = r.getResponse();
    data[r.getItem().getTitle()] = Array.isArray(a) ? a.join(', ') : a;
  });
  var email = e.response.getRespondentEmail();
  if (email) data.email = data.email || email;
  UrlFetchApp.fetch('${hookIn}', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(data), muteHttpExceptions: true
  });
}`)}`,
      web: h`<p>Point any form on your website at this address (fields named <code>name</code>, <code>phone</code>, <code>email</code>, <code>city</code>, <code>message</code>, <code>interest</code>):</p>
        ${codeBox(`${o}/api/hook/web/${s.key}`)}<p class="muted">Plain HTML form example (sends visitors to a thank-you page):</p>
        ${codeBox(`<form method="post" action="${o}/api/hook/web/${s.key}?redirect=https://kasturi.ratiforinsightfulliving.com/">
  <input name="name" placeholder="Name" required>
  <input name="phone" placeholder="Phone" required>
  <input name="email" placeholder="Email">
  <input name="_hp" style="display:none" tabindex="-1" autocomplete="off">
  <button>Enquire</button>
</form>`)}`,
      whatsapp: h`<p><b>Option A — WhatsApp Cloud API (Meta):</b> set up the Meta app connection on the Lead sources page, subscribe <b>messages</b>, and enter your WhatsApp <b>Phone number ID</b> below (leave blank to accept all numbers in the app). A first message from a new number creates a lead; later messages are added to the lead's history.</p>
        ${input('wa_phone_id', 'WhatsApp phone number ID', s.wa_phone_id)}
        <p style="margin-top:12px"><b>Option B — AiSensy, Interakt, WATI, Gallabox …:</b> add this webhook for "new contact / new message" events:</p>${codeBox(hookIn)}`,
      other: h`<p>Send a POST with JSON or form fields (<code>name</code>, <code>phone</code>, <code>email</code>, <code>city</code>, <code>message</code>, <code>interest</code>) to:</p>${codeBox(hookIn)}
        <p class="muted">Works with Zapier, Pabbly Connect, Make, Google Sheets scripts and landing-page builders.</p>`,
    };
    const m = modal({
      title: `${s.name} — setup`, wide: true,
      body: h`<div class="stack">${guides[s.type] || guides.other}
        <div class="fgrid">${input('name', 'Name', s.name)}${select('status', 'Status', [['active', 'Active'], ['paused', 'Paused']], s.status)}</div>
        ${s.last_error ? h`<div class="note warn">Last problem (${fdt(s.last_error_at)}): ${s.last_error}</div>` : ''}
        <div class="row"><button type="button" class="btn sm ghost" data-test>Send a test lead</button><button type="button" class="btn sm ghost" data-rotate>New secret address</button>
          <button type="button" class="btn sm danger" data-del>Delete source</button></div></div>`,
      onSubmit: async (d) => { await patch('/sources/' + s.id, d); await reloadMeta(); toast('Saved'); sources(box); },
    });
    on(m.el, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy));
    on(m.el, 'click', '[data-test]', async () => { try { await post(`/sources/${s.id}/test`); toast('Test lead added — see Leads'); } catch (ex) { errToast(ex); } });
    on(m.el, 'click', '[data-rotate]', async () => {
      if (!(await confirmBox('The old webhook address stops working. You must paste the new one wherever it was used.', { ok: 'Change address' }))) return;
      await patch('/sources/' + s.id, { rotate_key: 1 }); m.close(); const list = await get('/sources'); sources(box); setup(list.items.find((x) => x.id === s.id));
    });
    on(m.el, 'click', '[data-del]', async () => {
      if (!(await confirmBox('Leads already received stay in the CRM. New leads from this source will stop.', { ok: 'Delete' }))) return;
      await del('/sources/' + s.id); m.close(); await reloadMeta(); sources(box);
    });
  }
}

// ---------- Email ----------
async function email(box) {
  box = fresh(box);
  const c = await get('/settings');
  const log = await get('/email-log');
  setHTML(box, h`${shead('Email (EmailJS)', c.email_provider ? badge('Connected', '#15803d') : badge('Not set up', '#b45309'),
    'Used for the welcome email with the student\'s class page link, and optional update emails. EmailJS free plan: 200 emails a month.')}
    <form class="scard" data-f autocomplete="off"><div class="sbody stack">
      <ol class="steps"><li>Create a free account at <a href="https://www.emailjs.com" target="_blank" rel="noopener">emailjs.com</a> and add an <b>Email Service</b> (e.g. Gmail of Kasturi). Copy its <b>Service ID</b>.</li>
        <li>Create an <b>Email Template</b>: To Email = <code>{{to_email}}</code>, Subject = <code>{{subject}}</code>, Content = <code>{{message}}</code>, From Name = <code>{{from_name}}</code>. Copy the <b>Template ID</b>.</li>
        <li>Account → <b>API keys</b>: copy the Public key and the Private key.</li>
        <li>Account → <b>Security</b>: turn ON "Allow EmailJS API for non-browser applications".</li></ol>
      <div class="fgrid">${input('emailjs_service_id', 'Service ID', c.emailjs_service_id)}${input('emailjs_template_id', 'Template ID', c.emailjs_template_id)}
        ${input('emailjs_public_key', 'Public key', c.emailjs_public_key, 'text', 'autocomplete="off" data-lpignore="true" spellcheck="false"')}${input('emailjs_private_key', `Private key ${c.has_emailjs_private_key ? '(saved ✓ — type to replace)' : ''}`, '', 'password', 'autocomplete="new-password" data-lpignore="true"')}
        ${input('email_from_name', 'From name', c.email_from_name || c.brand_name)}</div>
      <div class="row end"><button type="button" class="btn ghost" data-test>Send test email to me</button><button class="btn primary">Save</button></div></div></form>
    <div class="scard"><div class="sbody"><h3>Recent emails</h3></div>${table([
      { label: 'When', cell: (r) => fdt(r.created_at) }, { label: 'To', cell: (r) => r.to_email }, { label: 'Subject', cell: (r) => r.subject },
      { label: 'Result', cell: (r) => (r.ok ? badge('Sent', '#15803d') : h`<span class="late">${r.detail}</span>`) }], log.items, { empty: 'No emails sent yet' })}</div>`);
  on(box, 'submit', '[data-f]', async (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); await put('/settings', d); toast('Saved'); email(box); });
  on(box, 'click', '[data-test]', async (e, b) => { b.disabled = true; try { const r = await post('/settings/test-email', {}); toast(r.detail); } catch (ex) { errToast(ex); } b.disabled = false; email(box); });
}

// ---------- Message wording ----------
async function messages(box) {
  box = fresh(box);
  const c = await get('/settings');
  setHTML(box, h`${shead('Message wording', '', 'Edit the ready-made WhatsApp messages and the welcome email.')}
    <form class="scard" data-f><div class="sbody stack">
      <h3>WhatsApp</h3><p class="muted">Placeholders: {name} first name, {user} your name, {brand}, {interest}.</p>
      ${textarea('wa_first', 'First message to a new lead', c.wa_first, 'rows="3"')}${textarea('wa_followup', 'Follow-up message', c.wa_followup, 'rows="3"')}
      ${textarea('wa_link', 'Sending the class page link to a student ({link}, {phone})', c.wa_link, 'rows="3"')}
      <h3 style="margin-top:12px">Welcome email (sent on enrolment)</h3><p class="muted">Placeholders: {name} {full_name} {course} {link} personal link, {portal} student page, {phone} {schedule} {schedule_line} {class_link} {brand}.</p>
      ${input('welcome_subject', 'Subject', c.welcome_subject)}${textarea('welcome_body', 'Email text', c.welcome_body, 'rows="12"')}
      <div class="row end"><button class="btn primary">Save</button></div></div></form>`);
  on(box, 'submit', '[data-f]', async (e) => { e.preventDefault(); await put('/settings', Object.fromEntries(new FormData(e.target))); await reloadMeta(); toast('Saved'); });
}

// ---------- General ----------
async function general(box) {
  box = fresh(box);
  const c = await get('/settings');
  setHTML(box, h`${shead('General')}
    <form class="scard" data-f><div class="sbody stack"><div class="fgrid">
      ${input('brand_name', 'Brand name', c.brand_name)}${input('tagline', 'Tagline', c.tagline)}
      ${input('support_phone', 'Support WhatsApp number (shown to students)', c.support_phone, 'tel')}
      ${input('followup_hours', 'Default next follow-up after a call (hours)', c.followup_hours, 'number', 'min="1" max="720"')}
      <div class="full">${input('app_url', 'Public address of this CRM (used in student links)', c.app_url, 'url', `placeholder="${esc(c.default_app_url)}"`)}
        <small class="muted">Leave blank to use ${c.default_app_url}. Fill it after connecting your own domain.</small></div>
      <div class="full">${textarea('portal_welcome', 'Welcome text on the student page', c.portal_welcome, 'rows="2"')}</div>
      <div class="full"><input type="hidden" name="counsellor_all" value="0">${check('counsellor_all', 'Counsellors can see every lead (not only the ones assigned to them)', c.counsellor_all)}</div>
    </div><div class="row end"><button class="btn primary">Save</button></div></div></form>`);
  on(box, 'submit', '[data-f]', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.counsellor_all = e.target.querySelector('input[type=checkbox][name=counsellor_all]').checked ? 1 : 0;
    await put('/settings', d); await reloadMeta(); toast('Saved');
  });
}
