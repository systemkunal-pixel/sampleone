// Where pincodes are, and planning agents by distance.
//
// server/data/pincodes.csv holds the centre of every Indian pincode (the median of its post offices'
// coordinates, from the Department of Posts directory). Distances are straight-line ("as the crow
// flies"); by road they are usually 20–40% longer.
import { readFileSync } from 'node:fs';

let table = null;

function pincodes() {
  if (table) return table;
  table = new Map();
  const file = new URL('./data/pincodes.csv', import.meta.url);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [pin, lat, lng, district, state] = line.split(',');
    table.set(pin, { lat: Number(lat), lng: Number(lng), district, state });
  }
  return table;
}

/**
 * The centre of a pincode: { lat, lng, approx }. A pincode missing from the directory takes the centre of the
 * numerically nearest pincode with the same first four (else three) digits, marked approx. Null if none.
 */
export function locate(pincode) {
  const pin = String(pincode || '');
  if (!/^[1-9]\d{5}$/.test(pin)) return null;
  const t = pincodes();
  const hit = t.get(pin);
  if (hit) return { lat: hit.lat, lng: hit.lng, approx: false };
  for (const len of [4, 3]) {
    let best = null;
    for (const [p, v] of t) {
      if (p.slice(0, len) !== pin.slice(0, len)) continue;
      const d = Math.abs(Number(p) - Number(pin));
      if (!best || d < best.d) best = { d, v };
    }
    if (best) return { lat: best.v.lat, lng: best.v.lng, approx: true };
  }
  return null;
}

const RAD = Math.PI / 180;
/** Great-circle distance in km. */
export function km(a, b) {
  const h = Math.sin(((b.lat - a.lat) * RAD) / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(((b.lng - a.lng) * RAD) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Pincodes (with accounts) within `range` km of `base`, nearest first.
 * areas: [{ pincode, ... }] → [{ ...area, km }]
 */
export function within(base, areas, range) {
  const b = locate(base);
  if (!b) return [];
  return areas
    .map((a) => {
      const at = locate(a.pincode);
      return at ? { ...a, km: Math.round(km(b, at) * 10) / 10, approx: at.approx } : null;
    })
    .filter((a) => a && a.km <= range)
    .sort((a, b2) => a.km - b2.km);
}

/**
 * Recruitment plan: where to place agents so every pincode with accounts is within `range` km of one,
 * and no agent gets more than `max` accounts.
 *
 * Greedy: repeatedly choose the base pincode whose reach (nearest first, up to `max` accounts) covers the
 * most overdue money not yet covered. A pincode with more than `max` accounts gets several agents of its
 * own. Agents who would get fewer than `min` accounts are listed separately as thin areas.
 *
 * areas: [{ pincode, district, state, accounts, overdue }] (one row per pincode).
 */
export function recruitmentPlan(areas, { range = 20, max = 250, min = 20 } = {}) {
  const located = [];
  const unlocated = [];
  for (const a of areas) {
    if (!a.accounts) continue;
    const at = locate(a.pincode);
    if (at) located.push({ ...a, at, left: a.accounts, overdueLeft: a.overdue });
    else unlocated.push(a);
  }
  // Neighbours of every pincode within range, nearest first.
  const near = new Map();
  for (const a of located) {
    near.set(a.pincode, located
      .map((b) => ({ b, d: a === b ? 0 : km(a.at, b.at) }))
      .filter((x) => x.d <= range)
      .sort((x, y) => x.d - y.d));
  }
  const agents = [];
  const take = (base) => {
    // What an agent based here would take: whole pincodes, nearest first, while they fit.
    const picked = [];
    let n = 0;
    let value = 0;
    for (const { b, d } of near.get(base.pincode)) {
      if (!b.left) continue;
      if (b.left > max) {
        // Too big for one agent: only an agent based there takes a full share of it.
        if (b === base && !picked.length) {
          picked.push({ b, d, n: max });
          n = max;
          value = (b.overdueLeft * max) / b.left;
          break;
        }
        continue;
      }
      if (n + b.left > max) continue;
      picked.push({ b, d, n: b.left });
      n += b.left;
      value += b.overdueLeft;
    }
    return { picked, n, value };
  };
  for (let guard = 0; guard < 5000; guard++) {
    let best = null;
    for (const c of located) {
      if (!c.left && !near.get(c.pincode).some((x) => x.b.left)) continue;
      const t = take(c);
      if (t.n && (!best || t.value > best.t.value || (t.value === best.t.value && t.n > best.t.n))) best = { c, t };
    }
    if (!best) break;
    const covers = best.t.picked.map(({ b, d, n }) => {
      const overdue = (b.overdueLeft * n) / b.left;
      b.left -= n;
      b.overdueLeft -= overdue;
      return { pincode: b.pincode, district: b.district, state: b.state, km: Math.round(d * 10) / 10, accounts: n, overdue: Math.round(overdue), approx: b.at.approx };
    });
    agents.push({
      base: { pincode: best.c.pincode, district: best.c.district, state: best.c.state, approx: best.c.at.approx },
      pincodes: covers,
      accounts: covers.reduce((s, p) => s + p.accounts, 0),
      overdue: covers.reduce((s, p) => s + p.overdue, 0),
      farthestKm: Math.max(...covers.map((p) => p.km)),
    });
  }
  agents.sort((a, b) => b.overdue - a.overdue);
  const main = agents.filter((a) => a.accounts >= min);
  const thin = agents.filter((a) => a.accounts < min);
  const total = (list, k) => list.reduce((s, a) => s + a[k], 0);
  return {
    range, max, min,
    agents: main.map((a, i) => ({ no: i + 1, ...a })),
    thin,
    unlocated,
    summary: {
      agents: main.length, accounts: total(main, 'accounts'), overdue: total(main, 'overdue'),
      thinAreas: thin.length, thinAccounts: total(thin, 'accounts'), thinOverdue: total(thin, 'overdue'),
      unlocated: unlocated.length, unlocatedAccounts: total(unlocated, 'accounts'),
    },
  };
}
