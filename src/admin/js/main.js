import { session, login, logout, api, setExpiredHandler } from './api.js';
import { esc, icon, initials, toast, dialog, closeDrawer } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as users from './views/users.js';
import * as loans from './views/loans.js';
import * as importer from './views/import.js';
import * as audit from './views/audit.js';
import * as help from './views/help.js';

const $root = document.getElementById('root');

const PAGES = [
  { path: 'dashboard', label: 'Dashboard', icon: 'dashboard', view: dashboard },
  { path: 'users', label: 'Users', icon: 'users', view: users },
  { path: 'loans', label: 'Loans', icon: 'loans', view: loans },
  { path: 'import', label: 'Import loans', icon: 'upload', view: importer },
  { path: 'audit', label: 'Audit log', icon: 'audit', view: audit },
  { path: 'help', label: 'Help & guides', icon: 'help', view: help },
];

// ---------- login ----------

function renderLogin(message = '') {
  document.title = 'Sign in · Loan Recovery Admin';
  $root.innerHTML = `
    <div class="login">
      <section class="login-art">
        <div>
          <img src="../icons/icon-192.png" alt="">
          <h1>Loan Recovery<br>Admin Console</h1>
          <p>Manage field staff, loan portfolios and imports for every branch from one place.</p>
          <ul>
            <li>${icon('users')} Officers, supervisors and admins</li>
            <li>${icon('upload')} Excel, CSV and JSON loan imports with validation</li>
            <li>${icon('loans')} Portfolio ageing and branch performance</li>
            <li>${icon('shield')} Full audit trail of every change</li>
          </ul>
        </div>
        <small>Authorised personnel only. Activity is logged.</small>
      </section>
      <section class="login-form">
        <form class="login-card form" id="login-form" novalidate>
          <div>
            <h2>Sign in</h2>
            <p class="muted">Use your admin code and password.</p>
          </div>
          ${message ? `<div class="info-box">${esc(message)}</div>` : ''}
          <label class="field"><span>Admin code</span>
            <input class="input" name="code" required autocomplete="username" autocapitalize="characters" autofocus>
          </label>
          <label class="field"><span>Password</span>
            <div class="input-group">
              <input class="input" name="pin" type="password" required autocomplete="current-password">
              <button type="button" class="icon-btn" data-toggle-pw aria-label="Show password">${icon('eye')}</button>
            </div>
          </label>
          <div class="error-box" id="login-error" role="alert"></div>
          <button class="btn primary block" type="submit">Sign in</button>
          <p class="muted small">Sessions end after 12 hours or when you close the browser.</p>
        </form>
      </section>
    </div>`;
  const form = document.getElementById('login-form');
  form.querySelector('[data-toggle-pw]').onclick = () => {
    form.pin.type = form.pin.type === 'password' ? 'text' : 'password';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    err.textContent = '';
    if (!form.code.value.trim() || !form.pin.value) {
      err.textContent = 'Enter your code and password.';
      return;
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await login(form.code.value.trim(), form.pin.value);
      if (!location.hash || location.hash === '#/login') location.hash = '#/dashboard';
      route();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };
}

// ---------- shell ----------

let pendingDeposits = null;

function renderShell() {
  const user = session.get().user;
  $root.innerHTML = `
    <div class="shell" id="shell">
      <aside class="sidebar" id="sidebar" aria-label="Main navigation">
        <div class="brand">
          <img src="../icons/icon-192.png" alt="">
          <div><b>Loan Recovery</b><small>ADMIN CONSOLE</small></div>
        </div>
        <nav class="nav" id="nav">
          <div class="nav-label">Overview</div>
          ${navLink(PAGES[0])}
          <div class="nav-label">Manage</div>
          ${PAGES.slice(1, 4).map(navLink).join('')}
          <div class="nav-label">Compliance</div>
          ${navLink(PAGES[4])}
          <div class="nav-label">Support</div>
          ${navLink(PAGES[5])}
        </nav>
        <div class="sidebar-foot">Signed in as ${esc(user.code)}<br>Field app: <a href="../" target="_blank" rel="noopener">open</a></div>
      </aside>
      <div class="scrim" id="scrim" hidden></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menu-btn" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
          <div class="title" id="page-title"></div>
          <details class="usermenu" id="usermenu">
            <summary aria-label="Account menu">
              <span class="avatar">${esc(initials(user.name))}</span>
              <span class="who"><b>${esc(user.name)}</b><small>${esc(user.code)} · Administrator</small></span>
              ${icon('chevronDown')}
            </summary>
            <div class="menu" role="menu">
              <button type="button" data-menu="password" role="menuitem">${icon('lock')} Change password</button>
              <button type="button" data-menu="help" role="menuitem">${icon('help')} Help &amp; guides</button>
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
    if (action === 'help') location.hash = '#/help';
  };
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

function navLink(p) {
  const badge = p.path === 'dashboard' && pendingDeposits ? `<span class="count" title="Bank deposits awaiting supervisor verification">${pendingDeposits}</span>` : '';
  return `<a href="#/${p.path}" data-path="${p.path}">${icon(p.icon)}<span>${p.label}</span>${badge}</a>`;
}

async function changePassword() {
  await dialog({
    title: 'Change password',
    ok: 'Update password',
    body: `
      <div class="form">
        <label class="field"><span>Current password</span><input class="input" type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input class="input" type="password" name="next" required minlength="10" autocomplete="new-password">
          <span class="hint">At least 10 characters, with letters and numbers.</span></label>
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
  const page = PAGES.find((p) => p.path === pathPart.split('/')[0]);
  if (!page) {
    location.replace('#/dashboard');
    return;
  }
  document.querySelectorAll('#nav a').forEach((a) => {
    const on = a.dataset.path === page.path;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.getElementById('page-title').textContent = page.label;
  document.title = `${page.label} · Loan Recovery Admin`;
  const el = document.getElementById('view');
  const mySeq = ++seq;
  el.onclick = el.onchange = el.oninput = el.onsubmit = null;
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await page.view.render(el, new URLSearchParams(queryPart), () => mySeq === seq);
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

export function setPendingBadge(n) {
  pendingDeposits = n;
  const link = document.querySelector('#nav a[data-path=dashboard]');
  if (link) link.outerHTML = navLink(PAGES[0]);
  document.querySelector('#nav a[data-path=dashboard]')?.classList.toggle('active', location.hash.startsWith('#/dashboard'));
}

setExpiredHandler(() => renderLogin('Your session has expired. Please sign in again.'));
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('drawer').classList.contains('open')) closeDrawer();
});
document.getElementById('drawer-scrim').onclick = closeDrawer;
document.getElementById('drawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDrawer();
});
route();
