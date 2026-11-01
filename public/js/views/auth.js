// Sign-in, first-run setup (first account becomes admin) and the forced password change for new users.
import { h, $, setHTML, post, input, formData, state } from '../core.js';
import { reloadMeta, render } from '../main.js';

function frame(app, title, sub, formHtml, onSubmit) {
  setHTML(app, h`<div class="auth">
    <div class="auth-side"><img class="kx-logo" src="/img/logo.png" alt="Kasturi" style="height:52px;filter:brightness(0) invert(1)">
      <div><h2>Your space to pause — and our space to look after every enquiry.</h2>
      <p>Leads from Facebook, Instagram, Google, WhatsApp and the website in one place. Call, follow up, enrol, and share class links with students.</p></div>
      <small style="color:#cfe3d4">Kasturi by RATI for Insightful Living</small></div>
    <div class="auth-main"><div class="auth-card"><h1>${title}</h1><p class="muted">${sub}</p>
      <form novalidate>${formHtml}<div class="form-err"></div><button class="btn primary" type="submit">${title}</button></form></div></div>
  </div>`);
  const form = $('form', app);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-err', form);
    const btn = $('button[type=submit]', form);
    err.textContent = ''; btn.disabled = true;
    try { await onSubmit(formData(form)); } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  });
  setTimeout(() => $('input', form)?.focus(), 30);
}

export function login(app) {
  frame(app, 'Sign in', 'Welcome back. Use the email your admin set up for you.',
    h`${input('email', 'Email', '', 'email', 'autocomplete="username" required')}${input('password', 'Password', '', 'password', 'autocomplete="current-password" required')}`,
    async (d) => { await post('/login', d); await reloadMeta(); location.hash = '#/home'; });
}

export function setup(app) {
  frame(app, 'Create admin account', 'First-time setup. This account will manage the team, lead sources and settings.',
    h`${input('name', 'Your name', '', 'text', 'required')}${input('email', 'Email', '', 'email', 'autocomplete="username" required')}
      ${input('password', 'Password (min 8 characters)', '', 'password', 'autocomplete="new-password" minlength="8" required')}`,
    async (d) => { await post('/setup', d); await reloadMeta(); location.hash = '#/settings'; });
}

export function mustChange(app) {
  frame(app, 'Choose your password', `Hi ${state.me.user.name}, please set your own password to continue.`,
    h`${input('password', 'New password (min 8 characters)', '', 'password', 'autocomplete="new-password" minlength="8" required')}`,
    async (d) => { await post('/me/password', d); await reloadMeta(); render(); });
}
