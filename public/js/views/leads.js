// Leads inbox + lead drawer (call, WhatsApp, email, notes, follow-up, stage, enrol) and the Follow-ups page.
import {
  h, raw, ic, $, $$, on, setHTML, state, get, post, patch, qs, toast, errToast, modal, drawer, closeDrawer, input, textarea, select, check, field,
  pagedTable, table, badge, tabs, fdt, cap, phoneFmt, copyText, esc, options, inr,
} from '../core.js';
import { setTitle, isAdmin, stageOf, userName, sourceName, refreshCounts, reloadMeta } from '../main.js';

const OUTCOME_LABEL = { connected: 'Connected', no_answer: 'No answer', busy: 'Busy', switched_off: 'Switched off', wrong_number: 'Wrong number', call_back: 'Call back later' };
const ACT_ICON = { call: 'phone', whatsapp: 'chat', email: 'inbox', note: 'edit', stage: 'refresh', system: 'star' };

// ---------- helpers shared with students.js ----------
export const waNumber = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };
export const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}${text ? '?text=' + encodeURIComponent(text) : ''}`;
export const telLink = (phone) => `tel:${String(phone || '').length === 10 ? '+91' + phone : phone}`;
function fill(tpl, l) {
  const c = state.me.config;
  const vars = { name: (l.name || '').split(' ')[0] || '', user: state.me.user.name.split(' ')[0], brand: c.brand_name, interest: l.interest || 'our classes' };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}
function localDT(hoursAhead) {
  const d = new Date(Date.now() + 330 * 60000 + hoursAhead * 3600e3);
  return d.toISOString().slice(0, 16);
}
const stageBadge = (id) => badge(stageOf(id).name, stageOf(id).color);
const dueCell = (l) => {
  if (!l.next_followup_at) return h`<span class="muted">—</span>`;
  const late = l.next_followup_at < new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);
  return h`<span class="${late ? 'late' : ''}">${fdt(l.next_followup_at)}</span>`;
};

// ---------- Leads list ----------
export async function leads(view, params, query) {
  setTitle('Leads');
  const me = state.me;
  const f = { q: query.get('q') || '', stage: query.get('stage') || '', source: query.get('source') || '', owner: query.get('owner') || '', fresh: query.get('fresh') || '', open: query.get('open') || '' };
  const ownerOpts = [['', 'Everyone'], ['me', 'Assigned to me'], ['none', 'Unassigned'], ...me.users.filter((u) => u.active).map((u) => [u.id, u.name])];
  setHTML(view, h`
    <div class="filters">
      <input type="search" name="q" placeholder="Search name, phone, email, city…" value="${f.q}">
      <select name="stage">${raw(options([['', 'All stages'], ...me.stages.map((s) => [s.id, s.name])], f.stage))}</select>
      <select name="source">${raw(options([['', 'All sources'], ['0', 'Added manually'], ...me.sources.map((s) => [s.id, s.name])], f.source))}</select>
      ${isAdmin() || me.config.counsellor_all ? h`<select name="owner">${raw(options(ownerOpts, f.owner))}</select>` : ''}
      <label class="check"><input type="checkbox" name="fresh" ${f.fresh ? raw('checked') : ''}> <span>Not called yet</span></label>
      <div class="sp" style="flex:1"></div>
      ${isAdmin() ? h`<button class="btn ghost" data-import>${ic('upload')} Import (Meta / Excel / CSV)</button><button class="btn ghost" data-export>${ic('download')} Export</button>` : ''}
      <button class="btn primary" data-add>${ic('plus')} Add lead</button>
    </div>
    <div class="bulkbar" id="bulk" hidden></div>
    <div class="card"><div class="card-b flush" id="list"></div></div>`);
  const sel = new Set();
  const listQ = (cursor) => qs({ q: f.q, stage: f.stage, source: f.source, owner: f.owner, fresh: f.fresh ? 1 : '', cursor });
  const pt = await pagedTable($('#list', view), {
    cols: [
      { label: raw('<input type="checkbox" data-all>'), cls: 'chk', cell: (l) => raw(`<input type="checkbox" data-sel="${l.id}" ${sel.has(l.id) ? 'checked' : ''}>`) },
      { label: 'Name', cell: (l) => h`<div class="cell-main">${l.name || 'Unknown'}${l.enquiry_count > 1 ? h` <span class="flag">×${l.enquiry_count}</span>` : ''}</div><div class="cell-sub">${phoneFmt(l.phone)}${l.city ? ' · ' + l.city : ''}</div>` },
      { label: 'Interest', cell: (l) => h`<span class="cell-sub">${l.interest || ''}</span>` },
      { label: 'Source', cell: (l) => h`<div>${sourceName(l.source_id)}</div><div class="cell-sub">${l.campaign || ''}</div>` },
      { label: 'Stage', cell: (l) => stageBadge(l.stage_id) },
      { label: 'Owner', cell: (l) => userName(l.owner_id) },
      { label: 'Next follow-up', cell: dueCell },
      { label: 'Received', cell: (l) => h`<span class="nowrap">${fdt(l.created_at)}</span>` },
    ],
    loader: (c) => get('/leads' + listQ(c)),
    empty: 'No leads match. New leads from Facebook, Instagram, Google, WhatsApp and the website appear here automatically.',
    rowAttr: (l) => `class="click" data-open="${l.id}"`,
  });
  const reload = () => { history.replaceState(null, '', '#/leads' + listQ()); pt.reload(); };
  let tmr;
  on(view, 'input', 'input[name=q]', (e) => { clearTimeout(tmr); tmr = setTimeout(() => { f.q = e.target.value.trim(); reload(); }, 300); });
  on(view, 'change', '.filters select, .filters input[type=checkbox]', (e) => { f[e.target.name] = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '') : e.target.value; reload(); });
  on(view, 'click', '[data-open]', (e, tr) => { if (e.target.closest('input,a')) return; openLead(Number(tr.dataset.open), pt.reload); });
  on(view, 'click', '[data-add]', () => addLead(pt.reload));
  on(view, 'click', '[data-export]', () => { location.href = '/api/leads/export' + listQ(); });
  on(view, 'click', '[data-import]', () => importLeads(pt.reload));

  // Bulk actions
  const bulk = $('#bulk', view);
  const drawBulk = () => {
    bulk.hidden = !sel.size;
    if (!sel.size) return;
    setHTML(bulk, h`<b>${sel.size} selected</b>
      ${isAdmin() ? h`<select data-bassign>${raw(options([['', 'Assign to…'], ...me.users.filter((u) => u.active).map((u) => [u.id, u.name])], ''))}</select>` : ''}
      <select data-bstage>${raw(options([['', 'Move to stage…'], ...me.stages.filter((s) => s.kind !== 'won').map((s) => [s.id, s.name])], ''))}</select>
      ${isAdmin() ? h`<button class="btn sm danger" data-bdel>Delete</button>` : ''}<button class="btn sm ghost" data-bclear>Clear</button>`);
  };
  on(view, 'change', '[data-sel]', (e) => { const id = Number(e.target.dataset.sel); e.target.checked ? sel.add(id) : sel.delete(id); drawBulk(); });
  on(view, 'change', '[data-all]', (e) => { $$('[data-sel]', view).forEach((c) => { c.checked = e.target.checked; const id = Number(c.dataset.sel); c.checked ? sel.add(id) : sel.delete(id); }); drawBulk(); });
  on(bulk, 'click', '[data-bclear]', () => { sel.clear(); drawBulk(); pt.reload(); });
  const doBulk = async (body) => { try { await post('/leads/bulk', { ids: [...sel], ...body }); toast('Done'); sel.clear(); drawBulk(); pt.reload(); } catch (ex) { errToast(ex); } };
  on(bulk, 'change', '[data-bassign]', (e) => e.target.value && doBulk({ action: 'assign', owner_id: e.target.value }));
  on(bulk, 'change', '[data-bstage]', (e) => e.target.value && doBulk({ action: 'stage', stage_id: e.target.value }));
  on(bulk, 'click', '[data-bdel]', () => modal({ title: `Delete ${sel.size} leads?`, body: h`<p>This removes the leads and their history for good.</p>`, submit: 'Delete', danger: true, onSubmit: () => doBulk({ action: 'delete' }) }));

  if (query.get('add')) addLead(pt.reload);
  if (params.id) openLead(Number(params.id), pt.reload);
}

// ---------- Follow-ups ----------
export async function followups(view, params, query) {
  setTitle('Follow-ups');
  const tab = query.get('tab') || 'today';
  const c = await get('/counts');
  setHTML(view, h`${tabs([['overdue', 'Overdue', c.overdue], ['today', 'Today', c.today], ['upcoming', 'Upcoming'], ['fresh', 'New — not called yet', c.fresh]], tab)}
    <div class="card" style="margin-top:12px"><div class="card-b flush" id="list"></div></div>`);
  on(view, 'click', '[data-tab]', (e, b) => { location.hash = '#/followups?tab=' + b.dataset.tab; });
  const load = async () => {
    const r = await get('/leads' + (tab === 'fresh' ? '?fresh=1' : `?open=1&due=${tab}`));
    setHTML($('#list', view), table([
      { label: 'Name', cell: (l) => h`<div class="cell-main">${l.name || 'Unknown'}</div><div class="cell-sub">${phoneFmt(l.phone)}</div>` },
      { label: 'Interest', cell: (l) => l.interest || '' },
      { label: 'Stage', cell: (l) => stageBadge(l.stage_id) },
      { label: tab === 'fresh' ? 'Received' : 'Follow-up', cell: (l) => (tab === 'fresh' ? fdt(l.created_at) : dueCell(l)) },
      { label: 'Owner', cell: (l) => userName(l.owner_id) },
      { label: '', cls: 'num', cell: (l) => h`<span class="qa" style="justify-content:flex-end">
        ${l.phone ? h`<a class="btn sm" href="${telLink(l.phone)}" data-call="${l.id}">${ic('phone')} Call</a><a class="btn sm wa" target="_blank" rel="noopener" href="${waLink(l.phone, fill(tab === 'fresh' ? state.me.config.wa_first : state.me.config.wa_followup, l))}">${ic('chat')}</a>` : ''}</span>` },
    ], r.items, { empty: tab === 'overdue' ? 'Nothing overdue. Well done!' : 'Nothing here.', rowAttr: (l) => `class="click" data-open="${l.id}"` }));
  };
  on(view, 'click', '[data-open]', (e, tr) => { if (e.target.closest('a')) return; openLead(Number(tr.dataset.open), load); });
  on(view, 'click', '[data-call]', (e, a) => setTimeout(() => openLead(Number(a.dataset.call), load, 'call'), 400));
  await load();
}

// ---------- Add / import ----------
function addLead(done) {
  const me = state.me;
  modal({
    title: 'Add lead',
    body: h`<div class="fgrid">${input('name', 'Name')}${input('phone', 'Phone', '', 'tel')}${input('email', 'Email', '', 'email')}${input('city', 'City')}
      <div class="full">${input('interest', 'Interested in', '', 'text', 'placeholder="e.g. Kasturi Meditation Classes"')}</div>
      ${select('source_id', 'Source', me.sources.map((s) => [s.id, s.name]), '', 'Added manually')}
      ${isAdmin() ? select('owner_id', 'Assign to', me.users.filter((u) => u.active).map((u) => [u.id, u.name]), me.user.id) : ''}
      <div class="full">${textarea('message', 'Notes / message')}</div></div>`,
    submit: 'Add lead',
    onSubmit: async (d) => {
      const r = await post('/leads', d);
      toast(r.repeat ? 'This person was already a lead — added to their history' : 'Lead added');
      done && done();
      openLead(r.id, done);
    },
  });
}

// Import a Meta Leads Center download (ZIP / CSV), an Excel sheet or any CSV. The same full export can be uploaded
// every day: leads already in the CRM (same Meta lead id, or same phone/email for files without ids) are left out.
function importLeads(done) {
  const me = state.me;
  const metaSrc = me.sources.find((s) => s.type === 'meta');
  let parsed = null, fresh = [];
  const m = modal({
    title: 'Import leads',
    wide: true,
    body: h`<p class="muted">Upload the <b>Meta lead export</b> (the .zip or .csv from Meta Leads Center / Ads Manager → Download leads), an <b>Excel</b> (.xlsx) or any <b>CSV</b>.
      You can upload the full export every day — leads already in the CRM are skipped automatically, only new people are added.</p>
      ${field('File(s)', raw('<input type="file" name="file" accept=".zip,.csv,.tsv,.txt,.xlsx,.xls" multiple required data-file>'))}
      <div id="imp-sum" class="note" hidden></div>
      <div class="fgrid">
        ${select('source_id', 'Mark leads as coming from', [...me.sources.map((s) => [s.id, s.name]), ...(metaSrc ? [] : [['__meta', 'Meta Lead Ads (new source)']])], metaSrc ? metaSrc.id : '__meta', 'Added manually')}
        ${select('owner_id', 'Assign to', me.users.filter((u) => u.active).map((u) => [u.id, u.name]), '', 'Round-robin (automatic)')}
      </div>
      <div id="imp-prog" class="muted"></div>`,
    submit: 'Import new leads',
    onOpen: (form) => {
      form.file.addEventListener('change', async () => {
        const sum = $('#imp-sum', form);
        parsed = null; fresh = [];
        if (!form.file.files.length) { sum.hidden = true; return; }
        sum.hidden = false; sum.className = 'note'; sum.textContent = 'Reading file…';
        try {
          const { readLeadFiles } = await import('../importer.js');
          parsed = await readLeadFiles([...form.file.files]);
          const rows = parsed.rows;
          const known = await post('/leads/import-check', {
            ids: rows.map((r) => r.external_id).filter(Boolean),
            phones: rows.map((r) => r.phone).filter(Boolean), emails: rows.map((r) => r.email).filter(Boolean),
          });
          const ids = new Set(known.ids), phones = new Set(known.phones), emails = new Set(known.emails.map((e) => e.toLowerCase()));
          const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
          const knownPhone = new Set([...phones].map(last10));
          // With a Meta id: new unless that id is known. Without: new unless the phone or email is already a lead.
          fresh = rows.filter((r) => (r.external_id ? !ids.has(r.external_id)
            : !(r.phone && knownPhone.has(last10(r.phone))) && !(r.email && emails.has(r.email.toLowerCase()))));
          const already = rows.length - fresh.length;
          setHTML(sum, h`<b>${rows.length} lead${rows.length === 1 ? '' : 's'}</b> found in ${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'}
            · <b>${fresh.length} new</b> · ${already} already in the CRM (skipped)${parsed.skipped ? h` · ${parsed.skipped} rows without phone/email ignored` : ''}
            <div class="muted" style="margin-top:4px;font-size:12px">${parsed.files.map((f) => `${f.name} (${f.rows})`).join(' · ')}</div>`);
          sum.className = fresh.length ? 'note info' : 'note';
        } catch (ex) { sum.className = 'note warn'; sum.textContent = ex.message; parsed = null; }
      });
    },
    onSubmit: async (d, form) => {
      if (!parsed) throw new Error('Choose the file first and wait until it has been read');
      if (!fresh.length) { toast('Nothing new to import — all these leads are already in the CRM'); return; }
      let sourceId = d.source_id;
      if (sourceId === '__meta') {
        sourceId = (await post('/sources', { type: 'meta', name: 'Meta Lead Ads' })).id;
        await reloadMeta();
      }
      const tot = { added: 0, repeat: 0, existing: 0, skipped: 0 };
      const prog = $('#imp-prog', form);
      for (let i = 0; i < fresh.length; i += 5) {
        const r = await post('/leads/import', { rows: fresh.slice(i, i + 5), source_id: sourceId, owner_id: d.owner_id });
        for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
        prog.textContent = `Importing ${Math.min(i + 5, fresh.length)} of ${fresh.length}…`;
      }
      toast(`${tot.added} new lead${tot.added === 1 ? '' : 's'} added${tot.repeat ? ` · ${tot.repeat} matched an existing lead (added to its history)` : ''}${tot.existing ? ` · ${tot.existing} already there` : ''}`);
      done && done();
      refreshCounts();
    },
  });
  return m;
}

// ---------- Lead drawer ----------
export async function openLead(id, onChange, focus) {
  const d = drawer({ title: 'Lead', wide: true, onClose: () => { if (location.hash.startsWith('#/leads/')) history.replaceState(null, '', '#/leads'); } });
  if (location.hash.startsWith('#/leads')) history.replaceState(null, '', '#/leads/' + id);
  const changed = () => { onChange && onChange(); refreshCounts(); };
  const load = async () => {
    const r = await get('/leads/' + id);
    draw(r);
  };
  const draw = ({ lead: l, activities, student, enrollments }) => {
    // Fresh container on every redraw so click handlers are not attached twice.
    const fresh = d.body.cloneNode(false); d.body.replaceWith(fresh); d.body = fresh;
    const me = state.me;
    const c = me.config;
    d.title.textContent = l.name || 'Lead #' + l.id;
    const extra = Object.entries(l.extra || {}).filter(([k]) => k !== 'test');
    setHTML(d.body, h`
      <div class="lead-head"><div class="av">${(l.name || '?').trim()[0]?.toUpperCase() || '?'}</div>
        <div style="flex:1;min-width:0"><h2>${l.name || 'Unknown'}</h2>
          <div class="muted">${phoneFmt(l.phone) || 'No phone'}${l.email ? ' · ' + l.email : ''}${l.city ? ' · ' + l.city : ''}</div>
          <div class="chips">${stageBadge(l.stage_id)}${badge(sourceName(l.source_id))}${l.enquiry_count > 1 ? h`<span class="flag red">Enquired ${l.enquiry_count}×</span>` : ''}
            ${l.next_followup_at ? h`<span class="badge">Follow-up: ${fdt(l.next_followup_at)}</span>` : ''}</div></div>
        <button class="btn sm ghost" data-edit>${ic('edit')} Edit</button></div>
      <div class="qa" style="margin-bottom:16px">
        ${l.phone ? h`<a class="btn" href="${telLink(l.phone)}" data-calllink>${ic('phone')} Call</a>
          <a class="btn wa" target="_blank" rel="noopener" href="${waLink(l.phone, fill(l.last_contact_at ? c.wa_followup : c.wa_first, l))}" data-wa>${ic('chat')} WhatsApp</a>` : ''}
        ${l.email ? h`<a class="btn" href="mailto:${l.email}" data-mail>${ic('inbox')} Email</a>` : ''}
        ${student ? h`<button class="btn" data-student="${student.id}">${ic('star')} Student page</button>` : ''}
        <button class="btn primary" data-enrol>${ic('check')} ${student ? 'Enrol in another course' : 'Enrol'}</button>
      </div>
      <div class="card"><div class="card-b">
        <form data-log class="stack" novalidate>
          ${tabs([['call', 'Log call'], ['whatsapp', 'WhatsApp'], ['note', 'Note']], focus === 'note' ? 'note' : 'call', 'data-ltype')}
          <input type="hidden" name="type" value="${focus === 'note' ? 'note' : 'call'}">
          <div class="outcomes" data-outs ${focus === 'note' ? raw('hidden') : ''}>${me.outcomes.map((o) => h`<label><input type="radio" name="outcome" value="${o}"> ${OUTCOME_LABEL[o]}</label>`)}</div>
          <textarea name="note" rows="2" placeholder="What was discussed?"></textarea>
          <div class="fgrid">
            ${field('Next follow-up', raw(`<input type="datetime-local" name="next_followup_at" value="${esc(l.stage_id === 5 ? '' : localDT(c.followup_hours))}">`))}
            ${select('stage_id', 'Stage', me.stages.filter((s) => s.kind !== 'won').map((s) => [s.id, s.name]), l.stage_id === 5 ? '' : l.stage_id, l.stage_id === 5 ? 'Enrolled' : null)}
          </div>
          <div class="form-err"></div>
          <div class="row end"><button class="btn primary" type="submit">Save</button></div>
        </form>
      </div></div>
      ${student ? h`<div class="card"><div class="card-h"><h3>Student</h3><div class="sp"></div>${student.last_seen_at ? h`<small class="muted">Last opened page ${fdt(student.last_seen_at)}</small>` : h`<small class="muted">Hasn't opened their page yet</small>`}</div><div class="card-b">
        ${enrollments.map((e) => h`<div class="row"><b>${e.course}</b><span class="muted">${inr(e.amount)} · ${cap(e.status)} · ${fdt(e.created_at)}</span></div>`)}
        <p class="muted" style="margin-top:8px">${student.link_sent_at ? 'Link emailed ' + fdt(student.link_sent_at) : 'Link not emailed yet'}</p></div></div>` : ''}
      <div class="card"><div class="card-h"><h3>Details</h3></div><div class="card-b"><dl class="kv">
        <dt>Interested in</dt><dd>${l.interest || '—'}</dd>
        <dt>Message</dt><dd style="white-space:pre-wrap">${l.message || '—'}</dd>
        <dt>Owner</dt><dd>${userName(l.owner_id)}</dd>
        <dt>Received</dt><dd>${fdt(l.created_at)}</dd>
        ${l.campaign ? h`<dt>Campaign</dt><dd>${l.campaign}</dd>` : ''}${l.adset ? h`<dt>Ad set</dt><dd>${l.adset}</dd>` : ''}${l.ad ? h`<dt>Ad</dt><dd>${l.ad}</dd>` : ''}
        ${l.platform ? h`<dt>Platform</dt><dd>${cap(l.platform)}</dd>` : ''}${l.utm_source ? h`<dt>UTM</dt><dd>${[l.utm_source, l.utm_medium, l.utm_campaign].filter(Boolean).join(' / ')}</dd>` : ''}
        ${l.landing_page ? h`<dt>Page</dt><dd style="word-break:break-all">${l.landing_page}</dd>` : ''}
        ${extra.map(([k, v]) => h`<dt>${cap(k)}</dt><dd>${v}</dd>`)}
      </dl></div></div>
      <div class="card"><div class="card-h"><h3>History</h3></div><div class="card-b"><div class="timeline">
        ${activities.map((a) => h`<div class="tl ${a.type}"><div class="tl-i">${ic(ACT_ICON[a.type] || 'star')}</div><div class="tl-t">
          <div><b>${a.type === 'call' ? 'Call' + (a.outcome ? ' · ' + OUTCOME_LABEL[a.outcome] : '') : a.type === 'system' || a.type === 'stage' ? '' : cap(a.type)}</b>
            <span style="white-space:pre-wrap">${a.note || ''}</span></div>
          <small class="muted">${a.user_name || 'System'} · ${fdt(a.created_at)}</small></div></div>`)}
      </div></div></div>`);

    const form = $('[data-log]', d.body);
    on(form, 'click', '[data-ltype]', (e, b) => {
      e.preventDefault();
      $$('[data-ltype]', form).forEach((x) => x.classList.toggle('on', x === b));
      form.type.value = b.dataset.ltype;
      $('[data-outs]', form).hidden = b.dataset.ltype !== 'call';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-err', form);
      err.textContent = '';
      const body = { type: form.type.value, note: form.note.value, next_followup_at: form.next_followup_at.value || null };
      if (body.type === 'call') { body.outcome = form.outcome.value || null; if (!body.outcome) { err.textContent = 'Pick how the call went'; return; } }
      if (form.stage_id.value) body.stage_id = form.stage_id.value;
      try { await post(`/leads/${l.id}/log`, body); toast('Saved'); changed(); await load(); } catch (ex) { err.textContent = ex.message; }
    });
    // Opening WhatsApp / dialer: log it so the team sees who reached out.
    on(d.body, 'click', '[data-wa]', () => post(`/leads/${l.id}/log`, { type: 'whatsapp', note: 'Opened WhatsApp chat' }).then(() => { changed(); load(); }).catch(errToast));
    on(d.body, 'click', '[data-calllink]', () => { $('[data-ltype="call"]', d.body)?.click(); setTimeout(() => form.note.focus(), 300); });
    on(d.body, 'click', '[data-edit]', () => editLead(l, async () => { changed(); await load(); }));
    on(d.body, 'click', '[data-enrol]', () => enrolModal(l, async () => { changed(); await load(); }));
    on(d.body, 'click', '[data-student]', (e, b) => { closeDrawer(); location.hash = '#/students/' + b.dataset.student; });
    if (focus === 'call') setTimeout(() => form.note.focus(), 100);
  };
  try { await load(); } catch (ex) { setHTML(d.body, h`<div class="note err">${ex.message}</div>`); }
}

