#!/usr/bin/env node
// Builds server/data/pincodes.csv (one centre per pincode) from the Department of Posts' All India Pincode
// Directory (one row per post office, with latitude/longitude; Open Government Data Platform India, GODL-India).
//
//   node scripts/pincodes.js path/to/pincode.csv
//
// The directory has known faults, handled here:
//   • many offices' coordinates are degrees + minutes written as a decimal (22.3424 = 22°34.24'): each office
//     gets both readings, and the reading its pincode's other offices — or its district's other pincodes — agree with wins;
//   • placeholder points copied onto offices of three or more pincodes are ignored;
//   • readings more than 400 km from the office's state are ignored.
import { readFileSync, writeFileSync } from 'node:fs';
const csv = readFileSync(process.argv[2] || (console.error('Give the path of the pincode directory CSV.'), process.exit(1)), 'utf8').split('\n').slice(1).filter(Boolean);
const inIndia = ([la, lo]) => la >= 6 && la <= 37.5 && lo >= 68 && lo <= 97.5;
// Degrees and minutes written as a decimal: 22.3424 meaning 22°34.24'.
const dms = (s) => {
  const m = /^(\d{1,2})\.(\d{2})(\d*)$/.exec(String(s).trim());
  if (!m || Number(m[2]) >= 60) return null;
  return Number(m[1]) + Number(`${m[2]}.${m[3] || 0}`) / 60;
};
const rad = Math.PI / 180;
const km = (a, b) => 12742 * Math.asin(Math.sqrt(Math.sin((b[0] - a[0]) * rad / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((b[1] - a[1]) * rad / 2) ** 2));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const medPt = (pts) => [med(pts.map((p) => p[0])), med(pts.map((p) => p[1]))];
const meanPt = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

const raw = csv.map((line) => {
  const f = line.match(/"([^"]*)"|[^,]+/g).map((x) => x.replace(/^"|"$/g, ''));
  return { pin: f[4], district: f[7], state: f[8], lat: f[9], lng: f[10], key: `${Number(f[9])},${Number(f[10])}` };
}).filter((r) => /^[1-9]\d{5}$/.test(r.pin));
// Placeholders: the same point given to offices of 3+ different pincodes.
const pinsOf = new Map();
for (const r of raw) { if (!pinsOf.has(r.key)) pinsOf.set(r.key, new Set()); pinsOf.get(r.key).add(r.pin); }
const uses = new Map([...pinsOf].map(([k, v]) => [k, v.size >= 3 ? 9 : 0]));
// Each state's centre from plain decimal readings, to drop readings hundreds of km away.
const stPts = new Map();
for (const r of raw) {
  const p = [Number(r.lat), Number(r.lng)];
  if (!inIndia(p) || uses.get(r.key) >= 4) continue;
  if (!stPts.has(r.state)) stPts.set(r.state, []);
  stPts.get(r.state).push(p);
}
const stCentre = new Map([...stPts].map(([s, pts]) => [s, medPt(pts)]));
const by = new Map();
let placeholders = 0;
for (const r of raw) {
  if (!by.has(r.pin)) by.set(r.pin, { offices: [], fallback: [], district: r.district, state: r.state });
  const p = by.get(r.pin);
  const sc = stCentre.get(r.state);
  const ok = (c) => inIndia(c) && (!sc || km(c, sc) <= 400);
  const dec = [Number(r.lat), Number(r.lng)];
  if (inIndia(dec)) p.fallback.push(dec);
  if (uses.get(r.key) >= 4) { placeholders++; continue; }
  const cands = [];
  if (ok(dec)) cands.push(dec);
  const alt = [dms(r.lat), dms(r.lng)];
  if (alt[0] != null && alt[1] != null && ok(alt) && (!cands.length || km(alt, dec) > 2)) cands.push(alt);
  if (cands.length) p.offices.push(cands);
}
for (const p of by.values()) if (!p.offices.length && p.fallback.length) p.offices = p.fallback.map((c) => [c]);
const pins = [...by].filter(([, p]) => p.offices.length);

