// Loan import: reads Excel (.xlsx), CSV or JSON, normalises every row and validates it.
// Column headings are matched loosely ("Loan No", "loan_no", "Loan Account Number" all work).
import ExcelJS from 'exceljs';
import { addMonths, addDays, money } from '../src/js/logic.js';

export const MAX_ROWS = 20000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_INSTALLMENTS = 600;

/** Canonical field → accepted column headings (compared lower-case, letters and digits only). */
export const LOAN_COLUMNS = {
  loanNo: ['loan no', 'loan number', 'loan_no', 'loan account', 'loan account no', 'loan account number', 'account no', 'account number', 'loan id'],
  id: ['id', 'system id', 'internal id'],
  branch: ['branch', 'branch name'],
  officerCode: ['officer code', 'officer', 'field officer', 'fo code', 'assigned officer', 'assigned to', 'collection officer'],
  product: ['product', 'product name', 'scheme', 'loan type'],
  principal: ['principal', 'loan amount', 'sanctioned amount', 'disbursed amount', 'disbursement amount'],
  emi: ['emi', 'emi amount', 'installment amount', 'instalment amount', 'installment'],
  disbursedOn: ['disbursed on', 'disbursement date', 'disbursal date', 'date of disbursement', 'disbursed date'],
  tenure: ['tenure', 'tenure months', 'no of installments', 'number of installments', 'no of emis', 'number of emis', 'installments count'],
  firstDueDate: ['first due date', 'first emi date', 'emi start date', 'first installment date', 'repayment start date'],
  frequency: ['frequency', 'repayment frequency', 'emi frequency'],
  name: ['borrower name', 'borrower', 'customer name', 'customer', 'name', 'member name'],
  phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'phone number', 'contact', 'contact no'],
  business: ['business', 'occupation', 'activity', 'business type'],
  address: ['address', 'house address', 'residential address'],
  village: ['village', 'area', 'locality', 'city', 'town', 'center', 'centre'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'lng', 'long', 'lon'],
  guarantorName: ['guarantor name', 'guarantor', 'co applicant', 'co-applicant'],
  guarantorPhone: ['guarantor phone', 'guarantor mobile', 'co applicant phone'],
};
export const INSTALLMENT_COLUMNS = {
  loanNo: LOAN_COLUMNS.loanNo,
  no: ['installment no', 'instalment no', 'emi no', 'no', 'sr no', 'installment number'],
  dueDate: ['due date', 'emi date', 'installment date', 'date'],
  amount: ['amount', 'emi', 'emi amount', 'installment amount', 'due amount'],
};
const REQUIRED_HEADERS = ['loanNo', 'branch', 'principal', 'emi', 'disbursedOn', 'name', 'phone'];

const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function headerMap(headers, columns) {
  const lookup = new Map();
  for (const [field, aliases] of Object.entries(columns)) for (const a of aliases) lookup.set(key(a), field);
  const map = {};
  headers.forEach((h, i) => {
    const field = lookup.get(key(h));
    if (field && map[field] === undefined) map[field] = i;
  });
  return map;
}

// ---------- value parsing ----------

const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Accepts Excel dates/serials, YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY and 25-Feb-2026. Day comes first (Indian format). */
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null; // Excel serial day numbers for 1954–2119
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) return iso(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) return iso(+m[3], +m[2], +m[1]);
  if ((m = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{4})$/.exec(s))) {
    const mon = MONTHS[m[2].toLowerCase()];
    return mon ? iso(+m[3], mon, +m[1]) : null;
  }
  return null;
}

export function parseAmount(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]|rs\.?|inr/gi, ''));
  return Number.isFinite(n) ? money(n) : NaN;
}

/** Indian mobile: 10 digits starting 6–9; +91 / 0 prefixes are dropped. */
export function parsePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const text = (v, max) => {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
};

/** Excel cells can be rich text, formulas or hyperlinks; reduce them to plain values. */
function cellValue(v) {
  if (v == null || typeof v !== 'object' || v instanceof Date) return v ?? null;
  if ('result' in v) return cellValue(v.result);
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
  if ('text' in v) return v.text;
  if ('error' in v) return null;
  return String(v);
}

// ---------- file readers ----------

