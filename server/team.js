// The field team: State Heads → District Coordinators → Agents. Everyone reports to one person above.
// Agents sign in as field officers; State Heads and Coordinators as supervisors who see their own team.
// Admin console → Team: the hierarchy with figures, importing people under a parent, moving people.
import { randomInt } from 'node:crypto';
import { isoDate } from '../src/js/logic.js';
import { hashPin, validPin, SUPPORT_CODE } from './auth.js';
import { withTx, audit, now } from './db.js';
import { HttpError, send } from './http.js';
import { readTable, parsePhone, parsePincode, ImportError } from './importer.js';
import { EMAIL } from './mail.js';
import { within } from './geo.js';
import ExcelJS from 'exceljs';

export const POSTS = {
  state_head: { label: 'State Head', role: 'supervisor', parent: null, prefix: 'SH', digits: 2 },
  coordinator: { label: 'District Coordinator', role: 'supervisor', parent: 'state_head', prefix: 'DC', digits: 4 },
  agent: { label: 'Agent', role: 'officer', parent: 'coordinator', prefix: 'AG', digits: 4 },
};
const MAX_PEOPLE = 2000;
const CODE = /^[A-Z0-9]{2,12}$/;

const PEOPLE_COLUMNS = {
  name: ['name', 'full name', 'agent name', 'employee name', 'person name'],
  phone: ['mobile', 'mobile no', 'mobile number', 'phone', 'phone number', 'contact', 'contact no'],
  code: ['code', 'user code', 'employee id', 'emp id', 'emp code', 'employee code', 'agent code', 'login code'],
  basePincode: ['home pincode', 'pincode', 'pin code', 'base pincode', 'residence pincode'],
  rangeKm: ['range km', 'range', 'coverage km', 'km', 'travel km'],
  states: ['state', 'states'],
  districts: ['district', 'districts'],
  pin: ['pin', 'login pin', 'password'],
  email: ['email', 'email id', 'e mail'],
};

const str = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** "Howrah; Hooghly", "HOWRAH, HOOGHLY" → "HOWRAH; HOOGHLY" */
const listOf = (v, max) => [...new Set(str(v, max * 2).split(/[;,/|]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))].join('; ').slice(0, max) || null;
export const splitList = (v) => (v ? String(v).split(/;\s*/).filter(Boolean) : []);

// ---------- who is in whose team ----------

/** All field users of a company with post/parent, as a Map code → user. */
async function people(conn, companyId) {
  return new Map((await conn.query(
    `SELECT id, code, name, role, branch, active, post, parent_code, phone, base_pincode, range_km, area_states, area_districts, last_login_at
     FROM users WHERE company_id = ? AND role <> 'admin'`, [companyId])).map((u) => [u.code, u]));
}

/** Codes of everyone below `code` (not including them). */
export function descendants(all, code) {
  const kids = new Map();
  for (const u of all.values()) {
    if (!u.parent_code) continue;
    if (!kids.has(u.parent_code)) kids.set(u.parent_code, []);
    kids.get(u.parent_code).push(u.code);
  }
  const out = [];
  const stack = [...(kids.get(code) || [])];
  const seen = new Set([code]);
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...(kids.get(c) || []));
  }
  return out;
}

/**
 * What a supervisor sees. With a team post: the accounts of the agents below them, plus (Coordinators,
 * and State Heads through their Coordinators) the unassigned accounts in their districts. Without a post:
 * their branch, as before. Returns { officerCodes, districts } or { branch }.
 */
export async function supervisorScope(conn, user) {
  const [me] = await conn.query('SELECT post, area_districts FROM users WHERE id = ?', [user.id]);
  if (!me?.post) return { branch: user.branch };
  const all = await people(conn, user.companyId);
  const below = descendants(all, user.code).map((c) => all.get(c));
  const officerCodes = below.filter((u) => u.role === 'officer').map((u) => u.code);
  const districts = new Set(splitList(me.area_districts));
  for (const u of below) if (u.post === 'coordinator') splitList(u.area_districts).forEach((d) => districts.add(d));
  return { officerCodes, districts: [...districts] };
}

