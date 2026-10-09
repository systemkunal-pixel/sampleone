// Rendering helpers shared by the officer and supervisor screens.
import * as store from './store.js';

const $toast = document.getElementById('toast');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function toast(msg, kind = 'ok') {
  $toast.textContent = msg;
  $toast.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.className = 'toast'), 3600);
}

export function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const fmtTime = (ts) => (ts ? ts.slice(11, 16) : '');
export const fmtWhen = (ts) => (ts ? `${fmtDate(ts)} ${fmtTime(ts)}` : '—');

/** Connection pill: Live / Sending… / Offline · N queued. */
export function netPill() {
  const queued = store.getState().outbox.length;
  const { status } = store.net;
  if (status === 'syncing') return '<span class="net sync">Sending…</span>';
  if (status === 'offline' || status === 'pending') {
    return `<a class="net off" href="#/settings" title="${esc(store.net.message)}">Offline${queued ? ` · ${queued} queued` : ''}</a>`;
  }
  if (status === 'online') return '<span class="net on">● Live</span>';
  return '<span class="net">…</span>';
}

/** Top bar. `help` is the id of the guide for this screen (opened by the ? button). */
export function header(title, back, help = '') {
  const signedIn = Boolean(store.getState().session && !store.getState().session.expired);
  return `<header class="topbar">
    ${back ? `<a class="back" href="${esc(back)}" aria-label="Back">‹</a>` : ''}
    <h1>${esc(title)}</h1>
    ${signedIn ? `<span id="net-pill">${netPill()}</span>` : ''}
    <a class="help-btn" href="#/help${help ? `/${esc(help)}` : ''}" aria-label="Help for this screen" title="Help">?</a>
  </header>`;
}

export function verificationTag(deposit) {
  if (deposit.verification === 'verified') return '<span class="tag tag-ok">Verified</span>';
  if (deposit.verification === 'rejected') return '<span class="tag tag-bad">Rejected</span>';
  return '<span class="tag tag-warn">Pending verification</span>';
}

/** One line on who decided a deposit and why. */
export function decisionLine(deposit) {
  if (!deposit?.verifiedBy) return '';
  const verb = deposit.verification === 'verified' ? 'Verified' : 'Rejected';
  return `<div class="small ${deposit.verification === 'rejected' ? 'bad' : 'muted'}">${verb} by ${esc(deposit.verifiedBy)} · ${esc(fmtWhen(deposit.verifiedAt))}${deposit.note ? ` — “${esc(deposit.note)}”` : ''}</div>`;
}

// Object URLs for slip images, released whenever the view changes.
let slipUrls = [];
export const trackUrl = (url) => (slipUrls.push(url), url);
export function revokeSlipUrls() {
  slipUrls.forEach((u) => URL.revokeObjectURL(u));
  slipUrls = [];
}

/** Fills [data-slip="<paymentId>"] placeholders with the slip image or a PDF link. */
export async function hydrateSlips() {
  for (const el of document.querySelectorAll('[data-slip]')) {
    const blob = await store.slipBlob(el.dataset.slip);
    if (!el.isConnected) return;
    if (!blob) {
      el.innerHTML = '<span class="muted small">Slip image unavailable (server unreachable?).</span>';
      continue;
    }
    const url = trackUrl(URL.createObjectURL(blob));
    el.innerHTML = blob.type === 'application/pdf'
      ? `<a class="btn" href="${url}" target="_blank" rel="noopener">📄 Open deposit slip (PDF)</a>`
      : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Bank deposit slip"></a>`;
  }
}

export function viewNotFound() {
  return `${header('Not found', '#/')}<p class="empty card">That record isn't available.</p>`;
}
