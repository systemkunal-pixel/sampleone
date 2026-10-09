import { api, download } from '../api.js';
import { esc, icon, inr, num, date, dateTime, toast, confirmDialog, emptyState, helpButton } from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';

const loansCount = (n) => (n === 1 ? t('1 loan') : t('{n} loans', { n: num(n) }));

const MAX_BYTES = 10 * 1024 * 1024;
// Column headings are what the file must contain, so they stay English; the hints are translated where shown.
const FIELD_LABELS = {
  loanNo: 'Loan No', branch: 'Branch', principal: 'Principal', emi: 'EMI', disbursedOn: 'Disbursed On',
  name: 'Borrower Name', phone: 'Phone',
};
/* i18n: t('Unique loan / account number. Re-importing the same number updates the loan.')
   t('Must match the branch of the assigned officer.') t('Active field officer of that branch. Blank = unassigned.')
   t('Defaults to "Loan".') t('Amount disbursed.') t('Installment amount.') t('Date (DD-MM-YYYY or an Excel date).')
   t('Number of installments — needed unless you give an Installments sheet.') t('Needed unless you give an Installments sheet.')
   t('monthly (default), weekly or fortnightly.') t('10-digit mobile; +91 is removed.') t('Shown to the officer.')
   t('Enables directions and "near me".') */
const COLUMNS = [
  ['Loan No', true, 'Unique loan / account number. Re-importing the same number updates the loan.'],
  ['Branch', true, 'Must match the branch of the assigned officer.'],
  ['Officer Code', false, 'Active field officer of that branch. Blank = unassigned.'],
  ['Product', false, 'Defaults to "Loan".'],
  ['Principal', true, 'Amount disbursed.'],
  ['EMI', true, 'Installment amount.'],
  ['Disbursed On', true, 'Date (DD-MM-YYYY or an Excel date).'],
  ['Tenure', false, 'Number of installments — needed unless you give an Installments sheet.'],
  ['First Due Date', false, 'Needed unless you give an Installments sheet.'],
  ['Frequency', false, 'monthly (default), weekly or fortnightly.'],
  ['Borrower Name', true, ''],
  ['Phone', true, '10-digit mobile; +91 is removed.'],
  ['Business, Address, Village', false, 'Shown to the officer.'],
  ['Latitude, Longitude', false, 'Enables directions and "near me".'],
  ['Guarantor Name, Guarantor Phone', false, ''],
];

let state = { step: 'upload', preview: null, result: null };

function steps() {
  const order = ['upload', 'review', 'done'];
  const labels = { upload: t('Upload file'), review: t('Review'), done: t('Imported') };
  const at = order.indexOf(state.step);
  return `<ol class="steps" aria-label="${esc(t('Import progress'))}" style="list-style:none;padding:0">${order.map((s, i) =>
    `<li class="step ${i === at ? 'active' : i < at ? 'done' : ''}" ${i === at ? 'aria-current="step"' : ''}><i>${i < at ? '✓' : i + 1}</i>${labels[s]}</li>`).join('')}</ol>`;
}

function uploadStep(history) {
  return `
    <div class="grid two">
      <section class="card">
        <div class="card-head"><div><h2>${t('Upload loan file')}</h2><p>${t('Excel (.xlsx), CSV or JSON · up to 10 MB / 20,000 loans')}</p></div>
          <button class="btn sm" data-act="template">${icon('download')} ${t('Excel template')}</button></div>
        <div class="card-body">
          <label class="dropzone" id="dropzone" tabindex="0">
            ${icon('sheet')}
            <b>${t('Drop your file here, or click to browse')}</b>
            <span class="muted small">${t('Nothing is saved until you review and confirm.')}</span>
            <input type="file" id="file" accept=".xlsx,.csv,.json,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
          </label>
          <div class="error-box" id="upload-error" role="alert" style="margin-top:12px"></div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>${t('File format')}</h2><p>${t('Headings are matched flexibly — “Loan Account No”, “Customer Name”, “Mobile” all work.')}</p></div></div>
        <div class="card-body">
          <ul class="cols">${COLUMNS.map(([c, req, hint]) => `<li><b>${esc(c)}</b>${req ? ' <span class="req" style="color:var(--bad)">*</span>' : ''}${hint ? `<br><span class="muted small">${esc(t(hint))}</span>` : ''}</li>`).join('')}</ul>
          <div class="info-box" style="margin-top:14px">${icon('sheet')} ${t('For exact schedules, add an <b>Installments</b> sheet with Loan No, Installment No, Due Date and Amount. JSON files may use the API loan format (borrower {…}, installments […]).')}</div>
        </div>
      </section>
    </div>
    ${historyCard(history)}`;
}

