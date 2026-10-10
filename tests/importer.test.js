import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseDate, parsePhone, parseAmount, readImportFile, normalise, loanIdFor, buildTemplate } from '../server/importer.js';

test('dates: Excel values and Indian day-first strings', () => {
  assert.equal(parseDate(new Date(Date.UTC(2026, 1, 25))), '2026-02-25');
  assert.equal(parseDate(46078), '2026-02-25'); // Excel serial
  assert.equal(parseDate('2026-02-25'), '2026-02-25');
  assert.equal(parseDate('25/02/2026'), '2026-02-25');
  assert.equal(parseDate('25-02-2026'), '2026-02-25');
  assert.equal(parseDate('25.2.2026'), '2026-02-25');
  assert.equal(parseDate('25-Feb-2026'), '2026-02-25');
  assert.equal(parseDate('25 February 2026'), '2026-02-25');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('02/25/2026'), null); // US order is not guessed
  assert.equal(parseDate('soon'), null);
  assert.equal(parseDate(''), null);
});

test('phones and amounts', () => {
  assert.equal(parsePhone('+91 98390 11111'), '9839011111');
  assert.equal(parsePhone('09839022222'), '9839022222');
  assert.equal(parsePhone('98390-44444'), '9839044444');
  assert.equal(parsePhone('12345'), null);
  assert.equal(parsePhone('5839011111'), null); // Indian mobiles start 6–9
  assert.equal(parseAmount('₹1,25,000.50'), 125000.5);
  assert.equal(parseAmount('Rs. 500'), 500);
  assert.ok(Number.isNaN(parseAmount('abc')));
});

