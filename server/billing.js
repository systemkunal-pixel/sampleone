// Circles and billing. A circle is a billing area of one client, defined by the company: whole states,
// districts (possibly from two states) or single pincodes. Each account belongs to the most specific
// matching circle (pincode, then district, then state); a Circle column in the client's file overrides.
// The billing report totals collections by Client → State → Circle → District → Branch for a period.
import ExcelJS from 'exceljs';
import { withTx, audit, now } from './db.js';
import { HttpError, send } from './http.js';

const KINDS = ['state', 'district', 'pincode'];
const up = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[;,\n]+/)).map(up).filter(Boolean))];
const NONE = '—';

/** Sets loans.circle_id for every account of a client from its circles. Returns { assigned, unmatched, created }. */
export async function resolveCircles(conn, companyId, clientId) {
  const circles = await conn.query('SELECT id, name FROM circles WHERE company_id = ? AND client_id = ? ORDER BY id', [companyId, clientId]);
  const byName = new Map(circles.map((c) => [up(c.name), c.id]));
  // Circles named in the client's file that don't exist yet are created (with no rules).
  let created = 0;
  for (const r of await conn.query(
    'SELECT DISTINCT circle_in_file AS name FROM loans WHERE company_id = ? AND client_id = ? AND circle_in_file IS NOT NULL', [companyId, clientId])) {
    if (byName.has(up(r.name))) continue;
    const res = await conn.query('INSERT INTO circles (company_id, client_id, name, created_at) VALUES (?, ?, ?, ?)', [companyId, clientId, r.name, now()]);
    byName.set(up(r.name), res.insertId);
    created += 1;
  }
  const rules = { state: new Map(), district: new Map(), pincode: new Map() };
  for (const a of await conn.query(
    'SELECT a.circle_id, a.kind, a.value FROM circle_areas a JOIN circles c ON c.id = a.circle_id WHERE c.client_id = ? ORDER BY a.circle_id', [clientId])) {
    if (!rules[a.kind].has(a.value)) rules[a.kind].set(a.value, a.circle_id); // the first circle defined wins a tie
  }
  const loans = await conn.query('SELECT id, state, district, pincode, circle_in_file, circle_id FROM loans WHERE company_id = ? AND client_id = ?', [companyId, clientId]);
  const target = new Map(); // circle id (or null) → loan ids
  let unmatched = 0;
  for (const l of loans) {
    const id = (l.circle_in_file && byName.get(up(l.circle_in_file)))
      || rules.pincode.get(up(l.pincode)) || rules.district.get(`${up(l.state)}|${up(l.district)}`) || rules.state.get(up(l.state)) || null;
    if (!id) unmatched += 1;
    if (id === l.circle_id) continue;
    if (!target.has(id)) target.set(id, []);
    target.get(id).push(l.id);
  }
  for (const [id, ids] of target) {
    for (let i = 0; i < ids.length; i += 1000) await conn.query('UPDATE loans SET circle_id = ? WHERE id IN (?)', [id, ids.slice(i, i + 1000)]);
  }
  return { assigned: loans.length - unmatched, unmatched, created };
}

async function clientOf(conn, companyId, id) {
  const [c] = await conn.query('SELECT * FROM clients WHERE company_id = ? AND id = ?', [companyId, Number(id) || 0]);
  if (!c) throw new HttpError(404, 'Client not found.');
  return c;
}

