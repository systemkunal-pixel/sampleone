import {
  VISIT_OUTCOMES, PAYMENT_MODES, DPD_BUCKETS, BANK_DEPOSIT,
  isoDate, addDays, daysBetween, formatINR, money, loanStatus, allocate, activePromise, visitList,
  validatePayment, validateDeposit, distanceKm, daySummary, portfolioSummary, collectionsCSV, outcomeLabel,
} from './logic.js';
import * as store from './store.js';
import { prepareSlip, putSlip, deleteSlip } from './slips.js';
import * as install from './install.js';
import * as supervisor from './supervisor.js';
import {
  esc, plural, toast, fmtDate, fmtTime, fmtWhen, netPill, header, verificationTag, decisionLine,
  trackUrl, revokeSlipUrls, hydrateSlips, viewNotFound,
} from './ui.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

let here = null; // last known officer location
let accountsFilter = { q: '', bucket: 'all' };
const SEND_WAIT_MS = 8000; // how long a save waits for the server before falling back to the outbox

const NAV = {
  officer: [['#/', 'today', '📋', 'Today'], ['#/accounts', 'accounts', '👥', 'Accounts'], ['#/summary', 'summary', '📊', 'Summary'], ['#/settings', 'settings', '⚙️', 'Settings']],
  supervisor: [['#/deposits', 'deposits', '🏦', 'Deposits'], ['#/accounts', 'accounts', '👥', 'Accounts'], ['#/summary', 'summary', '📊', 'Summary'], ['#/settings', 'settings', '⚙️', 'Settings']],
};

const isOfficer = () => store.user()?.role === 'officer';

// ---------- helpers ----------

function getPosition(timeout = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        here = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
        resolve(here);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 }
    );
  });
}

const isQueued = (id) => store.getState().outbox.some((o) => o.record.id === id);
const rejection = (id) => store.getState().rejected.find((r) => r.id === id);

/** Sends right away; resolves 'sent' | 'queued' | {error} once the server answers or SEND_WAIT_MS passes. */
async function sendNow(id) {
  await Promise.race([store.flush().catch(() => {}), new Promise((r) => setTimeout(r, SEND_WAIT_MS))]);
  const rej = rejection(id);
  if (rej) {
    store.dismissRejected(id); // shown inline instead
    return { error: rej.error };
  }
  return isQueued(id) ? 'queued' : 'sent';
}

function bucketBadge(st) {
  if (st.closed) return '<span class="badge b-closed">Closed</span>';
  return `<span class="badge b-${esc(st.bucket.key)}">${st.overdue > 0 ? `${st.dpd} DPD` : 'Current'}</span>`;
}

function ptpTag(loan, today) {
  const ptp = activePromise(loan);
  if (!ptp || ptp.kept) return '';
  if (ptp.ptpDate === today) return '<span class="tag tag-warn">PTP due today</span>';
  if (ptp.ptpDate < today) return '<span class="tag tag-bad">Broken PTP</span>';
  return `<span class="tag">PTP ${esc(fmtDate(ptp.ptpDate))}</span>`;
}