function historyCard(history) {
  return `
    <section class="card" style="margin-top:16px">
      <div class="card-head"><div><h2>${t('Import history')}</h2><p>${t('Last 20 imports')}</p></div></div>
      ${history.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>${t('When')}</th><th>${t('File')}</th><th>${t('By')}</th><th class="right">${t('Rows')}</th><th class="right">${t('New')}</th><th class="right">${t('Updated')}</th><th class="right">${t('Skipped')}</th></tr></thead>
        <tbody>${history.map((h) => `<tr>
          <td class="primary" data-label="${esc(t('When'))}"><div class="cell-main">${dateTime(h.at)}</div></td>
          <td data-label="${esc(t('File'))}">${esc(h.file_name)}</td><td data-label="${esc(t('By'))}">${esc(h.user_code)}</td>
          <td class="right num" data-label="${esc(t('Rows'))}">${num(h.total_rows)}</td><td class="right num" data-label="${esc(t('New'))}">${num(h.created)}</td>
          <td class="right num" data-label="${esc(t('Updated'))}">${num(h.updated)}</td><td class="right num" data-label="${esc(t('Skipped'))}">${h.skipped ? `<span class="badge warn">${num(h.skipped)}</span>` : '0'}</td>
        </tr>`).join('')}</tbody></table></div>` : emptyState(t('No imports yet'), t('Your imports will be listed here.'), 'upload')}
    </section>`;
}

const importLabel = (n) => (n === 1 ? t('Import 1 loan') : t('Import {n} loans', { n: num(n) }));

function reviewStep() {
  const p = state.preview;
  if (p.missingHeaders.length) {
    return `
      <section class="card"><div class="card-body stack">
        <div class="error-box">${icon('alert')} ${t('{file} is missing required columns: {columns}.', { file: `<b>${esc(p.fileName)}</b>`, columns: p.missingHeaders.map((h) => `<b>${esc(FIELD_LABELS[h] || h)}</b>`).join(', ') })}</div>
        <p class="muted">${t('Check the heading row of the Loans sheet (it must be the first non-empty row), or start from the Excel template.')}</p>
        <div><button class="btn" data-act="restart">${icon('chevronLeft')} ${t('Choose another file')}</button>
          <button class="btn" data-act="template">${icon('download')} ${t('Excel template')}</button></div>
      </div></section>`;
  }
  const creates = p.rows.filter((r) => r.action === 'create').length;
  const updates = p.rows.length - creates;
  const warned = p.rows.filter((r) => r.warnings.length);
  const tile = (label, value, cls = '') => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${num(value)}</div></div>`;
  return `
    <section class="stat-row" aria-label="${esc(t('Import summary'))}">
      ${tile(t('Rows in file'), p.totalRows)}
      ${tile(t('New loans'), creates)}
      ${tile(t('Updates'), updates)}
      ${tile(t('With warnings'), warned.length, warned.length ? 'attention' : '')}
      ${tile(t('Errors (skipped)'), p.errors.length, p.errors.length ? 'alert' : '')}
    </section>

    ${p.errors.length ? `
    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><div><h2>${p.errors.length === 1 ? t('1 row with errors') : t('{n} rows with errors', { n: num(p.errors.length) })}</h2><p>${t('These rows will be skipped. Fix them in your file and import it again — valid rows can be imported now.')}</p></div>
        <button class="btn sm" data-act="error-report">${icon('download')} ${t('Error report')}</button></div>
      <div class="table-wrap" style="max-height:340px;overflow:auto"><table class="data responsive">
        <thead><tr><th>${t('Row')}</th><th>${t('Loan No')}</th><th>${t('Problems')}</th></tr></thead>
        <tbody>${p.errors.slice(0, 500).map((e) => `<tr>
          <td class="primary nowrap" data-label="${esc(t('Row'))}"><div class="cell-main">${esc(t('{sheet} row {n}', { sheet: e.sheet, n: num(e.rowNo) }))}</div></td>
          <td data-label="${esc(t('Loan No'))}">${esc(e.loanNo || '—')}</td>
          <td data-label="${esc(t('Problems'))}" style="color:var(--bad)">${e.errors.map((m) => esc(tr(m))).join('<br>')}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}

    <section class="card">
      <div class="card-head"><div><h2>${t('Ready to import')}</h2><p>${p.rows.length > 100 ? t('Showing the first 100 of {n}.', { n: num(p.rows.length) }) : `${loansCount(p.rows.length)}.`}</p></div></div>
      ${p.rows.length ? `<div class="table-wrap" style="max-height:480px;overflow:auto"><table class="data responsive">
        <thead><tr><th></th><th>${t('Loan No')}</th><th>${t('Borrower')}</th><th>${t('Branch')}</th><th>${t('Officer')}</th><th class="right">${t('Principal')}</th><th class="right">${t('EMI')}</th><th>${t('Schedule')}</th></tr></thead>
        <tbody>${p.rows.slice(0, 100).map((r) => {
          const l = r.loan;
          const first = l.installments[0]?.dueDate;
          return `<tr>
            <td data-label="${esc(t('Action'))}">${r.action === 'create' ? `<span class="badge ok">${t('New')}</span>` : `<span class="badge info">${t('Update')}</span>`}</td>
            <td class="primary" data-label="${esc(t('Loan No'))}"><div class="cell-main">${esc(l.loanNo)}</div>${r.warnings.map((w) => `<div class="cell-sub" style="color:var(--warn)">⚠ ${esc(tr(w))}</div>`).join('')}</td>
            <td data-label="${esc(t('Borrower'))}">${esc(l.borrower.name)}<div class="cell-sub">${esc(l.borrower.phone)}</div></td>
            <td data-label="${esc(t('Branch'))}">${esc(l.branch)}</td>
            <td data-label="${esc(t('Officer'))}">${l.officerCode ? esc(l.officerCode) : `<span class="badge warn">${t('Unassigned')}</span>`}</td>
            <td class="right num" data-label="${esc(t('Principal'))}">${inr(l.principal)}</td>
            <td class="right num" data-label="${esc(t('EMI'))}">${inr(l.emi)}</td>
            <td data-label="${esc(t('Schedule'))}" class="nowrap">${t('{n} × from {date}', { n: l.installments.length, date: date(first) })}</td></tr>`;
        }).join('')}</tbody></table></div>` : emptyState(t('Nothing to import'), t('Every row has errors. Fix the file and upload it again.'), 'alert')}
      <div class="table-foot">
        <button class="btn" data-act="restart">${icon('chevronLeft')} ${t('Choose another file')}</button>
        <button class="btn primary" data-act="commit" ${p.rows.length ? '' : 'disabled'}>${icon('check')} ${importLabel(p.rows.length)}</button>
      </div>
    </section>`;
}

function doneStep() {
  const r = state.result;
  return `
    <section class="card"><div class="card-body" style="text-align:center;padding:40px 20px">
      <div class="avatar lg" style="margin:0 auto 14px;background:var(--ok-soft);color:var(--ok)">${icon('check')}</div>
      <h2 style="font-size:1.2rem">${t('Import complete')}</h2>
      <p class="muted">${esc(state.preview.fileName)} · ${[
        r.created === 1 ? t('1 new loan') : t('{n} new loans', { n: num(r.created) }),
        r.updated === 1 ? t('1 update') : t('{n} updates', { n: num(r.updated) }),
        ...(r.skipped ? [r.skipped === 1 ? t('1 row skipped') : t('{n} rows skipped', { n: num(r.skipped) })] : []),
      ].join(', ')}.</p>
      <div class="page-actions" style="justify-content:center;margin-top:18px">
        <a class="btn" href="#/loans?officer=__none">${t('Review unassigned loans')}</a>
        <a class="btn" href="#/loans">${t('Go to loans')}</a>
        <button class="btn primary" data-act="restart">${icon('upload')} ${t('Import another file')}</button>
      </div>
    </div></section>`;
}

function errorReportCsv(errors) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const head = [t('Sheet'), t('Row'), t('Loan No'), t('Problems')].map(cell).join(',');
  return [head, ...errors.map((e) => [e.sheet, e.rowNo, e.loanNo || '', e.errors.map(tr).join(' | ')].map(cell).join(','))].join('\r\n');
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error(t('Could not read the file.')));
  r.readAsDataURL(file);
});