test('CSV with alternative headings generates monthly and weekly schedules', async () => {
  const csv = [
    'Loan Account Number,Branch Name,FO Code,Loan Amount,EMI Amount,Disbursement Date,No of EMIs,First EMI Date,Frequency,Customer Name,Mobile No,Area',
    'A/1,Kanpur,FO1,"10,000",1000,01/01/2026,3,31/01/2026,monthly,Asha,9839011111,Gwaltoli',
    'A/2,Kanpur,,5000,500,01/01/2026,4,08/01/2026,weekly,"Devi, Meena",9839022222,',
    'A/1,Kanpur,,1,1,01/01/2026,1,01/02/2026,,Dup,9839033333,',
    ',Kanpur,,1,1,01/01/2026,1,01/02/2026,,No Number,9839044444,',
  ].join('\n');
  const parsed = await readImportFile('loans.csv', Buffer.from(csv));
  assert.deepEqual(parsed.missingHeaders, []);
  const { valid, errors } = normalise(parsed);
  assert.equal(valid.length, 2);
  const [a1, a2] = valid.map((v) => v.loan);
  assert.equal(a1.id, 'A-1');
  assert.equal(a1.officerCode, 'FO1');
  assert.equal(a1.principal, 10000);
  assert.deepEqual(a1.installments.map((i) => i.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(a2.installments.map((i) => i.dueDate), ['2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29']);
  assert.equal(a2.borrower.name, 'Devi, Meena');
  assert.equal(a2.officerCode, null);
  assert.deepEqual(errors.map((e) => e.rowNo), [4, 5]);
  assert.match(errors[0].errors[0], /Duplicate of row 2/);
  assert.match(errors[1].errors[0], /Loan number is missing/);
});

test('Excel workbook with an Installments sheet uses the exact schedule', async () => {
  const wb = new ExcelJS.Workbook();
  const loans = wb.addWorksheet('Loans');
  loans.addRow(['Loan No', 'Branch', 'Principal', 'EMI', 'Disbursed On', 'Borrower Name', 'Phone']);
  loans.addRow(['X-9', 'Kanpur', 15000, 5000, new Date(Date.UTC(2026, 0, 10)), 'Ravi', 9839011111]);
  const inst = wb.addWorksheet('Installments');
  inst.addRow(['Loan No', 'Installment No', 'Due Date', 'Amount']);
  inst.addRow(['X-9', 2, '10/03/2026', 5500]);
  inst.addRow(['X-9', 1, '10/02/2026', 5000]);
  const parsed = await readImportFile('book.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
  const { valid, errors } = normalise(parsed);
  assert.deepEqual(errors, []);
  assert.deepEqual(valid[0].loan.installments, [
    { no: 1, dueDate: '2026-02-10', amount: 5000 },
    { no: 2, dueDate: '2026-03-10', amount: 5500 },
  ]);
});

test('missing required columns and bad files are reported', async () => {
  const parsed = await readImportFile('x.csv', Buffer.from('Loan No,Name\nA,B'));
  assert.deepEqual(parsed.missingHeaders, ['branch', 'principal', 'emi', 'disbursedOn', 'phone']);
  await assert.rejects(readImportFile('x.xls', Buffer.from('x')), /\.xlsx/);
  await assert.rejects(readImportFile('x.xlsx', Buffer.from('not a zip')), /Could not read the Excel file/);
  await assert.rejects(readImportFile('x.json', Buffer.from('{')), /not valid JSON/);
});

test('JSON accepts the API loan shape and flat rows', async () => {
  const json = JSON.stringify([
    { loanNo: 'J1', branch: 'B', principal: 100, emi: 50, disbursedOn: '2026-01-01', borrower: { name: 'N', phone: '9839011111' },
      installments: [{ no: 1, dueDate: '2026-02-01', amount: 50 }, { no: 2, dueDate: '2026-03-01', amount: 50 }] },
    { 'Loan No': 'J2', Branch: 'B', Principal: 100, EMI: 100, 'Disbursed On': '01/01/2026', Tenure: 1, 'First Due Date': '01/02/2026', Name: 'M', Phone: '9839022222' },
  ]);
  const { valid, errors } = normalise(await readImportFile('l.json', Buffer.from(json)));
  assert.deepEqual(errors, []);
  assert.equal(valid[0].loan.installments.length, 2);
  assert.equal(valid[1].loan.installments[0].dueDate, '2026-02-01');
});

// The layout of a lender's recovery list (e.g. VFS "Borrower Details"): a blank first row and column,
// one overdue amount due since a date, and the account's state, district and pincode. Made-up data.
async function recoveryWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Borrower Details');
  ws.addRow([]);
  ws.addRow([null, 'PI_NAME', 'CUST_NAME', 'CUST_CD', 'ACCT_NO', 'Asset Class', 'Address', 'PIN Code', 'State', 'District', 'Mob No.',
    'OS_AMT', 'INT_RATE', 'DUE_SINCE', 'OD_DAYS', 'P_ODUE', 'I_ODUE', 'O_ODUE', 'T_ODUE', 'NPA_DT']);
  for (const r of rows) {
    ws.addRow([null, 'VFS CAPITAL LIMITED', r.name, 1000001, r.acct, r.cls || 'NPA', r.address || 'WARD 4 NEAR SCHOOL', r.pin, r.state || 'WEST BENGAL',
      r.district, r.phone, r.os ?? 20000, 18, r.since ?? 45570, 300, 18000, 2000, 1000, r.due ?? 21000, new Date(Date.UTC(2024, 9, 3))]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('a recovery list imports as one overdue amount per account, with state, district and pincode', async () => {
  const buf = await recoveryWorkbook([
    { acct: 'D000001A', name: 'TEST BORROWER ONE', pin: 711302, district: 'HOWRAH', phone: 9800000001, due: 26530 },
    { acct: 'D000002B', name: 'TEST BORROWER TWO', pin: '721429', district: 'EAST MEDINIPORE', phone: 1234567890 },
    { acct: 'D000003C', name: 'TEST BORROWER THREE', pin: 711302, district: 'HOWRAH', phone: 9800000003, os: 0, due: 5000, cls: 'sma1' },
    { acct: 'D000004D', name: '', pin: 'N/A', district: 'HOWRAH', phone: '', os: 7000, due: 0, since: 'not known' },
    { acct: 'D000005E', name: 'TEST BORROWER FIVE', pin: 711302, district: 'HOWRAH', phone: 9800000005, os: 0, due: 0 },
  ]);
  const parsed = await readImportFile('VFS Borrower Details.xlsx', buf);
  assert.deepEqual(parsed.missingHeaders, []);
  const { valid, errors } = normalise(parsed);
  assert.deepEqual(errors, [], 'no row is rejected for bad data');
  const [a, b, c, d, e] = valid.map((v) => v.loan);
  const warn = valid.map((v) => v.warnings);
  assert.equal(b.borrower.phone, '1234567890', 'a wrong number is kept as given');
  assert.match(warn[1][0], /not a valid 10-digit mobile number; imported as given/);
  assert.deepEqual([d.borrower.name, d.borrower.phone, d.pincode, d.principal], ['Name not given', '', null, 7000]);
  assert.equal(d.installments[0].amount, 7000, 'no overdue amount: the outstanding is used');
  assert.equal(warn[3].length, 4, warn[3].join(' | '));
  assert.deepEqual(e.installments, [], 'nothing due at all: imported anyway');
  assert.equal(e.source, 'recovery');
  // The commit step re-checks the loans exactly as the preview produced them.
  const again = normalise({ records: valid.map((v, i) => ({ rowNo: i + 1, sheet: 'Import', structured: v.loan })), installments: [] });
  assert.deepEqual(again.errors, []);
  assert.equal(a.branch, 'VFS');
  assert.equal(a.product, 'VFS · NPA · 18%');
  assert.equal(c.product, 'VFS · SMA1 · 18%');
  assert.deepEqual(a.installments, [{ no: 1, dueDate: '2024-10-05', amount: 26530 }]);
  assert.equal(a.emi, 26530);
  assert.equal(a.principal, 20000);
  assert.equal(c.principal, 5000, 'no outstanding given: the overdue amount stands in');
  assert.deepEqual([a.state, a.district, a.pincode], ['WEST BENGAL', 'HOWRAH', '711302']);
  assert.equal('officerCode' in a, false, 'no officer column: keep the current officer');
  assert.equal(a.borrower.phone, '9800000001');
});

test('the downloadable template imports cleanly', async () => {
  const parsed = await readImportFile('template.xlsx', await buildTemplate());
  const { valid, errors } = normalise(parsed);
  assert.deepEqual(errors, []);
  assert.equal(valid.length, 2);
  assert.equal(valid[1].loan.installments.length, 50);
  assert.equal(loanIdFor('MFL/25/2001'), 'MFL-25-2001');
});