export function registerBillingRoutes(R, { pool, readJson }) {
  // ---------- circles ----------

  /** The client's states and districts (from its accounts), and its circles with their coverage. */
  R('GET', '/clients/:id/circles', async ({ params, user }) => {
    const c = await clientOf(pool, user.companyId, params.id);
    const areas = await pool.query(
      `SELECT UPPER(COALESCE(state, '')) AS state, UPPER(COALESCE(district, '')) AS district, COUNT(*) AS accounts, SUM(circle_id IS NULL) AS unmatched
       FROM loans WHERE company_id = ? AND client_id = ? GROUP BY 1, 2 ORDER BY 1, 2`, [user.companyId, c.id]);
    const circles = await pool.query(
      `SELECT ci.id, ci.name, ci.fee_pct, (SELECT COUNT(*) FROM loans l WHERE l.circle_id = ci.id) AS accounts
       FROM circles ci WHERE ci.client_id = ? ORDER BY ci.name`, [c.id]);
    const rules = await pool.query(
      'SELECT a.circle_id, a.kind, a.value FROM circle_areas a JOIN circles ci ON ci.id = a.circle_id WHERE ci.client_id = ? ORDER BY a.kind, a.value', [c.id]);
    const states = new Map();
    for (const a of areas) {
      if (!states.has(a.state)) states.set(a.state, { state: a.state || NONE, accounts: 0, districts: [] });
      const s = states.get(a.state);
      s.accounts += Number(a.accounts);
      s.districts.push({ district: a.district || NONE, accounts: Number(a.accounts), unmatched: Number(a.unmatched) });
    }
    return {
      client: { id: c.id, code: c.code, name: c.name, feePct: c.fee_pct },
      states: [...states.values()],
      unmatched: areas.reduce((s, a) => s + Number(a.unmatched), 0),
      circles: circles.map((ci) => ({
        id: ci.id, name: ci.name, feePct: ci.fee_pct, accounts: Number(ci.accounts),
        states: rules.filter((r) => r.circle_id === ci.id && r.kind === 'state').map((r) => r.value),
        districts: rules.filter((r) => r.circle_id === ci.id && r.kind === 'district').map((r) => {
          const [state, district] = r.value.split('|');
          return { state, district };
        }),
        pincodes: rules.filter((r) => r.circle_id === ci.id && r.kind === 'pincode').map((r) => r.value),
      })),
    };
  });

  /** Creates or replaces a circle: { name, feePct, states: [], districts: [{state, district}] | ["STATE|DISTRICT"], pincodes: [] }. */
  async function saveCircle(user, clientId, circleId, b) {
    const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (name.length < 2) throw new HttpError(400, 'Enter the circle name.');
    const fee = b.feePct === '' || b.feePct == null ? null : Number(b.feePct);
    if (fee !== null && !(fee >= 0 && fee <= 100)) throw new HttpError(400, 'Fee must be a percentage from 0 to 100, or empty.');
    const states = list(b.states);
    const districts = (Array.isArray(b.districts) ? b.districts : [])
      .map((d) => (typeof d === 'string' ? d : `${up(d?.state)}|${up(d?.district)}`)).map(up).filter((d) => /^[^|]+\|[^|]+$/.test(d));
    const pincodes = list(b.pincodes).filter((p) => /^[1-9]\d{5}$/.test(p));
    return withTx(pool, async (conn) => {
      const c = await clientOf(conn, user.companyId, clientId);
      let id = circleId;
      try {
        if (id) {
          const r = await conn.query('UPDATE circles SET name = ?, fee_pct = ? WHERE id = ? AND client_id = ?', [name, fee, id, c.id]);
          if (!r.affectedRows) throw new HttpError(404, 'Circle not found.');
          await conn.query('DELETE FROM circle_areas WHERE circle_id = ?', [id]);
        } else {
          id = (await conn.query('INSERT INTO circles (company_id, client_id, name, fee_pct, created_at) VALUES (?, ?, ?, ?, ?)',
            [user.companyId, c.id, name, fee, now()])).insertId;
        }
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, `${c.name} already has a circle called ${name}.`);
        throw err;
      }
      const rows = [...states.map((v) => ['state', v]), ...districts.map((v) => ['district', v]), ...pincodes.map((v) => ['pincode', v])];
      for (const [kind, value] of rows) await conn.query('INSERT IGNORE INTO circle_areas (circle_id, kind, value) VALUES (?, ?, ?)', [id, kind, value]);
      const result = await resolveCircles(conn, user.companyId, c.id);
      await audit(conn, user, circleId ? 'circle_updated' : 'circle_created', name, { client: c.code, states: states.length, districts: districts.length, pincodes: pincodes.length });
      return { id, ...result };
    });
  }

  R('POST', '/clients/:id/circles', async ({ req, params, user }) => saveCircle(user, params.id, null, await readJson(req)));
  R('PUT', '/clients/:id/circles/:circle', async ({ req, params, user }) => saveCircle(user, params.id, Number(params.circle) || 0, await readJson(req)));
  R('DELETE', '/clients/:id/circles/:circle', async ({ params, user }) => withTx(pool, async (conn) => {
    const c = await clientOf(conn, user.companyId, params.id);
    const [ci] = await conn.query('SELECT id, name FROM circles WHERE id = ? AND client_id = ?', [Number(params.circle) || 0, c.id]);
    if (!ci) throw new HttpError(404, 'Circle not found.');
    await conn.query('DELETE FROM circles WHERE id = ?', [ci.id]);
    await conn.query('UPDATE loans SET circle_id = NULL WHERE circle_id = ?', [ci.id]);
    const result = await resolveCircles(conn, user.companyId, c.id);
    await audit(conn, user, 'circle_deleted', ci.name, { client: c.code });
    return result;
  }));

  // ---------- billing report ----------

  async function report(user, query) {
    const c = await clientOf(pool, user.companyId, query.get('client'));
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.get('from') || '') ? query.get('from') : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(query.get('to') || '') ? query.get('to') : null;
    if (!from || !to || from > to) throw new HttpError(400, 'Choose the period (from and to dates).');
    const basis = query.get('basis') === 'all' ? 'all' : 'verified';
    const rows = await pool.query(
      `SELECT p.id, p.recorded_at, p.amount, p.mode, p.receipt_no, p.officer_code, p.slip_no, p.verification, p.reference,
              l.loan_no, l.borrower, l.state, l.district, l.branch, l.pincode, ci.name AS circle, ci.fee_pct AS circle_fee, u.name AS officer_name
       FROM payments p JOIN loans l ON l.id = p.loan_id
       LEFT JOIN circles ci ON ci.id = p.circle_id LEFT JOIN users u ON u.company_id = p.company_id AND u.code = p.officer_code
       WHERE p.company_id = ? AND p.client_id = ? AND p.recorded_at >= ? AND p.recorded_at < DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY p.recorded_at`, [user.companyId, c.id, `${from} 00:00:00`, to]);
    const fee = (r) => (r.circle_fee != null ? Number(r.circle_fee) : c.fee_pct != null ? Number(c.fee_pct) : null);
    const blank = () => ({ receipts: 0, billable: 0, pending: 0, rejected: 0, fee: 0, accounts: new Set() });
    const add = (n, r) => {
      const deposit = Boolean(r.slip_no);
      const amount = Number(r.amount);
      if (deposit && r.verification === 'rejected') n.rejected += amount;
      else if (deposit && r.verification === 'pending' && basis === 'verified') n.pending += amount;
      else {
        n.billable += amount;
        n.receipts += 1;
        n.accounts.add(r.loan_no);
        const f = fee(r);
        if (f != null) n.fee += (amount * f) / 100;
      }
    };
    const total = blank();
    const states = new Map();
    const circles = new Map();
    const level = (map, key, make) => {
      if (!map.has(key)) map.set(key, make());
      return map.get(key);
    };
    for (const r of rows) {
      add(total, r);
      const S = level(states, r.state || NONE, () => ({ name: r.state || NONE, ...blank(), children: new Map() }));
      const C = level(S.children, r.circle || NONE, () => ({ name: r.circle || NONE, ...blank(), children: new Map() }));
      const D = level(C.children, r.district || NONE, () => ({ name: r.district || NONE, ...blank(), children: new Map() }));
      const B = level(D.children, r.branch || NONE, () => ({ name: r.branch || NONE, ...blank(), children: new Map() }));
      for (const n of [S, C, D, B]) add(n, r);
      add(level(circles, r.circle || NONE, () => ({ name: r.circle || NONE, ...blank(), states: new Set() })), r);
      circles.get(r.circle || NONE).states.add(r.state || NONE);
    }
    const out = (n) => ({
      name: n.name, receipts: n.receipts, accounts: n.accounts.size, billable: Math.round(n.billable * 100) / 100,
      pending: n.pending, rejected: n.rejected, fee: Math.round(n.fee * 100) / 100,
      ...(n.children ? { children: [...n.children.values()].sort((a, b) => b.billable - a.billable).map(out) } : {}),
      ...(n.states ? { states: [...n.states] } : {}),
    });
    return {
      client: { id: c.id, code: c.code, name: c.name, feePct: c.fee_pct }, from, to, basis,
      total: out(total),
      states: [...states.values()].sort((a, b) => b.billable - a.billable).map(out),
      circles: [...circles.values()].sort((a, b) => b.billable - a.billable).map(out),
      receipts: rows,
    };
  }

  R('GET', '/billing', async ({ query, user }) => {
    const r = await report(user, query);
    return { ...r, receipts: undefined, receiptCount: r.receipts.length };
  });

  R('GET', '/billing.xlsx', async ({ res, query, user }) => {
    const r = await report(user, query);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'LoanDesk';
    const head = (ws) => {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5132' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };
    const money = (ws, cols) => cols.forEach((c) => (ws.getColumn(c).numFmt = '#,##0.00'));
    const sum = wb.addWorksheet('Summary');
    sum.columns = [['Level', 10], ['State', 18], ['Circle', 22], ['District', 22], ['Branch', 16], ['Receipts', 10], ['Accounts', 10],
      ['Billable', 15], ['Deposits pending', 15], ['Rejected', 13], ['Fee', 13]].map(([header, width]) => ({ header, width }));
    const line = (lvl, path, n) => sum.addRow([lvl, ...path, n.receipts, n.accounts, n.billable, n.pending, n.rejected, n.fee]);
    for (const s of r.states) {
      line('State', [s.name, '', '', ''], s);
      for (const ci of s.children) {
        line('Circle', [s.name, ci.name, '', ''], ci);
        for (const d of ci.children) {
          line('District', [s.name, ci.name, d.name, ''], d);
          for (const b of d.children) if (b.name !== NONE) line('Branch', [s.name, ci.name, d.name, b.name], b);
        }
      }
    }
    sum.addRow(['Total', '', '', '', '', r.total.receipts, r.total.accounts, r.total.billable, r.total.pending, r.total.rejected, r.total.fee]).font = { bold: true };
    money(sum, [8, 9, 10, 11]);
    head(sum);
    const cir = wb.addWorksheet('Circles');
    cir.columns = [['Circle', 24], ['States', 30], ['Receipts', 10], ['Accounts', 10], ['Billable', 15], ['Deposits pending', 15], ['Rejected', 13], ['Fee', 13]]
      .map(([header, width]) => ({ header, width }));
    for (const ci of r.circles) cir.addRow([ci.name, ci.states.join(', '), ci.receipts, ci.accounts, ci.billable, ci.pending, ci.rejected, ci.fee]);
    money(cir, [5, 6, 7, 8]);
    head(cir);
    const det = wb.addWorksheet('Receipts');
    det.columns = [['Date', 18], ['Receipt no', 18], ['Account', 14], ['Borrower', 24], ['State', 16], ['Circle', 20], ['District', 20], ['Branch', 14],
      ['Pincode', 9], ['Agent', 10], ['Agent name', 20], ['Mode', 13], ['Amount', 12], ['Slip / reference', 16], ['Deposit status', 13], ['Billable', 9]]
      .map(([header, width]) => ({ header, width }));
    for (const p of r.receipts) {
      const deposit = Boolean(p.slip_no);
      const billable = !(deposit && (p.verification === 'rejected' || (p.verification === 'pending' && r.basis === 'verified')));
      det.addRow([p.recorded_at, p.receipt_no, p.loan_no, JSON.parse(p.borrower).name, p.state, p.circle || '', p.district, p.branch, p.pincode,
        p.officer_code, p.officer_name || '', p.mode, Number(p.amount), p.slip_no || p.reference || '', deposit ? p.verification : '', billable ? 'Yes' : 'No']);
    }
    money(det, [13]);
    head(det);
    const about = wb.addWorksheet('About');
    about.columns = [{ width: 24 }, { width: 70 }];
    for (const row of [['Client', `${r.client.name} (${r.client.code})`], ['Period', `${r.from} to ${r.to}`],
      ['Billable', r.basis === 'verified' ? 'Cash, UPI, cheque and transfers as recorded; bank deposits once a supervisor verified the slip' : 'Everything recorded, except rejected deposits'],
      ['Fee', 'Circle fee % where set, otherwise the client fee %'], ['Circle', 'As the account was on the day the payment was collected'], ['Made', now()]]) about.addRow(row);
    send(res, 200, Buffer.from(await wb.xlsx.writeBuffer()), {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="billing-${r.client.code}-${r.from}-to-${r.to}.xlsx"`,
    });
  });
}
