// Demo portfolio, generated relative to "today" so the app always has
// a realistic mix of current, overdue and NPA accounts.
import { addMonths, addDays, isoDate, money } from './logic.js';

const PEOPLE = [
  ['Ramesh Kumar', 'Kirana store owner', 'Ward 4, Near Hanuman Mandir', 'Rampur', 26.851, 80.949],
  ['Sunita Devi', 'Tailoring unit', 'House 12, Gali No. 3', 'Rampur', 26.856, 80.941],
  ['Mohammed Irfan', 'Auto-rickshaw driver', 'Behind Bus Stand', 'Sitapur Road', 26.872, 80.932],
  ['Lakshmi Bai', 'Dairy (2 buffaloes)', 'Patel Nagar, Plot 7', 'Bakshi Ka Talab', 26.98, 80.93],
  ['Arjun Singh', 'Mobile repair shop', 'Main Market, Shop 21', 'Rampur', 26.849, 80.952],
  ['Geeta Yadav', 'Vegetable vendor', 'Mandi Road', 'Chinhat', 26.884, 81.03],
  ['Pradeep Verma', 'Small poultry farm', 'Village Sarai, East side', 'Mohanlalganj', 26.69, 80.98],
  ['Fatima Begum', 'Bangle shop', 'Chowk Bazaar, Lane 2', 'Chinhat', 26.887, 81.026],
  ['Suresh Pal', 'Carpentry workshop', 'Near Primary School', 'Mohanlalganj', 26.694, 80.975],
  ['Kavita Sharma', 'Beauty parlour', 'Shastri Nagar, Block B', 'Sitapur Road', 26.875, 80.928],
  ['Rajesh Gupta', 'Tea stall', 'Railway Crossing', 'Bakshi Ka Talab', 26.976, 80.927],
  ['Anita Kushwaha', 'Goat rearing', 'Purva Village', 'Mohanlalganj', 26.7, 80.99],
];

// [months since disbursal, installments paid so far, principal, tenure]
const PROFILES = [
  [8, 8, 50000, 12],  // current
  [6, 5, 30000, 12],  // ~1 EMI behind
  [10, 7, 80000, 18], // ~3 behind
  [9, 9, 40000, 12],  // current
  [7, 5, 60000, 12],  // 2 behind
  [12, 7, 25000, 12], // 5 behind (NPA)
  [5, 4, 100000, 24], // 1 behind
  [8, 6, 35000, 12],  // 2 behind
  [11, 6, 45000, 12], // 5 behind (NPA)
  [4, 3, 20000, 10],  // 1 behind
  [6, 3, 15000, 12],  // 3 behind
  [9, 8, 55000, 18],  // 1 behind
];

export function seedLoans(today = isoDate()) {
  return PEOPLE.map(([name, business, address, village, lat, lng], i) => {
    const [monthsAgo, paidCount, principal, tenure] = PROFILES[i];
    // Disburse a few days off the month boundary so due dates vary.
    const disbursed = addDays(addMonths(today, -monthsAgo), -(i * 2 + 3));
    const emi = Math.round((principal * (1 + 0.24 * (tenure / 12))) / tenure);
    const installments = Array.from({ length: tenure }, (_, k) => ({
      no: k + 1,
      dueDate: addMonths(disbursed, k + 1),
      amount: emi,
    }));
    const payments = installments.slice(0, paidCount).map((inst, k) => ({
      id: `seed-p-${i}-${k}`,
      at: `${addDays(inst.dueDate, k % 3)}T11:00:00`,
      amount: inst.amount,
      mode: k % 2 ? 'UPI' : 'Cash',
      receiptNo: `R-HIST-${i}${String(k).padStart(2, '0')}`,
      officer: 'Branch',
      synced: true,
    }));
    const visits = [];
    // Give a couple of accounts promise-to-pay history.
    if (i === 2) {
      visits.push(visit(i, addDays(today, -5), 'PTP', 'Said harvest payment due next week', addDays(today, -1), emi));
    }
    if (i === 7) {
      visits.push(visit(i, addDays(today, -3), 'PTP', 'Will pay after wholesale settlement', today, money(emi * 2)));
    }
    if (i === 5) {
      visits.push(visit(i, addDays(today, -10), 'DOOR_LOCKED', 'Neighbour says family at relative\'s place'));
    }
    if (i === 10) {
      visits.push(visit(i, addDays(today, -2), 'PTP', 'Business slow; promised part payment', addDays(today, 4), emi));
    }
    return {
      id: `L${1001 + i}`,
      loanNo: `MFL/24/${String(1001 + i)}`,
      product: tenure > 12 ? 'MSME Term Loan' : 'Micro Business Loan',
      principal,
      emi,
      disbursedOn: disbursed,
      borrower: {
        name,
        business,
        phone: `98${String(10000000 + i * 7391173).slice(0, 8)}`,
        address,
        village,
        lat,
        lng,
        guarantor: i % 3 === 0 ? null : { name: `${name.split(' ')[1]} (relative)`, phone: `97${String(20000000 + i * 3311).slice(0, 8)}` },
      },
      installments,
      payments,
      visits,
      followUpDate: null,
    };
  });
}

function visit(i, day, outcome, notes, ptpDate = null, ptpAmount = null) {
  return {
    id: `seed-v-${i}-${day}`,
    at: `${day}T10:30:00`,
    outcome,
    notes,
    ptpDate,
    ptpAmount,
    officer: 'Branch',
    synced: true,
  };
}
