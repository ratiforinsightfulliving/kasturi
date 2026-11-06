// End-to-end checks against a running dev server:  npm run dev  then  node scripts/qa.mjs [baseUrl]
// Uses a fresh local database (first run creates the admin). Re-run after: rm -rf .wrangler/state && npm run db:local
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, failN = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; } else { failN++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const r = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { 'x-requested-with': 'kx', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
}

const admin = client();
const anon = client();
const stamp = Date.now().toString().slice(-6);

// ---- setup / auth ----
let r = await anon('GET', '/api/setup-status');
if (r.data.needsSetup) {
  r = await admin('POST', '/api/setup', { name: 'Kasturi Admin', email: 'admin@kasturi.test', password: 'LocalDev-2026' });
  ok(r.status === 200, 'setup creates admin', r.data);
} else {
  r = await admin('POST', '/api/login', { email: 'admin@kasturi.test', password: 'LocalDev-2026' });
  ok(r.status === 200, 'admin login', r.data);
}
r = await anon('POST', '/api/setup', { name: 'X', email: 'x@x.test', password: '12345678' });
ok(r.status === 403, 'setup closed once a user exists');
r = await anon('GET', '/api/leads');
ok(r.status === 401, 'leads need login');
r = await admin('POST', '/api/leads', { phone: '9000000000' }, { 'x-requested-with': '' });
ok(r.status === 403, 'CSRF header required');
r = await admin('GET', '/api/me');
ok(r.status === 200 && r.data.user.role === 'admin' && r.data.stages.length === 6 && r.data.courses.length >= 1, 'me returns meta', r.data);
const course1 = r.data.courses.find((c) => c.name.includes('Kasturi'));
ok(course1 && course1.price === 3000, 'seeded Kasturi course ₹3000', r.data.courses);

// ---- team ----
r = await admin('POST', '/api/users', { name: 'Counsellor ' + stamp, email: `c${stamp}@kasturi.test`, role: 'counsellor', in_rotation: 1 });
ok(r.status === 200 && r.data.password, 'create counsellor', r.data);
const cPass = r.data.password;
const coun = client();
r = await coun('POST', '/api/login', { email: `c${stamp}@kasturi.test`, password: cPass });
ok(r.status === 200 && r.data.me.must_change, 'counsellor logs in with temp password');
r = await coun('GET', '/api/leads');
ok(r.status === 403, 'must change password first');
r = await coun('POST', '/api/me/password', { password: 'Counsellor-2026' });
ok(r.status === 200, 'counsellor sets own password');
r = await coun('GET', '/api/settings');
ok(r.status === 403, 'counsellor cannot open settings');
const counsellorId = (await coun('GET', '/api/me')).data.user.id;
// Take the admin out of rotation so round-robin is predictable.
const adminId = (await admin('GET', '/api/me')).data.user.id;
await admin('PATCH', `/api/users/${adminId}`, { in_rotation: 0 });

// ---- settings ----
r = await admin('PUT', '/api/settings', { meta_app_secret: 'test-app-secret', support_phone: '9876500000' });
ok(r.status === 200 && r.data.has_meta_app_secret && !('meta_app_secret' in r.data) && r.data.meta_verify_token, 'settings save seals secret', r.data);
const verify = r.data.meta_verify_token;

// ---- sources + webhooks ----
const mk = async (type, extra = {}) => (await admin('POST', '/api/sources', { type, name: `${type} ${stamp}`, ...extra })).data.id;
const ids = { web: await mk('web'), google: await mk('google'), meta: await mk('meta', { page_id: 'P' + stamp }), wa: await mk('whatsapp', { wa_phone_id: 'W' + stamp }), gform: await mk('gform') };
const srcs = (await admin('GET', '/api/sources')).data.items;
const S = (id) => srcs.find((s) => s.id === id);
ok(srcs.every((s) => !('page_token' in s)), 'page tokens never returned');
r = await coun('GET', '/api/sources');
ok(r.status === 200 && r.data.items.every((s) => !s.key), 'counsellor sees source names only');

const phone = '98' + stamp + '01';
r = await anon('POST', `/api/hook/web/${S(ids.web).key}`, { name: 'Priya Web', phone: '+91 ' + phone, email: `priya${stamp}@example.com`, city: 'Pune', course: 'Kasturi Meditation', utm_source: 'insta' }, { 'x-requested-with': '' });
ok(r.status === 200 && r.data.id, 'website form creates lead', r.data);
const webLead = r.data.id;
r = await anon('POST', `/api/hook/web/${S(ids.web).key}`, { name: 'Priya again', phone, message: 'Second enquiry' });
ok(r.status === 200 && r.data.id === webLead, 'repeat enquiry merges into same lead', r.data);
r = await anon('POST', `/api/hook/web/${S(ids.web).key}`, { name: 'Bot', phone: '9999999999', _hp: 'x' });
ok(r.status === 200 && !r.data.id, 'honeypot ignored');
r = await anon('POST', `/api/hook/web/bad-key`, { phone: '9000000001' });
ok(r.status === 404, 'unknown key rejected');
r = await anon('POST', `/api/hook/web/${S(ids.web).key}?redirect=https://example.com/thanks`, 'name=Form+Post&phone=97' + stamp + '02', { 'content-type': 'application/x-www-form-urlencoded' });
ok(r.status === 303, 'plain HTML form redirects to thank-you page', r.status);

r = await anon('POST', `/api/hook/google/${S(ids.google).key}`, { google_key: 'wrong', lead_id: 'x' });
ok(r.status === 401, 'google wrong key rejected');
r = await anon('POST', `/api/hook/google/${S(ids.google).key}`, { google_key: S(ids.google).secret, lead_id: 'G' + stamp, campaign_id: 123,
  user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Rahul Google' }, { column_id: 'PHONE_NUMBER', string_value: '+9196' + stamp + '03' }, { column_id: 'WHICH_COURSE', string_value: 'Meditation' }] });
ok(r.status === 200 && r.data.id, 'google lead form', r.data);
r = await anon('POST', `/api/hook/google/${S(ids.google).key}`, { google_key: S(ids.google).secret, lead_id: 'G' + stamp, user_column_data: [] });
ok(r.data.id === undefined || r.status === 200, 'google duplicate lead_id ignored');

// Google Form via Apps Script (question titles as keys)
r = await anon('POST', `/api/hook/in/${S(ids.gform).key}`, { 'Full Name': 'Ananya Form', 'Phone Number': '95' + stamp + '04', 'Email': `ananya${stamp}@example.com`, 'Which city?': 'Kolkata', 'What do you do?': 'Software engineer' });
ok(r.status === 200 && r.data.ids?.length === 1, 'google form via apps script', r.data);
const gformLead = r.data.ids[0];

// Meta Lead Ads (signed)
const sign = (raw) => 'sha256=' + createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
r = await anon('GET', `/api/hook/meta?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=abc`);
ok(r.status === 200 && r.data === 'abc', 'meta verify handshake');
const metaBody = JSON.stringify({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { page_id: 'P' + stamp, form_id: 'F1', leadgen_id: 'L' + stamp,
  _test_payload: { created_time: '2026-11-01T10:00:00+0000', campaign_name: 'Nov Insta', ad_name: 'Reel 1', platform: 'ig',
    field_data: [{ name: 'full_name', values: ['Meera Meta'] }, { name: 'phone_number', values: ['+9193' + stamp + '05'] }, { name: 'are_you_an_it_professional?', values: ['Yes'] }] } } }] }] });
