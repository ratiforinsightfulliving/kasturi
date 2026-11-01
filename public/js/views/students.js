// Students (enrolled people + their personal class-page link) and Classes & updates (courses, class links,
// notes, recordings, wellness tips) — what students see on /learn/.
import {
  h, raw, ic, $, on, setHTML, state, get, post, patch, del, qs, toast, errToast, modal, drawer, closeDrawer, input, textarea, select, check,
  pagedTable, badge, fdt, fdate, cap, phoneFmt, copyText, inr, options, emptyState, confirmBox,
} from '../core.js';
import { setTitle, isAdmin, reloadMeta, refresh } from '../main.js';
import { waLink, shareLink } from './leads.js';

const KIND = { class: ['Class', '#205b36'], notes: ['Class notes', '#2563eb'], recording: ['Recording', '#7c3aed'], wellness: ['Wellness tip', '#b8925a'], announcement: ['Announcement', '#0891b2'] };

// ---------- Students ----------
export async function students(view, params, query) {
  setTitle('Students');
  const me = state.me;
  const f = { q: '', course: query.get('course') || '', inactive: '' };
  setHTML(view, h`<div class="filters">
      <input type="search" name="q" placeholder="Search name, phone, email…">
      <select name="course">${raw(options([['', 'All courses'], ...me.courses.map((c) => [c.id, c.name])], f.course))}</select>
      <label class="check"><input type="checkbox" name="inactive"> <span>Show switched-off</span></label>
      <div class="sp" style="flex:1"></div><button class="btn primary" data-add>${ic('plus')} Add student</button></div>
    <p class="muted" style="margin:0 0 10px">Students open <a href="/learn/" target="_blank" rel="noopener">${location.origin}/learn/</a> and type their phone number — or tap the personal link we email them.</p>
    <div class="card"><div class="card-b flush" id="list"></div></div>`);
  const pt = await pagedTable($('#list', view), {
    cols: [
      { label: 'Student', cell: (s) => h`<div class="cell-main">${s.name}${s.active ? '' : h` <span class="flag">off</span>`}</div><div class="cell-sub">${phoneFmt(s.phone)}${s.email ? ' · ' + s.email : ''}</div>` },
      { label: 'Courses', cell: (s) => s.courses || h`<span class="muted">—</span>` },
      { label: 'Paid', cls: 'num', cell: (s) => inr(s.paid) },
      { label: 'Link emailed', cell: (s) => (s.link_sent_at ? fdt(s.link_sent_at) : h`<span class="late">Not yet</span>`) },
      { label: 'Last opened page', cell: (s) => (s.last_seen_at ? fdt(s.last_seen_at) : h`<span class="muted">Never</span>`) },
      { label: 'Joined', cell: (s) => fdate(s.created_at) },
    ],
    loader: (c) => get('/students' + qs({ ...f, cursor: c })),
    empty: 'No students yet. Enrol a lead (Leads → open a lead → Enrol) or add a student here.',
    rowAttr: (s) => `class="click" data-open="${s.id}"`,
  });
  let tmr;
  on(view, 'input', 'input[name=q]', (e) => { clearTimeout(tmr); tmr = setTimeout(() => { f.q = e.target.value.trim(); pt.reload(); }, 300); });
  on(view, 'change', '.filters select, .filters input[type=checkbox]', (e) => { f[e.target.name] = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '') : e.target.value; pt.reload(); });
  on(view, 'click', '[data-open]', (e, tr) => openStudent(Number(tr.dataset.open), pt.reload));
  on(view, 'click', '[data-add]', () => addStudent(pt.reload));
  if (params.id) openStudent(Number(params.id), pt.reload);
}

function courseSelect(name = 'course_id') {
  const cs = state.me.courses.filter((c) => c.active);
  return select(name, 'Course', cs.map((c) => [c.id, `${c.name}${c.price ? ' · ₹' + c.price.toLocaleString('en-IN') : ''}`]), cs[0]?.id);
}
function priceSync(form) {
  form.course_id?.addEventListener('change', () => { const c = state.me.courses.find((x) => String(x.id) === form.course_id.value); if (c) form.amount.value = c.price; });
}