export async function render(el, q, alive) {
  if (state.step === 'done') state = { step: 'upload', preview: null, result: null };
  const { imports } = await api('imports');
  if (!alive()) return;

  const draw = () => {
    el.innerHTML = `
      <div class="page-head"><div><h1>${t('Import loans')}</h1><p>${t(`Add new loans or update existing ones from your loan system's export.`)}</p></div>
        <div class="page-actions">${helpButton('import-loans', t('How to import'))}${helpButton('fix-import-errors', t('Fixing errors'))}</div></div>
      ${steps()}
      ${state.step === 'upload' ? uploadStep(imports) : state.step === 'review' ? reviewStep() : doneStep()}`;
    const zone = el.querySelector('#dropzone');
    if (zone) {
      zone.ondragover = (e) => {
        e.preventDefault();
        zone.classList.add('drag');
      };
      zone.ondragleave = () => zone.classList.remove('drag');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('drag');
        if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
      };
      zone.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), el.querySelector('#file').click());
    }
  };

  async function upload(file) {
    const err = el.querySelector('#upload-error');
    err.textContent = '';
    if (!/\.(xlsx|csv|json)$/i.test(file.name)) {
      err.textContent = t('Choose an .xlsx, .csv or .json file. Old .xls files: open in Excel and “Save As” .xlsx.');
      return;
    }
    if (file.size > MAX_BYTES) {
      err.textContent = t('The file is larger than 10 MB. Split it into smaller files.');
      return;
    }
    const zone = el.querySelector('#dropzone');
    zone.innerHTML = `${icon('refresh')}<b>${t('Checking {file}…', { file: esc(file.name) })}</b><span class="muted small">${t('Validating every row against officers and existing loans.')}</span>`;
    try {
      state.preview = await api('import/preview', { method: 'POST', body: { fileName: file.name, base64: await toBase64(file) } });
      state.step = 'review';
      draw();
      window.scrollTo(0, 0);
    } catch (ex) {
      draw();
      el.querySelector('#upload-error').textContent = tr(ex.message);
    }
  }

  draw();
  el.onchange = (e) => e.target.id === 'file' && e.target.files[0] && upload(e.target.files[0]);
  el.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'template') download('import/template', 'loan-import-template.xlsx').catch((ex) => toast(tr(ex.message), 'bad'));
    if (act === 'restart') {
      state = { step: 'upload', preview: null, result: null };
      render(el, q, alive);
    }
    if (act === 'error-report') {
      const url = URL.createObjectURL(new Blob([`﻿${errorReportCsv(state.preview.errors)}`], { type: 'text/csv' }));
      Object.assign(document.createElement('a'), { href: url, download: `import-errors-${state.preview.fileName}.csv` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    if (act === 'commit') {
      const p = state.preview;
      const n = p.rows.length;
      const ask = n === 1 ? t('Import 1 loan from {file}?', { file: esc(p.fileName) }) : t('Import {n} loans from {file}?', { n: num(n), file: esc(p.fileName) });
      const skip = !p.errors.length ? '' : p.errors.length === 1 ? t('1 row with errors will be skipped.') : t('{n} rows with errors will be skipped.', { n: num(p.errors.length) });
      const msg = [ask, skip, t('Officers see their new loans within a minute.')].filter(Boolean).join(' ');
      if (!(await confirmDialog(t('Import loans?'), msg, t('Import')))) return;
      const btn = e.target.closest('button');
      btn.disabled = true;
      btn.textContent = t('Importing…');
      try {
        state.result = await api('import/commit', {
          method: 'POST', body: { fileName: p.fileName, totalRows: p.totalRows, loans: p.rows.map((r) => r.loan) },
        });
        state.step = 'done';
        const done = state.result.created + state.result.updated;
        toast(done === 1 ? t('Imported 1 loan') : t('Imported {n} loans', { n: num(done) }));
        draw();
      } catch (ex) {
        toast(tr(ex.message), 'bad');
        btn.disabled = false;
        btn.innerHTML = `${icon('check')} ${importLabel(p.rows.length)}`;
      }
    }
  };
}
