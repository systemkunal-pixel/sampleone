import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, daysBetween, loanStatus, allocate, activePromise, priorityScore, visitList,
  validatePayment, receiptNumber, distanceKm, daySummary, portfolioSummary, toCSV, bucketFor,
  validateDeposit, findDuplicateSlip, collectionsCSV,
} from '../src/js/logic.js';
import { seedLoans } from '../src/js/seed.js';

const TODAY = '2026-10-08';

function makeLoan(overrides = {}) {
  return {
    id: 'L1',
    loanNo: 'MFL/1',
    emi: 1000,
    borrower: { name: 'Test', lat: 26.85, lng: 80.95 },
    installments: [
      { no: 1, dueDate: '2026-07-05', amount: 1000 },
      { no: 2, dueDate: '2026-08-05', amount: 1000 },
      { no: 3, dueDate: '2026-09-05', amount: 1000 },
      { no: 4, dueDate: '2026-10-05', amount: 1000 },
      { no: 5, dueDate: '2026-11-05', amount: 1000 },
    ],
    payments: [],
    visits: [],
    followUpDate: null,
    ...overrides,
  };
}

const pay = (amount, at = '2026-07-06T10:00:00') => ({ id: `p${amount}${at}`, at, amount, mode: 'Cash' });

test('date helpers', () => {
  assert.equal(daysBetween('2026-09-05', '2026-10-08'), 33);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 2), '2027-01-15');
});

test('DPD is measured from the oldest unpaid installment', () => {
  const st = loanStatus(makeLoan(), TODAY);
  assert.equal(st.overdue, 4000);
  assert.equal(st.outstanding, 5000);
  assert.equal(st.dpd, daysBetween('2026-07-05', TODAY));
  assert.equal(st.bucket.key, '90+'); // 95 days
  assert.equal(st.overdueInstallments, 4);
  assert.deepEqual(st.nextDue, { date: '2026-11-05', amount: 1000 });
});

test('payments allocate oldest-first, partials included', () => {
  const loan = makeLoan({ payments: [pay(2500)] });
  const rows = allocate(loan);
  assert.deepEqual(rows.map((r) => r.pending), [0, 0, 500, 1000, 1000]);
  const st = loanStatus(loan, TODAY);
  assert.equal(st.overdue, 1500);
  assert.equal(st.dpd, daysBetween('2026-09-05', TODAY));
  assert.equal(st.bucket.key, '31-60');
});

test('fully paid-up loan is current, fully repaid loan is closed', () => {
  assert.equal(loanStatus(makeLoan({ payments: [pay(4000)] }), TODAY).bucket.key, 'current');
  const closed = loanStatus(makeLoan({ payments: [pay(5000)] }), TODAY);
  assert.equal(closed.closed, true);
  assert.equal(closed.nextDue, null);
});

test('bucket boundaries', () => {
  assert.equal(bucketFor(0, 0).key, 'current');
  assert.equal(bucketFor(30).key, '1-30');
  assert.equal(bucketFor(31).key, '31-60');
  assert.equal(bucketFor(90).key, '61-90');
  assert.equal(bucketFor(91).key, '90+');
});

test('promise to pay: kept vs broken', () => {
  const ptpVisit = { id: 'v1', at: '2026-10-01T10:00:00', outcome: 'PTP', ptpDate: '2026-10-05', ptpAmount: 1000 };
  const broken = makeLoan({ visits: [ptpVisit] });
  assert.equal(activePromise(broken).kept, false);
  const kept = makeLoan({ visits: [ptpVisit], payments: [pay(1000, '2026-10-04T12:00:00')] });
  assert.equal(activePromise(kept).kept, true);
  // A payment from before the promise doesn't count.
  const early = makeLoan({ visits: [ptpVisit], payments: [pay(1000, '2026-09-20T12:00:00')] });
  assert.equal(activePromise(early).kept, false);
});

test('visit priority: PTP due today > broken PTP > plain overdue > future PTP; current excluded', () => {
  const base = makeLoan();
  const ptp = (date) => [{ id: 'v', at: '2026-10-01T10:00:00', outcome: 'PTP', ptpDate: date, ptpAmount: 1000 }];
  const dueToday = makeLoan({ id: 'today', visits: ptp(TODAY) });
  const broken = makeLoan({ id: 'broken', visits: ptp('2026-10-06') });
  const future = makeLoan({ id: 'future', visits: ptp('2026-10-12') });
  const current = makeLoan({ id: 'current', payments: [pay(4000)] });
  assert.ok(priorityScore(dueToday, TODAY) > priorityScore(broken, TODAY));
  assert.ok(priorityScore(broken, TODAY) > priorityScore(base, TODAY));
  assert.ok(priorityScore(base, TODAY) > priorityScore(future, TODAY));
  assert.equal(priorityScore(current, TODAY), 0);
  const ids = visitList([current, future, base, broken, dueToday], TODAY).map((x) => x.loan.id);
  assert.deepEqual(ids, ['today', 'broken', 'L1', 'future']);
});