function addStudent(done) {
  if (!state.me.courses.some((c) => c.active)) { toast('Add a course first in Classes & updates', 'err'); return; }
  modal({
    title: 'Add student',
    body: h`<p class="muted">For people who joined without coming through the CRM (walk-ins, existing students).</p><div class="fgrid">
      ${input('name', 'Name', '', 'text', 'required')}${input('phone', 'Phone (they sign in with this)', '', 'tel', 'required')}${input('email', 'Email')}
      ${input('amount', 'Amount paid (₹)', state.me.courses.find((c) => c.active)?.price || 0, 'number', 'min="0"')}
      <div class="full">${courseSelect()}</div><div class="full">${check('send_email', 'Email them their class page link now', true)}</div></div>`,
    submit: 'Add student',
    onOpen: priceSync,
    onSubmit: async (d) => { const r = await post('/students', d); done(); shareLink(r, d.phone); },
  });
}

async function openStudent(id, onChange) {
  const d = drawer({ title: 'Student', wide: true, onClose: () => { if (location.hash.startsWith('#/students/')) history.replaceState(null, '', '#/students'); } });
  history.replaceState(null, '', '#/students/' + id);
  const load = async () => {
    const r = await get('/students/' + id);
    const s = r.student;
    d.title.textContent = s.name;
    // Fresh container on every redraw so click handlers are not attached twice.
    const fresh = d.body.cloneNode(false); d.body.replaceWith(fresh); d.body = fresh;
    setHTML(d.body, h`
      <div class="lead-head"><div class="av">${s.name.trim()[0]?.toUpperCase() || '?'}</div><div style="flex:1"><h2>${s.name}</h2>
        <div class="muted">${phoneFmt(s.phone)}${s.email ? ' · ' + s.email : ''}</div>
        <div class="chips">${s.active ? badge('Active', '#15803d') : badge('Switched off', '#93a097')}
          ${s.last_seen_at ? badge('Opened page ' + fdt(s.last_seen_at)) : badge('Has not opened page yet')}</div></div>
        <button class="btn sm ghost" data-edit>${ic('edit')} Edit</button></div>
      <div class="card"><div class="card-h"><h3>Personal class page link</h3></div><div class="card-b">
        <div class="linkbox"><code>${r.link}</code><button class="btn sm ghost" data-copy>${ic('copy')} Copy</button></div>
        <div class="qa" style="margin-top:12px">
          <a class="btn wa" target="_blank" rel="noopener" href="${waLink(s.phone, r.wa_text)}">${ic('chat')} Send on WhatsApp</a>
          <button class="btn" data-resend ${s.email ? '' : raw('disabled title="Add an email first"')}>${ic('inbox')} ${s.link_sent_at ? 'Email link again' : 'Email link'}</button>
          ${s.lead_id ? h`<a class="btn ghost" href="#/leads/${s.lead_id}">Lead history</a>` : ''}
        </div>
        <p class="muted" style="margin-top:8px">${s.link_sent_at ? 'Last emailed ' + fdt(s.link_sent_at) + '. ' : ''}They can also open ${location.origin}/learn/ and type ${phoneFmt(s.phone)}.</p>
      </div></div>
      <div class="card"><div class="card-h"><h3>Courses</h3><div class="sp"></div><button class="btn sm" data-enrol>${ic('plus')} Add course</button></div><div class="card-b flush">
        ${r.enrollments.length ? h`<div class="table-wrap"><table class="tbl"><thead><tr><th>Course</th><th class="num">Paid</th><th>Status</th><th>Since</th></tr></thead><tbody>
          ${r.enrollments.map((e) => h`<tr><td><div class="cell-main">${e.course}</div><div class="cell-sub">${e.schedule || ''}</div></td><td class="num">${inr(e.amount)}</td>
            <td><select data-enr="${e.id}">${raw(options([['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled']], e.status))}</select></td><td>${fdate(e.created_at)}</td></tr>`)}
        </tbody></table></div>` : emptyState('Not enrolled in any course')}
      </div></div>
      ${isAdmin() ? h`<div class="card"><div class="card-h"><h3>Access</h3></div><div class="card-b stack">
        <p class="muted">Switching a student off hides their class page. "New link" makes the old personal link stop working (e.g. if it was shared).</p>
        <div class="qa"><button class="btn ${s.active ? 'danger' : 'primary'}" data-active="${s.active ? 0 : 1}">${s.active ? 'Switch off' : 'Switch on'}</button>
          <button class="btn ghost" data-newlink>New link</button></div></div></div>` : ''}`);
    on(d.body, 'click', '[data-copy]', () => copyText(r.link));
    on(d.body, 'click', '[data-resend]', async (e, b) => { b.disabled = true; try { await post(`/students/${id}/resend`); toast('Link emailed'); await load(); onChange(); } catch (ex) { errToast(ex); b.disabled = false; } });
    on(d.body, 'change', '[data-enr]', async (e) => { try { await patch('/enrollments/' + e.target.dataset.enr, { status: e.target.value }); toast('Saved'); onChange(); } catch (ex) { errToast(ex); } });
    on(d.body, 'click', '[data-active]', async (e, b) => { await patch('/students/' + id, { active: Number(b.dataset.active) }); toast('Saved'); await load(); onChange(); });
    on(d.body, 'click', '[data-newlink]', async () => {
      if (!(await confirmBox('The old link will stop working. Send the new one to the student after this.', { ok: 'Make new link' }))) return;
      await patch('/students/' + id, { new_link: 1 }); toast('New link ready'); await load();
    });
    on(d.body, 'click', '[data-edit]', () => modal({
      title: 'Edit student',
      body: h`${input('name', 'Name', s.name)}${input('phone', 'Phone', s.phone, 'tel')}${input('email', 'Email', s.email, 'email')}`,
      onSubmit: async (v) => { await patch('/students/' + id, v); toast('Saved'); await load(); onChange(); },
    }));
    on(d.body, 'click', '[data-enrol]', () => modal({
      title: 'Add a course',
      body: h`${courseSelect()}${input('amount', 'Amount paid (₹)', state.me.courses.find((c) => c.active)?.price || 0, 'number', 'min="0"')}
        ${s.email ? check('send_email', 'Email them the link again', false) : ''}`,
      onOpen: priceSync,
      onSubmit: async (v) => { await post(`/students/${id}/enrol`, v); toast('Enrolled'); await load(); onChange(); },
    }));
  };
  try { await load(); } catch (ex) { setHTML(d.body, h`<div class="note err">${ex.message}</div>`); }
}

