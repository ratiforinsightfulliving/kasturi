// Student page: sign in with the phone number used at enrolment (or the personal link from the email),
// then see the class link, schedule and every update (notes, recordings, wellness tips, announcements).
const app = document.getElementById('app');
const out = document.getElementById('out');
const KEY = 'kasturi_student';
const KIND = { class: 'Class', notes: 'Class notes', recording: 'Recording', wellness: 'Wellness tip', announcement: 'Announcement' };
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? e(u) : '#');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fdate = (s) => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-'); return `${+d} ${MON[+m - 1]} ${y}`; };
const linkify = (t) => e(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode: keep in memory only */ } mem = v; },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } mem = null; },
};
let mem = null;
const token = () => store.get() || mem;

async function api(path, opts = {}) {
  const r = await fetch('/api/portal' + path, {
    ...opts, headers: { 'content-type': 'application/json', 'x-requested-with': 'kx', ...(token() ? { 'x-student-token': token() } : {}), ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error || 'Something went wrong. Please try again.'); err.status = r.status; throw err; }
  return data;
}

async function signIn(msg) {
  out.hidden = true;
  let info = {};
  try { info = await api('/info'); } catch { /* show the form anyway */ }
  app.innerHTML = `<section class="card hero"><div class="eyebrow">Your space to pause</div><h1>Welcome to ${e(info.brand || 'Kasturi')}</h1>
      <p>${e(info.welcome || 'Your class link, class notes and wellness updates are all here.')}</p></section>
    <section class="card"><h2>Open my class page</h2><p class="muted">Enter the phone number you registered with.</p>
      <form class="signin" novalidate><label><span>Phone number</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98765 43210" required></label>
        <div class="err">${e(msg || '')}</div><button class="btn" type="submit">Continue</button></form>
      ${info.support_phone ? `<p class="help muted">Need help? <a href="https://wa.me/${e(String(info.support_phone).replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'))}" target="_blank" rel="noopener">WhatsApp us on ${e(info.support_phone)}</a></p>` : ''}</section>`;
  const f = app.querySelector('form');
  f.phone.focus();
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    f.querySelector('.err').textContent = '';
    try {
      const r = await api('/login', { method: 'POST', body: JSON.stringify({ phone: f.phone.value }) });
      store.set(r.token);
      await home();
    } catch (ex) { f.querySelector('.err').textContent = ex.message; btn.disabled = false; }
  });
}

let filter = 'all';
async function home() {
  let d;
  try { d = await api('/me'); } catch (ex) {
    if (ex.status === 401) { store.clear(); return signIn(ex.message === 'Please sign in' ? '' : ex.message); }
    app.innerHTML = `<div class="card"><p class="err">${e(ex.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  out.hidden = false;
  document.title = `My ${d.brand} — class page`;
  const first = (d.student.name || '').split(' ')[0];
  const kinds = [...new Set(d.updates.map((u) => u.kind))];
  const draw = () => {
    const ups = d.updates.filter((u) => filter === 'all' || u.kind === filter);
    app.innerHTML = `<section class="card hero"><div class="eyebrow">Namaste</div><h1>${e(first || 'Welcome')} 🙏</h1><p>${e(d.welcome)}</p></section>
      ${d.courses.length ? d.courses.map((c) => `<section class="card course">
        <div class="row"><h2 style="flex:1">${e(c.name)}</h2>${c.status === 'completed' ? '<span class="pill">Completed</span>' : '<span class="pill">Enrolled</span>'}</div>
        ${c.schedule ? `<div><b>When:</b> ${e(c.schedule)}</div>` : ''}${c.starts_on ? `<div class="muted">Starts ${fdate(c.starts_on)}</div>` : ''}
        ${c.class_link ? `<div class="row"><a class="btn" href="${safeUrl(c.class_link)}" target="_blank" rel="noopener">Join class</a><span class="muted" style="font-size:13px;word-break:break-all">${e(c.class_link)}</span></div>`
          : c.status === 'active' ? '<div class="muted">The class link will appear here before your first class.</div>' : ''}
        ${c.description ? `<p class="muted" style="margin:0;white-space:pre-wrap">${e(c.description)}</p>` : ''}</section>`).join('')
        : '<section class="card"><p class="muted">You are not enrolled in a course right now.</p></section>'}
      <section class="card"><h2>Updates</h2>
        ${kinds.length > 1 ? `<div class="tabs">${['all', ...kinds].map((k) => `<button data-k="${e(k)}" class="${k === filter ? 'on' : ''}">${k === 'all' ? 'All' : e(KIND[k] || k)}</button>`).join('')}</div>` : ''}
        ${ups.length ? ups.map((u) => `<article class="upd"><div class="when">${u.pinned ? '📌 ' : ''}<span class="pill">${e(KIND[u.kind] || u.kind)}</span> · ${fdate(u.created_at)}${u.course ? ' · ' + e(u.course) : ''}</div>
          <h3>${e(u.title)}</h3>${u.body ? `<p>${linkify(u.body)}</p>` : ''}${u.link ? `<p><a class="btn ghost" href="${safeUrl(u.link)}" target="_blank" rel="noopener">Open ${u.kind === 'recording' ? 'recording' : u.kind === 'notes' ? 'notes' : 'link'}</a></p>` : ''}</article>`).join('')
          : '<p class="muted">Class notes, recordings and wellness tips will appear here.</p>'}</section>
      ${d.support_phone ? `<p class="help muted" style="text-align:center">Questions? <a href="https://wa.me/${e(String(d.support_phone).replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'))}" target="_blank" rel="noopener">WhatsApp ${e(d.support_phone)}</a></p>` : ''}`;
    app.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.k; draw(); }));
  };
  draw();
}

out.addEventListener('click', () => { store.clear(); signIn(); });

// Personal link from the welcome email: /learn/#t=<token>
const m = /[#&]t=([\w.-]+)/.exec(location.hash);
if (m) { store.set(m[1]); history.replaceState(null, '', location.pathname); }
token() ? home() : signIn();
