// Pincode locations and the agent recruitment plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, km, within, recruitmentPlan } from '../server/geo.js';

test('pincodes are located from the post-office directory; unknown ones from a neighbour', () => {
  const kolkata = locate('700001');
  const howrah = locate('711101');
  assert.ok(kolkata && !kolkata.approx);
  assert.ok(Math.abs(kolkata.lat - 22.57) < 0.2 && Math.abs(kolkata.lng - 88.35) < 0.2, JSON.stringify(kolkata));
  const d = km(kolkata, howrah);
  assert.ok(d > 1 && d < 15, `Kolkata GPO to Howrah is ${d} km`);
  assert.equal(locate('12345'), null);
  assert.equal(locate('989898'), null, 'no pincode starts with 989');
  const guess = locate('700199');
  assert.ok(!guess || guess.approx);
});

test('within() lists pincodes with accounts inside the range, nearest first', () => {
  const near = within('700001', [{ pincode: '711101', accounts: 3 }, { pincode: '700001', accounts: 1 }, { pincode: '110001', accounts: 9 }], 20);
  assert.deepEqual(near.map((p) => p.pincode), ['700001', '711101']);
  assert.equal(near[0].km, 0);
});

test('the recruitment plan covers every pincode within range and respects the account limit', () => {
  const areas = [
    { pincode: '700001', district: 'KOLKATA', state: 'WEST BENGAL', accounts: 120, overdue: 1200000 },
    { pincode: '711101', district: 'HOWRAH', state: 'WEST BENGAL', accounts: 100, overdue: 900000 },
    { pincode: '700091', district: 'NORTH 24 PARGANAS', state: 'WEST BENGAL', accounts: 60, overdue: 500000 },
    { pincode: '711302', district: 'HOWRAH', state: 'WEST BENGAL', accounts: 700, overdue: 7000000 },
    { pincode: '110001', district: 'NEW DELHI', state: 'DELHI', accounts: 5, overdue: 50000 },
  ];
  const plan = recruitmentPlan(areas, { range: 20, max: 250, min: 20 });
  const all = [...plan.agents, ...plan.thin];
  const covered = {};
  for (const a of all) {
    assert.ok(a.accounts <= 250, `agent with ${a.accounts}`);
    for (const p of a.pincodes) {
      assert.ok(p.km <= 20, `${p.pincode} at ${p.km} km`);
      covered[p.pincode] = (covered[p.pincode] || 0) + p.accounts;
    }
  }
  for (const a of areas) assert.equal(covered[a.pincode], a.accounts, `${a.pincode} fully covered`);
  // 700 accounts in one pincode need three agents there; Delhi's 5 accounts are a thin area.
  assert.equal(all.filter((a) => a.base.pincode === '711302' && a.pincodes.every((p) => p.pincode === '711302')).length, 3);
  assert.deepEqual(plan.thin.map((a) => a.base.pincode), ['110001']);
  assert.equal(plan.summary.accounts + plan.summary.thinAccounts, 985);
  assert.equal(plan.agents[0].no, 1);
});