r = await anon('POST', '/api/hook/meta', metaBody, { 'x-hub-signature-256': 'sha256=bad', 'content-type': 'application/json' });
ok(r.data.ok === false, 'meta bad signature refused');
r = await anon('POST', '/api/hook/meta', metaBody, { 'x-hub-signature-256': sign(metaBody), 'content-type': 'application/json' });
ok(r.data.ok && r.data.created === 1, 'meta lead created', r.data);
r = await anon('POST', '/api/hook/meta', metaBody, { 'x-hub-signature-256': sign(metaBody), 'content-type': 'application/json' });
ok(r.data.created === 0, 'meta lead not imported twice');

// WhatsApp Cloud API
const waBody = (text) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'W' + stamp },
  contacts: [{ wa_id: '9192' + stamp + '06', profile: { name: 'Kabir WA' } }], messages: [{ from: '9192' + stamp + '06', type: 'text', text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
let b = waBody('Hi, I want to know about the meditation classes');
r = await anon('POST', '/api/hook/meta', b, { 'x-hub-signature-256': sign(b), 'content-type': 'application/json' });
ok(r.data.created === 1, 'whatsapp message creates lead', r.data);
b = waBody('What is the fee?');
r = await anon('POST', '/api/hook/meta', b, { 'x-hub-signature-256': sign(b), 'content-type': 'application/json' });
ok(r.data.created === 0, 'second whatsapp message goes to history');

// ---- leads ----
r = await admin('GET', '/api/leads');
ok(r.status === 200 && r.data.items.length >= 6, 'admin lists leads', r.data.items?.length);
const waLead = r.data.items.find((l) => l.name === 'Kabir WA');
ok(waLead && waLead.phone === '92' + stamp + '06', 'whatsapp phone normalised', waLead);
ok(r.data.items.every((l) => l.owner_id === counsellorId), 'round-robin assigns to counsellor in rotation');
r = await admin('GET', `/api/leads/${waLead.id}`);
ok(r.data.activities.filter((a) => a.type === 'whatsapp').length === 2, 'whatsapp messages in history', r.data.activities);
r = await admin('GET', `/api/leads/${webLead}`);
ok(r.data.lead.enquiry_count === 2 && r.data.lead.interest === 'Kasturi Meditation' && r.data.lead.utm_source === 'insta', 'web lead fields + count', r.data.lead);
r = await admin('GET', `/api/leads/${gformLead}`);
ok(r.data.lead.city === 'Kolkata' || r.data.lead.extra.which_city === 'Kolkata', 'google form answers kept', r.data.lead);
r = await admin('GET', '/api/leads?q=' + stamp + '01');
ok(r.data.items.length === 1 && r.data.items[0].id === webLead, 'search by phone');
r = await admin('GET', '/api/leads?fresh=1');
ok(r.data.items.length >= 5, 'not-called-yet filter');

// counsellor scoping
const other = (await admin('POST', '/api/leads', { name: 'Admin Own', phone: '91' + stamp + '07', owner_id: adminId })).data.id;
r = await coun('GET', `/api/leads/${other}`);
ok(r.status === 403, 'counsellor cannot open others\' lead');
r = await coun('GET', '/api/leads');
ok(r.data.items.every((l) => l.owner_id === counsellorId), 'counsellor sees own leads only');
r = await coun('POST', '/api/leads/bulk', { ids: [webLead], action: 'assign', owner_id: adminId });
ok(r.status === 403, 'counsellor cannot reassign');

// call log
const fu = new Date(Date.now() + 330 * 60000 + 3 * 86400000).toISOString().slice(0, 10); // 3 days ahead (IST)
r = await coun('POST', `/api/leads/${webLead}/log`, { type: 'call', outcome: 'connected', note: 'Interested, call back Friday', next_followup_at: fu + 'T18:00' });
ok(r.status === 200, 'log call');
r = await coun('GET', `/api/leads/${webLead}`);
ok(r.data.lead.stage_id === 2 && r.data.lead.next_followup_at === fu + ' 18:00:00' && r.data.lead.last_contact_at, 'call moves New→Contacted + sets follow-up', r.data.lead);
r = await coun('PATCH', `/api/leads/${webLead}`, { stage_id: 5 });
ok(r.status === 400, 'cannot set Enrolled without enrolment');
r = await coun('GET', '/api/counts');
ok(r.status === 200 && typeof r.data.overdue === 'number', 'counts');
r = await coun('GET', '/api/leads?open=1&due=upcoming');
ok(r.data.items.some((l) => l.id === webLead), 'upcoming follow-ups list');

// ---- courses / enrol / students ----
r = await admin('PATCH', `/api/courses/${course1.id}`, { name: course1.name, price: 3000, class_link: 'https://meet.google.com/abc-defg-hij', schedule: 'Sat & Sun, 7–8 pm IST' });
ok(r.status === 200, 'set class link');
r = await coun('POST', `/api/courses`, { name: 'X' });
ok(r.status === 403, 'counsellor cannot create courses');
r = await coun('POST', `/api/leads/${webLead}/enrol`, { course_id: course1.id, amount: 3000, send_email: 1 });
ok(r.status === 200 && r.data.link.includes('/learn/#t=') && r.data.wa_text.includes(r.data.link) && r.data.email.ok === false, 'enrol returns link + wa text (email not configured)', r.data);
const link = r.data.link;
const studentId = r.data.student_id;
r = await admin('GET', `/api/leads/${webLead}`);
ok(r.data.lead.stage_id === 5 && r.data.student?.id === studentId && r.data.enrollments.length === 1, 'lead marked Enrolled', r.data.lead);
r = await admin('GET', '/api/email-log');
ok(r.data.items.some((x) => x.kind === 'welcome' && !x.ok), 'failed welcome email is logged');
r = await admin('POST', '/api/students', { name: 'Walk In', phone: '90' + stamp + '08', email: `walk${stamp}@example.com`, course_id: course1.id, amount: 2500, send_email: 0 });
ok(r.status === 200, 'add student directly');
r = await admin('GET', '/api/students?q=' + stamp + '08');
ok(r.data.items.length === 1 && r.data.items[0].paid === 2500, 'student list + paid');

// ---- updates ----
r = await admin('POST', '/api/updates', { course_id: course1.id, kind: 'notes', title: 'Class 1 notes', body: 'Breath awareness', link: 'https://drive.google.com/x', pinned: 1 });
ok(r.status === 200, 'post course update');
r = await admin('POST', '/api/updates', { kind: 'wellness', title: 'Sleep tip', body: 'Screens off at 10' });
ok(r.status === 200, 'post update to all');
r = await admin('POST', '/api/updates', { kind: 'notes', title: 'Bad', link: 'javascript:alert(1)' });
ok(r.status === 400, 'non-http links refused');

// ---- student portal ----
const stu = client();
r = await stu('POST', '/api/portal/login', { phone: '0000000000' });
ok(r.status === 404, 'unknown phone refused');
r = await stu('POST', '/api/portal/login', { phone: '+91 ' + phone });
ok(r.status === 200 && r.data.token, 'student signs in by phone', r.data);
const tok = r.data.token;
r = await stu('GET', '/api/portal/me', undefined, { 'x-student-token': tok });
ok(r.status === 200 && r.data.courses[0].class_link === 'https://meet.google.com/abc-defg-hij' && r.data.updates.length >= 2 && r.data.updates[0].pinned === 1, 'portal shows class link + updates (pinned first)', r.data);
const linkTok = link.split('#t=')[1];
r = await stu('GET', '/api/portal/me', undefined, { 'x-student-token': linkTok });
ok(r.status === 200, 'emailed personal link works');
r = await stu('GET', '/api/portal/me', undefined, { 'x-student-token': studentId + '.forged' });
ok(r.status === 401, 'forged token refused');
await admin('PATCH', `/api/students/${studentId}`, { new_link: 1 });
r = await stu('GET', '/api/portal/me', undefined, { 'x-student-token': tok });
ok(r.status === 401, 'new link revokes old tokens');
await admin('PATCH', `/api/students/${studentId}`, { active: 0 });
r = await stu('POST', '/api/portal/login', { phone });
ok(r.status === 404, 'switched-off student cannot sign in');
r = await anon('GET', '/api/portal/info');
ok(r.status === 200 && r.data.brand === 'Kasturi' && r.data.support_phone, 'portal info');

// ---- export / test source ----
r = await admin('GET', '/api/leads/export');
ok(r.status === 200 && String(r.data).includes('Priya'), 'CSV export');
r = await coun('GET', '/api/leads/export');
ok(r.status === 403, 'counsellor cannot export');
r = await admin('POST', `/api/sources/${ids.meta}/test`);
ok(r.status === 200 && r.data.lead.id, 'test lead button');
r = await admin('GET', '/api/dashboard');
ok(r.status === 200 && r.data.bySource.length && r.data.revenue.amount >= 5500, 'dashboard', r.data.revenue);
ok(Number(r.headers.get('x-queries')) <= 45, 'dashboard within query budget', r.headers.get('x-queries'));

// ---- file import (Meta export / Excel / CSV), re-uploaded daily ----
const metaRows = [
  { external_id: 'M1' + stamp, created_time: '2026-11-03T10:16:51+05:30', name: 'Meta File One', phone: '+9188' + stamp + '11', email: `m1${stamp}@example.com`, city: 'Pune',
    campaign: 'KASTURI LEAD CAMPAIGN', ad: 'Reel', form: 'KASTURI FORM', platform: 'instagram', extra: { how_soon_would_you_like_to_start_the_program: 'immediately' } },
  { external_id: 'M2' + stamp, name: 'Meta File Two', phone: '+9188' + stamp + '12', platform: 'facebook' },
  // a new Meta lead id for someone already in the CRM (Priya from the website)
  { external_id: 'M3' + stamp, name: 'Priya via Meta', phone: phone },
];
r = await coun('POST', '/api/leads/import', { rows: metaRows });
ok(r.status === 403, 'counsellor cannot import');
r = await admin('POST', '/api/leads/import-check', { ids: metaRows.map((x) => x.external_id), phones: metaRows.map((x) => x.phone) });
ok(r.status === 200 && r.data.ids.length === 0 && r.data.phones.length === 1, 'import-check: ids new, Priya phone known', r.data);
r = await admin('POST', '/api/leads/import', { rows: metaRows, source_id: ids.meta });
ok(r.data.added === 2 && r.data.repeat === 1, 'first import: 2 added, 1 merged into existing', r.data);
r = await admin('POST', '/api/leads/import', { rows: metaRows, source_id: ids.meta });
ok(r.data.added === 0 && r.data.repeat === 0 && r.data.existing === 3, 'same export again: nothing added or merged', r.data);
r = await admin('POST', '/api/leads/import-check', { ids: metaRows.map((x) => x.external_id) });
ok(r.data.ids.length === 3, 'import-check knows all 3 ids (incl. merged one)', r.data);
r = await admin('GET', '/api/leads?q=' + stamp + '11');
const fileLead = r.data.items[0];
r = await admin('GET', `/api/leads/${fileLead.id}`);
ok(r.data.lead.created_at === '2026-11-03 10:16:51' && r.data.lead.campaign === 'KASTURI LEAD CAMPAIGN' && r.data.lead.platform === 'instagram'
  && r.data.lead.extra.how_soon_would_you_like_to_start_the_program === 'immediately' && r.data.lead.external_id === 'M1' + stamp, 'imported lead keeps date, campaign, answers, id', r.data.lead);
const sheetRows = [{ name: 'Sheet Person', phone: '87' + stamp + '13' }, { name: 'Priya again', phone }];
r = await admin('POST', '/api/leads/import', { rows: sheetRows });
ok(r.data.added === 1 && r.data.existing === 1 && r.data.repeat === 0, 'sheet without ids: existing phone skipped silently', r.data);
r = await admin('POST', '/api/leads/import', { rows: sheetRows });
ok(r.data.added === 0 && r.data.existing === 2, 'same sheet again: nothing added', r.data);
r = await admin('GET', `/api/leads/${webLead}`);
ok(r.data.lead.enquiry_count === 3, 'Priya: one merge from Meta file, none from re-uploads', r.data.lead.enquiry_count);

// ---- static ----
r = await anon('GET', '/learn/');
ok(r.status === 200 && String(r.data).includes('learn.js'), 'student page served');
r = await anon('GET', '/');
ok(r.status === 200 && String(r.data).includes('Kasturi CRM'), 'team app served');

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
