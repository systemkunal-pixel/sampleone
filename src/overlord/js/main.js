import { session, passwordStep, codeStep, logout, api, setExpiredHandler } from './api.js';
import { esc, icon, initials, toast, dialog, closeDrawer } from '../../admin/js/ui.js';
import * as overview from './views/overview.js';
import * as companies from './views/companies.js';
import * as support from './views/support.js';
import * as plans from './views/plans.js';
import * as overlords from './views/overlords.js';
import * as audit from './views/audit.js';
import * as guide from './views/guide.js';
import * as updates from './views/updates.js';
import * as leads from './views/leads.js';
import * as mail from './views/mail.js';

const $root = document.getElementById('root');

const PAGES = [
  { path: 'overview', label: 'Overview', icon: 'dashboard', view: overview },
  { path: 'companies', label: 'Companies', icon: 'building', view: companies },
  { path: 'leads', label: 'Demo requests', icon: 'phone', view: leads },
  { path: 'support', label: 'Support sessions', icon: 'headset', view: support },
  { path: 'plans', label: 'Plans & features', icon: 'layers', view: plans },
  { path: 'updates', label: 'Update & diagnostics', icon: 'refresh', view: updates },
  { path: 'mail', label: 'Email', icon: 'mail', view: mail },
  { path: 'overlords', label: 'Overlord accounts', icon: 'crown', view: overlords },
  { path: 'audit', label: 'Overlord audit log', icon: 'audit', view: audit },
  { path: 'guide', label: 'Guide', icon: 'book', view: guide },
];

// ---------- sign-in: password, then authenticator code ----------

function loginFrame(inner) {
  document.title = 'Sign in · LoanDesk Overlord';
  $root.innerHTML = `
    <div class="login">
      <section class="login-art">
        <div>
          <img src="../icons/icon-192.png" alt="">
          <h1>LoanDesk<br>Overlord</h1>
          <p>The platform console: every lending company on LoanDesk, their plans, and support access.</p>
          <ul>
            <li>${icon('building')} Create, lock and archive companies</li>
            <li>${icon('layers')} Plans and per-company features</li>
            <li>${icon('headset')} Time-boxed, logged support access</li>
            <li>${icon('shield')} Password + authenticator app, every time</li>
          </ul>
        </div>
        <small>Platform operators only. Every action is logged.</small>
      </section>
      <section class="login-form">${inner}</section>
    </div>`;
}

