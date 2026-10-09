import { session, login, logout, api, me, adoptSupportToken, setExpiredHandler } from './api.js';
import { esc, icon, initials, toast, dialog, closeDrawer } from './ui.js';
import { t, tr, loadLang, getLang, langSelect, bindLangSelect } from '../../i18n/i18n.js';
import { loadHelpLang } from '../../help/content.js';
import * as dashboard from './views/dashboard.js';
import * as users from './views/users.js';
import * as loans from './views/loans.js';
import * as importer from './views/import.js';
import * as audit from './views/audit.js';
import * as help from './views/help.js';

const $root = document.getElementById('root');

// Labels stay English here and are translated where shown: t(p.label).
/* i18n: t('Dashboard') t('Users') t('Loans') t('Import loans') t('Audit log') t('Help & guides') */
const PAGES = [
  { path: 'dashboard', label: 'Dashboard', icon: 'dashboard', view: dashboard },
  { path: 'users', label: 'Users', icon: 'users', view: users },
  { path: 'loans', label: 'Loans', icon: 'loans', view: loans },
  { path: 'import', label: 'Import loans', icon: 'upload', view: importer, needs: 'loan_import' },
  { path: 'audit', label: 'Audit log', icon: 'audit', view: audit, needs: 'audit_log' },
  { path: 'help', label: 'Help & guides', icon: 'help', view: help },
];

const COMPANY_KEY = 'loandesk:company';
const rememberedCompany = () => {
  try {
    return localStorage.getItem(COMPANY_KEY) || '';
  } catch {
    return '';
  }
};

// Plan features and company for the signed-in admin, from /api/me. Elements with data-needs="feature"
// are hidden by CSS when the company's plan doesn't include it.
let context = null;
export const features = () => context?.features || {};

async function loadContext() {
  context = await me();
  const off = Object.entries(context.features).filter(([, on]) => !on).map(([k]) => k);
  document.body.dataset.off = off.join(' ');
}

// ---------- login ----------

let loginMessage = ''; // kept so a language switch can re-render the sign-in screen as it was

function renderLogin(message = '') {
  loginMessage = message;
  document.title = t('Sign in · LoanDesk Admin');
  $root.innerHTML = `
    <div class="login">
      <section class="login-art">
        <div>
          <img src="../icons/icon-192.png" alt="">
          <h1>LoanDesk<br>${t('Admin Console')}</h1>
          <p>${t('Manage field staff, loan portfolios and imports for every branch from one place.')}</p>
          <ul>
            <li>${icon('users')} ${t('Officers, supervisors and admins')}</li>
            <li>${icon('upload')} ${t('Excel, CSV and JSON loan imports with validation')}</li>
            <li>${icon('loans')} ${t('Portfolio ageing and branch performance')}</li>
            <li>${icon('shield')} ${t('Full audit trail of every change')}</li>
          </ul>
        </div>
        <small>${t('Authorised personnel only. Activity is logged.')}</small>
      </section>
      <section class="login-form">
        <form class="login-card form" id="login-form" novalidate>
          <div class="login-card-head">
            <div>
              <h2>${t('Sign in')}</h2>
              <p class="muted">${t('Use your admin code and password.')}</p>
            </div>
            ${langSelect('login-lang', esc(t('Language')))}
          </div>
          ${message ? `<div class="info-box">${esc(message)}</div>` : ''}
          <label class="field"><span>${t('Company code')}</span>
            <input class="input" name="company" autocomplete="organization" autocapitalize="characters" maxlength="12" value="${esc(rememberedCompany())}" ${rememberedCompany() ? '' : 'autofocus'}>
            <span class="hint">${t('Given to you by LoanDesk, e.g. BRMC.')}</span>
          </label>
          <label class="field"><span>${t('Admin code')}</span>
            <input class="input" name="code" required autocomplete="username" autocapitalize="characters" ${rememberedCompany() ? 'autofocus' : ''}>
          </label>
          <label class="field"><span>${t('Password')}</span>
            <div class="input-group">
              <input class="input" name="pin" type="password" required autocomplete="current-password">
              <button type="button" class="icon-btn" data-toggle-pw aria-label="${esc(t('Show password'))}">${icon('eye')}</button>
            </div>
          </label>
          <div class="error-box" id="login-error" role="alert"></div>
          <button class="btn primary block" type="submit">${t('Sign in')}</button>
          <p class="muted small">${t('Sessions end after 12 hours or when you close the browser.')}</p>
        </form>
      </section>
    </div>`;
  const form = document.getElementById('login-form');
  bindLangSelect(form);
  form.querySelector('[data-toggle-pw]').onclick = () => {
    form.pin.type = form.pin.type === 'password' ? 'text' : 'password';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    err.textContent = '';
    if (!form.code.value.trim() || !form.pin.value) {
      err.textContent = t('Enter your code and password.');
      return;
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = t('Signing in…');
    try {
      const company = form.company.value.trim().toUpperCase();
      await login(company, form.code.value.trim(), form.pin.value);
      try {
        localStorage.setItem(COMPANY_KEY, company);
      } catch {}
      if (!location.hash || location.hash === '#/login') location.hash = '#/dashboard';
      route();
    } catch (ex) {
      err.textContent = tr(ex.message);
      btn.disabled = false;
      btn.textContent = t('Sign in');
    }
  };
}

// ---------- shell ----------

let pendingDeposits = null;

function supportBanner(user) {
  if (!user.support) return '';
  return `<div class="support-banner" role="status">
    ${icon('headset')}<span><b>${t('Support session')}</b> · ${t('inside {company} as LoanDesk support ({name}) · everything you do is logged · ends in {time}', {
      company: esc(user.company.name), name: esc(user.support.overlordName), time: '<b id="support-left">–</b>',
    })}</span>
    <button class="btn sm" id="support-exit">${t('Exit')}</button></div>`;
}

let supportTimer = null;
function startSupportClock(user) {
  clearInterval(supportTimer);
  if (!user.support) return;
  const end = Date.now() + user.support.secondsLeft * 1000;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    const el = document.getElementById('support-left');
    if (el) el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    if (!left) {
      clearInterval(supportTimer);
      session.clear();
      renderLogin(t('The support session has ended (45 minutes).'));
    }
  };
  tick();
  supportTimer = setInterval(tick, 1000);
  document.getElementById('support-exit').onclick = async () => {
    clearInterval(supportTimer);
    await logout();
    renderLogin(t('Support session ended. You can close this tab.'));
  };
}

