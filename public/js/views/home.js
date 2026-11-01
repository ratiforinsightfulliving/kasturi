// Home: today's work (new / due / overdue), pipeline, sources, team and enrolments.
import { h, setHTML, get, stat, num, inr, fdt, badge, table, rangePicker, bindRange, todayStr, addDays, $, state } from '../core.js';
import { setTitle, isAdmin, stageOf, sourceName } from '../main.js';

export async function home(view) {
  setTitle(`Namaste, ${state.me.user.name.split(' ')[0]}`);
  let from = addDays(todayStr(), -29), to = todayStr();
  setHTML(view, h`<div class="page-h"><h2>Overview</h2><div class="sp"></div><div id="rng">${rangePicker(from, to)}</div></div><div id="dash"><div class="loading">Loading…</div></div>`);
  bindRange($('#rng', view), (r) => { from = r.from; to = r.to; load(); });
  async function load() {
    const d = await get(`/dashboard?from=${from}&to=${to}`);
    const w = d.work, t = d.totals || {};
    const maxSrc = Math.max(1, ...d.bySource.map((s) => s.n));
    const maxStage = Math.max(1, ...d.byStage.map((s) => s.n));
    setHTML($('#dash', view), h`
      <div class="stats g4 grid" style="margin-bottom:16px">
        <a href="#/leads?fresh=1" style="color:inherit">${stat('New — not called yet', num(w.fresh), 'Call these first', w.fresh ? 'red' : '')}</a>
        <a href="#/followups" style="color:inherit">${stat('Follow-ups today', num(w.today), w.overdue ? `${w.overdue} overdue` : 'All on time', w.overdue ? 'red' : '')}</a>
        ${stat('Leads in period', num(t.leads), `${num(t.today)} today`)}
        ${isAdmin() && d.revenue ? stat('Enrolments in period', num(d.revenue.n), inr(d.revenue.amount)) : stat('Enrolled in period', num(t.enrolled), t.leads ? Math.round((t.enrolled / t.leads) * 100) + '% of leads' : '')}
      </div>
      <div class="grid g2">
        <div class="card"><div class="card-h"><h3>Leads by source</h3></div><div class="card-b">
          ${d.bySource.length ? h`<div class="hbars">${d.bySource.map((s) => h`<div class="hbar"><div class="hbar-l">${s.name}</div>
            <div class="hbar-t"><i style="width:${(s.n / maxSrc) * 100}%"></i></div><b>${s.n}${s.won ? h` <small class="muted">· ${s.won} enrolled</small>` : ''}</b></div>`)}</div>`
            : h`<p class="muted">No leads in this period yet. Connect a lead source in Settings → Lead sources.</p>`}
        </div></div>
        <div class="card"><div class="card-h"><h3>Pipeline (all time)</h3></div><div class="card-b"><div class="hbars">
          ${d.byStage.map((s) => h`<a class="hbar" href="#/leads?stage=${s.id}" style="color:inherit"><div class="hbar-l">${s.name}</div>
            <div class="hbar-t"><i style="width:${(s.n / maxStage) * 100}%;background:${s.color}"></i></div><b>${s.n}</b></a>`)}
        </div></div></div>
      </div>
      ${isAdmin() && d.byOwner.length ? h`<div class="card" style="margin-top:16px"><div class="card-h"><h3>Team (leads received in period)</h3></div><div class="card-b flush">
        ${table([{ label: 'Name', cell: (r) => r.name }, { label: 'Leads', cls: 'num', cell: (r) => r.leads }, { label: 'Not called yet', cls: 'num', cell: (r) => r.untouched || 0 },
          { label: 'Enrolled', cls: 'num', cell: (r) => r.won || 0 }, { label: 'Conversion', cls: 'num', cell: (r) => (r.leads ? Math.round(((r.won || 0) / r.leads) * 100) + '%' : '—') }], d.byOwner)}
      </div></div>` : ''}
      <div class="card" style="margin-top:16px"><div class="card-h"><h3>Latest leads</h3><div class="sp"></div><a href="#/leads">All leads →</a></div><div class="card-b flush">
        ${table([{ label: 'Name', cell: (r) => h`<a href="#/leads/${r.id}">${r.name || r.phone || 'Unknown'}</a>` }, { label: 'Interest', cell: (r) => r.interest || '' },
          { label: 'Source', cell: (r) => sourceName(r.source_id) }, { label: 'Stage', cell: (r) => badge(stageOf(r.stage_id).name, stageOf(r.stage_id).color) },
          { label: 'Received', cell: (r) => fdt(r.created_at) }], d.recent, { empty: 'No leads yet' })}
      </div></div>`);
  }
  await load();
}