function parseCsv(textIn) {
  const s = textIn.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Table rows → [{ rowNo, values: {field: raw} }] using the column map. */
function tableToRecords(table, columns, sheetName) {
  const nonEmpty = (r) => r.some((c) => c != null && String(c).trim() !== '');
  const headerIdx = table.findIndex(nonEmpty);
  if (headerIdx < 0) return { records: [], map: {}, headers: [] };
  const headers = table[headerIdx].map((h) => text(h, 100));
  const map = headerMap(headers, columns);
  const records = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || !nonEmpty(r)) continue;
    const values = {};
    for (const [field, col] of Object.entries(map)) values[field] = r[col];
    records.push({ rowNo: i + 1, sheet: sheetName, values });
  }
  return { records, map, headers };
}

async function readWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw new ImportError('Could not read the Excel file. Save it as .xlsx (Excel Workbook) and try again.');
  }
  const sheets = wb.worksheets.map((ws) => {
    const table = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      table[n - 1] = row.values.slice(1).map(cellValue);
    });
    return { name: ws.name, table: Array.from(table, (r) => r || []) };
  });
  const byName = (re) => sheets.find((s) => re.test(s.name));
  const loansSheet = byName(/^loans?$/i) || sheets.find((s) => !/instal|emi|schedule|instruction|read ?me|help/i.test(s.name));
  const instSheet = byName(/instal|schedule|emi/i);
  if (!loansSheet) throw new ImportError('No "Loans" sheet found in the workbook.');
  return { loans: loansSheet, installments: instSheet };
}

export class ImportError extends Error {}

/**
 * Reads an uploaded file into raw loan records plus optional installment records.
 * Structured JSON (the API's loan shape, with borrower{} and installments[]) is passed through as-is.
 */
export async function readImportFile(fileName, buf) {
  if (buf.length > MAX_FILE_BYTES) throw new ImportError('File is larger than 10 MB. Split it into smaller files.');
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  let loanTable;
  let instTable = null;
  let loanSheetName = 'Loans';
  if (ext === 'json') {
    let data;
    try {
      data = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    } catch {
      throw new ImportError('The JSON file is not valid JSON.');
    }
    const list = Array.isArray(data) ? data : data?.loans;
    if (!Array.isArray(list)) throw new ImportError('JSON must be an array of loans (or { "loans": [...] }).');
    if (list.length > MAX_ROWS) throw new ImportError(`Too many loans (${list.length}); the limit is ${MAX_ROWS} per file.`);
    return {
      format: 'json',
      records: list.map((obj, i) => (obj && typeof obj === 'object' && obj.borrower && Array.isArray(obj.installments)
        ? { rowNo: i + 1, sheet: 'JSON', structured: obj }
        : { rowNo: i + 1, sheet: 'JSON', values: flatValues(obj) })),
      installments: [],
      missingHeaders: [],
    };
  }
  if (ext === 'csv') {
    loanTable = parseCsv(buf.toString('utf8'));
  } else if (ext === 'xlsx') {
    const wb = await readWorkbook(buf);
    loanTable = wb.loans.table;
    loanSheetName = wb.loans.name;
    instTable = wb.installments?.table || null;
  } else {
    throw new ImportError('Upload an Excel (.xlsx), CSV (.csv) or JSON (.json) file. Old .xls files: save as .xlsx first.');
  }
  const { records, map } = tableToRecords(loanTable, LOAN_COLUMNS, loanSheetName);
  if (records.length > MAX_ROWS) throw new ImportError(`Too many rows (${records.length}); the limit is ${MAX_ROWS} per file.`);
  const missingHeaders = REQUIRED_HEADERS.filter((f) => map[f] === undefined);
  const inst = instTable ? tableToRecords(instTable, INSTALLMENT_COLUMNS, 'Installments').records : [];
  return { format: ext, records, installments: inst, missingHeaders };
}

function flatValues(obj) {
  const headers = Object.keys(obj || {});
  const map = headerMap(headers, LOAN_COLUMNS);
  const values = {};
  for (const [field, i] of Object.entries(map)) values[field] = obj[headers[i]];
  return values;
}

// ---------- normalisation ----------

export const loanIdFor = (loanNo) => loanNo.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function schedule({ emi, tenure, firstDueDate, frequency }) {
  const step = { monthly: (d, k) => addMonths(d, k), weekly: (d, k) => addDays(d, 7 * k), fortnightly: (d, k) => addDays(d, 14 * k) }[frequency];
  return Array.from({ length: tenure }, (_, k) => ({ no: k + 1, dueDate: step(firstDueDate, k), amount: emi }));
}