function distanceText(loan) {
  const km = distanceKm(here, loan.borrower);
  if (km == null) return '';
  return `<span class="muted">· ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`}</span>`;
}

function loanCard(loan, today, extra = '') {
  const st = loanStatus(loan, today);
  return `
    <a class="card loan-card" href="#/loan/${esc(loan.id)}">
      <div class="row between">
        <strong>${esc(loan.borrower.name)}</strong>
        ${bucketBadge(st)}
      </div>
      <div class="muted small">${esc(loan.loanNo)} · ${esc(loan.borrower.village)} ${isOfficer() ? distanceText(loan) : `· ${esc(loan.officerCode || 'unassigned')}`}</div>
      <div class="row between mt-s">
        <span>Overdue <strong class="${st.overdue > 0 ? 'bad' : ''}">${formatINR(st.overdue)}</strong></span>
        <span class="tags">${ptpTag(loan, today)}${extra}</span>
      </div>
    </a>`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- login ----------

function viewLogin() {
  const { session, outbox } = store.getState();
  const expired = session?.expired;
  return `
    <section class="setup">
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1>Loan Recovery</h1>
      <p class="muted">${expired ? 'Your session has expired. Log in again to continue.' : 'Log in with your officer code and PIN.'}</p>
      ${outbox.length ? `<p class="note warn-note">${plural(outbox.length, 'record')} on this phone still need to reach the server. They'll be sent as soon as you log in.</p>` : ''}
      <form id="login-form" class="card form">
        <label>Officer / supervisor code<input name="code" required maxlength="12" autocapitalize="characters" autocomplete="username" value="${esc(session?.user?.code || '')}"></label>
        <label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" required minlength="4" maxlength="8" autocomplete="current-password"></label>
        <p class="error" id="login-error" role="alert"></p>
        <button class="btn primary big" type="submit">Log in</button>
      </form>
    </section>`;
}

// ---------- officer views ----------

const IOS_STEPS = 'In Safari, tap the Share button <b>⬆</b>, then <b>Add to Home Screen</b>.';

function installCard() {
  switch (install.installState()) {
    case 'installed':
      return '<p class="small">✅ Installed on this phone.</p>';
    case 'prompt':
      return '<button class="btn primary" data-action="install">📲 Install app on this phone</button>';
    case 'ios':
      return `<p class="small">To install: ${IOS_STEPS}</p>`;
    default:
      return '<p class="muted small">To install, open the browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>';
  }
}

function installBanner() {
  const state = install.installState();
  if (install.bannerDismissed() || (state !== 'prompt' && state !== 'ios')) return '';
  return `<div class="banner">
    <span>📲 ${state === 'prompt' ? 'Install this app for one-tap access and full offline use.' : `Install this app: ${IOS_STEPS}`}</span>
    <span class="banner-actions">
      ${state === 'prompt' ? '<button class="btn small primary" data-action="install">Install</button>' : ''}
      <button class="btn small" data-action="dismiss-install" aria-label="Dismiss">✕</button>
    </span>
  </div>`;
}

/** Things the officer must act on: records the server refused, deposits a supervisor rejected. */
function alerts(loans, today) {
  const { rejected } = store.getState();
  const refused = rejected.map((r) => `
    <div class="card alert">
      <div class="row between"><strong>Not accepted by server</strong><button class="btn small" data-action="dismiss-rejected" data-id="${esc(r.id)}">Dismiss</button></div>
      <div class="small">${esc(r.summary)}</div>
      <div class="small bad">${esc(r.error)}</div>
    </div>`);
  const bounced = loans.flatMap((loan) => loan.payments
    .filter((p) => p.deposit?.verification === 'rejected' && p.deposit.verifiedAt && daysBetween(p.deposit.verifiedAt.slice(0, 10), today) <= 7)
    .map((p) => `
      <a class="card alert" href="#/loan/${esc(loan.id)}">
        <strong>Bank deposit rejected · ${formatINR(p.amount)}</strong>
        <div class="small">${esc(loan.borrower.name)} · slip ${esc(p.deposit.slipNo)} — revisit the borrower.</div>
        ${decisionLine(p.deposit)}
      </a>`));
  return [...refused, ...bounced].join('');
}

function viewToday() {
  const { loans, outbox } = store.getState();
  const me = store.user();
  const today = isoDate();
  const list = visitList(loans, today);
  const day = daySummary(loans, today);
  const visitedToday = new Set(day.visits.map((v) => v.loan.id).concat(day.payments.map((p) => p.loan.id)));
  const pending = list.filter((x) => !visitedToday.has(x.loan.id));
  const done = list.filter((x) => visitedToday.has(x.loan.id));
  const pendingDeposits = loans.flatMap((l) => l.payments).filter((p) => p.deposit?.verification === 'pending').length;

  return `
    ${header(`Hi, ${me.name.split(' ')[0]}`)}
    ${installBanner()}
    ${alerts(loans, today)}
    <section class="stats">
      <div class="stat"><span>Collected today</span><strong>${formatINR(day.collected)}</strong></div>
      <div class="stat"><span>Visits</span><strong>${day.visits.length}</strong></div>
      <div class="stat ${pendingDeposits ? 'warn' : ''}"><span>Deposits unverified</span><strong>${pendingDeposits}</strong></div>
      <a class="stat ${outbox.length ? 'warn' : ''}" href="#/settings"><span>Not sent</span><strong>${outbox.length}</strong></a>
    </section>
    <section>
      <div class="row between section-head">
        <h2>Visit plan · ${pending.length} left</h2>
        <button class="btn small" data-action="locate">📍 Near me</button>
      </div>
      ${loans.length ? '' : '<p class="empty card">No accounts are assigned to you yet. Contact your branch.</p>'}
      ${pending.length ? pending.map((x) => loanCard(x.loan, today)).join('') : loans.length ? '<p class="empty card">No pending visits. Great work!</p>' : ''}
      ${done.length ? `<h2 class="mt">Done today · ${done.length}</h2>${done.map((x) => loanCard(x.loan, today, '<span class="tag tag-ok">Visited</span>')).join('')}` : ''}
    </section>`;
}

function viewAccounts() {
  const { loans } = store.getState();
  const today = isoDate();
  const q = accountsFilter.q.trim().toLowerCase();
  const rows = loans
    .map((loan) => ({ loan, st: loanStatus(loan, today) }))
    .filter(({ loan, st }) => {
      if (accountsFilter.bucket !== 'all' && (st.closed || st.bucket.key !== accountsFilter.bucket)) return false;
      if (!q) return true;
      const b = loan.borrower;
      return [b.name, b.phone, b.village, loan.loanNo, loan.officerCode].some((v) => String(v ?? '').toLowerCase().includes(q));
    })
    .sort((a, b) => b.st.dpd - a.st.dpd || b.st.overdue - a.st.overdue);

  const chip = (key, label) =>
    `<button class="chip ${accountsFilter.bucket === key ? 'active' : ''}" data-bucket="${esc(key)}">${esc(label)}</button>`;

  return `
    ${header(isOfficer() ? 'My accounts' : 'Branch accounts')}
    <div class="search"><input id="search" type="search" placeholder="Search name, phone, village, loan no.${isOfficer() ? '' : ', officer'}" value="${esc(accountsFilter.q)}"></div>
    <div class="chips">${chip('all', 'All')}${DPD_BUCKETS.map((b) => chip(b.key, b.label)).join('')}</div>
    <p class="muted small">${plural(rows.length, 'account')}</p>
    ${rows.map(({ loan }) => loanCard(loan, today)).join('') || '<p class="empty card">No accounts match.</p>'}`;
}

function paymentLine(loan, p) {
  const link = `<a href="#/receipt/${esc(loan.id)}/${esc(p.id)}">${esc(p.receiptNo)}</a>`;
  if (!p.deposit) return `<strong class="ok">${formatINR(p.amount)}</strong> collected · ${esc(p.mode)} · ${link}`;
  const struck = p.deposit.verification === 'rejected';
  return `<strong class="${struck ? 'struck' : 'ok'}">${formatINR(p.amount)}</strong> bank deposit · slip ${esc(p.deposit.slipNo)} · ${link} ${verificationTag(p.deposit)}${decisionLine(p.deposit)}`;
}

function viewLoan(id) {
  const loan = store.getLoan(id);
  if (!loan) return viewNotFound();
  const today = isoDate();
  const st = loanStatus(loan, today);
  const b = loan.borrower;
  const ptp = activePromise(loan);
  const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}`;
  const history = [
    ...loan.payments.map((p) => ({ at: p.at, html: paymentLine(loan, p), synced: p.synced })),
    ...loan.visits.map((v) => ({
      at: v.at,
      html: `Visit: <strong>${esc(outcomeLabel(v.outcome))}</strong>${v.outcome === 'PTP' ? ` · ${formatINR(v.ptpAmount)} by ${esc(fmtDate(v.ptpDate))}` : ''}${v.notes ? `<div class="muted small">${esc(v.notes)}</div>` : ''}`,
      synced: v.synced,
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));

  const schedule = allocate(loan);

  return `
    ${header(b.name, isOfficer() ? '#/' : '#/accounts')}
    <section class="card">
      <div class="row between"><span class="muted small">${esc(loan.loanNo)} · ${esc(loan.product)}</span>${bucketBadge(st)}</div>
      <div class="muted small">${esc(b.business)}${isOfficer() ? '' : ` · officer ${esc(loan.officerCode || '—')}`}</div>
      <div class="mt-s">${esc(b.address)}, ${esc(b.village)} ${distanceText(loan)}</div>
      <div class="actions mt">
        <a class="btn" href="tel:${esc(b.phone)}">📞 Call</a>
        <a class="btn" href="https://wa.me/91${esc(b.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>
        <a class="btn" href="${esc(mapUrl)}" target="_blank" rel="noopener">🧭 Directions</a>
      </div>
      ${b.guarantor ? `<div class="muted small mt-s">Guarantor: ${esc(b.guarantor.name)} · <a href="tel:${esc(b.guarantor.phone)}">${esc(b.guarantor.phone)}</a></div>` : ''}
    </section>

    <section class="grid2">
      <div class="stat"><span>Overdue</span><strong class="${st.overdue > 0 ? 'bad' : ''}">${formatINR(st.overdue)}</strong><small>${plural(st.overdueInstallments, 'EMI')}</small></div>
      <div class="stat"><span>Total outstanding</span><strong>${formatINR(st.outstanding)}</strong><small>EMI ${formatINR(loan.emi)}</small></div>
      <div class="stat"><span>Next due</span><strong>${st.nextDue ? esc(fmtDate(st.nextDue.date)) : '—'}</strong><small>${st.nextDue ? formatINR(st.nextDue.amount) : ''}</small></div>
      <div class="stat"><span>Promise</span><strong>${ptp && !ptp.kept ? esc(fmtDate(ptp.ptpDate)) : '—'}</strong><small>${ptp && !ptp.kept ? formatINR(ptp.ptpAmount) : ''}</small></div>
    </section>

    ${isOfficer() ? `
    <div class="actions sticky">
      <a class="btn primary big ${st.closed ? 'disabled' : ''}" href="#/loan/${esc(loan.id)}/pay">Collect payment</a>
      <a class="btn big" href="#/loan/${esc(loan.id)}/visit">Log visit</a>
    </div>` : ''}

    <section>
      <h2>History</h2>
      ${history.length ? `<ul class="timeline">${history.map((h) => `<li><span class="muted small">${esc(fmtWhen(h.at))} ${h.synced ? '' : '<span class="tag tag-warn">Not sent</span>'}</span><div>${h.html}</div></li>`).join('')}</ul>` : '<p class="muted">No activity yet.</p>'}
    </section>

    <details class="card">
      <summary>Repayment schedule (${plural(schedule.length, 'EMI')})</summary>
      <table class="schedule">
        <thead><tr><th>#</th><th>Due</th><th>EMI</th><th>Status</th></tr></thead>
        <tbody>${schedule.map((r) => `<tr class="${r.pending <= 0 ? 'paid' : r.dueDate <= today ? 'late' : ''}">
          <td>${r.no}</td><td>${esc(fmtDate(r.dueDate))}</td><td>${formatINR(r.amount)}</td>
          <td>${r.pending <= 0 ? 'Paid' : r.paid > 0 ? `Part (${formatINR(r.pending)} due)` : r.dueDate <= today ? 'Overdue' : 'Upcoming'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </details>`;
}

function viewPay(id) {
  const loan = store.getLoan(id);
  if (!loan || !isOfficer()) return viewNotFound();
  const st = loanStatus(loan, isoDate());
  const quick = [...new Set([loan.emi, st.overdue, st.outstanding].filter((v) => v > 0 && v <= st.outstanding))];
  return `
    ${header('Collect payment', `#/loan/${loan.id}`)}
    <form id="pay-form" class="card form" data-loan="${esc(loan.id)}">
      <div class="muted">${esc(loan.borrower.name)} · ${esc(loan.loanNo)}</div>
      <div class="muted small">Overdue ${formatINR(st.overdue)} · Outstanding ${formatINR(st.outstanding)}</div>
      <label>Amount (₹)<input name="amount" type="number" inputmode="decimal" step="0.01" min="1" max="${st.outstanding}" required value="${st.overdue || ''}"></label>
      <div class="chips">${quick.map((v) => `<button type="button" class="chip" data-fill="${v}">${formatINR(v)}</button>`).join('')}</div>
      <fieldset class="modes"><legend>Mode</legend>
        ${PAYMENT_MODES.map((m, i) => `<label class="radio"><input type="radio" name="mode" value="${esc(m)}" ${i === 0 ? 'checked' : ''}> ${esc(m)}</label>`).join('')}
      </fieldset>
      <label id="ref-wrap" hidden>Reference / UTR / Cheque no.<input name="reference" autocomplete="off"></label>
      <div id="deposit-fields" class="form" hidden>
        <p class="note">Borrower paid directly at the bank. Photograph the counterfoil / pay-in slip and enter the details exactly as printed. A supervisor verifies it against the bank.</p>
        <label class="slip-pick">
          <span id="slip-preview" class="slip-preview">📷 Take photo or choose file</span>
          <input name="slip" type="file" accept="image/*,application/pdf" capture="environment" hidden>
        </label>
        <label>Slip / journal no.<input name="slipNo" autocomplete="off" autocapitalize="characters"></label>
        <label>Bank &amp; branch<input name="bank" autocomplete="off" placeholder="e.g. SBI, Chinhat"></label>
        <label>Deposit date<input name="depositDate" type="date" max="${isoDate()}" min="${addDays(isoDate(), -90)}" value="${isoDate()}"></label>
      </div>
      <p class="error" id="pay-error" role="alert"></p>
      <button class="btn primary big" type="submit">Confirm &amp; issue receipt</button>
    </form>`;
}

function viewVisit(id) {
  const loan = store.getLoan(id);
  if (!loan || !isOfficer()) return viewNotFound();
  const today = isoDate();
  return `
    ${header('Log visit', `#/loan/${loan.id}`)}
    <form id="visit-form" class="card form" data-loan="${esc(loan.id)}">
      <div class="muted">${esc(loan.borrower.name)} · ${esc(loan.loanNo)}</div>
      <label>Outcome
        <select name="outcome" required>
          <option value="" disabled selected>Select outcome…</option>
          ${VISIT_OUTCOMES.filter((o) => !['PAID', 'PARTIAL'].includes(o.code)).map((o) => `<option value="${o.code}">${esc(o.label)}</option>`).join('')}
        </select>
      </label>
      <p class="muted small">Collected money? Use <a href="#/loan/${esc(loan.id)}/pay">Collect payment</a> instead — it counts as today's visit and issues a receipt.</p>
      <div id="ptp-fields" hidden>
        <label>Promised date<input name="ptpDate" type="date" min="${today}" max="${addDays(today, 30)}"></label>
        <label>Promised amount (₹)<input name="ptpAmount" type="number" inputmode="decimal" min="1" step="0.01" value="${loan.emi}"></label>
      </div>
      <label>Next follow-up<input name="followUpDate" type="date" min="${today}"></label>
      <label>Notes<textarea name="notes" rows="3" maxlength="500" placeholder="What did the borrower say? Who did you meet?"></textarea></label>
      <p class="error" id="visit-error" role="alert"></p>
      <button class="btn primary big" type="submit">Save visit</button>
    </form>`;
}

function viewReceipt(loanId, paymentId) {
  const loan = store.getLoan(loanId);
  const p = loan?.payments.find((x) => x.id === paymentId);
  if (!p) return viewNotFound();
  const me = store.user();
  const st = loanStatus(loan, isoDate());
  const d = p.deposit;
  const by = p.officer === me.code ? `${me.name} (${me.code})` : p.officer;
  return `
    ${header(d ? 'Acknowledgement' : 'Receipt', `#/loan/${loan.id}`)}
    <p class="sync-line ${p.synced ? 'ok' : 'warn'}">${p.synced ? '✓ Received by server' : '⏳ Saved on this phone — sends automatically when the server is reachable'}</p>
    <section class="card receipt" id="receipt">
      <div class="center"><strong>${d ? 'BANK DEPOSIT ACKNOWLEDGEMENT' : 'PAYMENT RECEIPT'}</strong><div class="muted small">${esc(loan.branch || me.branch)} branch</div></div>
      <dl>
        <dt>${d ? 'Ack.' : 'Receipt'} no.</dt><dd>${esc(p.receiptNo)}</dd>
        <dt>${d ? 'Recorded' : 'Date &amp; time'}</dt><dd>${esc(fmtWhen(p.at))}</dd>
        <dt>Borrower</dt><dd>${esc(loan.borrower.name)}</dd>
        <dt>Loan no.</dt><dd>${esc(loan.loanNo)}</dd>
        <dt>Amount</dt><dd class="amount">${formatINR(p.amount)}</dd>
        ${d ? `
        <dt>Deposited at</dt><dd>${esc(d.bank)}</dd>
        <dt>Deposit date</dt><dd>${esc(fmtDate(d.depositDate))}</dd>
        <dt>Slip no.</dt><dd>${esc(d.slipNo)}</dd>
        <dt>Status</dt><dd>${verificationTag(d)}</dd>` : `
        <dt>Mode</dt><dd>${esc(p.mode)}${p.reference ? ` (${esc(p.reference)})` : ''}</dd>`}
        <dt>Balance outstanding</dt><dd>${formatINR(st.outstanding)}</dd>
        <dt>${d ? 'Recorded by' : 'Collected by'}</dt><dd>${esc(by)}</dd>
      </dl>
      ${d ? `${decisionLine(d)}<p class="muted small center">Credit is subject to verification of the deposit with the bank.</p>
        <div class="slip-view" data-slip="${esc(p.id)}"><span class="muted small">Loading slip…</span></div>` : ''}
      ${p.location ? `<div class="muted small center">GPS ${p.location.lat.toFixed(5)}, ${p.location.lng.toFixed(5)}</div>` : ''}
    </section>
    <div class="actions">
      <button class="btn" data-action="share-receipt" data-loan="${esc(loan.id)}" data-payment="${esc(p.id)}">📤 Share / SMS</button>
      <button class="btn" data-action="print">🖨 Print</button>
      <a class="btn primary" href="#/">Done</a>
    </div>`;
}

function viewSummary() {
  const { loans } = store.getState();
  const today = isoDate();
  const day = daySummary(loans, today);
  const pf = portfolioSummary(loans, today);
  const maxCount = Math.max(1, ...pf.buckets.map((b) => b.count));
  return `
    ${header(isOfficer() ? 'Summary' : 'Branch summary')}
    <section class="card">
      <h2>Today · ${esc(fmtDate(today))}</h2>
      <div class="big-number">${formatINR(day.collected)}</div>
      <div class="muted small">${plural(day.payments.length, 'receipt')} · ${plural(day.visits.length, 'visit')} · ${plural(day.ptpCount, 'promise')}</div>
      ${Object.keys(day.byMode).length ? `<table class="kv mt">${Object.entries(day.byMode).map(([m, v]) => `<tr><td>${esc(m)}</td><td>${formatINR(v)}</td></tr>`).join('')}</table>` : ''}
      ${Object.keys(day.byOutcome).length ? `<h3 class="mt">Visit outcomes</h3><table class="kv">${Object.entries(day.byOutcome).map(([o, n]) => `<tr><td>${esc(outcomeLabel(o))}</td><td>${n}</td></tr>`).join('')}</table>` : ''}
      <div class="actions mt"><button class="btn" data-action="export-csv">⬇ Export today (CSV)</button></div>
    </section>
    <section class="card">
      <h2>Portfolio</h2>
      <div class="grid2">
        <div class="stat"><span>Total overdue</span><strong class="bad">${formatINR(pf.overdue)}</strong></div>
        <div class="stat"><span>Total outstanding</span><strong>${formatINR(pf.outstanding)}</strong></div>
      </div>
      <div class="bars mt">
        ${pf.buckets.map((b) => `
          <a class="bar-row" href="#/accounts" data-bucket-link="${esc(b.key)}">
            <span class="bar-label">${esc(b.label)}</span>
            <span class="bar-track"><span class="bar b-${esc(b.key)}" style="width:${(b.count / maxCount) * 100}%"></span></span>
            <span class="bar-val">${b.count} · ${formatINR(b.overdue)}</span>
          </a>`).join('')}
      </div>
    </section>`;
}

async function hydrateStorage() {
  const el = document.querySelector('[data-storage]');
  if (!el) return;
  const { persisted, usage, quota } = await install.storageInfo();
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  el.innerHTML = `${persisted ? '🔒 Storage protected — the phone will not auto-clear app data.' : '⚠️ Storage not yet protected. Installing the app usually fixes this.'}${quota ? `<br>Using ${mb(usage)} of ${mb(quota)} available.` : ''}`;
}

function viewSettings() {
  const { outbox, lastSyncAt } = store.getState();
  const me = store.user();
  const status = {
    online: 'Connected — records are sent the moment you save them.',
    syncing: 'Sending records…',
    pending: `Server not accepting records right now (${store.net.message}). Retrying automatically.`,
    offline: 'Server unreachable — no signal or server maintenance. Keep working; records are kept on this phone and sent automatically.',
  }[store.net.status] || 'Checking connection…';
  return `
    ${header('Settings')}
    <section class="card">
      <h2>${esc(me.name)}</h2>
      <p class="muted small">${esc(me.code)} · ${me.role === 'officer' ? 'Field officer' : 'Supervisor'} · ${esc(me.branch)}</p>
    </section>
    <section class="card">
      <h2>Connection ${netPill()}</h2>
      <p class="small">${esc(status)}</p>
      <p class="muted small">${plural(outbox.length, 'record')} waiting · last sent ${lastSyncAt ? esc(fmtWhen(lastSyncAt)) : '—'}</p>
      <div class="actions">
        ${outbox.length ? '<button class="btn primary" data-action="sync">⟳ Send now</button>' : ''}
        <button class="btn" data-action="refresh">↻ Refresh from server</button>
      </div>
    </section>
    <section class="card">
      <h2>App</h2>
      ${installCard()}
      <p class="muted small mt-s" data-storage>Checking storage…</p>
    </section>
    <section class="card">
      <button class="btn danger" data-action="logout">Log out</button>
      ${outbox.length ? '<p class="muted small mt-s">You can log out once all records have reached the server.</p>' : ''}
    </section>`;
}

// ---------- router ----------

let routeSeq = 0;
const FORM_ROUTES = /^(loan\/[^/]+\/(pay|visit)|deposit\/)/;

function renderNav(tab) {
  const items = NAV[store.user().role] || [];
  $nav.innerHTML = items.map(([href, key, icon, label]) =>
    `<a href="${href}" data-tab="${key}" class="${key === tab ? 'active' : ''}"><span>${icon}</span>${label}</a>`).join('');
  $nav.hidden = false;
}

async function route({ keepScroll = false } = {}) {
  const seq = ++routeSeq;
  const { session } = store.getState();
  if (!session || session.expired) {
    $nav.hidden = true;
    $app.innerHTML = viewLogin();
    return;
  }
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  const officer = isOfficer();
  let view;
  let tab = '';
  if (!parts.length) [view, tab] = officer ? [viewToday, 'today'] : [() => supervisor.viewDeposits('pending'), 'deposits'];
  else if (parts[0] === 'accounts') [view, tab] = [viewAccounts, 'accounts'];
  else if (parts[0] === 'summary') [view, tab] = [viewSummary, 'summary'];
  else if (parts[0] === 'settings') [view, tab] = [viewSettings, 'settings'];
  else if (parts[0] === 'deposits' && !officer) [view, tab] = [() => supervisor.viewDeposits(parts[1]), 'deposits'];
  else if (parts[0] === 'deposit' && !officer) view = () => supervisor.viewDeposit(parts[1]);
  else if (parts[0] === 'loan' && parts[2] === 'pay') view = () => viewPay(parts[1]);
  else if (parts[0] === 'loan' && parts[2] === 'visit') view = () => viewVisit(parts[1]);
  else if (parts[0] === 'loan') view = () => viewLoan(parts[1]);
  else if (parts[0] === 'receipt') view = () => viewReceipt(parts[1], parts[2]);
  else view = viewNotFound;
  renderNav(tab);
  let html = view();
  if (html instanceof Promise) {
    if (!keepScroll) $app.innerHTML = `${header('Loading…')}<p class="empty">Loading…</p>`;
    html = await html;
    if (seq !== routeSeq) return; // navigated away meanwhile
  }
  const y = window.scrollY;
  revokeSlipUrls();
  $app.innerHTML = html;
  hydrateSlips();
  hydrateStorage();
  window.scrollTo(0, keepScroll ? y : 0);
}

/** Live updates: refresh the screen when server data changes, unless the user is mid-form. */
store.onChange((reason) => {
  if (reason === 'session') return route();
  const pill = document.getElementById('net-pill');
  if (pill) pill.innerHTML = netPill();
  if (reason !== 'data') return;
  const hash = location.hash.replace(/^#\/?/, '');
  const busy = document.activeElement?.matches?.('input, textarea, select');
  if (!FORM_ROUTES.test(hash) && !busy) route({ keepScroll: true });
});

// ---------- events ----------

async function savePayment(form, data) {
  const loan = store.getLoan(form.dataset.loan);
  const amount = money(Number(data.amount));
  const isDeposit = data.mode === BANK_DEPOSIT;
  const file = form.slip.files[0];
  const slipNo = String(data.slipNo || '').trim();
  const bank = String(data.bank || '').trim();
  const $err = form.querySelector('#pay-error');
  const needsRef = !isDeposit && data.mode !== 'Cash' && !String(data.reference || '').trim();
  const err =
    validatePayment(loan, Number(data.amount)) ||
    (isDeposit && validateDeposit({ slipNo, bank, depositDate: data.depositDate, hasSlip: !!file }, store.getState().loans)) ||
    (needsRef && `Enter the ${data.mode} reference number.`);
  if (err) {
    $err.textContent = err;
    return;
  }
  const prompt = isDeposit
    ? `Record bank deposit of ${formatINR(amount)} by ${loan.borrower.name} (slip ${slipNo})? A supervisor will verify it.`
    : `Confirm collection of ${formatINR(amount)} by ${data.mode} from ${loan.borrower.name}?`;
  if (!confirm(prompt)) return;
  const btn = form.querySelector('[type=submit]');
  const label = btn.textContent;
  btn.disabled = true;
  const id = store.uid('p');
  let savedSlip = false;
  try {
    if (isDeposit) {
      btn.textContent = 'Saving slip…';
      await putSlip(id, await prepareSlip(file));
      savedSlip = true;
    }
    btn.textContent = 'Capturing location…';
    const loc = await getPosition(5000);
    btn.textContent = 'Sending to server…';
    const p = store.recordPayment(loan.id, {
      id, amount, mode: data.mode, reference: isDeposit ? slipNo : data.reference?.trim(), location: loc,
      deposit: isDeposit ? { slipNo, bank, depositDate: data.depositDate } : null,
    });
    const result = await sendNow(p.id);
    if (result.error) {
      if (savedSlip) deleteSlip(id).catch(() => {});
      $err.textContent = `Server did not accept this: ${result.error}`;
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    const kind = isDeposit ? 'Acknowledgement' : 'Receipt';
    toast(result === 'sent' ? `${kind} ${p.receiptNo} issued · saved on server` : `${kind} ${p.receiptNo} issued · server unreachable, will send automatically`, result === 'sent' ? 'ok' : 'warn');
    location.hash = `#/receipt/${loan.id}/${p.id}`;
  } catch (e2) {
    if (savedSlip) deleteSlip(id).catch(() => {});
    $err.textContent = e2.message || 'Could not save the payment.';
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveVisit(form, data) {
  const $err = form.querySelector('#visit-error');
  if (data.outcome === 'PTP' && (!data.ptpDate || !(Number(data.ptpAmount) > 0))) {
    $err.textContent = 'Enter the promised date and amount.';
    return;
  }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Capturing location…';
  const loc = await getPosition(5000);
  btn.textContent = 'Sending to server…';
  const v = store.recordVisit(form.dataset.loan, {
    outcome: data.outcome,
    notes: data.notes.trim(),
    ptpDate: data.ptpDate || null,
    ptpAmount: data.ptpAmount ? money(Number(data.ptpAmount)) : null,
    followUpDate: data.followUpDate || null,
    location: loc,
  });
  const result = await sendNow(v.id);
  if (result.error) {
    $err.textContent = `Server did not accept this: ${result.error}`;
    btn.disabled = false;
    btn.textContent = 'Save visit';
    return;
  }
  toast(result === 'sent' ? 'Visit saved on server' : 'Visit saved on phone · will send automatically', result === 'sent' ? 'ok' : 'warn');
  location.hash = `#/loan/${form.dataset.loan}`;
}

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));

  if (await supervisor.handleSubmit(form, data)) return;
  if (form.id === 'pay-form') return savePayment(form, data);
  if (form.id === 'visit-form') return saveVisit(form, data);
  if (form.id === 'login-form') {
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    try {
      await store.login(data.code, data.pin);
      location.hash = '#/';
      install.protectStorage().catch(() => {});
    } catch (err) {
      form.querySelector('#login-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  }
});

document.addEventListener('click', async (e) => {
  // Tapping the tab you're already on reloads it (e.g. to pull new deposits into the queue).
  const tabLink = e.target.closest('#nav a');
  if (tabLink && tabLink.getAttribute('href') === (location.hash || '#/')) {
    route();
    return;
  }
  const el = e.target.closest('[data-action],[data-fill],[data-bucket],[data-bucket-link],[data-reason]');
  if (!el) return;
  if (await supervisor.handleClick(el)) return;

  if (el.dataset.fill) {
    el.closest('form').amount.value = el.dataset.fill;
    return;
  }
  if (el.dataset.bucket) {
    accountsFilter.bucket = el.dataset.bucket;
    route();
    return;
  }
  if (el.dataset.bucketLink) {
    accountsFilter = { q: '', bucket: el.dataset.bucketLink };
    return; // the link itself navigates to #/accounts
  }

  switch (el.dataset.action) {
    case 'locate': {
      el.textContent = 'Locating…';
      const pos = await getPosition();
      if (!pos) toast('Could not get your location', 'bad');
      route();
      break;
    }
    case 'print':
      window.print();
      break;
    case 'share-receipt': {
      const loan = store.getLoan(el.dataset.loan);
      const p = loan.payments.find((x) => x.id === el.dataset.payment);
      const st = loanStatus(loan, isoDate());
      const text = p.deposit
        ? `Ack ${p.receiptNo}: Your bank deposit of ${formatINR(p.amount)} (slip ${p.deposit.slipNo}, ${p.deposit.bank}, ${fmtDate(p.deposit.depositDate)}) towards loan ${loan.loanNo} has been recorded and is pending verification. Balance outstanding ${formatINR(st.outstanding)}.`
        : `Receipt ${p.receiptNo}: Received ${formatINR(p.amount)} (${p.mode}) towards loan ${loan.loanNo} on ${fmtDate(p.at)} ${fmtTime(p.at)}. Balance outstanding ${formatINR(st.outstanding)}. Thank you.`;
      if (navigator.share) {
        navigator.share({ title: 'Payment receipt', text }).catch(() => {});
      } else {
        location.href = `sms:${loan.borrower.phone}?body=${encodeURIComponent(text)}`;
      }
      break;
    }
    case 'export-csv': {
      const today = isoDate();
      download(`collections-${store.user().code}-${today}.csv`, collectionsCSV(store.getState().loans, today), 'text/csv');
      break;
    }
    case 'sync': {
      el.disabled = true;
      const n = await store.flush().catch(() => 0);
      const left = store.getState().outbox.length;
      toast(left ? `Sent ${n}; ${plural(left, 'record')} still waiting — server unreachable` : `Sent ${plural(n, 'record')}`, left ? 'bad' : 'ok');
      route();
      break;
    }
    case 'refresh':
      el.disabled = true;
      try {
        await store.refresh();
        toast('Up to date');
      } catch (err) {
        toast(err.message, 'bad');
      }
      route();
      break;
    case 'dismiss-rejected':
      store.dismissRejected(el.dataset.id);
      break;
    case 'install':
      if (await install.promptInstall()) toast('Installing…');
      route();
      break;
    case 'dismiss-install':
      install.dismissBanner();
      route();
      break;
    case 'logout':
      if (!confirm('Log out of this phone?')) break;
      try {
        await store.logout();
        location.hash = '#/';
      } catch (err) {
        toast(err.message, 'bad');
      }
      break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    accountsFilter.q = e.target.value;
    const pos = e.target.selectionStart;
    route({ keepScroll: true }).then(() => {
      const input = document.getElementById('search');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    });
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.form?.id === 'pay-form') document.getElementById('pay-error').textContent = '';
  if (t.name === 'mode' && t.form?.id === 'pay-form') {
    document.getElementById('ref-wrap').hidden = t.value === 'Cash' || t.value === BANK_DEPOSIT;
    document.getElementById('deposit-fields').hidden = t.value !== BANK_DEPOSIT;
    t.form.querySelector('[type=submit]').textContent =
      t.value === BANK_DEPOSIT ? 'Save deposit & issue acknowledgement' : 'Confirm & issue receipt';
  }
  if (t.name === 'slip' && t.form?.id === 'pay-form') {
    const file = t.files[0];
    const box = document.getElementById('slip-preview');
    revokeSlipUrls();
    if (!file) box.textContent = '📷 Take photo or choose file';
    else if (file.type.startsWith('image/')) box.innerHTML = `<img src="${trackUrl(URL.createObjectURL(file))}" alt="Deposit slip preview"><span>Tap to retake</span>`;
    else box.textContent = `📄 ${file.name} — tap to change`;
  }
  if (t.name === 'outcome' && t.form?.id === 'visit-form') {
    const show = t.value === 'PTP';
    const box = document.getElementById('ptp-fields');
    box.hidden = !show;
    box.querySelectorAll('input').forEach((i) => (i.required = show));
  }
});

window.addEventListener('hashchange', () => route());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

install.onInstallChange(() => {
  const h = location.hash;
  if (h === '' || h === '#/' || h === '#/settings') route();
});
install.protectStorage().catch(() => {});

store.startAutoSync();
route();
if (store.getState().session && !store.getState().session.expired) {
  store.refresh().then(() => store.flush()).catch(() => {});
}
