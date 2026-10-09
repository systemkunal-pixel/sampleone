import {
  VISIT_OUTCOMES, PAYMENT_MODES, DPD_BUCKETS, BANK_DEPOSIT,
  isoDate, addDays, daysBetween, formatINR, money, loanStatus, allocate, activePromise, visitList,
  validatePayment, validateDeposit, distanceKm, daySummary, portfolioSummary, collectionsCSV, outcomeLabel,
} from './logic.js';
import * as store from './store.js';
import { prepareSlip, putSlip, deleteSlip } from './slips.js';
import * as install from './install.js';
import * as supervisor from './supervisor.js';
import { viewHelp, viewHelpTopic, setHelpQuery } from './help.js';
import { loadHelpLang } from '../help/content.js';
import { t, tr, loadLang, setLang, getLang, langSelect } from '../i18n/i18n.js';
import {
  esc, plural, toast, fmtDate, fmtTime, fmtWhen, netPill, header, verificationTag, decisionLine,
  trackUrl, revokeSlipUrls, hydrateSlips, viewNotFound,
} from './ui.js';

/*
 * Labels that come from logic.js (shared with the server) and are translated where they are shown.
 * i18n: t('Cash') t('UPI') t('Cheque') t('Bank transfer') t('Bank deposit')
 * i18n: t('Paid in full') t('Partial payment') t('Promise to pay') t('Borrower not available') t('Door locked')
 *       t('Refused to pay') t('Disputes the dues') t('Shifted / not traceable')
 * i18n: t('Current') t('1–30 DPD') t('31–60 DPD') t('61–90 DPD') t('90+ DPD (NPA)')
 * Validation messages from logic.js (shown with tr(), which also matches the {placeholder} keys):
 * i18n: t('Enter an amount greater than zero.') t('Amount can have at most two decimal places.')
 *       t('Amount exceeds total outstanding of {amount}.') t('Attach a photo of the deposit slip.')
 *       t('Enter the slip / journal number printed on the slip.') t('Enter the bank and branch where it was deposited.')
 *       t('Enter the deposit date.') t('Deposit date cannot be in the future.')
 *       t('Deposit is more than 90 days old — refer it to the branch.')
 *       t('Slip {slip} is already recorded on {loan} ({name}).')
 */

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

let here = null; // last known officer location
let accountsFilter = { q: '', bucket: 'all' };
const SEND_WAIT_MS = 8000; // how long a save waits for the server before falling back to the outbox

// Tab labels are translated in renderNav: t('Today') t('Accounts') t('Summary') t('Settings') t('Deposits')
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
  if (st.closed) return `<span class="badge b-closed">${t('Closed')}</span>`;
  return `<span class="badge b-${esc(st.bucket.key)}">${st.overdue > 0 ? t('{n} DPD', { n: st.dpd }) : t('Current')}</span>`;
}