/** Turns one raw record into a loan, or a list of problems. */
function normaliseRecord(rec, instByLoan) {
  const errors = [];
  const v = rec.structured ? structuredToValues(rec.structured) : rec.values;
  const loanNo = text(v.loanNo, 40);
  if (!loanNo) errors.push('Loan number is missing.');
  const branch = text(v.branch, 100);
  if (!branch) errors.push('Branch is missing.');
  const name = text(v.name, 100);
  if (!name) errors.push('Borrower name is missing.');
  const phone = parsePhone(v.phone);
  if (!phone) errors.push(`Phone "${text(v.phone, 20) || '—'}" is not a valid 10-digit mobile number.`);
  const principal = parseAmount(v.principal);
  if (!(principal > 0)) errors.push('Principal must be an amount greater than 0.');
  const emi = parseAmount(v.emi);
  if (!(emi > 0)) errors.push('EMI must be an amount greater than 0.');
  const disbursedOn = parseDate(v.disbursedOn);
  if (!disbursedOn) errors.push(`Disbursement date "${text(v.disbursedOn instanceof Date ? '' : v.disbursedOn, 20)}" is not a valid date (use DD-MM-YYYY).`);
  const officerCode = text(v.officerCode, 12).toUpperCase() || null;
  const id = text(v.id, 40) || (loanNo ? loanIdFor(loanNo) : '');
  if (v.id && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) errors.push('ID may only contain letters, digits, - and _.');

  let lat = v.lat === '' || v.lat == null ? null : Number(v.lat);
  let lng = v.lng === '' || v.lng == null ? null : Number(v.lng);
  if ((lat != null || lng != null) && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
    errors.push('Latitude/longitude are not valid coordinates.');
    lat = lng = null;
  }
  const gName = text(v.guarantorName, 100);
  const gPhone = v.guarantorPhone ? parsePhone(v.guarantorPhone) : null;
  if (v.guarantorPhone && !gPhone) errors.push('Guarantor phone is not a valid 10-digit mobile number.');

  // Installments: explicit rows win; otherwise generate from tenure + first due date.
  let installments = [];
  const explicit = rec.structured?.installments ?? instByLoan.get(key(loanNo));
  if (explicit?.length) {
    explicit.forEach((r, i) => {
      const dueDate = parseDate(r.dueDate);
      const amount = parseAmount(r.amount);
      const where = r.rowNo ? `Installments row ${r.rowNo}` : `Installment ${i + 1}`;
      if (!dueDate) errors.push(`${where}: due date is not valid.`);
      if (!(amount > 0)) errors.push(`${where}: amount must be greater than 0.`);
      installments.push({ dueDate, amount });
    });
    installments.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    installments = installments.map((x, i) => ({ no: i + 1, ...x }));
  } else {
    const tenure = Number(v.tenure);
    const firstDueDate = parseDate(v.firstDueDate);
    const frequency = text(v.frequency, 20).toLowerCase() || 'monthly';
    if (!Number.isInteger(tenure) || tenure < 1 || tenure > MAX_INSTALLMENTS) {
      errors.push('Tenure (number of EMIs) is missing or invalid — or give an Installments sheet for this loan.');
    }
    if (!firstDueDate) errors.push('First due date is missing or invalid — or give an Installments sheet for this loan.');
    if (!['monthly', 'weekly', 'fortnightly'].includes(frequency)) errors.push('Frequency must be monthly, weekly or fortnightly.');
    if (!errors.length) installments = schedule({ emi, tenure, firstDueDate, frequency });
  }
  if (installments.length > MAX_INSTALLMENTS) errors.push(`More than ${MAX_INSTALLMENTS} installments.`);
  if (disbursedOn && installments.some((x) => x.dueDate && x.dueDate < disbursedOn)) {
    errors.push('An installment falls due before the disbursement date.');
  }

  if (errors.length) return { rowNo: rec.rowNo, sheet: rec.sheet, loanNo, errors };
  return {
    rowNo: rec.rowNo,
    sheet: rec.sheet,
    loan: {
      id, loanNo, branch, officerCode, product: text(v.product, 60) || 'Loan', principal, emi, disbursedOn,
      borrower: {
        name, phone, business: text(v.business, 100), address: text(v.address, 200), village: text(v.village, 100),
        lat, lng, guarantor: gName || gPhone ? { name: gName, phone: gPhone || '' } : null,
      },
      installments,
    },
  };
}

function structuredToValues(o) {
  const b = o.borrower || {};
  return {
    loanNo: o.loanNo, id: o.id, branch: o.branch, officerCode: o.officerCode, product: o.product,
    principal: o.principal, emi: o.emi, disbursedOn: o.disbursedOn, name: b.name, phone: b.phone,
    business: b.business, address: b.address, village: b.village, lat: b.lat, lng: b.lng,
    guarantorName: b.guarantor?.name, guarantorPhone: b.guarantor?.phone,
  };
}