// Consensus: the reading most offices agree on (within 5 km), decimal readings first on ties.
function consensus(offices) {
  let best = null;
  for (const o of offices) o.forEach((c, i) => {
    const votes = offices.filter((x) => x.some((d) => km(c, d) <= 5)).length;
    if (!best || votes > best.votes || (votes === best.votes && i < best.i)) best = { c, votes, i };
  });
  return near(offices, best.c, best.votes);
}
function near(offices, ref, votes = 0) {
  const pts = offices.map((c) => c.reduce((a, b) => (km(a, ref) <= km(b, ref) ? a : b)));
  const m = medPt(pts);
  const close = pts.filter((p) => km(p, m) <= 15);
  return { c: meanPt(close.length ? close : pts), votes };
}
const own = new Map(pins.map(([pin, p]) => [pin, consensus(p.offices)]));
const centre = new Map([...own].map(([k, v]) => [k, v.c]));
const groups = (len) => {
  const g = new Map();
  for (const [pin] of pins) { const k = pin.slice(0, len); if (!g.has(k)) g.set(k, []); g.get(k).push(pin); }
  return g;
};
const g4 = groups(4), g3 = groups(3);
// Neighbours: the pincodes of the same district whose offices agree among themselves; else same first 4/3 digits.
const strong = new Set(pins.filter(([pin, p]) => own.get(pin).votes >= 2 && own.get(pin).votes >= p.offices.length / 2).map(([pin]) => pin));
const byDistrict = new Map();
for (const [pin, p] of pins) {
  const k = `${p.state}|${p.district}`;
  if (!byDistrict.has(k)) byDistrict.set(k, []);
  byDistrict.get(k).push(pin);
}
const hintOf = (pin) => {
  const p = by.get(pin);
  let nb = byDistrict.get(`${p.state}|${p.district}`).filter((x) => x !== pin && strong.has(x));
  if (nb.length < 3) nb = g4.get(pin.slice(0, 4)).filter((x) => x !== pin);
  if (nb.length < 3) nb = g3.get(pin.slice(0, 3)).filter((x) => x !== pin);
  return nb.length ? medPt(nb.map((x) => centre.get(x))) : null;
};
let overridden = 0;
for (let round = 0; round < 4; round++) {
  const next = new Map();
  let changed = 0;
  for (const [pin, p] of pins) {
    const hint = hintOf(pin);
    const a = own.get(pin);
    let c = a.c;
    if (hint) {
      const weak = a.votes < 2 || a.votes < p.offices.length / 2;
      // The offices' readings within 40 km of the neighbours.
      const pts = p.offices.map((o) => o.reduce((x, y) => (km(x, hint) <= km(y, hint) ? x : y))).filter((q) => km(q, hint) <= 40);
      const b = pts.length ? meanPt(pts) : a.c;
      const support = pts.length / p.offices.length;
      // Neighbours overrule a pincode's own offices only when those disagree or sit far from every neighbour.
      if ((weak && km(b, hint) < km(a.c, hint) - 10) || (support >= 0.25 && km(b, hint) < km(a.c, hint) - 20)) c = b;
    }
    if (km(c, centre.get(pin)) > 1) changed++;
    next.set(pin, c);
  }
  for (const [k, v] of next) centre.set(k, v);
  console.log('round', round, 'changed', changed);
}
for (const [pin] of pins) if (km(centre.get(pin), own.get(pin).c) > 1) overridden++;
let far = 0;
for (const [pin] of pins) { const h = hintOf(pin); if (h && km(centre.get(pin), h) > 50) far++; }
console.log('offices', raw.length, 'placeholders', placeholders, 'pincodes', pins.length, 'overruled by neighbours', overridden, '>50 km from neighbours', far);
const rows = pins.sort(([a], [b]) => a.localeCompare(b)).map(([pin, p]) => {
  const c = centre.get(pin);
  return [pin, c[0].toFixed(4), c[1].toFixed(4), p.district.replace(/,/g, ' '), p.state.replace(/,/g, ' ')].join(',');
});
writeFileSync(new URL('../server/data/pincodes.csv', import.meta.url),
  '# India pincode centres built by scripts/pincodes.js from the Department of Posts All India Pincode Directory (Dec 2021,\n' +
  '# Open Government Data Platform India, GODL-India; copy from github.com/harshvardhaniimi/IndiaPIN, MIT). pincode,lat,lng,district,state\n' +
  `${rows.join('\n')}\n`);
