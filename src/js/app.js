import {
  VISIT_OUTCOMES, PAYMENT_MODES, DPD_BUCKETS, BANK_DEPOSIT,
  isoDate, addDays, formatINR, money, loanStatus, allocate, activePromise, visitList,
  validatePayment, validateDeposit, distanceKm, daySummary, portfolioSummary, collectionsCSV, outcomeLabel,
} from './logic.js';
import * as store from './store.js';
import { prepareSlip, putSlip, getSlip, deleteSlip } from './slips.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');

let here = null; // last known officer location
let accountsFilter = { q: '', bucket: 'all' };

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg, kind = 'ok') {
  $toast.textContent = msg;
  $toast.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.className = 'toast'), 3200);
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function verificationTag(deposit) {
  if (deposit.verification === 'verified') return '<span class="tag tag-ok">Verified</span>';
  if (deposit.verification === 'rejected') return '<span class="tag tag-bad">Rejected</span>';
  return '<span class="tag tag-warn">Pending verification</span>';
}

// Object URLs for slip images, released whenever the view changes.
let slipUrls = [];
const trackUrl = (url) => (slipUrls.push(url), url);
function revokeSlipUrls() {
  slipUrls.forEach((u) => URL.revokeObjectURL(u));
  slipUrls = [];
}

