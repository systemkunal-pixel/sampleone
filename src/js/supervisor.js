// Supervisor screens: the bank-deposit verification queue.
import { formatINR, loanStatus, daysBetween } from './logic.js';
import * as store from './store.js';
import { esc, header, fmtDate, fmtWhen, verificationTag, decisionLine, toast, plural } from './ui.js';

const STATUSES = [
  ['pending', 'Pending'],
  ['verified', 'Verified'],
  ['rejected', 'Rejected'],
];
const REJECT_REASONS = [
  'Amount on slip does not match',
  'Not credited in bank statement',
  'Slip unreadable — retake photo',
  'Slip belongs to another account',
];

const cache = new Map(); // status → deposits (last fetch)

function findCached(id) {
  for (const list of cache.values()) {
    const d = list.find((x) => x.id === id);
    if (d) return d;
  }
  return null;
}

/** Red flags a supervisor should look at before verifying. */
function checks(d) {
  const flags = [];
  const lag = daysBetween(d.deposit.depositDate, d.at.slice(0, 10));
  if (lag > 7) flags.push(`Deposited ${lag} days before it was reported`);
  if (d.amount > d.emi * 3) flags.push(`Amount is more than 3× the EMI (${formatINR(d.emi)})`);
  if (!d.location) flags.push('No GPS location captured');
  return flags;
}

export async function viewDeposits(status = 'pending') {
  if (!STATUSES.some(([s]) => s === status)) status = 'pending';
  let list;
  let error = '';
  try {
    list = await store.fetchDeposits(status);
    cache.set(status, list);
  } catch (err) {
    list = cache.get(status) || [];
    error = `${err.message} Showing the last list loaded.`;
  }
  const total = list.reduce((s, d) => s + d.amount, 0);
  return `
    ${header('Bank deposits', '', 'verify-deposit')}
    <div class="chips tabs">${STATUSES.map(([s, label]) =>
      `<a class="chip ${s === status ? 'active' : ''}" href="#/deposits/${s}">${label}</a>`).join('')}</div>
    ${error ? `<p class="note bad mt-s">${esc(error)}</p>` : ''}
    <p class="muted small">${plural(list.length, 'deposit')} · ${formatINR(total)}${status === 'pending' ? ' · oldest first' : ''}</p>
    ${list.length ? list.map((d) => `
      <a class="card loan-card" href="#/deposit/${esc(d.id)}">
        <div class="row between"><strong>${esc(d.borrower)}</strong><strong>${formatINR(d.amount)}</strong></div>
        <div class="muted small">${esc(d.loanNo)} · slip ${esc(d.deposit.slipNo)} · ${esc(d.deposit.bank)}</div>
        <div class="row between mt-s">
          <span class="small">By ${esc(d.officerName)} · ${esc(fmtWhen(d.at))}</span>
          <span class="tags">${checks(d).length && status === 'pending' ? '<span class="tag tag-bad">Check</span>' : ''}${verificationTag(d.deposit)}</span>
        </div>
      </a>`).join('') : `<p class="empty card">${status === 'pending' ? 'Nothing waiting for verification. 🎉' : 'None yet.'}</p>`}`;
}