function renderShell() {
  const user = session.get().user;
  $root.innerHTML = `
    ${supportBanner(user)}
    <div class="shell ${user.support ? 'with-banner' : ''}" id="shell">
      <aside class="sidebar" id="sidebar" aria-label="${esc(t('Main navigation'))}">
        <div class="brand">
          <img src="../icons/icon-192.png" alt="">
          <div><b>LoanDesk</b><small>${t('ADMIN CONSOLE')}</small></div>
        </div>
        <nav class="nav" id="nav">
          <div class="nav-label">${t('Overview')}</div>
          ${navLink(PAGES[0])}
          <div class="nav-label">${t('Manage')}</div>
          ${PAGES.slice(1, 4).map(navLink).join('')}
          <div class="nav-label">${t('Compliance')}</div>
          ${navLink(PAGES[4])}
          <div class="nav-label">${t('Support')}</div>
          ${navLink(PAGES[5])}
        </nav>
        <div class="sidebar-foot"><b>${esc(user.company.name)}</b><br>${t('Company code {company} · signed in as {user}', { company: esc(user.company.code), user: esc(user.code) })}<br>${t('Field app: {link}', { link: `<a href="../app/" target="_blank" rel="noopener">${t('open')}</a>` })}</div>
      </aside>
      <div class="scrim" id="scrim" hidden></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menu-btn" aria-label="${esc(t('Open navigation'))}" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
          <div class="title" id="page-title"></div>
          <details class="usermenu" id="usermenu">
            <summary aria-label="${esc(t('Account menu'))}">
              <span class="avatar">${esc(initials(user.name))}</span>
              <span class="who"><b>${esc(user.name)}</b><small>${esc(user.code)} · ${esc(user.company.code)} · ${user.support ? t('Support') : t('Administrator')}</small></span>
              ${icon('chevronDown')}
            </summary>
            <div class="menu" role="menu">
              ${user.support ? '' : `<button type="button" data-menu="password" role="menuitem">${icon('lock')} ${t('Change password')}</button>`}
              <button type="button" data-menu="help" role="menuitem">${icon('help')} ${esc(t('Help & guides'))}</button>
              <div class="menu-lang">${icon('globe')}${langSelect('menu-lang-select', esc(t('Language')))}</div>
              <hr>
              <button type="button" data-menu="logout" role="menuitem">${icon('logout')} ${t('Sign out')}</button>
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
  bindLangSelect(menu);
  menu.onclick = async (e) => {
    const action = e.target.closest('[data-menu]')?.dataset.menu;
    if (!action) return;
    menu.open = false;
    if (action === 'logout') {
      clearInterval(supportTimer);
      const wasSupport = Boolean(user.support);
      await logout();
      renderLogin(wasSupport ? t('Support session ended. You can close this tab.') : t('You have been signed out.'));
    }
    if (action === 'password') changePassword();
    if (action === 'help') location.hash = '#/help';
  };
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

function navLink(p) {
  const badge = p.path === 'dashboard' && pendingDeposits ? `<span class="count" title="${esc(t('Bank deposits awaiting supervisor verification'))}">${pendingDeposits}</span>` : '';
  return `<a href="#/${p.path}" data-path="${p.path}" ${p.needs ? `data-needs="${p.needs}"` : ''}>${icon(p.icon)}<span>${esc(t(p.label))}</span>${badge}</a>`;
}

async function changePassword() {
  await dialog({
    title: t('Change password'),
    ok: t('Update password'),
    body: `
      <div class="form">
        <label class="field"><span>${t('Current password')}</span><input class="input" type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>${t('New password')}</span><input class="input" type="password" name="next" required minlength="10" autocomplete="new-password">
          <span class="hint">${t('At least 10 characters, with letters and numbers.')}</span></label>
        <label class="field"><span>${t('Confirm new password')}</span><input class="input" type="password" name="confirm" required autocomplete="new-password"></label>
      </div>`,
    onOk: async (data) => {
      if (data.next !== data.confirm) throw new Error(t('The new passwords do not match.'));
      await api('me/password', { method: 'POST', body: { current: data.current, next: data.next } });
      toast(t('Password updated'));
    },
  });
}

// ---------- router ----------

let seq = 0;

export async function route() {
  closeDrawer();
  const handover = /^#support=([\w-]+)/.exec(location.hash);
  if (handover) {
    history.replaceState(null, '', '#/dashboard');
    try {
      await adoptSupportToken(decodeURIComponent(handover[1]));
    } catch {
      session.clear();
      return renderLogin(t('That support link has expired. Start a new support session from the overlord console.'));
    }
    document.getElementById('shell')?.remove();
  }
  if (!session.get()) return renderLogin();
  if (!document.getElementById('shell')) {
    try {
      await loadContext();
    } catch (err) {
      if (err.status === 401) return;
      throw err;
    }
    session.set({ ...session.get(), user: context.user });
    renderShell();
    startSupportClock(context.user);
  }
  const [pathPart, queryPart = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const page = PAGES.find((p) => p.path === pathPart.split('/')[0]);
  if (!page || (page.needs && !features()[page.needs])) {
    location.replace('#/dashboard');
    return;
  }
  document.querySelectorAll('#nav a').forEach((a) => {
    const on = a.dataset.path === page.path;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.getElementById('page-title').textContent = t(page.label);
  document.title = t('{page} · LoanDesk Admin', { page: t(page.label) });
  const el = document.getElementById('view');
  const mySeq = ++seq;
  el.onclick = el.onchange = el.oninput = el.onsubmit = null;
  el.innerHTML = `<div class="empty">${t('Loading…')}</div>`;
  try {
    await page.view.render(el, new URLSearchParams(queryPart), () => mySeq === seq);
  } catch (err) {
    if (mySeq !== seq || err.status === 401) return;
    el.innerHTML = `<div class="card"><div class="empty">${icon('alert')}<b>${t(`Couldn't load this page`)}</b>${esc(tr(err.message))}<div style="margin-top:14px"><button class="btn" id="retry">${icon('refresh')} ${t('Try again')}</button></div></div></div>`;
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

setExpiredHandler(() => renderLogin(t('Your session has expired. Please sign in again.')));
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('drawer').classList.contains('open')) closeDrawer();
});
document.getElementById('drawer-scrim').onclick = closeDrawer;
document.getElementById('drawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDrawer();
});

// Language: re-render everything in the new language (the shell, or the sign-in screen).
window.addEventListener('langchange', async () => {
  await loadHelpLang(getLang());
  if (!session.get()) return renderLogin(loginMessage);
  document.getElementById('shell')?.remove();
  route();
});

await loadLang();
await loadHelpLang(getLang());
route();