/** Normalises every record; returns valid loans and per-row errors (including duplicates within the file). */
export function normalise({ records, installments }) {
  const instByLoan = new Map();
  for (const r of installments) {
    const k = key(r.values.loanNo);
    if (!k) continue;
    if (!instByLoan.has(k)) instByLoan.set(k, []);
    instByLoan.get(k).push({ rowNo: r.rowNo, dueDate: r.values.dueDate, amount: r.values.amount });
  }
  const valid = [];
  const errors = [];
  const seen = new Map();
  for (const rec of records) {
    const out = normaliseRecord(rec, instByLoan);
    if (out.errors) {
      errors.push(out);
      continue;
    }
    const k = key(out.loan.loanNo);
    if (seen.has(k)) {
      errors.push({ rowNo: out.rowNo, sheet: out.sheet, loanNo: out.loan.loanNo, errors: [`Duplicate of row ${seen.get(k)} in this file.`] });
      continue;
    }
    seen.set(k, out.rowNo);
    valid.push(out);
  }
  return { valid, errors };
}

/**
 * Checks normalised loans against the database: officer assignment, and whether each loan is new or
 * an update (matched by loan number). Moves failures into errors and adds warnings.
 */
export async function checkAgainstDb(conn, companyId, valid, errors) {
  const officers = new Map(
    (await conn.query("SELECT code, branch, active FROM users WHERE company_id = ? AND role = 'officer'", [companyId])).map((o) => [o.code, o]));
  const existing = new Map();
  const existingIds = new Map();
  const nos = valid.map((v) => v.loan.loanNo);
  for (let i = 0; i < nos.length; i += 1000) {
    const chunk = nos.slice(i, i + 1000);
    const rows = await conn.query(
      `SELECT l.id, l.loan_no, l.installments, (SELECT COUNT(*) FROM payments p WHERE p.loan_id = l.id) AS payments
       FROM loans l WHERE l.company_id = ? AND l.loan_no IN (?)`, [companyId, chunk]);
    for (const r of rows) existing.set(r.loan_no.toLowerCase(), r);
  }
  // Loan ids are global, so a new loan's id gets the company prefix ("7-MFL-25-2001").
  const prefix = `${companyId}-`;
  for (const v of valid) {
    if (!existing.has(v.loan.loanNo.toLowerCase()) && !v.loan.id.startsWith(prefix)) v.loan.id = (prefix + v.loan.id).slice(0, 40);
  }
  const ids = valid.map((v) => v.loan.id);
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await conn.query('SELECT id, loan_no, company_id FROM loans WHERE id IN (?)', [ids.slice(i, i + 1000)]);
    for (const r of rows) existingIds.set(r.id, r.company_id === companyId ? r.loan_no : null);
  }
  const ok = [];
  for (const v of valid) {
    const { loan } = v;
    const problems = [];
    const warnings = [];
    const match = existing.get(loan.loanNo.toLowerCase());
    if (match) {
      loan.loanNo = match.loan_no; // keep stored spelling
      if (![match.id, loanIdFor(loan.loanNo), match.id.replace(prefix, '')].includes(loan.id)) problems.push(`Loan ${loan.loanNo} already exists with ID ${match.id}.`);
      loan.id = match.id;
      if (match.payments > 0 && JSON.stringify(JSON.parse(match.installments)) !== JSON.stringify(loan.installments)) {
        warnings.push(`Repayment schedule changes; ${match.payments} recorded payment(s) are kept and re-allocated.`);
      }
    } else if (existingIds.has(loan.id)) {
      const other = existingIds.get(loan.id);
      problems.push(other ? `ID ${loan.id} is already used by loan ${other}.` : `ID ${loan.id} is already in use. Leave the ID column blank.`);
    }
    if (loan.officerCode) {
      const o = officers.get(loan.officerCode);
      if (!o) problems.push(`Officer ${loan.officerCode} does not exist.`);
      else if (!o.active) problems.push(`Officer ${loan.officerCode} is deactivated.`);
      else if (o.branch !== loan.branch) problems.push(`Officer ${loan.officerCode} belongs to ${o.branch}, not ${loan.branch}.`);
    } else {
      warnings.push('No officer assigned — the loan will be unassigned.');
    }
    if (problems.length) errors.push({ rowNo: v.rowNo, sheet: v.sheet, loanNo: loan.loanNo, errors: problems });
    else ok.push({ ...v, action: match ? 'update' : 'create', warnings });
  }
  errors.sort((a, b) => a.rowNo - b.rowNo);
  return ok;
}