// ---------- Classes & updates ----------
export async function classes(view, params) {
  setTitle('Classes & updates');
  const cid = params.id ? Number(params.id) : null;
  const r = await get('/courses');
  const courses = r.items;
  const cur = courses.find((c) => c.id === cid);
  setHTML(view, h`<div class="grid g2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);align-items:start">
    <div class="card"><div class="card-h"><h3>Courses</h3><div class="sp"></div>${isAdmin() ? h`<button class="btn sm primary" data-newcourse>${ic('plus')} New course</button>` : ''}</div>
      <div class="card-b flush">${courses.length ? h`<div class="table-wrap"><table class="tbl"><tbody>
        <tr class="click ${!cid ? 'sel' : ''}" data-go=""><td><div class="cell-main">All students</div><div class="cell-sub">Updates shown to every student</div></td><td></td></tr>
        ${courses.map((c) => h`<tr class="click ${c.id === cid ? 'sel' : ''}" data-go="${c.id}"><td><div class="cell-main">${c.name}${c.active ? '' : h` <span class="flag">off</span>`}</div>
          <div class="cell-sub">${c.schedule || 'No schedule set'} · ${c.class_link ? 'Class link set' : h`<span class="late">No class link</span>`}</div></td>
          <td class="num"><b>${c.students}</b><div class="cell-sub">students</div></td></tr>`)}
      </tbody></table></div>` : emptyState('No courses yet')}</div></div>
    <div>
      ${cur ? h`<div class="card"><div class="card-h"><h3>${cur.name}</h3><div class="sp"></div>
          <a class="btn sm ghost" href="#/students?course=${cur.id}">${ic('users')} Students</a>${isAdmin() ? h`<button class="btn sm" data-editcourse>${ic('edit')} Edit</button>` : ''}</div>
        <div class="card-b"><dl class="kv"><dt>Class link</dt><dd>${cur.class_link ? h`<a href="${cur.class_link}" target="_blank" rel="noopener">${cur.class_link}</a>` : h`<span class="late">Not set — students won't see a Join button</span>`}</dd>
          <dt>Schedule</dt><dd>${cur.schedule || '—'}</dd><dt>Starts</dt><dd>${cur.starts_on ? fdate(cur.starts_on) : '—'}</dd><dt>Fee</dt><dd>${inr(cur.price)}</dd>
          <dt>About</dt><dd style="white-space:pre-wrap">${cur.description || '—'}</dd></dl></div></div>` : ''}
      <div class="card"><div class="card-h"><h3>Updates ${cur ? 'for ' + cur.name : 'for all students'}</h3><div class="sp"></div>
        <button class="btn sm primary" data-post>${ic('plus')} Post update</button></div>
        <div class="card-b" id="ups"><div class="loading">Loading…</div></div></div>
    </div></div>`);

  on(view, 'click', '[data-go]', (e, tr) => { location.hash = '#/classes' + (tr.dataset.go ? '/' + tr.dataset.go : ''); });
  on(view, 'click', '[data-newcourse]', () => courseForm(null));
  on(view, 'click', '[data-editcourse]', () => courseForm(cur));
  on(view, 'click', '[data-post]', () => updateForm(null));

  async function courseForm(c) {
    modal({
      title: c ? 'Edit course' : 'New course', wide: true,
      body: h`<div class="fgrid"><div class="full">${input('name', 'Course name', c?.name, 'text', 'required')}</div>
        <div class="full">${input('class_link', 'Class link (Google Meet / Zoom)', c?.class_link, 'url', 'placeholder="https://meet.google.com/…"')}</div>
        <div class="full">${input('schedule', 'Schedule', c?.schedule, 'text', 'placeholder="e.g. Every Sat & Sun, 7:00–8:00 pm IST"')}</div>
        ${input('starts_on', 'Starts on', c?.starts_on, 'date')}${input('price', 'Fee (₹)', c?.price ?? 3000, 'number', 'min="0"')}
        <div class="full">${textarea('description', 'About this course (students see this)', c?.description, 'rows="4"')}</div>
        ${c ? h`<div class="full">${check('active', 'Open for enrolment', c.active)}</div>` : ''}</div>`,
      onSubmit: async (d) => {
        if (c) await patch('/courses/' + c.id, d); else await post('/courses', d);
        await reloadMeta(); toast('Saved'); refresh();
      },
    });
  }

  function updateForm(u) {
    const me = state.me;
    modal({
      title: u ? 'Edit update' : 'Post an update', wide: true,
      body: h`<div class="fgrid">
        ${select('kind', 'Type', me.update_kinds.map((k) => [k, KIND[k][0]]), u?.kind || 'notes')}
        ${select('course_id', 'Who sees it', [['', 'All students'], ...courses.map((c) => [c.id, c.name])], u ? u.course_id || '' : cid || '')}
        <div class="full">${input('title', 'Title', u?.title, 'text', 'required placeholder="e.g. Class 3 notes — breath awareness"')}</div>
        <div class="full">${textarea('body', 'Message', u?.body, 'rows="6" placeholder="Notes, practice for the week, wellness tip…"')}</div>
        <div class="full">${input('link', 'Link (optional) — Google Drive notes, YouTube recording, PDF…', u?.link, 'url', 'placeholder="https://…"')}</div>
        <div class="full">${check('pinned', 'Pin to the top', u?.pinned)}</div>
        ${u ? '' : h`<div class="full">${check('email_students', 'Also email it to these students (uses EmailJS quota; max 35 per post)', false)}</div>`}</div>`,
      submit: u ? 'Save' : 'Post',
      onSubmit: async (d) => {
        if (u) { await patch('/updates/' + u.id, d); toast('Saved'); }
        else {
          const res = await post('/updates', d);
          toast(d.email_students ? `Posted · ${res.emailed} emailed${res.failed ? ', ' + res.failed + ' failed' : ''}${res.capped ? ' (limit reached)' : ''}` : 'Posted — students can see it now');
        }
        loadUpdates();
      },
    });
  }

  async function loadUpdates() {
    const box = $('#ups', view);
    const res = await get('/updates' + qs({ course: cid || '0' }));
    if (!res.items.length) { setHTML(box, emptyState('Nothing posted yet. Post class notes, recordings, wellness tips or announcements — students see them on their page.')); return; }
    setHTML(box, h`${res.items.map((u) => h`<div class="upd"><div class="meta">${badge(KIND[u.kind]?.[0] || u.kind, KIND[u.kind]?.[1])}${u.pinned ? badge('Pinned', '#b45309') : ''}
        <span>${fdt(u.created_at)} · ${u.by_name || ''}</span><span class="sp" style="flex:1"></span>
        <button class="btn xs ghost" data-uedit="${u.id}">Edit</button><button class="btn xs ghost" data-udel="${u.id}">Delete</button></div>
      <b>${u.title}</b>${u.body ? h`<p>${u.body}</p>` : ''}${u.link ? h`<p><a href="${u.link}" target="_blank" rel="noopener">${u.link}</a></p>` : ''}</div>`)}`);
    box.onclick = async (e) => {
      const ed = e.target.closest('[data-uedit]'), dl = e.target.closest('[data-udel]');
      if (ed) updateForm(res.items.find((x) => x.id === Number(ed.dataset.uedit)));
      if (dl && (await confirmBox('Students will no longer see this update.', { ok: 'Delete' }))) { await del('/updates/' + dl.dataset.udel); toast('Deleted'); loadUpdates(); }
    };
  }
  await loadUpdates();
}