function ptpTag(loan, today) {
  const ptp = activePromise(loan);
  if (!ptp || ptp.kept) return '';
  if (ptp.ptpDate === today) return `<span class="tag tag-warn">${t('PTP due today')}</span>`;
  if (ptp.ptpDate < today) return `<span class="tag tag-bad">${t('Broken PTP')}</span>`;
  return `<span class="tag">${esc(t('PTP {date}', { date: fmtDate(ptp.ptpDate) }))}</span>`;
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
      <div class="muted small">${esc(loan.loanNo)} · ${esc(loan.borrower.village)} ${isOfficer() ? distanceText(loan) : `· ${esc(loan.officerCode || t('unassigned'))}`}</div>
      <div class="row between mt-s">
        <span>${t('Overdue')} <strong class="${st.overdue > 0 ? 'bad' : ''}">${formatINR(st.overdue)}</strong></span>
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
      <div class="setup-lang">${langSelect('', t('Language'))}</div>
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1>LoanDesk</h1>
      <p class="muted small" style="margin-top:-6px">${t('Loan recovery for field teams')}</p>
      <p class="muted">${expired ? t('Your session has expired. Log in again to continue.') : t('Log in with your officer code and PIN.')}</p>
      ${outbox.length ? `<p class="note warn-note">${plural(outbox.length,
        t('1 record on this phone still needs to reach the server. It will be sent as soon as you log in.'),
        t('{n} records on this phone still need to reach the server. They’ll be sent as soon as you log in.'))}</p>` : ''}
      <form id="login-form" class="card form">
        <label>${t('Company code')}<input name="company" maxlength="12" autocapitalize="characters" autocomplete="organization" value="${esc(session?.user?.company?.code || store.rememberedCompany())}" placeholder="${esc(t('e.g. BRMC'))}"></label>
        <label>${t('Officer / supervisor code')}<input name="code" required maxlength="12" autocapitalize="characters" autocomplete="username" value="${esc(session?.user?.code || '')}"></label>
        <label>${t('PIN')}<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" required minlength="4" maxlength="8" autocomplete="current-password"></label>
        <p class="error" id="login-error" role="alert"></p>
        <button class="btn primary big" type="submit">${t('Log in')}</button>
      </form>
      <p class="small"><a href="#/help/sign-in">${t('Trouble signing in?')}</a> · <a href="#/help/install-phone">${t('Install the app')}</a> · <a href="#/help">${t('All help')}</a></p>
    </section>`;
}

// ---------- officer views ----------

const iosSteps = () => t('In Safari, tap the Share button <b>⬆</b>, then <b>Add to Home Screen</b>.');

function installCard() {
  switch (install.installState()) {
    case 'installed':
      return `<p class="small">✅ ${t('Installed on this phone.')}</p>`;
    case 'prompt':
      return `<button class="btn primary" data-action="install">📲 ${t('Install app on this phone')}</button>`;
    case 'ios':
      return `<p class="small">${t('To install: {steps}', { steps: iosSteps() })}</p>`;
    default:
      return `<p class="muted small">${t('To install, open the browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>.')}</p>`;
  }
}

function installBanner() {
  const state = install.installState();
  if (install.bannerDismissed() || (state !== 'prompt' && state !== 'ios')) return '';
  return `<div class="banner">
    <span>📲 ${state === 'prompt' ? t('Install this app for one-tap access and full offline use.') : t('Install this app: {steps}', { steps: iosSteps() })}</span>
    <span class="banner-actions">
      ${state === 'prompt' ? `<button class="btn small primary" data-action="install">${t('Install')}</button>` : ''}
      <button class="btn small" data-action="dismiss-install" aria-label="${esc(t('Dismiss'))}">✕</button>
    </span>
  </div>`;
}

/** Things the officer must act on: records the server refused, deposits a supervisor rejected. */
function alerts(loans, today) {
  const { rejected } = store.getState();
  const refused = rejected.map((r) => `
    <div class="card alert">
      <div class="row between"><strong>${t('Not accepted by server')}</strong><button class="btn small" data-action="dismiss-rejected" data-id="${esc(r.id)}">${t('Dismiss')}</button></div>
      <div class="small">${esc(r.summary)}</div>
      <div class="small bad">${esc(tr(r.error))}</div>
    </div>`);
  const bounced = loans.flatMap((loan) => loan.payments
    .filter((p) => p.deposit?.verification === 'rejected' && p.deposit.verifiedAt && daysBetween(p.deposit.verifiedAt.slice(0, 10), today) <= 7)
    .map((p) => `
      <a class="card alert" href="#/loan/${esc(loan.id)}">
        <strong>${esc(t('Bank deposit rejected · {amount}', { amount: formatINR(p.amount) }))}</strong>
        <div class="small">${esc(t('{name} · slip {slip} — revisit the borrower.', { name: loan.borrower.name, slip: p.deposit.slipNo }))}</div>
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
    ${header(t('Hi, {name}', { name: me.name.split(' ')[0] }), '', 'plan-day')}
    ${installBanner()}
    ${alerts(loans, today)}
    <section class="stats">
      <div class="stat"><span>${t('Collected today')}</span><strong>${formatINR(day.collected)}</strong></div>
      <div class="stat"><span>${t('Visits')}</span><strong>${day.visits.length}</strong></div>
      <div class="stat ${pendingDeposits ? 'warn' : ''}"><span>${t('Deposits unverified')}</span><strong>${pendingDeposits}</strong></div>
      <a class="stat ${outbox.length ? 'warn' : ''}" href="#/settings"><span>${t('Not sent')}</span><strong>${outbox.length}</strong></a>
    </section>
    <section>
      <div class="row between section-head">
        <h2>${t('Visit plan · {n} left', { n: pending.length })}</h2>
        <button class="btn small" data-action="locate">📍 ${t('Near me')}</button>
      </div>
      ${loans.length ? '' : `<p class="empty card">${t('No accounts are assigned to you yet. Contact your branch.')}</p>`}
      ${pending.length ? pending.map((x) => loanCard(x.loan, today)).join('') : loans.length ? `<p class="empty card">${t('No pending visits. Great work!')}</p>` : ''}
      ${done.length ? `<h2 class="mt">${t('Done today · {n}', { n: done.length })}</h2>${done.map((x) => loanCard(x.loan, today, `<span class="tag tag-ok">${t('Visited')}</span>`)).join('')}` : ''}
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
    ${header(isOfficer() ? t('My accounts') : t('Branch accounts'), '', 'find-account')}
    <div class="search"><input id="search" type="search" placeholder="${esc(isOfficer() ? t('Search name, phone, village, loan no.') : t('Search name, phone, village, loan no., officer'))}" value="${esc(accountsFilter.q)}"></div>
    <div class="chips">${chip('all', t('All'))}${DPD_BUCKETS.map((b) => chip(b.key, t(b.label))).join('')}</div>
    <p class="muted small">${plural(rows.length, t('1 account'), t('{n} accounts'))}</p>
    ${rows.map(({ loan }) => loanCard(loan, today)).join('') || `<p class="empty card">${t('No accounts match.')}</p>`}`;
}

function paymentLine(loan, p) {
  const link = `<a href="#/receipt/${esc(loan.id)}/${esc(p.id)}">${esc(p.receiptNo)}</a>`;
  if (!p.deposit) return `${t('{amount} collected', { amount: `<strong class="ok">${formatINR(p.amount)}</strong>` })} · ${esc(t(p.mode))} · ${link}`;
  const struck = p.deposit.verification === 'rejected';
  const amount = `<strong class="${struck ? 'struck' : 'ok'}">${formatINR(p.amount)}</strong>`;
  return `${t('{amount} bank deposit', { amount })} · ${esc(t('slip {slip}', { slip: p.deposit.slipNo }))} · ${link} ${verificationTag(p.deposit)}${decisionLine(p.deposit)}`;
}

function viewLoan(id) {
  const loan = store.getLoan(id);
  if (!loan) return viewNotFound();
  const today = isoDate();
  const st = loanStatus(loan, today);
  const b = loan.borrower;
  const ptp = activePromise(loan);
  const dest = b.lat != null && b.lng != null ? `${b.lat},${b.lng}` : [b.address, b.village].filter(Boolean).join(', ');
  const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  const history = [
    ...loan.payments.map((p) => ({ at: p.at, html: paymentLine(loan, p), synced: p.synced })),
    ...loan.visits.map((v) => ({
      at: v.at,
      html: `${t('Visit:')} <strong>${esc(t(outcomeLabel(v.outcome)))}</strong>${v.outcome === 'PTP' ? ` · ${esc(t('{amount} by {date}', { amount: formatINR(v.ptpAmount), date: fmtDate(v.ptpDate) }))}` : ''}${v.notes ? `<div class="muted small">${esc(v.notes)}</div>` : ''}`,
      synced: v.synced,
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));

  const schedule = allocate(loan);

  return `
    ${header(b.name, isOfficer() ? '#/' : '#/accounts', isOfficer() ? 'collect-payment' : 'branch-view')}
    <section class="card">
      <div class="row between"><span class="muted small">${esc(loan.loanNo)} · ${esc(loan.product)}</span>${bucketBadge(st)}</div>
      <div class="muted small">${esc(b.business)}${isOfficer() ? '' : ` · ${esc(t('officer {code}', { code: loan.officerCode || '—' }))}`}</div>
      <div class="mt-s">${esc(b.address)}, ${esc(b.village)} ${distanceText(loan)}</div>
      <div class="actions mt">
        <a class="btn" href="tel:${esc(b.phone)}">📞 ${t('Call')}</a>
        <a class="btn" href="https://wa.me/91${esc(b.phone)}" target="_blank" rel="noopener">💬 ${t('WhatsApp')}</a>
        <a class="btn" href="${esc(mapUrl)}" target="_blank" rel="noopener">🧭 ${t('Directions')}</a>
      </div>
      ${b.guarantor ? `<div class="muted small mt-s">${esc(t('Guarantor: {name}', { name: b.guarantor.name }))} · <a href="tel:${esc(b.guarantor.phone)}">${esc(b.guarantor.phone)}</a></div>` : ''}
    </section>

    <section class="grid2">
      <div class="stat"><span>${t('Overdue')}</span><strong class="${st.overdue > 0 ? 'bad' : ''}">${formatINR(st.overdue)}</strong><small>${plural(st.overdueInstallments, t('1 EMI'), t('{n} EMIs'))}</small></div>
      <div class="stat"><span>${t('Total outstanding')}</span><strong>${formatINR(st.outstanding)}</strong><small>${t('EMI {amount}', { amount: formatINR(loan.emi) })}</small></div>
      <div class="stat"><span>${t('Next due')}</span><strong>${st.nextDue ? esc(fmtDate(st.nextDue.date)) : '—'}</strong><small>${st.nextDue ? formatINR(st.nextDue.amount) : ''}</small></div>
      <div class="stat"><span>${t('Promise')}</span><strong>${ptp && !ptp.kept ? esc(fmtDate(ptp.ptpDate)) : '—'}</strong><small>${ptp && !ptp.kept ? formatINR(ptp.ptpAmount) : ''}</small></div>
    </section>

    ${isOfficer() ? `
    <div class="actions sticky">
      <a class="btn primary big ${st.closed ? 'disabled' : ''}" href="#/loan/${esc(loan.id)}/pay">${t('Collect payment')}</a>
      <a class="btn big" href="#/loan/${esc(loan.id)}/visit">${t('Log visit')}</a>
    </div>` : ''}

    <section>
      <h2>${t('History')}</h2>
      ${history.length ? `<ul class="timeline">${history.map((h) => `<li><span class="muted small">${esc(fmtWhen(h.at))} ${h.synced ? '' : `<span class="tag tag-warn">${t('Not sent')}</span>`}</span><div>${h.html}</div></li>`).join('')}</ul>` : `<p class="muted">${t('No activity yet.')}</p>`}
    </section>

    <details class="card">
      <summary>${plural(schedule.length, t('Repayment schedule (1 EMI)'), t('Repayment schedule ({n} EMIs)'))}</summary>
      <table class="schedule">
        <thead><tr><th>#</th><th>${t('Due')}</th><th>${t('EMI')}</th><th>${t('Status')}</th></tr></thead>
        <tbody>${schedule.map((r) => `<tr class="${r.pending <= 0 ? 'paid' : r.dueDate <= today ? 'late' : ''}">
          <td>${r.no}</td><td>${esc(fmtDate(r.dueDate))}</td><td>${formatINR(r.amount)}</td>
          <td>${r.pending <= 0 ? t('Paid') : r.paid > 0 ? t('Part ({amount} due)', { amount: formatINR(r.pending) }) : r.dueDate <= today ? t('Overdue') : t('Upcoming')}</td>
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
    ${header(t('Collect payment'), `#/loan/${loan.id}`, 'collect-payment')}
    <form id="pay-form" class="card form" data-loan="${esc(loan.id)}">
      <div class="muted">${esc(loan.borrower.name)} · ${esc(loan.loanNo)}</div>
      <div class="muted small">${t('Overdue {overdue} · Outstanding {outstanding}', { overdue: formatINR(st.overdue), outstanding: formatINR(st.outstanding) })}</div>
      <label>${t('Amount (₹)')}<input name="amount" type="number" inputmode="decimal" step="0.01" min="1" max="${st.outstanding}" required value="${st.overdue || ''}"></label>
      <div class="chips">${quick.map((v) => `<button type="button" class="chip" data-fill="${v}">${formatINR(v)}</button>`).join('')}</div>
      <fieldset class="modes"><legend>${t('Mode')}</legend>
        ${PAYMENT_MODES.filter((m) => m !== BANK_DEPOSIT || store.getState().features?.bank_deposits !== false).map((m, i) => `<label class="radio"><input type="radio" name="mode" value="${esc(m)}" ${i === 0 ? 'checked' : ''}> ${esc(t(m))}</label>`).join('')}
      </fieldset>
      <label id="ref-wrap" hidden>${t('Reference / UTR / Cheque no.')}<input name="reference" autocomplete="off"></label>
      <div id="deposit-fields" class="form" hidden>
        <p class="note">${t('Borrower paid directly at the bank. Photograph the counterfoil / pay-in slip and enter the details exactly as printed. A supervisor verifies it against the bank.')}</p>
        <label class="slip-pick">
          <span id="slip-preview" class="slip-preview">📷 ${t('Take photo or choose file')}</span>
          <input name="slip" type="file" accept="image/*,application/pdf" capture="environment" hidden>
        </label>
        <label>${t('Slip / journal no.')}<input name="slipNo" autocomplete="off" autocapitalize="characters"></label>
        <label>${t('Bank & branch')}<input name="bank" autocomplete="off" placeholder="${esc(t('e.g. SBI, Chinhat'))}"></label>
        <label>${t('Deposit date')}<input name="depositDate" type="date" max="${isoDate()}" min="${addDays(isoDate(), -90)}" value="${isoDate()}"></label>
      </div>
      <p class="error" id="pay-error" role="alert"></p>
      <button class="btn primary big" type="submit">${t('Confirm & issue receipt')}</button>
    </form>`;
}

function viewVisit(id) {
  const loan = store.getLoan(id);
  if (!loan || !isOfficer()) return viewNotFound();
  const today = isoDate();
  return `
    ${header(t('Log visit'), `#/loan/${loan.id}`, 'log-visit')}
    <form id="visit-form" class="card form" data-loan="${esc(loan.id)}">
      <div class="muted">${esc(loan.borrower.name)} · ${esc(loan.loanNo)}</div>
      <label>${t('Outcome')}
        <select name="outcome" required>
          <option value="" disabled selected>${t('Select outcome…')}</option>
          ${VISIT_OUTCOMES.filter((o) => !['PAID', 'PARTIAL'].includes(o.code)).map((o) => `<option value="${o.code}">${esc(t(o.label))}</option>`).join('')}
        </select>
      </label>
      <p class="muted small">${t('Collected money? Use <a href="{href}">Collect payment</a> instead — it counts as today’s visit and issues a receipt.', { href: `#/loan/${esc(loan.id)}/pay` })}</p>
      <div id="ptp-fields" hidden>
        <label>${t('Promised date')}<input name="ptpDate" type="date" min="${today}" max="${addDays(today, 30)}"></label>
        <label>${t('Promised amount (₹)')}<input name="ptpAmount" type="number" inputmode="decimal" min="1" step="0.01" value="${loan.emi}"></label>
      </div>
      <label>${t('Next follow-up')}<input name="followUpDate" type="date" min="${today}"></label>
      <label>${t('Notes')}<textarea name="notes" rows="3" maxlength="500" placeholder="${esc(t('What did the borrower say? Who did you meet?'))}"></textarea></label>
      <p class="error" id="visit-error" role="alert"></p>
      <button class="btn primary big" type="submit">${t('Save visit')}</button>
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
    ${header(d ? t('Acknowledgement') : t('Receipt'), `#/loan/${loan.id}`, d ? 'record-bank-deposit' : 'share-receipt')}
    <p class="sync-line ${p.synced ? 'ok' : 'warn'}">${p.synced ? `✓ ${t('Received by server')}` : `⏳ ${t('Saved on this phone — sends automatically when the server is reachable')}`}</p>
    <section class="card receipt" id="receipt">
      <div class="center"><strong>${d ? t('BANK DEPOSIT ACKNOWLEDGEMENT') : t('PAYMENT RECEIPT')}</strong><div class="muted small">${esc(t('{branch} branch', { branch: loan.branch || me.branch }))}</div></div>
      <dl>
        <dt>${d ? t('Ack. no.') : t('Receipt no.')}</dt><dd>${esc(p.receiptNo)}</dd>
        <dt>${d ? t('Recorded') : t('Date & time')}</dt><dd>${esc(fmtWhen(p.at))}</dd>
        <dt>${t('Borrower')}</dt><dd>${esc(loan.borrower.name)}</dd>
        <dt>${t('Loan no.')}</dt><dd>${esc(loan.loanNo)}</dd>
        <dt>${t('Amount')}</dt><dd class="amount">${formatINR(p.amount)}</dd>
        ${d ? `
        <dt>${t('Deposited at')}</dt><dd>${esc(d.bank)}</dd>
        <dt>${t('Deposit date')}</dt><dd>${esc(fmtDate(d.depositDate))}</dd>
        <dt>${t('Slip no.')}</dt><dd>${esc(d.slipNo)}</dd>
        <dt>${t('Status')}</dt><dd>${verificationTag(d)}</dd>` : `
        <dt>${t('Mode')}</dt><dd>${esc(t(p.mode))}${p.reference ? ` (${esc(p.reference)})` : ''}</dd>`}
        <dt>${t('Balance outstanding')}</dt><dd>${formatINR(st.outstanding)}</dd>
        <dt>${d ? t('Recorded by') : t('Collected by')}</dt><dd>${esc(by)}</dd>
      </dl>
      ${d ? `${decisionLine(d)}<p class="muted small center">${t('Credit is subject to verification of the deposit with the bank.')}</p>
        <div class="slip-view" data-slip="${esc(p.id)}"><span class="muted small">${t('Loading slip…')}</span></div>` : ''}
      ${p.location ? `<div class="muted small center">${t('GPS {lat}, {lng}', { lat: p.location.lat.toFixed(5), lng: p.location.lng.toFixed(5) })}</div>` : ''}
    </section>
    <div class="actions">
      <button class="btn" data-action="share-receipt" data-loan="${esc(loan.id)}" data-payment="${esc(p.id)}">📤 ${t('Share / SMS')}</button>
      <button class="btn" data-action="print">🖨 ${t('Print')}</button>
      <a class="btn primary" href="#/">${t('Done')}</a>
    </div>`;
}

function viewSummary() {
  const { loans } = store.getState();
  const today = isoDate();
  const day = daySummary(loans, today);
  const pf = portfolioSummary(loans, today);
  const maxCount = Math.max(1, ...pf.buckets.map((b) => b.count));
  return `
    ${header(isOfficer() ? t('Summary') : t('Branch summary'), '', isOfficer() ? 'end-of-day' : 'branch-view')}
    <section class="card">
      <h2>${esc(t('Today · {date}', { date: fmtDate(today) }))}</h2>
      <div class="big-number">${formatINR(day.collected)}</div>
      <div class="muted small">${plural(day.payments.length, t('1 receipt'), t('{n} receipts'))} · ${plural(day.visits.length, t('1 visit'), t('{n} visits'))} · ${plural(day.ptpCount, t('1 promise'), t('{n} promises'))}</div>
      ${Object.keys(day.byMode).length ? `<table class="kv mt">${Object.entries(day.byMode).map(([m, v]) => `<tr><td>${esc(t(m))}</td><td>${formatINR(v)}</td></tr>`).join('')}</table>` : ''}
      ${Object.keys(day.byOutcome).length ? `<h3 class="mt">${t('Visit outcomes')}</h3><table class="kv">${Object.entries(day.byOutcome).map(([o, n]) => `<tr><td>${esc(t(outcomeLabel(o)))}</td><td>${n}</td></tr>`).join('')}</table>` : ''}
      <div class="actions mt"><button class="btn" data-action="export-csv">⬇ ${t('Export today (CSV)')}</button></div>
    </section>
    <section class="card">
      <h2>${t('Portfolio')}</h2>
      <div class="grid2">
        <div class="stat"><span>${t('Total overdue')}</span><strong class="bad">${formatINR(pf.overdue)}</strong></div>
        <div class="stat"><span>${t('Total outstanding')}</span><strong>${formatINR(pf.outstanding)}</strong></div>
      </div>
      <div class="bars mt">
        ${pf.buckets.map((b) => `
          <a class="bar-row" href="#/accounts" data-bucket-link="${esc(b.key)}">
            <span class="bar-label">${esc(t(b.label))}</span>
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
  el.innerHTML = `${persisted ? `🔒 ${t('Storage protected — the phone will not auto-clear app data.')}` : `⚠️ ${t('Storage not yet protected. Installing the app usually fixes this.')}`}${quota ? `<br>${esc(t('Using {used} of {total} available.', { used: mb(usage), total: mb(quota) }))}` : ''}`;
}

function viewSettings() {
  const { outbox, lastSyncAt } = store.getState();
  const me = store.user();
  const status = {
    online: t('Connected — records are sent the moment you save them.'),
    syncing: t('Sending records…'),
    pending: t('Server not accepting records right now ({reason}). Retrying automatically.', { reason: tr(store.net.message) }),
    offline: t('Server unreachable — no signal or server maintenance. Keep working; records are kept on this phone and sent automatically.'),
  }[store.net.status] || t('Checking connection…');
  return `
    ${header(t('Settings'), '', 'work-offline')}
    <section class="card">
      <h2>${esc(me.name)}</h2>
      <p class="muted small">${esc(me.code)} · ${me.role === 'officer' ? t('Field officer') : t('Supervisor')} · ${esc(me.branch)}</p>
      ${me.company ? `<p class="muted small">${esc(me.company.name)} · ${esc(t('company code {code}', { code: me.company.code }))}</p>` : ''}
    </section>
    <section class="card">
      <h2>${t('Connection')} ${netPill()}</h2>
      <p class="small">${esc(status)}</p>
      <p class="muted small">${esc(plural(outbox.length, t('1 record waiting · last sent {when}'), t('{n} records waiting · last sent {when}'), { when: lastSyncAt ? fmtWhen(lastSyncAt) : '—' }))}</p>
      <div class="actions">
        ${outbox.length ? `<button class="btn primary" data-action="sync">⟳ ${t('Send now')}</button>` : ''}
        <button class="btn" data-action="refresh">↻ ${t('Refresh from server')}</button>
      </div>
    </section>
    <section class="card">
      <h2>${t('Language')}</h2>
      <p class="muted small">${t('Choose the language for the app and the help guides.')}</p>
      ${langSelect('wide', t('Language'))}
    </section>
    <section class="card">
      <h2>${t('Help & guides')}</h2>
      <p class="muted small">${t('Step-by-step guides for every task, a daily routine and answers to common problems. Works offline.')}</p>
      <a class="btn primary" href="#/help">📖 ${t('Open help')}</a>
    </section>
    <section class="card">
      <h2>${t('App')}</h2>
      ${installCard()}
      <p class="muted small mt-s" data-storage>${t('Checking storage…')}</p>
    </section>
    <section class="card">
      <button class="btn danger" data-action="logout">${t('Log out')}</button>
      ${outbox.length ? `<p class="muted small mt-s">${t('You can log out once all records have reached the server.')}</p>` : ''}
    </section>`;
}

// ---------- router ----------

let routeSeq = 0;
const FORM_ROUTES = /^(loan\/[^/]+\/(pay|visit)|deposit\/)/;

function renderNav(tab) {
  const items = NAV[store.user().role] || [];
  $nav.innerHTML = items.map(([href, key, icon, label]) =>
    `<a href="${href}" data-tab="${key}" class="${key === tab ? 'active' : ''}"><span>${icon}</span>${esc(t(label))}</a>`).join('');
  $nav.hidden = false;
}

async function route({ keepScroll = false } = {}) {
  const seq = ++routeSeq;
  const { session } = store.getState();
  const helpMatch = /^#\/help(?:\/([a-z0-9-]+))?$/.exec(location.hash);
  if (!session || session.expired) {
    $nav.hidden = true;
    $app.innerHTML = helpMatch ? (helpMatch[1] ? viewHelpTopic(helpMatch[1]) : viewHelp()) : viewLogin();
    if (helpMatch) window.scrollTo(0, 0);
    return;
  }
  if (store.user().role === 'admin') {
    $nav.hidden = true;
    $app.innerHTML = `${header(t('Admin account'))}
      <section class="card"><p>${t('Admin accounts don’t use the field app.')}</p>
        <div class="actions"><a class="btn primary" href="admin/">${t('Open the admin console')}</a><button class="btn" data-action="logout">${t('Log out')}</button></div></section>`;
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
  else if (parts[0] === 'help') [view, tab] = [() => (parts[1] ? viewHelpTopic(parts[1]) : viewHelp()), 'settings'];
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
    if (!keepScroll) $app.innerHTML = `${header(t('Loading…'))}<p class="empty">${t('Loading…')}</p>`;
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
    (needsRef && t('Enter the {mode} reference number.', { mode: t(data.mode) }));
  if (err) {
    $err.textContent = tr(err);
    return;
  }
  const prompt = isDeposit
    ? t('Record bank deposit of {amount} by {name} (slip {slip})? A supervisor will verify it.', { amount: formatINR(amount), name: loan.borrower.name, slip: slipNo })
    : t('Confirm collection of {amount} by {mode} from {name}?', { amount: formatINR(amount), mode: t(data.mode), name: loan.borrower.name });
  if (!confirm(prompt)) return;
  const btn = form.querySelector('[type=submit]');
  const label = btn.textContent;
  btn.disabled = true;
  const id = store.uid('p');
  let savedSlip = false;
  try {
    if (isDeposit) {
      btn.textContent = t('Saving slip…');
      await putSlip(id, await prepareSlip(file));
      savedSlip = true;
    }
    btn.textContent = t('Capturing location…');
    const loc = await getPosition(5000);
    btn.textContent = t('Sending to server…');
    const p = store.recordPayment(loan.id, {
      id, amount, mode: data.mode, reference: isDeposit ? slipNo : data.reference?.trim(), location: loc,
      deposit: isDeposit ? { slipNo, bank, depositDate: data.depositDate } : null,
    });
    const result = await sendNow(p.id);
    if (result.error) {
      if (savedSlip) deleteSlip(id).catch(() => {});
      $err.textContent = t('Server did not accept this: {error}', { error: tr(result.error) });
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    const no = { no: p.receiptNo };
    const msg = isDeposit
      ? result === 'sent' ? t('Acknowledgement {no} issued · saved on server', no) : t('Acknowledgement {no} issued · server unreachable, will send automatically', no)
      : result === 'sent' ? t('Receipt {no} issued · saved on server', no) : t('Receipt {no} issued · server unreachable, will send automatically', no);
    toast(msg, result === 'sent' ? 'ok' : 'warn');
    location.hash = `#/receipt/${loan.id}/${p.id}`;
  } catch (e2) {
    if (savedSlip) deleteSlip(id).catch(() => {});
    $err.textContent = tr(e2.message) || t('Could not save the payment.');
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveVisit(form, data) {
  const $err = form.querySelector('#visit-error');
  if (data.outcome === 'PTP' && (!data.ptpDate || !(Number(data.ptpAmount) > 0))) {
    $err.textContent = t('Enter the promised date and amount.');
    return;
  }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = t('Capturing location…');
  const loc = await getPosition(5000);
  btn.textContent = t('Sending to server…');
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
    $err.textContent = t('Server did not accept this: {error}', { error: tr(result.error) });
    btn.disabled = false;
    btn.textContent = t('Save visit');
    return;
  }
  toast(result === 'sent' ? t('Visit saved on server') : t('Visit saved on phone · will send automatically'), result === 'sent' ? 'ok' : 'warn');
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
    btn.textContent = t('Logging in…');
    try {
      await store.login(data.company, data.code, data.pin);
      location.hash = '#/';
      install.protectStorage().catch(() => {});
    } catch (err) {
      form.querySelector('#login-error').textContent = tr(err.message);
      btn.disabled = false;
      btn.textContent = t('Log in');
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
      el.textContent = t('Locating…');
      const pos = await getPosition();
      if (!pos) toast(t('Could not get your location'), 'bad');
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
        ? t('Ack {no}: Your bank deposit of {amount} (slip {slip}, {bank}, {date}) towards loan {loan} has been recorded and is pending verification. Balance outstanding {balance}.', {
          no: p.receiptNo, amount: formatINR(p.amount), slip: p.deposit.slipNo, bank: p.deposit.bank,
          date: fmtDate(p.deposit.depositDate), loan: loan.loanNo, balance: formatINR(st.outstanding),
        })
        : t('Receipt {no}: Received {amount} ({mode}) towards loan {loan} on {date} {time}. Balance outstanding {balance}. Thank you.', {
          no: p.receiptNo, amount: formatINR(p.amount), mode: t(p.mode), loan: loan.loanNo,
          date: fmtDate(p.at), time: fmtTime(p.at), balance: formatINR(st.outstanding),
        });
      if (navigator.share) {
        navigator.share({ title: t('Payment receipt'), text }).catch(() => {});
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
      toast(left
        ? plural(left, t('Sent {sent}; 1 record still waiting — server unreachable'), t('Sent {sent}; {n} records still waiting — server unreachable'), { sent: n })
        : plural(n, t('Sent 1 record'), t('Sent {n} records')), left ? 'bad' : 'ok');
      route();
      break;
    }
    case 'refresh':
      el.disabled = true;
      try {
        await store.refresh();
        toast(t('Up to date'));
      } catch (err) {
        toast(tr(err.message), 'bad');
      }
      route();
      break;
    case 'dismiss-rejected':
      store.dismissRejected(el.dataset.id);
      break;
    case 'install':
      if (await install.promptInstall()) toast(t('Installing…'));
      route();
      break;
    case 'dismiss-install':
      install.dismissBanner();
      route();
      break;
    case 'logout':
      if (!confirm(t('Log out of this phone?'))) break;
      try {
        await store.logout();
        location.hash = '#/';
      } catch (err) {
        toast(tr(err.message), 'bad');
      }
      break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'help-search') {
    setHelpQuery(e.target.value);
    const pos = e.target.selectionStart;
    route({ keepScroll: true }).then(() => {
      const input = document.getElementById('help-search');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    });
    return;
  }
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
  const el = e.target;
  if (el.matches?.('[data-lang-select]')) {
    setLang(el.value);
    return;
  }
  if (el.form?.id === 'pay-form') document.getElementById('pay-error').textContent = '';
  if (el.name === 'mode' && el.form?.id === 'pay-form') {
    document.getElementById('ref-wrap').hidden = el.value === 'Cash' || el.value === BANK_DEPOSIT;
    document.getElementById('deposit-fields').hidden = el.value !== BANK_DEPOSIT;
    el.form.querySelector('[type=submit]').textContent =
      el.value === BANK_DEPOSIT ? t('Save deposit & issue acknowledgement') : t('Confirm & issue receipt');
  }
  if (el.name === 'slip' && el.form?.id === 'pay-form') {
    const file = el.files[0];
    const box = document.getElementById('slip-preview');
    revokeSlipUrls();
    if (!file) box.textContent = `📷 ${t('Take photo or choose file')}`;
    else if (file.type.startsWith('image/')) box.innerHTML = `<img src="${trackUrl(URL.createObjectURL(file))}" alt="${esc(t('Deposit slip preview'))}"><span>${t('Tap to retake')}</span>`;
    else box.textContent = `📄 ${t('{file} — tap to change', { file: file.name })}`;
  }
  if (el.name === 'outcome' && el.form?.id === 'visit-form') {
    const show = el.value === 'PTP';
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

// Load the language (and the help in that language) before the first render.
await loadLang().catch(() => {});
await loadHelpLang(getLang()).catch(() => {});
document.title = t('LoanDesk');

window.addEventListener('langchange', async () => {
  await loadHelpLang(getLang()).catch(() => {});
  document.title = t('LoanDesk');
  route({ keepScroll: true });
});

store.startAutoSync();
route();
if (store.getState().session && !store.getState().session.expired) {
  store.refresh().then(() => store.flush()).catch(() => {});
}