/** SQL condition on loans `l` for a scope from supervisorScope. */
export function scopeSql(scope) {
  if (scope.branch !== undefined) return { sql: 'l.branch = ?', args: [scope.branch] };
  const parts = [];
  const args = [];
  if (scope.officerCodes.length) parts.push('l.officer_code IN (?)'), args.push(scope.officerCodes);
  if (scope.districts.length) parts.push('(l.officer_code IS NULL AND UPPER(l.district) IN (?))'), args.push(scope.districts);
  return parts.length ? { sql: `(${parts.join(' OR ')})`, args } : { sql: '1 = 0', args: [] };
}

// ---------- codes and PINs ----------

async function nextCodes(conn, prefix, digits, n) {
  const rows = await conn.query('SELECT code FROM users WHERE code LIKE ?', [`${prefix}%`]);
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(r.code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Array.from({ length: n }, (_, i) => `${prefix}${String(max + 1 + i).padStart(digits, '0')}`);
}

const randomPin = () => String(randomInt(0, 10000)).padStart(4, '0');

// ---------- checking a list of people ----------

/**
 * rows: [{ rowNo, values: { name, phone, code, basePincode, rangeKm, states, districts, pin, email } }]
 * Returns { ready: [person], errors: [{ rowNo, name, errors }] }; warnings never stop a row.
 */
async function checkPeople(conn, companyId, post, rows, { defaultRange = 20 } = {}) {
  const existing = new Set((await conn.query('SELECT code FROM users')).map((r) => r.code));
  const inFile = new Map();
  const ready = [];
  const errors = [];
  const needCode = [];
  for (const r of rows) {
    const v = r.values;
    const warnings = [];
    const problems = [];
    const name = str(v.name, 100);
    if (name.length < 2) problems.push('Name is missing.');
    let phone = parsePhone(v.phone);
    if (!phone) {
      phone = str(v.phone, 20).replace(/[^\d+]/g, '') || null;
      warnings.push(`Mobile "${str(v.phone, 20) || '—'}" is not a valid 10-digit number; imported as given.`);
    }
    let code = str(v.code, 12).toUpperCase().replace(/\s/g, '');
    if (code && !CODE.test(code)) problems.push(`Code ${code} must be 2–12 letters or digits.`);
    else if (code === SUPPORT_CODE) problems.push(`${SUPPORT_CODE} is reserved for LoanDesk support.`);
    else if (code && existing.has(code)) problems.push(`Code ${code} is already used by someone else.`);
    else if (code && inFile.has(code)) problems.push(`Code ${code} is also on row ${inFile.get(code)}.`);
    if (code) inFile.set(code, r.rowNo);
    let basePincode = null;
    let rangeKm = null;
    if (post === 'agent') {
      basePincode = parsePincode(v.basePincode);
      if (!basePincode) warnings.push('No home pincode: set it later for “Pincodes in range”.');
      rangeKm = Number(v.rangeKm) || defaultRange;
      if (!(rangeKm >= 1 && rangeKm <= 200)) {
        warnings.push(`Range "${str(v.rangeKm, 10)}" is not 1–200 km: ${defaultRange} km is used.`);
        rangeKm = defaultRange;
      }
    }
    let pin = str(v.pin, 8);
    let pinGiven = Boolean(pin);
    if (pin && !validPin(pin, 'officer')) {
      warnings.push('PIN must be 4–8 digits: a new PIN is made instead.');
      pin = '';
      pinGiven = false;
    }
    let email = str(v.email, 190).toLowerCase() || null;
    if (email && !EMAIL.test(email)) {
      warnings.push('Email is not valid; left empty.');
      email = null;
    }
    const person = {
      rowNo: r.rowNo, code, autoCode: !code, name, phone, basePincode, rangeKm,
      states: listOf(v.states, 300), districts: listOf(v.districts, 1000), pin: pin || null, pinGiven, email, warnings,
    };
    if (problems.length) errors.push({ rowNo: r.rowNo, name, errors: problems });
    else {
      ready.push(person);
      if (!code) needCode.push(person);
    }
  }
  const p = POSTS[post];
  const codes = await nextCodes(conn, p.prefix, p.digits, needCode.length + inFile.size);
  for (const person of needCode) {
    while (inFile.has(codes[0]) || existing.has(codes[0])) codes.shift();
    person.code = codes.shift();
  }
  return { ready, errors };
}

function parentFor(all, post, parentCode) {
  const want = POSTS[post].parent;
  if (!want) {
    if (parentCode) throw new HttpError(400, 'State Heads report to the company admin; leave the parent empty.');
    return null;
  }
  const parent = all.get(String(parentCode || '').toUpperCase());
  if (!parent || parent.post !== want) throw new HttpError(400, `Choose the ${POSTS[want].label} these people report to.`);
  if (!parent.active) throw new HttpError(400, `${parent.name} is deactivated.`);
  return parent;
}

// ---------- routes ----------

export function registerTeamRoutes(R, { pool, readJson, deputeNearby }) {
  async function rowsFrom(b) {
    if (Array.isArray(b.people)) {
      if (b.people.length > MAX_PEOPLE) throw new HttpError(400, `Up to ${MAX_PEOPLE} people at a time.`);
      return b.people.map((v, i) => ({ rowNo: i + 1, values: v || {} }));
    }
    const name = str(b.fileName, 200);
    if (!name || typeof b.base64 !== 'string') throw new HttpError(400, 'Choose a file to upload.');
    try {
      const { records, map } = await readTable(name, Buffer.from(b.base64, 'base64'), PEOPLE_COLUMNS, MAX_PEOPLE);
      if (map.name === undefined) throw new HttpError(400, 'The file needs a Name column.');
      return records.map((r) => ({ rowNo: r.rowNo, values: r.values }));
    } catch (err) {
      if (err instanceof ImportError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  const postOf = (b) => {
    if (!POSTS[b.post]) throw new HttpError(400, 'Choose the post.');
    return b.post;
  };

  R('POST', '/team/preview', async ({ req, user }) => {
    const b = await readJson(req, 12 * 1024 * 1024);
    const post = postOf(b);
    const all = await people(pool, user.companyId);
    const parent = parentFor(all, post, b.parentCode);
    const { ready, errors } = await checkPeople(pool, user.companyId, post, await rowsFrom(b), { defaultRange: Number(b.defaultRange) || 20 });
    return { post, parent: parent && { code: parent.code, name: parent.name }, rows: ready.map(({ pin, ...p }) => p), errors };
  });

  R('POST', '/team/commit', async ({ req, user }) => {
    const b = await readJson(req, 12 * 1024 * 1024);
    const post = postOf(b);
    const p = POSTS[post];
    const result = await withTx(pool, async (conn) => {
      const all = await people(conn, user.companyId);
      const parent = parentFor(all, post, b.parentCode);
      // Re-check everything: the browser's copy is never trusted.
      const { ready, errors } = await checkPeople(conn, user.companyId, post, await rowsFrom(b), { defaultRange: Number(b.defaultRange) || 20 });
      if (!ready.length) throw new HttpError(400, 'Nobody to add.');
      const logins = [];
      for (const person of ready) {
        const pin = person.pin || randomPin();
        await conn.query(
          `INSERT INTO users (company_id, code, name, role, branch, pin_hash, post, parent_code, phone, base_pincode, range_km,
             area_states, area_districts, email, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [user.companyId, person.code, person.name, p.role, await hashPin(pin), post, parent?.code ?? null, person.phone, person.basePincode,
            person.rangeKm, person.states, person.districts, person.email, now()]);
        logins.push({ code: person.code, name: person.name, phone: person.phone, pin, post: p.label });
      }
      await audit(conn, user, 'team_imported', parent?.code || 'top', { post, count: ready.length, skipped: errors.length });
      return { logins, skipped: errors.length };
    });
    // Agents: depute them to the pincodes within their range that have no agent yet.
    let deputed = 0;
    if (post === 'agent' && b.autoDepute && deputeNearby) {
      for (const l of result.logins) deputed += await deputeNearby(user, l.code);
    }
    return { ...result, deputed };
  });

  R('GET', '/team/template', async ({ res, query }) => {
    const post = POSTS[query.get('post')] ? query.get('post') : 'agent';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('People');
    const cols = [['Name *', 24], ['Mobile *', 14], ['Code', 10], ...(post === 'agent' ? [['Home Pincode', 13], ['Range km', 9]] : []),
      ['State', 16], ['District', 28], ['PIN', 8], ['Email', 24]];
    ws.columns = cols.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5132' } };
    ws.addRow(['Sk Rafiq Hossain', '9830012345', '', ...(post === 'agent' ? ['711302', 20] : []), 'WEST BENGAL', post === 'state_head' ? '' : 'HOWRAH', '', '']);
    const help = wb.addWorksheet('Instructions');
    help.columns = [{ width: 18 }, { width: 90 }];
    for (const r of [
      ['Name, Mobile', 'Required. A wrong mobile number is imported as given and flagged.'],
      ['Code', `Leave blank to get the next free code (${POSTS[post].prefix}…). Codes are unique across LoanDesk.`],
      ...(post === 'agent' ? [['Home Pincode, Range km', 'Where the agent lives and how far they travel; used for “Pincodes in range”.']] : []),
      ['State, District', 'The area they look after. Several districts: separate with ; (e.g. HOWRAH; HOOGHLY). Coordinators also see unassigned accounts in their districts.'],
      ['PIN', 'Blank = a random 4-digit PIN. The logins sheet after import lists every PIN once.'],
    ]) help.addRow(r);
    send(res, 200, Buffer.from(await wb.xlsx.writeBuffer()), {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="team-${post}-template.xlsx"`,
    });
  });

  /** The hierarchy with figures that add up the tree. */
  R('GET', '/team', async ({ user }) => {
    const all = await people(pool, user.companyId);
    const team = [...all.values()].filter((u) => u.post);
    const month = `${isoDate().slice(0, 7)}-01 00:00:00`;
    const loans = await pool.query(
      `SELECT officer_code, district, COUNT(*) AS n, SUM(t_odue) AS due FROM loans WHERE company_id = ? GROUP BY officer_code, district`, [user.companyId]);
    const byOfficer = new Map();
    const unassignedByDistrict = new Map();
    for (const l of loans) {
      if (l.officer_code) {
        const o = byOfficer.get(l.officer_code) || { accounts: 0, due: 0 };
        o.accounts += Number(l.n);
        o.due += Number(l.due) || 0;
        byOfficer.set(l.officer_code, o);
      } else if (l.district) {
        const k = l.district.toUpperCase();
        unassignedByDistrict.set(k, (unassignedByDistrict.get(k) || 0) + Number(l.n));
      }
    }
    const collected = new Map((await pool.query(
      `SELECT officer_code, SUM(amount) AS amount FROM payments WHERE company_id = ? AND recorded_at >= ? AND (verification IS NULL OR verification <> 'rejected')
       GROUP BY officer_code`, [user.companyId, month])).map((r) => [r.officer_code, Number(r.amount) || 0]));
    const node = (u) => {
      const kids = team.filter((k) => k.parent_code === u.code).sort((a, b) => a.name.localeCompare(b.name)).map(node);
      const own = byOfficer.get(u.code) || { accounts: 0, due: 0 };
      const districts = splitList(u.area_districts);
      const unassigned = u.post === 'coordinator'
        ? districts.reduce((s, d) => s + (unassignedByDistrict.get(d) || 0), 0)
        : kids.reduce((s, k) => s + k.unassigned, 0);
      return {
        code: u.code, name: u.name, post: u.post, active: Boolean(u.active), phone: u.phone, parentCode: u.parent_code,
        basePincode: u.base_pincode, rangeKm: u.range_km, states: splitList(u.area_states), districts, lastLoginAt: u.last_login_at,
        people: kids.reduce((s, k) => s + 1 + k.people, 0),
        accounts: own.accounts + kids.reduce((s, k) => s + k.accounts, 0),
        due: own.due + kids.reduce((s, k) => s + k.due, 0),
        collectedMonth: (collected.get(u.code) || 0) + kids.reduce((s, k) => s + k.collectedMonth, 0),
        unassigned,
        children: kids,
      };
    };
    const roots = team.filter((u) => !u.parent_code || !all.get(u.parent_code)?.post).sort((a, b) => a.name.localeCompare(b.name)).map(node);
    const count = (post) => team.filter((u) => u.post === post && u.active).length;
    const orphans = team.filter((u) => u.post !== 'state_head' && (!u.parent_code || !all.get(u.parent_code))).length;
    return {
      counts: { state_head: count('state_head'), coordinator: count('coordinator'), agent: count('agent'), orphans },
      roots,
      parents: team.filter((u) => u.active && u.post !== 'agent').map((u) => ({ code: u.code, name: u.name, post: u.post, parentCode: u.parent_code, districts: splitList(u.area_districts), states: splitList(u.area_states) })),
    };
  });

  /** Moves someone under another parent (same post rules), or changes their area. */
  R('PATCH', '/team/:code', async ({ req, params, user }) => {
    const b = await readJson(req);
    return withTx(pool, async (conn) => {
      const all = await people(conn, user.companyId);
      const u = all.get(params.code);
      if (!u?.post) throw new HttpError(404, 'Not a member of the team.');
      const changes = {};
      if (b.parentCode !== undefined) {
        const parent = parentFor(all, u.post, b.parentCode);
        if (parent && descendants(all, u.code).includes(parent.code)) throw new HttpError(400, 'Someone cannot report to a person in their own team.');
        if ((parent?.code ?? null) !== u.parent_code) changes.parent_code = parent?.code ?? null;
      }
      if (b.states !== undefined) changes.area_states = listOf(b.states, 300);
      if (b.districts !== undefined) changes.area_districts = listOf(b.districts, 1000);
      if (b.phone !== undefined) changes.phone = str(b.phone, 20) || null;
      if (!Object.keys(changes).length) return { ok: true };
      await conn.query(`UPDATE users SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...Object.values(changes), now(), u.id]);
      await audit(conn, user, 'team_updated', u.code, changes);
      return { ok: true };
    });
  });
}

/** Pincodes with accounts within an agent's range that have no agent yet: depute the agent there. */
export async function deputeNearbyFor(pool, user, code, pincodeFigures) {
  const [o] = await pool.query("SELECT code, branch, base_pincode, range_km FROM users WHERE company_id = ? AND code = ? AND role = 'officer' AND active = 1",
    [user.companyId, code]);
  if (!o?.base_pincode) return 0;
  const pins = (await pincodeFigures(user.companyId, '')).filter((p) => !p.agent);
  const near = within(o.base_pincode, pins, o.range_km || 20).map((p) => p.pincode);
  if (!near.length) return 0;
  return withTx(pool, async (conn) => {
    for (const p of near) {
      await conn.query('INSERT IGNORE INTO area_agents (company_id, pincode, officer_code, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
        [user.companyId, p, o.code, user.code, now()]);
    }
    const r = await conn.query(
      `UPDATE loans l JOIN area_agents a ON a.company_id = l.company_id AND a.pincode = l.pincode AND a.officer_code = ?
       SET l.officer_code = ?, l.updated_at = ? WHERE l.company_id = ? AND l.officer_code IS NULL AND l.pincode IN (?) ${o.branch ? 'AND l.branch = ?' : ''}`,
      [o.code, o.code, now(), user.companyId, near, ...(o.branch ? [o.branch] : [])]);
    await audit(conn, user, 'area_agent_set', o.code, { pincodes: near.slice(0, 50), count: near.length, loans: r.affectedRows, mode: 'nearby' });
    return r.affectedRows;
  });
}
