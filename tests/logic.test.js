import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, daysBetween, loanStatus, allocate, activePromise, priorityScore, visitList,
  validatePayment, receiptNumber, distanceKm, daySummary, portfolioSummary, toCSV, bucketFor,
  validateDeposit, findDuplicateSlip, collectionsCSV, lastReceiptSeq,
  dailyReport, accountFacts, statusOn, ageBand, lastContact, weekStart, monthStart,
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

test('a rejected deposit stops counting toward dues and frees its slip number', () => {
  const deposit = (verification) => ({ slipNo: 'JRN1', bank: 'SBI', depositDate: '2026-10-07', verification });
  const make = (v) => makeLoan({ payments: [{ ...pay(1000, `${TODAY}T10:00:00`), mode: 'Bank deposit', deposit: deposit(v) }] });
  assert.equal(loanStatus(make('pending'), TODAY).overdue, 3000);
  assert.equal(loanStatus(make('verified'), TODAY).overdue, 3000);
  assert.equal(loanStatus(make('rejected'), TODAY).overdue, 4000);
  assert.equal(daySummary([make('rejected')], TODAY).collected, 0);
  assert.equal(findDuplicateSlip([make('rejected')], 'JRN1'), null);
  assert.ok(findDuplicateSlip([make('verified')], 'JRN1'));
});

test('receipt numbering continues from the server', () => {
  const nos = ['R-FO27-261008-004', 'R-FO27-261008-011', 'R-FO31-261008-020', 'R-FO27-261007-030', 'R-HIST-1'];
  assert.equal(lastReceiptSeq(nos, 'FO27', '2026-10-08'), 11);
  assert.equal(lastReceiptSeq([], 'FO27', '2026-10-08'), 0);
});

// ---------- recovery desk ----------

const at = (time) => `${TODAY}T${time}`;
const dpay = (id, time, amount, officer = 'AG1', extra = {}) => ({ id, at: at(time), amount, mode: 'Cash', officer, ...extra });
const dvisit = (id, time, outcome, officer = 'AG1', extra = {}) => ({ id, at: at(time), outcome, officer, contactType: 'visit', ...extra });

test('daily report: contacted, visits, calls, no contact, PTP, collections — the agency format', () => {
  const loans = [
    makeLoan({ id: 'A', officerCode: 'AG1', visits: [dvisit('v1', '10:00:00', 'PTP', 'AG1', { ptpDate: '2026-10-09', ptpAmount: 1500 })] }),
    makeLoan({ id: 'B', officerCode: 'AG1', visits: [dvisit('v2', '11:00:00', 'NO_ANSWER', 'AG1', { contactType: 'call' })] }),
    makeLoan({ id: 'C', officerCode: 'AG1', visits: [dvisit('v3', '12:00:00', 'REFUSED', 'AG1', { contactType: 'call' })], case: { level: 1, note: 'threatens' } }),
    makeLoan({ id: 'D', officerCode: 'AG1', visits: [dvisit('v4', '13:00:00', 'DOOR_LOCKED')] }),
    makeLoan({ id: 'E', officerCode: 'AG1', payments: [dpay('p1', '14:00:00', 900)] }),
    makeLoan({ id: 'F', officerCode: 'AG1' }),
    // Another agent's account and work are not counted for AG1.
    makeLoan({ id: 'G', officerCode: 'AG2', payments: [dpay('p2', '15:00:00', 700, 'AG2')], visits: [dvisit('v5', '15:00:00', 'PAID', 'AG2')] }),
    // A rejected bank deposit is not a collection.
    makeLoan({ id: 'H', officerCode: 'AG1', payments: [dpay('p3', '16:00:00', 500, 'AG1', { deposit: { verification: 'rejected' } })] }),
  ];
  const r = dailyReport(loans, TODAY, 'AG1');
  assert.deepEqual(
    [r.assigned, r.contacted, r.visits, r.calls, r.ptpObtained, r.ptpAmount, r.collected, r.receipts, r.ptpDueTomorrow, r.ptpDueTomorrowAmount, r.noContact, r.notAttempted, r.difficult],
    [7, 3, 3, 2, 1, 1500, 900, 1, 1, 1500, 2, 2, 1],
  );
  const all = dailyReport(loans, TODAY);
  assert.equal(all.assigned, 8);
  assert.equal(all.collected, 1600);
  assert.equal(all.contacted, 4);
});

test('a payment counts as a visit unless the account was only phoned that day', () => {
  const phoned = makeLoan({ officerCode: 'AG1', payments: [dpay('p1', '11:00:00', 500)], visits: [dvisit('v1', '10:00:00', 'PTP', 'AG1', { contactType: 'call', ptpDate: TODAY, ptpAmount: 500 })] });
  const r = dailyReport([phoned], TODAY, 'AG1');
  assert.deepEqual([r.contacted, r.visits, r.calls], [1, 0, 1]);
  const met = makeLoan({ officerCode: 'AG1', payments: [dpay('p1', '11:00:00', 500)] });
  assert.deepEqual([dailyReport([met], TODAY, 'AG1').visits], [1]);
});

test('account facts: promise due or broken, no contact on the last attempt, high value, ageing band', () => {
  const broken = makeLoan({ visits: [{ id: 'v', at: '2026-10-01T10:00:00', outcome: 'PTP', ptpDate: '2026-10-05', ptpAmount: 1000 }] });
  const f = accountFacts(broken, TODAY, 2500);
  assert.equal(f.ptpBroken, true);
  assert.equal(f.ptpToday, false);
  assert.equal(f.highValue, true, '₹4,000 overdue ≥ ₹2,500');
  assert.equal(f.band.key, '91-180');
  assert.equal(f.untouched, false);
  // Paid after the promise: kept, and the payment counts as reaching the borrower.
  const kept = { ...broken, payments: [{ id: 'p', at: '2026-10-04T10:00:00', amount: 1000, mode: 'Cash' }] };
  assert.equal(accountFacts(kept, TODAY).ptpBroken, false);
  assert.equal(lastContact(kept).reached, true);
  const locked = makeLoan({ visits: [{ id: 'v', at: '2026-10-07T10:00:00', outcome: 'DOOR_LOCKED' }] });
  assert.equal(accountFacts(locked, TODAY).noContact, true);
  assert.equal(accountFacts(makeLoan(), TODAY).untouched, true);
  assert.deepEqual([ageBand(0).key, ageBand(30).key, ageBand(91).key, ageBand(366).key, ageBand(731).key], ['0-30', '0-30', '91-180', '1-2y', '2y+']);
});

test('status on an earlier day ignores later payments; week and month start', () => {
  const loan = makeLoan({ payments: [{ id: 'p', at: '2026-10-02T10:00:00', amount: 1000, mode: 'Cash' }] });
  assert.equal(statusOn(loan, '2026-09-30').overdue, 3000);
  assert.equal(statusOn(loan, TODAY).overdue, 3000, 'paid 1,000 of 4,000 due by 8 Oct');
  assert.equal(weekStart('2026-10-08'), '2026-10-05', 'Monday');
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(monthStart('2026-10-08'), '2026-10-01');
});