test('payment validation', () => {
  const loan = makeLoan();
  assert.match(validatePayment(loan, 0, TODAY), /greater than zero/);
  assert.match(validatePayment(loan, NaN, TODAY), /greater than zero/);
  assert.match(validatePayment(loan, 10.555, TODAY), /two decimal/);
  assert.match(validatePayment(loan, 5001, TODAY), /exceeds/);
  assert.equal(validatePayment(loan, 5000, TODAY), null);
  assert.equal(validatePayment(loan, 1234.5, TODAY), null);
});

test('receipt numbers', () => {
  assert.equal(receiptNumber('fo27', '2026-10-08', 7), 'R-FO27-261008-007');
  assert.equal(receiptNumber('', '2026-10-08', 1), 'R-FO-261008-001');
});

test('distance', () => {
  const d = distanceKm({ lat: 26.8467, lng: 80.9462 }, { lat: 26.8467, lng: 81.0462 });
  assert.ok(d > 9.5 && d < 10.5, `got ${d}`);
  assert.equal(distanceKm(null, { lat: 1, lng: 1 }), null);
});

test('day and portfolio summaries', () => {
  const a = makeLoan({ id: 'a', payments: [pay(1000, `${TODAY}T09:00:00`), pay(500, '2026-10-01T09:00:00')] });
  a.payments[0].mode = 'UPI';
  const b = makeLoan({ id: 'b', visits: [{ id: 'v', at: `${TODAY}T11:00:00`, outcome: 'PTP', ptpDate: '2026-10-10', ptpAmount: 500 }] });
  const day = daySummary([a, b], TODAY);
  assert.equal(day.collected, 1000);
  assert.deepEqual(day.byMode, { UPI: 1000 });
  assert.equal(day.ptpCount, 1);
  const pf = portfolioSummary([a, b], TODAY);
  assert.equal(pf.overdue, 2500 + 4000);
  assert.equal(pf.buckets.reduce((s, x) => s + x.count, 0), 2);
});

test('CSV escapes quotes/commas and neutralises formulas', () => {
  const csv = toCSV(['a', 'b'], [['x,y', '=HYPERLINK("evil")'], ['say "hi"', 3]]);
  assert.equal(csv, 'a,b\r\n"x,y","\'=HYPERLINK(""evil"")"\r\n"say ""hi""",3');
});

test('seed portfolio has a realistic mix', () => {
  const loans = seedLoans(TODAY);
  assert.equal(loans.length, 12);
  const keys = new Set(loans.map((l) => loanStatus(l, TODAY).bucket.key));
  for (const k of ['current', '1-30', '61-90', '90+']) assert.ok(keys.has(k), `missing bucket ${k}`);
  assert.ok(visitList(loans, TODAY).length >= 8);
});

test('bank deposit validation', () => {
  const ok = { slipNo: 'JRN 4471', bank: 'SBI Chinhat', depositDate: '2026-10-07', hasSlip: true };
  assert.equal(validateDeposit(ok, [], TODAY), null);
  assert.match(validateDeposit({ ...ok, hasSlip: false }, [], TODAY), /photo/);
  assert.match(validateDeposit({ ...ok, slipNo: ' - ' }, [], TODAY), /slip \/ journal/);
  assert.match(validateDeposit({ ...ok, bank: '' }, [], TODAY), /bank/);
  assert.match(validateDeposit({ ...ok, depositDate: '' }, [], TODAY), /deposit date/);
  assert.match(validateDeposit({ ...ok, depositDate: '2026-10-09' }, [], TODAY), /future/);
  assert.match(validateDeposit({ ...ok, depositDate: '2026-06-01' }, [], TODAY), /90 days/);
});

test('the same slip cannot be recorded twice, even typed differently', () => {
  const deposit = { slipNo: 'JRN-4471', bank: 'SBI', depositDate: '2026-10-07', verification: 'pending' };
  const loan = makeLoan({ payments: [{ ...pay(1000, `${TODAY}T10:00:00`), mode: 'Bank deposit', deposit }] });
  assert.equal(findDuplicateSlip([loan], 'jrn 4471').loan, loan);
  assert.equal(findDuplicateSlip([loan], 'JRN4472'), null);
  const err = validateDeposit({ slipNo: 'jrn4471', bank: 'SBI', depositDate: '2026-10-07', hasSlip: true }, [loan], TODAY);
  assert.match(err, /already recorded on MFL\/1/);
  // Deposits count toward the borrower's dues and appear in the day's export.
  assert.equal(loanStatus(loan, TODAY).overdue, 3000);
  assert.match(collectionsCSV([loan], TODAY), /Deposited 2026-10-07 at SBI; slip pending/);
});