function editLead(l, done) {
  const me = state.me;
  modal({
    title: 'Edit lead',
    body: h`<div class="fgrid">${input('name', 'Name', l.name)}${input('phone', 'Phone', l.phone, 'tel')}${input('email', 'Email', l.email, 'email')}${input('city', 'City', l.city)}
      <div class="full">${input('interest', 'Interested in', l.interest)}</div>
      ${isAdmin() ? select('owner_id', 'Owner', me.users.filter((u) => u.active || u.id === l.owner_id).map((u) => [u.id, u.name]), l.owner_id, 'Unassigned') : ''}</div>`,
    onSubmit: async (d) => { await patch('/leads/' + l.id, d); toast('Saved'); done(); },
  });
}

export function enrolModal(l, done) {
  const courses = state.me.courses.filter((c) => c.active);
  if (!courses.length) { modal({ title: 'No courses yet', body: h`<p>Add a course first in <a href="#/classes">Classes & updates</a>.</p>`, cancel: 'Close' }); return; }
  modal({
    title: `Enrol ${l.name || 'lead'}`,
    body: h`<div class="fgrid">
      <div class="full">${select('course_id', 'Course', courses.map((c) => [c.id, `${c.name}${c.price ? ' · ₹' + c.price.toLocaleString('en-IN') : ''}`]), courses[0].id, null, 'data-course')}</div>
      ${input('amount', 'Amount paid (₹)', courses[0].price, 'number', 'min="0" step="1"')}${input('name', 'Student name', l.name)}
      ${input('phone', 'Phone (they sign in with this)', l.phone, 'tel', 'required')}${input('email', 'Email (link is sent here)', l.email, 'email')}
      <div class="full">${check('send_email', 'Email the student their class page link now', true)}</div></div>`,
    submit: 'Enrol',
    onOpen: (form) => {
      form.course_id.addEventListener('change', () => { const c = courses.find((x) => String(x.id) === form.course_id.value); if (c) form.amount.value = c.price; });
    },
    onSubmit: async (d) => {
      const r = await post(`/leads/${l.id}/enrol`, d);
      done && done();
      shareLink(r, d.phone || l.phone);
    },
  });
}

// After enrolment: show the personal link, email status and a one-tap WhatsApp share.
export function shareLink(r, phone) {
  modal({
    title: 'Enrolled 🎉',
    body: h`<p>${r.email?.ok ? h`The class page link was emailed. ` : h`<span class="late">Email not sent: ${r.email?.detail || ''}.</span> `}You can also share it on WhatsApp.</p>
      <div class="linkbox"><code>${r.link}</code><button type="button" class="btn sm ghost" data-copy>${ic('copy')} Copy</button></div>
      <div class="qa" style="margin-top:12px"><a class="btn wa" target="_blank" rel="noopener" href="${waLink(phone, r.wa_text)}">${ic('chat')} Send link on WhatsApp</a>
        <a class="btn ghost" href="#/students/${r.student_id}" data-close>Open student</a></div>`,
    cancel: 'Done',
    onOpen: (form) => on(form, 'click', '[data-copy]', () => copyText(r.link)),
  });
}