export async function viewDeposit(id) {
  let d = findCached(id);
  if (!d) {
    for (const [s] of STATUSES) {
      try {
        cache.set(s, await store.fetchDeposits(s));
      } catch {
        break;
      }
      if ((d = findCached(id))) break;
    }
  }
  if (!d) return `${header('Deposit', '#/deposits')}<p class="empty card">Deposit not found, or the server is unreachable.</p>`;
  const loan = store.getLoan(d.loanId);
  const st = loan ? loanStatus(loan) : null;
  const flags = checks(d);
  const pending = d.deposit.verification === 'pending';
  return `
    ${header('Verify deposit', `#/deposits/${d.deposit.verification}`, 'verify-deposit')}
    <section class="card">
      <div class="row between"><strong>${esc(d.borrower)}</strong>${verificationTag(d.deposit)}</div>
      <div class="muted small">${esc(d.loanNo)}${st ? ` · overdue ${formatINR(st.overdue)} · outstanding ${formatINR(st.outstanding)}` : ''}</div>
      <div class="slip-view" data-slip="${esc(d.id)}"><span class="muted small">Loading slip…</span></div>
      <p class="muted small center">Tap the slip to open it full size and check every figure.</p>
      <dl class="facts">
        <dt>Amount entered</dt><dd class="amount">${formatINR(d.amount)}</dd>
        <dt>Slip / journal no.</dt><dd>${esc(d.deposit.slipNo)}</dd>
        <dt>Bank &amp; branch</dt><dd>${esc(d.deposit.bank)}</dd>
        <dt>Deposit date</dt><dd>${esc(fmtDate(d.deposit.depositDate))}</dd>
        <dt>Recorded by</dt><dd>${esc(d.officerName)} (${esc(d.officer)})</dd>
        <dt>Recorded at</dt><dd>${esc(fmtWhen(d.at))}</dd>
        <dt>Ack. no.</dt><dd>${esc(d.receiptNo)}</dd>
        <dt>EMI</dt><dd>${formatINR(d.emi)}</dd>
      </dl>
      ${flags.length ? `<div class="note warn-note">⚠️ ${flags.map(esc).join('<br>⚠️ ')}</div>` : ''}
      ${decisionLine(d.deposit)}
    </section>
    ${pending ? `
    <section class="card">
      <h2>Decision</h2>
      <p class="muted small">Verify only after you've matched the slip with the bank statement or branch credit.</p>
      <button class="btn primary big" data-action="verify-deposit" data-id="${esc(d.id)}">✓ Verify ${formatINR(d.amount)}</button>
      <form id="reject-form" class="form mt" data-id="${esc(d.id)}">
        <label>Reason for rejecting
          <textarea name="note" rows="2" maxlength="300" required placeholder="The officer and borrower will see this"></textarea>
        </label>
        <div class="chips">${REJECT_REASONS.map((r) => `<button type="button" class="chip" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <p class="error" id="decision-error" role="alert"></p>
        <button class="btn danger" type="submit">✕ Reject deposit</button>
      </form>
    </section>` : ''}`;
}

async function decide(id, decision, note, $err) {
  try {
    const p = await store.decideDeposit(id, decision, note);
    for (const list of cache.values()) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    }
    toast(decision === 'verified' ? `Verified ${formatINR(p.amount)}` : 'Deposit rejected — officer will be notified');
    if (location.hash === '#/deposits/pending') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = '#/deposits/pending';
  } catch (err) {
    const msg = err.status === 409 || err.status === 404 ? err.message : `${err.message} Nothing was changed — try again.`;
    if ($err) $err.textContent = msg;
    else toast(msg, 'bad');
    if (err.status === 409) cache.clear();
  }
}

/** Returns true when the event was handled here. */
export async function handleClick(el) {
  if (el.dataset.reason) {
    el.closest('form').note.value = el.dataset.reason;
    return true;
  }
  if (el.dataset.action === 'verify-deposit') {
    const d = findCached(el.dataset.id);
    if (!confirm(`Confirm you have matched slip ${d?.deposit.slipNo} for ${formatINR(d?.amount)} with the bank?`)) return true;
    el.disabled = true;
    await decide(el.dataset.id, 'verified', '', document.getElementById('decision-error'));
    el.disabled = false;
    return true;
  }
  return false;
}

export async function handleSubmit(form, data) {
  if (form.id !== 'reject-form') return false;
  const note = String(data.note || '').trim();
  const $err = form.querySelector('#decision-error');
  if (!note) {
    $err.textContent = 'Give a reason — the officer needs to know what to fix.';
    return true;
  }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  await decide(form.dataset.id, 'rejected', note, $err);
  btn.disabled = false;
  return true;
}
