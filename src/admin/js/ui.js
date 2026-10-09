// Shared admin UI helpers: formatting, icons, toasts, drawer, dialogs.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- formatting ----------

export const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const inr2 = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const num = (n) => Number(n || 0).toLocaleString('en-IN');

/** Indian short form: ₹4.23 L, ₹1.2 Cr. */
export function inrShort(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 1 : 2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return inr(v);
}

export function date(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(ts) {
  if (!ts) return '—';
  return `${date(ts)}, ${String(ts).replace('T', ' ').slice(11, 16)}`;
}

/** "3 min ago", "yesterday", or a date. Timestamps are server-local (same zone as the browser for Indian deployments). */
export function ago(ts) {
  if (!ts) return 'Never';
  const t = new Date(String(ts).replace(' ', 'T')).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'Yesterday';
  if (s < 7 * 86400) return `${Math.round(s / 86400)} days ago`;
  return date(ts);
}

export const initials = (name) =>
  String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export const plural = (n, w, p = `${w}s`) => `${num(n)} ${n === 1 ? w : p}`;

// ---------- icons (24×24 stroke paths) ----------

const PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  loans: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  audit: '<path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 4v5h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m10.3 3.9-8.2 14a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3l-8.2-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8M12 11v8"/>',
  bank: '<path d="m3 10 9-6 9 6"/><path d="M5 10v8M9 10v8M15 10v8M19 10v8"/><path d="M3 21h18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  map: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;

// ---------- badges ----------

const ROLE = { admin: ['Admin', 'info'], supervisor: ['Supervisor', 'brand'], officer: ['Field officer', ''] };
export const roleBadge = (r) => `<span class="badge ${ROLE[r]?.[1] || ''}">${ROLE[r]?.[0] || esc(r)}</span>`;
export const statusBadge = (active) =>
  active ? '<span class="badge ok"><span class="dot"></span>Active</span>' : '<span class="badge"><span class="dot"></span>Inactive</span>';

export const BUCKETS = [
  ['current', 'Current'], ['1-30', '1–30 DPD'], ['31-60', '31–60 DPD'], ['61-90', '61–90 DPD'], ['90+', '90+ DPD'],
];
export function ageBadge(bucket, dpd) {
  if (bucket === 'closed') return '<span class="age"><i class="a-closed"></i>Closed</span>';
  return `<span class="age"><i class="a-${esc(bucket)}"></i>${dpd > 0 ? `${dpd} DPD` : 'Current'}</span>`;
}

// ---------- toasts ----------

export function toast(message, kind = 'ok') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'bad' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
  host.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3500);
}

// ---------- drawer ----------

const $drawer = () => document.getElementById('drawer');
const $scrim = () => document.getElementById('drawer-scrim');
let lastFocus = null;

export function openDrawer(html) {
  const d = $drawer();
  lastFocus = document.activeElement;
  d.innerHTML = html;
  d.setAttribute('aria-hidden', 'false');
  d.classList.add('open');
  $scrim().classList.add('open');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => (d.querySelector('[autofocus], input:not([type=hidden]):not([readonly]), select, textarea') || d).focus());
  return d;
}

export function closeDrawer() {
  const d = $drawer();
  if (!d.classList.contains('open')) return;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  $scrim().classList.remove('open');
  document.body.style.overflow = '';
  d.onclick = d.onsubmit = d.onchange = d.oninput = null;
  setTimeout(() => {
    if (!d.classList.contains('open')) d.innerHTML = '';
  }, 250);
  lastFocus?.focus?.();
}

export const drawerHead = (title, sub = '') => `
  <div class="drawer-head">
    <div class="grow"><h2>${title}</h2>${sub ? `<div class="muted small">${sub}</div>` : ''}</div>
    <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
  </div>`;

// ---------- dialogs ----------

/**
 * Shows a modal dialog. `body` may contain a form; resolves with the clicked button's value
 * (and the form data for 'ok'), or null when dismissed.
 */
export function dialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false, onOk }) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `
    <form method="dialog">
      <div class="dlg-body"><h2>${title}</h2>${body}<div class="error-box" data-err></div></div>
      <div class="dlg-foot">
        ${cancel ? `<button class="btn" value="cancel" formnovalidate>${esc(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button>
      </div>
    </form>`;
  const form = dlg.querySelector('form');
  return new Promise((resolve) => {
    form.onsubmit = async (e) => {
      const value = e.submitter?.value;
      if (value !== 'ok') return resolve(null);
      if (!onOk) return resolve({});
      e.preventDefault();
      const btn = e.submitter;
      btn.disabled = true;
      try {
        const result = await onOk(Object.fromEntries(new FormData(form)), form);
        if (result !== false) {
          dlg.close();
          resolve(result ?? {});
        }
      } catch (err) {
        form.querySelector('[data-err]').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    };
    dlg.onclose = () => resolve(null);
    dlg.onclick = (e) => {
      const gen = e.target.closest('[data-generate]');
      if (gen) {
        const input = form.elements[gen.dataset.generate];
        input.value = generateSecret(gen.dataset.kind);
        input.type = 'text';
      }
    };
    dlg.showModal();
  });
}

export const confirmDialog = (title, message, ok = 'Confirm', danger = false) =>
  dialog({ title, body: `<p>${message}</p>`, ok, danger }).then(Boolean);

/** Random 6-digit PIN, or a 12-character password with letters and digits for admins. */
export function generateSecret(kind = 'pin') {
  const rand = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  if (kind === 'pin') return String(100000 + rand(900000));
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  let s = '';
  for (let i = 0; i < 9; i++) s += alpha[rand(alpha.length)];
  for (let i = 0; i < 3; i++) s += digits[rand(digits.length)];
  return s;
}

/** Small "Help" button that opens a guide in the Help & guides page. */
export const helpButton = (topic, label = 'Help') =>
  `<a class="btn ghost" href="#/help?topic=${encodeURIComponent(topic)}" title="Open the guide for this page">${icon('help')} ${label}</a>`;

export function emptyState(title, text, iconName = 'search') {
  return `<div class="empty">${icon(iconName)}<b>${title}</b>${text}</div>`;
}

export function pager({ page, pages, total, pageSize }, label = 'rows') {
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return `
    <div class="table-foot">
      <span>${num(from)}–${num(to)} of ${plural(total, label.replace(/s$/, ''), label)}</span>
      <div class="pager">
        <button class="icon-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
        <span>Page ${page} of ${pages}</span>
        <button class="icon-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
      </div>
    </div>`;
}