// ---------- template ----------

export async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LoanDesk';
  const brand = 'FF0F5132';
  const head = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand } };
    r.alignment = { vertical: 'middle' };
    r.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ width: 26 }, { width: 90 }];
  [
    ['Loan import template', ''],
    ['', ''],
    ['Sheet "Loans"', 'One row per loan. Columns marked * are required. Keep the heading row.'],
    ['Sheet "Installments"', 'Optional. Give the exact schedule (loan no, installment no, due date, amount). If a loan has no rows here, its schedule is generated from Tenure, First due date, EMI and Frequency.'],
    ['Dates', 'Use real Excel dates, or DD-MM-YYYY (day first), or YYYY-MM-DD.'],
    ['Phone', '10-digit Indian mobile number. +91 or a leading 0 is removed automatically.'],
    ['Officer code', 'Must be an active field officer of the same branch. Leave blank to import unassigned.'],
    ['Re-importing', 'Loans are matched by Loan number. Re-importing updates borrower details, schedule and officer; payments and visits are never changed.'],
    ['Frequency', 'monthly (default), weekly or fortnightly.'],
  ].forEach((r, i) => {
    const row = help.addRow(r);
    if (i === 0) row.font = { bold: true, size: 14, color: { argb: brand } };
    else row.getCell(1).font = { bold: true };
    row.alignment = { wrapText: true, vertical: 'top' };
  });

  const loans = wb.addWorksheet('Loans');
  loans.columns = [
    ['Loan No *', 'loanNo', 18], ['Branch *', 'branch', 18], ['Officer Code', 'officerCode', 13], ['Product', 'product', 20],
    ['Principal *', 'principal', 12], ['EMI *', 'emi', 10], ['Disbursed On *', 'disbursedOn', 15], ['Tenure', 'tenure', 9],
    ['First Due Date', 'firstDueDate', 15], ['Frequency', 'frequency', 12], ['Borrower Name *', 'name', 22],
    ['Phone *', 'phone', 13], ['Business', 'business', 20], ['Address', 'address', 28], ['Village', 'village', 16],
    ['Latitude', 'lat', 11], ['Longitude', 'lng', 11], ['Guarantor Name', 'guarantorName', 20], ['Guarantor Phone', 'guarantorPhone', 15],
  ].map(([header, k, width]) => ({ header, key: k, width }));
  const d = (s) => new Date(`${s}T00:00:00Z`);
  loans.addRow({
    loanNo: 'MFL/25/2001', branch: 'Lucknow Rural', officerCode: 'FO27', product: 'Micro Business Loan', principal: 50000,
    emi: 5167, disbursedOn: d('2026-01-25'), tenure: 12, firstDueDate: d('2026-02-25'), frequency: 'monthly',
    name: 'Ramesh Kumar', phone: '9810012345', business: 'Kirana store', address: 'Ward 4, Near Hanuman Mandir',
    village: 'Rampur', lat: 26.851, lng: 80.949, guarantorName: 'Suresh Kumar', guarantorPhone: '9720023177',
  });
  loans.addRow({
    loanNo: 'MFL/25/2002', branch: 'Lucknow Rural', officerCode: '', product: 'JLG Weekly', principal: 30000,
    emi: 700, disbursedOn: d('2026-03-02'), tenure: 50, firstDueDate: d('2026-03-09'), frequency: 'weekly',
    name: 'Sunita Devi', phone: '+91 98200 54321', village: 'Chinhat',
  });
  head(loans);
  for (const k of ['disbursedOn', 'firstDueDate']) loans.getColumn(k).numFmt = 'dd-mm-yyyy';
  for (const k of ['principal', 'emi']) loans.getColumn(k).numFmt = '#,##0.00';
  for (let r = 2; r <= 1000; r++) {
    loans.getCell(`J${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"monthly,weekly,fortnightly"'],
    };
  }

  const inst = wb.addWorksheet('Installments');
  inst.columns = [
    { header: 'Loan No', key: 'loanNo', width: 18 }, { header: 'Installment No', key: 'no', width: 15 },
    { header: 'Due Date', key: 'dueDate', width: 14 }, { header: 'Amount', key: 'amount', width: 12 },
  ];
  head(inst);
  inst.getColumn('dueDate').numFmt = 'dd-mm-yyyy';
  inst.getColumn('amount').numFmt = '#,##0.00';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