/** Fills [data-slip] placeholders with the stored slip image or PDF link. */
async function hydrateSlips() {
  for (const el of document.querySelectorAll('[data-slip]')) {
    const blob = await getSlip(el.dataset.slip).catch(() => null);
    if (!blob) {
      el.innerHTML = '<span class="muted small">Slip image not available on this device.</span>';
      continue;
    }
    const url = trackUrl(URL.createObjectURL(blob));
    el.innerHTML = blob.type === 'application/pdf'
      ? `<a class="btn" href="${url}" target="_blank" rel="noopener">📄 Open deposit slip (PDF)</a>`
      : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Bank deposit slip"></a>`;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtTime(ts) {
  return ts ? ts.slice(11, 16) : '';
}

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
      <div class="muted small">${esc(loan.loanNo)} · ${esc(loan.borrower.village)} ${distanceText(loan)}</div>
      <div class="row between mt-s">
        <span>Overdue <strong class="${st.overdue > 0 ? 'bad' : ''}">${formatINR(st.overdue)}</strong></span>
        <span class="tags">${ptpTag(loan, today)}${extra}</span>
      </div>
    </a>`;
}

function header(title, back) {
  return `<header class="topbar">
    ${back ? `<a class="back" href="${esc(back)}" aria-label="Back">‹</a>` : ''}
    <h1>${esc(title)}</h1>
    <span class="net ${navigator.onLine ? 'on' : 'off'}" title="Network">${navigator.onLine ? 'Online' : 'Offline'}</span>
  </header>`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- views ----------

function viewSetup() {
  $nav.hidden = true;
  return `
    <section class="setup">
      <div class="logo">₹</div>
      <h1>Loan Recovery</h1>
      <p class="muted">Field officer collections app. Works offline; records sync when you are back in network.</p>
      <form id="setup-form" class="card form">
        <label>Your name<input name="name" required autocomplete="name"></label>
        <label>Officer code<input name="code" required maxlength="6" placeholder="e.g. FO27" autocapitalize="characters"></label>
        <label>Branch<input name="branch" required placeholder="e.g. Lucknow Rural"></label>
        <label class="check"><input type="checkbox" name="demo" checked> Load demo portfolio (12 accounts)</label>
        <button class="btn primary" type="submit">Start</button>
      </form>
    </section>`;
}

function viewToday() {
  const { loans, officer, outbox } = store.getState();
  const today = isoDate();
  const list = visitList(loans, today);
  const day = daySummary(loans, today);
  const visitedToday = new Set(day.visits.map((v) => v.loan.id).concat(day.payments.map((p) => p.loan.id)));
  const pending = list.filter((x) => !visitedToday.has(x.loan.id));
  const done = list.filter((x) => visitedToday.has(x.loan.id));

  return `
    ${header(`Hi, ${officer.name.split(' ')[0]}`)}
    <section class="stats">
      <div class="stat"><span>Collected today</span><strong>${formatINR(day.collected)}</strong></div>
      <div class="stat"><span>Visits</span><strong>${day.visits.length}</strong></div>
      <div class="stat"><span>Promises</span><strong>${day.ptpCount}</strong></div>
      <a class="stat ${outbox.length ? 'warn' : ''}" href="#/settings"><span>To sync</span><strong>${outbox.length}</strong></a>
    </section>
    <section>
      <div class="row between section-head">
        <h2>Visit plan · ${pending.length} left</h2>
        <button class="btn small" data-action="locate">📍 Near me</button>
      </div>
      ${pending.length ? pending.map((x) => loanCard(x.loan, today)).join('') : '<p class="empty card">No pending visits. Great work!</p>'}
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
      return [b.name, b.phone, b.village, loan.loanNo].some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => b.st.dpd - a.st.dpd || b.st.overdue - a.st.overdue);

  const chip = (key, label) =>
    `<button class="chip ${accountsFilter.bucket === key ? 'active' : ''}" data-bucket="${esc(key)}">${esc(label)}</button>`;

  return `
    ${header('Accounts')}
    <div class="search"><input id="search" type="search" placeholder="Search name, phone, village, loan no." value="${esc(accountsFilter.q)}"></div>
    <div class="chips">${chip('all', 'All')}${DPD_BUCKETS.map((b) => chip(b.key, b.label)).join('')}</div>
    <p class="muted small">${rows.length} account${rows.length === 1 ? '' : 's'}</p>
    ${rows.map(({ loan }) => loanCard(loan, today)).join('') || '<p class="empty card">No accounts match.</p>'}`;
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
    ...loan.payments.map((p) => ({
      at: p.at,
      html: p.deposit
        ? `<strong class="ok">${formatINR(p.amount)}</strong> bank deposit · slip ${esc(p.deposit.slipNo)} · <a href="#/receipt/${esc(loan.id)}/${esc(p.id)}">${esc(p.receiptNo)}</a> ${verificationTag(p.deposit)}`
        : `<strong class="ok">${formatINR(p.amount)}</strong> collected · ${esc(p.mode)} · <a href="#/receipt/${esc(loan.id)}/${esc(p.id)}">${esc(p.receiptNo)}</a>`,
      synced: p.synced,
    })),
    ...loan.visits.map((v) => ({
      at: v.at,
      html: `Visit: <strong>${esc(outcomeLabel(v.outcome))}</strong>${v.outcome === 'PTP' ? ` · ${formatINR(v.ptpAmount)} by ${esc(fmtDate(v.ptpDate))}` : ''}${v.notes ? `<div class="muted small">${esc(v.notes)}</div>` : ''}`,
      synced: v.synced,
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));

  const schedule = allocate(loan);

  return `
    ${header(b.name, '#/')}
    <section class="card">
      <div class="row between"><span class="muted small">${esc(loan.loanNo)} · ${esc(loan.product)}</span>${bucketBadge(st)}</div>
      <div class="muted small">${esc(b.business)}</div>
      <div class="mt-s">${esc(b.address)}, ${esc(b.village)} ${distanceText(loan)}</div>
      <div class="actions mt">
        <a class="btn" href="tel:${esc(b.phone)}">📞 Call</a>
        <a class="btn" href="https://wa.me/91${esc(b.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>
        <a class="btn" href="${esc(mapUrl)}" target="_blank" rel="noopener">🧭 Directions</a>
      </div>
      ${b.guarantor ? `<div class="muted small mt-s">Guarantor: ${esc(b.guarantor.name)} · <a href="tel:${esc(b.guarantor.phone)}">${esc(b.guarantor.phone)}</a></div>` : ''}
    </section>

    <section class="grid2">
      <div class="stat"><span>Overdue</span><strong class="${st.overdue > 0 ? 'bad' : ''}">${formatINR(st.overdue)}</strong><small>${st.overdueInstallments} EMI${st.overdueInstallments === 1 ? '' : 's'}</small></div>
      <div class="stat"><span>Total outstanding</span><strong>${formatINR(st.outstanding)}</strong><small>EMI ${formatINR(loan.emi)}</small></div>
      <div class="stat"><span>Next due</span><strong>${st.nextDue ? esc(fmtDate(st.nextDue.date)) : '—'}</strong><small>${st.nextDue ? formatINR(st.nextDue.amount) : ''}</small></div>
      <div class="stat"><span>Promise</span><strong>${ptp && !ptp.kept ? esc(fmtDate(ptp.ptpDate)) : '—'}</strong><small>${ptp && !ptp.kept ? formatINR(ptp.ptpAmount) : ''}</small></div>
    </section>

    <div class="actions sticky">
      <a class="btn primary big ${st.closed ? 'disabled' : ''}" href="#/loan/${esc(loan.id)}/pay">Collect payment</a>
      <a class="btn big" href="#/loan/${esc(loan.id)}/visit">Log visit</a>
    </div>

    <section>
      <h2>History</h2>
      ${history.length ? `<ul class="timeline">${history.map((h) => `<li><span class="muted small">${esc(fmtDate(h.at))} ${esc(fmtTime(h.at))} ${h.synced ? '' : '<span class="tag tag-warn">Not synced</span>'}</span><div>${h.html}</div></li>`).join('')}</ul>` : '<p class="muted">No activity yet.</p>'}
    </section>

    <details class="card">
      <summary>Repayment schedule (${schedule.length} EMIs)</summary>
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
  if (!loan) return viewNotFound();
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
        <p class="note">Borrower paid directly at the bank. Photograph the counterfoil / pay-in slip and enter the details exactly as printed.</p>
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
  if (!loan) return viewNotFound();
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
  const { officer } = store.getState();
  const st = loanStatus(loan, isoDate());
  const d = p.deposit;
  return `
    ${header(d ? 'Acknowledgement' : 'Receipt', `#/loan/${loan.id}`)}
    <section class="card receipt" id="receipt">
      <div class="center"><strong>${d ? 'BANK DEPOSIT ACKNOWLEDGEMENT' : 'PAYMENT RECEIPT'}</strong><div class="muted small">${esc(officer.branch)} branch</div></div>
      <dl>
        <dt>${d ? 'Ack.' : 'Receipt'} no.</dt><dd>${esc(p.receiptNo)}</dd>
        <dt>${d ? 'Recorded' : 'Date &amp; time'}</dt><dd>${esc(fmtDate(p.at))} ${esc(fmtTime(p.at))}</dd>
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
        <dt>${d ? 'Recorded by' : 'Collected by'}</dt><dd>${esc(officer.name)} (${esc(officer.code)})</dd>
      </dl>
      ${d ? `<p class="muted small center">Credit is subject to verification of the deposit with the bank.</p>
        <div class="slip-view" data-slip="${esc(d.slipId)}"><span class="muted small">Loading slip…</span></div>` : ''}
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
    ${header('Summary')}
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

function viewSettings() {
  const { officer, settings, outbox, lastSyncAt } = store.getState();
  return `
    ${header('Settings')}
    <section class="card">
      <h2>Sync</h2>
      <p class="muted small">${outbox.length} record${outbox.length === 1 ? '' : 's'} waiting · last sync ${lastSyncAt ? `${esc(fmtDate(lastSyncAt))} ${esc(fmtTime(lastSyncAt))}` : 'never'}</p>
      <button class="btn primary" data-action="sync" ${outbox.length ? '' : 'disabled'}>⟳ Sync now</button>
      <form id="sync-form" class="form mt">
        <label>Sync endpoint URL<input name="syncUrl" type="url" placeholder="https://api.example.com/field-sync" value="${esc(settings.syncUrl)}"></label>
        <label>Access token<input name="syncToken" type="password" autocomplete="off" value="${esc(settings.syncToken)}"></label>
        <button class="btn" type="submit">Save sync settings</button>
      </form>
    </section>
    <section class="card">
      <h2>Officer profile</h2>
      <form id="profile-form" class="form">
        <label>Name<input name="name" required value="${esc(officer.name)}"></label>
        <label>Officer code<input name="code" required maxlength="6" value="${esc(officer.code)}"></label>
        <label>Branch<input name="branch" required value="${esc(officer.branch)}"></label>
        <button class="btn" type="submit">Save profile</button>
      </form>
    </section>
    <section class="card">
      <h2>Data</h2>
      <div class="actions">
        <button class="btn" data-action="backup">⬇ Backup (JSON)</button>
        <label class="btn">⬆ Restore<input type="file" accept="application/json" id="restore" hidden></label>
        <button class="btn" data-action="demo">Reload demo data</button>
        <button class="btn danger" data-action="reset">Erase all data</button>
      </div>
    </section>`;
}

function viewNotFound() {
  return `${header('Not found', '#/')}<p class="empty card">That record doesn't exist on this device.</p>`;
}

// ---------- router ----------

function route() {
  const state = store.getState();
  const hash = location.hash.replace(/^#/, '') || '/';
  if (!state.officer) {
    $app.innerHTML = viewSetup();
    return;
  }
  $nav.hidden = false;
  const parts = hash.split('/').filter(Boolean);
  let html;
  let tab = '';
  if (!parts.length) [html, tab] = [viewToday(), 'today'];
  else if (parts[0] === 'accounts') [html, tab] = [viewAccounts(), 'accounts'];
  else if (parts[0] === 'summary') [html, tab] = [viewSummary(), 'summary'];
  else if (parts[0] === 'settings') [html, tab] = [viewSettings(), 'settings'];
  else if (parts[0] === 'loan' && parts[2] === 'pay') html = viewPay(parts[1]);
  else if (parts[0] === 'loan' && parts[2] === 'visit') html = viewVisit(parts[1]);
  else if (parts[0] === 'loan') html = viewLoan(parts[1]);
  else if (parts[0] === 'receipt') html = viewReceipt(parts[1], parts[2]);
  else html = viewNotFound();
  revokeSlipUrls();
  $app.innerHTML = html;
  hydrateSlips();
  $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  window.scrollTo(0, 0);
}

// ---------- events ----------

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));

  if (form.id === 'setup-form') {
    store.setupOfficer(
      { name: data.name.trim(), code: data.code.trim().toUpperCase(), branch: data.branch.trim() },
      data.demo === 'on'
    );
    location.hash = '#/';
    route();
  }

  if (form.id === 'pay-form') {
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
      ? `Record bank deposit of ${formatINR(amount)} by ${loan.borrower.name} (slip ${slipNo})? It will be marked pending verification.`
      : `Confirm collection of ${formatINR(amount)} by ${data.mode} from ${loan.borrower.name}?`;
    if (!confirm(prompt)) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    let deposit = null;
    try {
      if (isDeposit) {
        btn.textContent = 'Saving slip…';
        const blob = await prepareSlip(file);
        const slipId = store.uid('slip');
        await putSlip(slipId, blob);
        deposit = { slipId, slipType: blob.type, slipNo, bank, depositDate: data.depositDate };
      }
      btn.textContent = 'Capturing location…';
      const loc = await getPosition(5000);
      const p = store.recordPayment(loan.id, {
        amount,
        mode: data.mode,
        reference: isDeposit ? slipNo : data.reference?.trim(),
        location: loc,
        deposit,
      });
      toast(`${isDeposit ? 'Acknowledgement' : 'Receipt'} ${p.receiptNo} issued`);
      location.hash = `#/receipt/${loan.id}/${p.id}`;
    } catch (e2) {
      if (deposit) deleteSlip(deposit.slipId).catch(() => {});
      $err.textContent = e2.message || 'Could not save the payment.';
      btn.disabled = false;
      btn.textContent = 'Confirm & issue receipt';
    }
  }

  if (form.id === 'visit-form') {
    const $err = form.querySelector('#visit-error');
    if (data.outcome === 'PTP' && (!data.ptpDate || !(Number(data.ptpAmount) > 0))) {
      $err.textContent = 'Enter the promised date and amount.';
      return;
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Capturing location…';
    const loc = await getPosition(5000);
    store.recordVisit(form.dataset.loan, {
      outcome: data.outcome,
      notes: data.notes.trim(),
      ptpDate: data.ptpDate || null,
      ptpAmount: data.ptpAmount ? money(Number(data.ptpAmount)) : null,
      followUpDate: data.followUpDate || null,
      location: loc,
    });
    toast('Visit saved');
    location.hash = `#/loan/${form.dataset.loan}`;
  }

  if (form.id === 'sync-form') {
    store.updateSettings({ syncUrl: data.syncUrl.trim(), syncToken: data.syncToken.trim() });
    toast('Sync settings saved');
  }

  if (form.id === 'profile-form') {
    store.updateOfficer({ name: data.name.trim(), code: data.code.trim().toUpperCase(), branch: data.branch.trim() });
    toast('Profile saved');
    route();
  }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action],[data-fill],[data-bucket],[data-bucket-link]');
  if (!el) return;

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
      download(`collections-${store.getState().officer.code}-${today}.csv`, collectionsCSV(store.getState().loans, today), 'text/csv');
      break;
    }
    case 'sync':
      el.disabled = true;
      try {
        const n = await store.syncNow();
        toast(`Synced ${n} record${n === 1 ? '' : 's'}`);
      } catch (err) {
        toast(err.message, 'bad');
      }
      route();
      break;
    case 'backup':
      download(`loan-recovery-backup-${isoDate()}.json`, store.exportBackup(), 'application/json');
      break;
    case 'demo':
      try {
        if (confirm('Replace the loan book on this device with demo data?')) {
          store.loadDemoData();
          toast('Demo data loaded');
          route();
        }
      } catch (err) {
        toast(err.message, 'bad');
      }
      break;
    case 'reset': {
      const pending = store.getState().outbox.length;
      const msg = pending
        ? `${pending} records are NOT synced and will be lost. Erase everything anyway?`
        : 'Erase all data on this device?';
      if (confirm(msg)) {
        await store.resetAll();
        location.hash = '#/';
        route();
      }
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    accountsFilter.q = e.target.value;
    const pos = e.target.selectionStart;
    route();
    const input = document.getElementById('search');
    input.focus();
    input.setSelectionRange(pos, pos);
  }
});

document.addEventListener('change', async (e) => {
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
  if (t.id === 'restore' && t.files[0]) {
    try {
      store.importBackup(await t.files[0].text());
      toast('Backup restored');
      route();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
});

window.addEventListener('hashchange', route);
window.addEventListener('online', () => {
  route();
  const { outbox, settings } = store.getState();
  if (outbox.length && settings.syncUrl) {
    store.syncNow().then((n) => n && toast(`Back online — synced ${n} records`)).catch(() => {});
  }
});
window.addEventListener('offline', route);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

route();