function renderLogin(message = '') {
  loginFrame(`
    <form class="login-card form" id="login-form" novalidate>
      <div><h2>Overlord sign-in</h2><p class="muted">Step 1 of 2 · email and password</p></div>
      ${message ? `<div class="info-box">${esc(message)}</div>` : ''}
      <label class="field"><span>Email</span>
        <input class="input" name="email" type="email" required autocomplete="username" autofocus>
      </label>
      <label class="field"><span>Password</span>
        <div class="input-group">
          <input class="input" name="password" type="password" required autocomplete="current-password">
          <button type="button" class="icon-btn" data-toggle-pw aria-label="Show password">${icon('eye')}</button>
        </div>
      </label>
      <div class="error-box" id="login-error" role="alert"></div>
      <button class="btn primary block" type="submit">Continue</button>
      <p class="muted small">Company admins sign in at <a href="../admin/">/admin/</a>.</p>
    </form>`);
  const form = document.getElementById('login-form');
  form.querySelector('[data-toggle-pw]').onclick = () => {
    form.password.type = form.password.type === 'password' ? 'text' : 'password';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    err.textContent = '';
    if (!form.email.value.trim() || !form.password.value) {
      err.textContent = 'Enter your email and password.';
      return;
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      renderCodeStep(await passwordStep(form.email.value.trim(), form.password.value));
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  };
}

function renderCodeStep(step) {
  const enrolling = step.stage === 'enroll';
  const qr = enrolling && step.qrSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(step.qrSvg)}` : '';
  loginFrame(`
    <form class="login-card form" id="code-form" novalidate style="width:min(${enrolling ? 520 : 380}px,100%)">
      <div><h2>${enrolling ? 'Set up your authenticator' : 'Enter your code'}</h2>
        <p class="muted">Step 2 of 2 · ${enrolling ? 'one-time setup on your phone' : 'from your authenticator app'}</p></div>
      ${enrolling ? `
        <div class="enroll">
          ${qr ? `<img src="${qr}" alt="QR code for the authenticator app">` : '<div class="info-box">QR code unavailable — use the setup key.</div>'}
          <div class="stack" style="gap:10px">
            <ol class="steps">
              <li>Install <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> or <b>Authy</b> on your phone.</li>
              <li>Tap <b>+</b> and scan this QR code.</li>
              <li>Can't scan? Choose <b>Enter a setup key</b> and type:</li>
            </ol>
            <div class="secret" id="secret">${esc(step.secret.match(/.{1,4}/g).join(' '))}</div>
            <p class="muted small" style="margin:0">Keep the phone safe: from now on every sign-in needs a code from it.</p>
          </div>
        </div>` : ''}
      <label class="field"><span>6-digit code</span>
        <input class="input code-input" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]*" autofocus>
      </label>
      <div class="error-box" id="code-error" role="alert"></div>
      <button class="btn primary block" type="submit">${enrolling ? 'Confirm and sign in' : 'Sign in'}</button>
      <button class="btn ghost block" type="button" id="restart">Start again</button>
    </form>`);
  const form = document.getElementById('code-form');
  document.getElementById('restart').onclick = () => renderLogin();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('code-error');
    err.textContent = '';
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await codeStep(step.ticket, form.code.value.replace(/\s/g, ''));
      if (!location.hash || location.hash === '#/login') location.hash = '#/overview';
      route();
    } catch (ex) {
      if (ex.status === 401) return renderLogin(ex.message);
      err.textContent = ex.message;
      btn.disabled = false;
      form.code.select();
    }
  };
}

// ---------- shell ----------

function renderShell() {
  const me = session.get().overlord;
  $root.innerHTML = `
    <div class="shell" id="shell">
      <aside class="sidebar" id="sidebar" aria-label="Main navigation">
        <div class="brand">
          <img src="../icons/icon-192.png" alt="">
          <div><b>LoanDesk</b><small>OVERLORD</small></div>
        </div>
        <nav class="nav" id="nav">
          <div class="nav-label">Platform</div>
          ${PAGES.slice(0, 3).map(navLink).join('')}
          <div class="nav-label">Control</div>
          ${PAGES.slice(3, 7).map(navLink).join('')}
          <div class="nav-label">Accountability</div>
          ${PAGES.slice(7, 9).map(navLink).join('')}
          <div class="nav-label">Help</div>
          ${navLink(PAGES[9])}
        </nav>
        <div class="sidebar-foot">Signed out after 60 minutes idle.<br>Admin console: <a href="../admin/" target="_blank" rel="noopener">open</a></div>
      </aside>
      <div class="scrim" id="scrim" hidden></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menu-btn" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
          <div class="title" id="page-title"></div>
          <details class="usermenu" id="usermenu">
            <summary aria-label="Account menu">
              <span class="avatar">${esc(initials(me.name))}</span>
              <span class="who"><b>${esc(me.name)}</b><small>${esc(me.email)}</small></span>
              ${icon('chevronDown')}
            </summary>
            <div class="menu" role="menu">
              <button type="button" data-menu="password" role="menuitem">${icon('lock')} Change password</button>
              <button type="button" data-menu="guide" role="menuitem">${icon('book')} Guide</button>
              <hr>
              <button type="button" data-menu="logout" role="menuitem">${icon('logout')} Sign out</button>
            </div>
          </details>
        </header>
        <main class="content" id="view" tabindex="-1"></main>
      </div>
    </div>`;

  const shell = document.getElementById('shell');
  const setNav = (open) => {
    shell.classList.toggle('nav-open', open);
    document.getElementById('scrim').hidden = !open;
    document.getElementById('menu-btn').setAttribute('aria-expanded', String(open));
  };
  document.getElementById('menu-btn').onclick = () => setNav(true);
  document.getElementById('scrim').onclick = () => setNav(false);
  document.getElementById('nav').onclick = (e) => e.target.closest('a') && setNav(false);

  const menu = document.getElementById('usermenu');
  menu.onclick = async (e) => {
    const action = e.target.closest('[data-menu]')?.dataset.menu;
    if (!action) return;
    menu.open = false;
    if (action === 'logout') {
      await logout();
      renderLogin('You have been signed out.');
    }
    if (action === 'password') changePassword();
    if (action === 'guide') location.hash = '#/guide';
  };
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

const navLink = (p) => `<a href="#/${p.path}" data-path="${p.path}">${icon(p.icon)}<span>${p.label}</span></a>`;

async function changePassword() {
  await dialog({
    title: 'Change password',
    ok: 'Update password',
    body: `
      <div class="form">
        <label class="field"><span>Current password</span><input class="input" type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input class="input" type="password" name="next" required minlength="12" autocomplete="new-password">
          <span class="hint">At least 12 characters, with letters and numbers. Your other sessions are signed out.</span></label>
        <label class="field"><span>Confirm new password</span><input class="input" type="password" name="confirm" required autocomplete="new-password"></label>
      </div>`,
    onOk: async (data) => {
      if (data.next !== data.confirm) throw new Error('The new passwords do not match.');
      await api('me/password', { method: 'POST', body: { current: data.current, next: data.next } });
      toast('Password updated');
    },
  });
}

// ---------- router ----------

let seq = 0;

export async function route() {
  closeDrawer();
  if (!session.get()) return renderLogin();
  if (!document.getElementById('shell')) renderShell();
  const [pathPart, queryPart = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [top, ...rest] = pathPart.split('/');
  const page = PAGES.find((p) => p.path === top);
  if (!page) {
    location.replace('#/overview');
    return;
  }
  document.querySelectorAll('#nav a').forEach((a) => {
    const on = a.dataset.path === page.path;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.getElementById('page-title').textContent = page.label;
  document.title = `${page.label} · LoanDesk Overlord`;
  const el = document.getElementById('view');
  const mySeq = ++seq;
  el.onclick = el.onchange = el.oninput = el.onsubmit = null;
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await page.view.render(el, new URLSearchParams(queryPart), rest, () => mySeq === seq);
  } catch (err) {
    if (mySeq !== seq || err.status === 401) return;
    el.innerHTML = `<div class="card"><div class="empty">${icon('alert')}<b>Couldn't load this page</b>${esc(err.message)}<div style="margin-top:14px"><button class="btn" id="retry">${icon('refresh')} Try again</button></div></div></div>`;
    document.getElementById('retry').onclick = () => route();
  }
}

/** Updates the hash query without adding a history entry per keystroke. */
export function setQuery(params, { replace = false } = {}) {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const next = `#/${path}${q ? `?${q}` : ''}`;
  if (next === location.hash) return route();
  if (replace) {
    history.replaceState(null, '', next);
    route();
  } else location.hash = next;
}

setExpiredHandler(() => renderLogin('Your session has ended. Please sign in again.'));
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('drawer').classList.contains('open')) closeDrawer();
});
document.getElementById('drawer-scrim').onclick = closeDrawer;
document.getElementById('drawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDrawer();
});
route();
