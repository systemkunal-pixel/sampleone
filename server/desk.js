// The recovery desk: the coordinator's dashboard and the agents' daily report (figures worked out from what
// agents record — nobody fills in a report), standing targets per agent, difficult cases that agents raise and
// coordinators escalate to the agency head, allocation by coordinators within their own team, and the company
// settings behind them (post names, the planning figure of accounts per agent, the high-value mark).
import ExcelJS from 'exceljs';
import {
  isoDate, addDays, money, dailyReport, accountFacts, statusOn, monthStart, weekStart, countsTowardDues,
  AGE_BANDS, outcomeLabel,
} from '../src/js/logic.js';
import { loadLoans, withTx, audit, now } from './db.js';
import { HttpError, send } from './http.js';
import { people, descendants, scopeOfPerson, scopeSql, supervisorScope, POSTS } from './team.js';

export const DEFAULTS = { accountsPerAgent: 25, highValue: 100000 };
const LIST_MAX = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- settings ----------

export async function getSettings(conn, companyId) {
  const [r] = await conn.query('SELECT * FROM company_settings WHERE company_id = ?', [companyId]);
  const labels = r?.post_labels ? JSON.parse(r.post_labels) : {};
  return {
    // null = the standard name (State Head, District Coordinator, Agent), shown translated.
    posts: Object.fromEntries(Object.keys(POSTS).map((k) => [k, labels[k] || null])),
    accountsPerAgent: r?.accounts_per_agent ?? DEFAULTS.accountsPerAgent,
    highValue: r?.high_value != null ? Number(r.high_value) : DEFAULTS.highValue,
  };
}

const postName = (settings, post) => (post ? settings.posts[post] || POSTS[post]?.label || post : '');

// ---------- whose figures ----------

/**
 * What a desk request covers. Admins: the whole company, or everyone under one person (`under`).
 * Supervisors: their own team, or the team of someone below them. Returns the loans filter and the agents.
 */
async function deskScope(conn, user, under) {
  const all = await people(conn, user.companyId);
  let root = null;
  if (user.role === 'supervisor') {
    const me = all.get(user.code);
    if (!me?.post) {
      // A branch supervisor without a team post: their branch, as on the Deposits screen.
      const sc = await supervisorScope(conn, user);
      const agents = [...all.values()].filter((u) => u.role === 'officer' && u.branch === user.branch).map((u) => u.code);
      return { all, root: me || null, where: scopeSql(sc), agentCodes: agents, below: [] };
    }
    root = me;
    if (under && under !== user.code) {
      if (!descendants(all, user.code).includes(under)) throw new HttpError(404, 'This person is not in your team.');
      root = all.get(under);
    }
  } else if (under) {
    root = all.get(under);
    if (!root) throw new HttpError(404, 'This person is not in your team.');
  }
  if (!root) {
    const agents = [...all.values()].filter((u) => u.role === 'officer').map((u) => u.code);
    return { all, root: null, where: { sql: '1 = 1', args: [] }, agentCodes: agents, below: [...all.values()] };
  }
  const sc = scopeOfPerson(all, root.code);
  return { all, root, where: scopeSql(sc), agentCodes: sc.officerCodes, below: descendants(all, root.code).map((c) => all.get(c)) };
}

/** A loan as it stood at the end of `date` (for looking back at an earlier day). */
const asOf = (loan, date) => ({
  ...loan,
  payments: loan.payments.filter((p) => p.at.slice(0, 10) <= date),
  visits: loan.visits.filter((v) => v.at.slice(0, 10) <= date),
});

function listRow(loan, f, all) {
  return {
    id: loan.id, loanNo: loan.loanNo, name: loan.borrower?.name || '', phone: loan.borrower?.phone || '',
    officerCode: loan.officerCode || null, officerName: all.get(loan.officerCode)?.name || null,
    client: loan.client?.code || null, district: loan.area?.district || null, pincode: loan.area?.pincode || null,
    overdue: f.st.overdue, dpd: f.st.dpd,
    ptpDate: f.ptp?.ptpDate || null, ptpAmount: f.ptp?.ptpAmount || null,
    lastAt: f.last?.at || null, lastType: f.last?.type || null, lastOutcome: f.last?.outcome || null,
    caseLevel: loan.case?.level || 0, caseNote: loan.case?.note || null, caseBy: loan.case?.by || null, caseAt: loan.case?.at || null,
  };
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Everything the dashboard and the daily report show, for one day. */
export async function deskData(conn, user, { date = isoDate(), under = null } = {}) {
  if (!DATE.test(date)) throw new HttpError(400, 'Choose a valid date.');
  if (date > isoDate()) throw new HttpError(400, 'Choose today or an earlier day.');
  const settings = await getSettings(conn, user.companyId);
  const { all, root, where, agentCodes, below } = await deskScope(conn, user, under);
  const today = isoDate();
  const loaded = await loadLoans(conn, { companyId: user.companyId, where });
  const loans = date < today ? loaded.map((l) => asOf(l, date)) : loaded;
  const ms = monthStart(date);
  const ws = weekStart(date);
  const before = addDays(ms, -1);

  const totals = {
    accounts: 0, unassigned: 0, outstanding: 0, overdue: 0, openingOverdue: 0,
    collectedToday: 0, collectedWeek: 0, collectedMonth: 0,
    ptpToday: 0, ptpTodayAmount: 0, broken: 0, brokenAmount: 0, noContact: 0, untouched: 0,
    highValue: 0, highValueOverdue: 0, difficult: 0, escalated: 0,
  };
  const ages = AGE_BANDS.map((b) => ({ key: b.key, label: b.label, count: 0, overdue: 0 }));
  const lists = { ptpToday: [], broken: [], noContact: [], highValue: [], difficult: [] };
  const byAgent = new Map(agentCodes.map((c) => [c, { assigned: [], extra: new Set(), accounts: 0, overdue: 0, opening: 0, week: 0, month: 0 }]));
  const add = (k, n) => (totals[k] = money(totals[k] + n));

  for (const loan of loans) {
    const f = accountFacts(loan, date, settings.highValue);
    const opening = statusOn(loan, before).overdue;
    add('openingOverdue', opening);
    const mine = byAgent.get(loan.officerCode);
    if (mine) {
      mine.assigned.push(loan);
      mine.opening = money(mine.opening + opening);
    }
    for (const p of loan.payments) {
      if (!countsTowardDues(p)) continue;
      const d = p.at.slice(0, 10);
      if (d === date) add('collectedToday', p.amount);
      if (d >= ws && d <= date) add('collectedWeek', p.amount);
      if (d >= ms && d <= date) add('collectedMonth', p.amount);
      const collector = byAgent.get(p.officer);
      if (collector) {
        if (d >= ws && d <= date) collector.week = money(collector.week + p.amount);
        if (d >= ms && d <= date) collector.month = money(collector.month + p.amount);
        if (d === date && p.officer !== loan.officerCode) collector.extra.add(loan);
      }
    }
    for (const v of loan.visits) {
      const visitor = byAgent.get(v.officer);
      if (visitor && v.at.slice(0, 10) === date && v.officer !== loan.officerCode) visitor.extra.add(loan);
    }
    if (f.st.closed) continue;
    totals.accounts += 1;
    if (!loan.officerCode) totals.unassigned += 1;
    add('outstanding', f.st.outstanding);
    add('overdue', f.st.overdue);
    if (mine) {
      mine.accounts += 1;
      mine.overdue = money(mine.overdue + f.st.overdue);
    }
    const age = ages.find((a) => a.key === f.band.key);
    age.count += 1;
    age.overdue = money(age.overdue + f.st.overdue);
    const row = () => listRow(loan, f, all);
    if (f.ptpToday) {
      totals.ptpToday += 1;
      add('ptpTodayAmount', f.ptp.ptpAmount || 0);
      lists.ptpToday.push(row());
    }
    if (f.ptpBroken) {
      totals.broken += 1;
      add('brokenAmount', f.ptp.ptpAmount || 0);
      lists.broken.push(row());
    }
    if (f.noContact) {
      totals.noContact += 1;
      lists.noContact.push(row());
    }
    if (f.untouched) totals.untouched += 1;
    if (f.highValue) {
      totals.highValue += 1;
      add('highValueOverdue', f.st.overdue);
      lists.highValue.push(row());
    }
    if (f.difficult) {
      totals.difficult += 1;
      if (loan.case.level >= 2) totals.escalated += 1;
      lists.difficult.push(row());
    }
  }
  totals.recoveryPct = pct(totals.collectedMonth, totals.openingOverdue);
  for (const k of Object.keys(lists)) {
    lists[k].sort((a, b) => (k === 'difficult' ? b.caseLevel - a.caseLevel : 0) || b.overdue - a.overdue);
    lists[k] = lists[k].slice(0, LIST_MAX);
  }

  // Standing targets: the latest set on or before the day.
  const targets = new Map();
  if (agentCodes.length) {
    for (const t of await conn.query(
      'SELECT * FROM targets WHERE company_id = ? AND officer_code IN (?) AND from_date <= ? ORDER BY from_date', [user.companyId, agentCodes, date])) {
      targets.set(t.officer_code, t);
    }
  }

  const agents = agentCodes.map((code) => {
    const u = all.get(code);
    const a = byAgent.get(code);
    const report = dailyReport([...a.assigned, ...a.extra], date, code);
    const t = targets.get(code);
    const target = t ? {
      fromDate: t.from_date, dayAmount: t.day_amount, dayVisits: t.day_visits, weekAmount: t.week_amount, monthAmount: t.month_amount,
    } : null;
    return {
      code, name: u?.name || code, post: u?.post || null, parentCode: u?.parent_code || null, active: Boolean(u?.active),
      phone: u?.phone || null, report,
      accounts: a.accounts, overdue: a.overdue, openingOverdue: a.opening, collectedWeek: a.week, collectedMonth: a.month,
      recoveryPct: pct(a.month, a.opening),
      target,
      achievement: target ? {
        day: pct(report.collected, target.dayAmount), visits: pct(report.visits, target.dayVisits),
        week: pct(a.week, target.weekAmount), month: pct(a.month, target.monthAmount),
      } : null,
    };
  }).filter((a) => a.active || a.accounts || a.report.receipts || a.report.visits || a.report.calls)
    .sort((x, y) => x.name.localeCompare(y.name));

  // Coordinators' areas and State Heads' regions: their agents' figures added up.
  const agentByCode = new Map(agents.map((a) => [a.code, a]));
  const rollup = (u) => {
    const codes = [u.code, ...descendants(all, u.code)].filter((c) => agentByCode.has(c));
    const rows = codes.map((c) => agentByCode.get(c));
    const sum = (f) => money(rows.reduce((s, r) => s + (f(r) || 0), 0));
    const opening = sum((r) => r.openingOverdue);
    const month = sum((r) => r.collectedMonth);
    return {
      code: u.code, name: u.name, post: u.post, parentCode: u.parent_code || null, agents: rows.length,
      accounts: sum((r) => r.accounts), overdue: sum((r) => r.overdue),
      assigned: sum((r) => r.report.assigned), contacted: sum((r) => r.report.contacted), visits: sum((r) => r.report.visits),
      calls: sum((r) => r.report.calls), ptpObtained: sum((r) => r.report.ptpObtained), noContact: sum((r) => r.report.noContact),
      notAttempted: sum((r) => r.report.notAttempted), difficult: sum((r) => r.report.difficult),
      collectedToday: sum((r) => r.report.collected), collectedWeek: sum((r) => r.collectedWeek), collectedMonth: month,
      monthTarget: sum((r) => r.target?.monthAmount), recoveryPct: pct(month, opening),
    };
  };
  const leaders = (post) => below.filter((u) => u?.post === post && u.active).sort((a, b) => a.name.localeCompare(b.name)).map(rollup);
  const day = dailyReport(loans, date);

  return {
    date, monthStart: ms, weekStart: ws, settings,
    scope: root ? { code: root.code, name: root.name, post: root.post } : null,
    totals: { ...totals, day },
    ages,
    agents,
    areas: leaders('coordinator'),
    regions: leaders('state_head'),
    lists,
    choices: (root ? below : [...all.values()]).filter((u) => u?.post && u.post !== 'agent' && u.active)
      .map((u) => ({ code: u.code, name: u.name, post: u.post, parentCode: u.parent_code || null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------- targets, allocation, cases ----------

/** Agents this user may set targets for or move accounts to. */
async function manageableAgents(conn, user) {
  const all = await people(conn, user.companyId);
  if (user.role === 'admin') return [...all.values()].filter((u) => u.role === 'officer' && u.active);
  const me = all.get(user.code);
  if (!me?.post) return [...all.values()].filter((u) => u.role === 'officer' && u.active && u.branch === user.branch);
  return descendants(all, user.code).map((c) => all.get(c)).filter((u) => u.role === 'officer' && u.active);
}

function amountOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new HttpError(400, 'Targets must be amounts of 0 or more.');
  return money(n);
}

export async function setTargets(pool, user, b) {
  const codes = [...new Set((Array.isArray(b.officerCodes) ? b.officerCodes : []).map((c) => String(c).toUpperCase()))];
  if (!codes.length) throw new HttpError(400, 'Choose the agents.');
  const fromDate = b.fromDate || isoDate();
  if (!DATE.test(fromDate)) throw new HttpError(400, 'Choose a valid date.');
  const values = {
    day_amount: amountOrNull(b.dayAmount), day_visits: b.dayVisits === '' || b.dayVisits == null ? null : Math.min(500, Math.max(0, Math.round(Number(b.dayVisits) || 0))),
    week_amount: amountOrNull(b.weekAmount), month_amount: amountOrNull(b.monthAmount),
  };
  return withTx(pool, async (conn) => {
    const allowed = new Set((await manageableAgents(conn, user)).map((u) => u.code));
    const outside = codes.filter((c) => !allowed.has(c));
    if (outside.length) throw new HttpError(400, `${outside.slice(0, 5).join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in your team.`);
    for (const code of codes) {
      await conn.query(
        `INSERT INTO targets (company_id, officer_code, from_date, day_amount, day_visits, week_amount, month_amount, set_by, set_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE day_amount = VALUES(day_amount), day_visits = VALUES(day_visits),
           week_amount = VALUES(week_amount), month_amount = VALUES(month_amount), set_by = VALUES(set_by), set_at = VALUES(set_at)`,
        [user.companyId, code, fromDate, values.day_amount, values.day_visits, values.week_amount, values.month_amount, user.code, now()]);
    }
    await audit(conn, user, 'targets_set', codes.length === 1 ? codes[0] : `${codes.length} agents`, { fromDate, ...values, agents: codes.slice(0, 50) });
    return { ok: true, count: codes.length };
  });
}

/** The current target of one agent (shown on their phone). */
export async function currentTarget(conn, companyId, code, date = isoDate()) {
  const [t] = await conn.query(
    'SELECT * FROM targets WHERE company_id = ? AND officer_code = ? AND from_date <= ? ORDER BY from_date DESC LIMIT 1', [companyId, code, date]);
  return t ? { fromDate: t.from_date, dayAmount: t.day_amount, dayVisits: t.day_visits, weekAmount: t.week_amount, monthAmount: t.month_amount } : null;
}

/** A coordinator moves accounts of their team (or unassigned ones in their districts) to one of their agents. */
export async function assignWithinTeam(pool, user, b) {
  const ids = [...new Set((Array.isArray(b.loanIds) ? b.loanIds : []).map(String))].slice(0, 500);
  if (!ids.length) throw new HttpError(400, 'Choose the accounts.');
  const code = String(b.officerCode || '').toUpperCase();
  return withTx(pool, async (conn) => {
    const agent = (await manageableAgents(conn, user)).find((u) => u.code === code);
    if (!agent) throw new HttpError(400, 'Choose an agent of your team.');
    const sc = scopeSql(await supervisorScope(conn, user));
    const rows = await conn.query(`SELECT l.id, l.officer_code FROM loans l WHERE l.company_id = ? AND l.id IN (?) AND ${sc.sql} FOR UPDATE`,
      [user.companyId, ids, ...sc.args]);
    if (rows.length !== ids.length) throw new HttpError(404, 'Some accounts are not in your team.');
    const moving = rows.filter((r) => r.officer_code !== code).map((r) => r.id);
    if (moving.length) await conn.query('UPDATE loans SET officer_code = ?, updated_at = ? WHERE id IN (?)', [code, now(), moving]);
    await audit(conn, user, 'loans_assigned', code, { count: moving.length, from: [...new Set(rows.map((r) => r.officer_code || 'unassigned'))].slice(0, 10) });
    return { ok: true, changed: moving.length };
  });
}

const CASE_ACTIONS = {
  raise: { from: [0], to: 1, event: 'raised' },
  escalate: { from: [1], to: 2, event: 'escalated' },
  resolve: { from: [1, 2], to: 0, event: 'resolved' },
};

/** Raise, escalate to the agency head, or resolve a difficult case. A note is always required. */
export async function caseAction(pool, user, loanId, b) {
  const act = CASE_ACTIONS[b.action];
  if (!act) throw new HttpError(400, 'Unknown action.');
  const note = str(b.note, 300);
  if (!note) throw new HttpError(400, 'Add a note: what happened, or why.');
  return withTx(pool, async (conn) => {
    const sc = user.role === 'admin' ? { sql: '1 = 1', args: [] } : scopeSql(await supervisorScope(conn, user));
    const [l] = await conn.query(`SELECT l.id, l.case_level FROM loans l WHERE l.company_id = ? AND l.id = ? AND ${sc.sql} FOR UPDATE`,
      [user.companyId, loanId, ...sc.args]);
    if (!l) throw new HttpError(404, 'Loan not found.');
    if (!act.from.includes(l.case_level)) {
      throw new HttpError(409, l.case_level ? 'This case has already moved on. Refresh to see where it is.' : 'This account is not a difficult case.');
    }
    const at = now();
    if (act.to) {
      await conn.query('UPDATE loans SET case_level = ?, case_note = ?, case_at = ?, case_by = ? WHERE id = ?', [act.to, note, at, user.code, loanId]);
    } else {
      await conn.query('UPDATE loans SET case_level = 0, case_note = NULL, case_at = NULL, case_by = NULL WHERE id = ?', [loanId]);
    }
    await conn.query('INSERT INTO case_events (company_id, loan_id, at, user_code, action, note) VALUES (?, ?, ?, ?, ?, ?)',
      [user.companyId, loanId, at, user.code, act.event, note]);
    await audit(conn, user, `case_${act.event}`, loanId, { note });
    return { case: act.to ? { level: act.to, note, at, by: user.code } : null };
  });
}

export async function caseHistory(conn, companyId, loanId) {
  return (await conn.query('SELECT at, user_code, action, note FROM case_events WHERE company_id = ? AND loan_id = ? ORDER BY id', [companyId, loanId]))
    .map((e) => ({ at: e.at, by: e.user_code, action: e.action, note: e.note }));
}

// ---------- Excel ----------

const CASE_LEVEL = ['', 'With coordinator', 'With agency head'];

export async function deskWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LoanDesk';
  const brand = 'FF0F5132';
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([header, width, numFmt]) => ({ header, width, style: numFmt ? { numFmt } : {} }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(r);
    return ws;
  };
  const INR = '#,##,##0';
  const PCT = '0.0"%"';
  const T = data.totals;
  const who = data.scope ? `${data.scope.name} (${postName(data.settings, data.scope.post)})` : 'Whole company';
  sheet('Summary', [['Figure', 34], ['Value', 22, INR]], [
    ['Date', data.date], ['Team', who],
    ['Accounts', T.accounts], ['Unassigned accounts', T.unassigned],
    ['Total outstanding', T.outstanding], ['Total overdue', T.overdue],
    ["Today's collection", T.collectedToday], ['This week', T.collectedWeek], ['Month to date', T.collectedMonth],
    ['Overdue on the 1st of the month', T.openingOverdue], ['Recovery % (month to date ÷ overdue on the 1st)', T.recoveryPct],
    ['PTP due today (accounts)', T.ptpToday], ['PTP due today (amount)', T.ptpTodayAmount],
    ['Broken PTP (accounts)', T.broken], ['Broken PTP (amount)', T.brokenAmount],
    ['No contact on last attempt', T.noContact], ['Never attempted', T.untouched],
    [`High-value accounts (overdue ≥ ${data.settings.highValue})`, T.highValue], ['Difficult cases', T.difficult], ['… with the agency head', T.escalated],
    ...data.ages.map((a) => [`Ageing ${a.label}: accounts`, a.count]),
  ]);
  const agentPost = postName(data.settings, 'agent');
  sheet('Daily report', [
    [agentPost, 26], ['Code', 9], ['Accounts assigned', 10], ['Customers contacted', 11], ['Visits made', 9], ['Calls', 8],
    ['PTP obtained', 9], ['Amount collected', 13, INR], ['PTP due tomorrow', 10], ['PTP due tomorrow ₹', 13, INR],
    ['No-contact cases', 10], ['Not attempted', 10], ['Difficult cases', 10], ['This week', 13, INR], ['Month to date', 13, INR],
    ['Month target', 13, INR], ['Month achieved %', 10, PCT], ['Recovery %', 10, PCT],
  ], data.agents.map((a) => [
    a.name, a.code, a.report.assigned, a.report.contacted, a.report.visits, a.report.calls, a.report.ptpObtained, a.report.collected,
    a.report.ptpDueTomorrow, a.report.ptpDueTomorrowAmount, a.report.noContact, a.report.notAttempted, a.report.difficult,
    a.collectedWeek, a.collectedMonth, a.target?.monthAmount ?? null, a.achievement?.month ?? null, a.recoveryPct,
  ]));
  const rollCols = (label) => [[label, 26], ['Code', 9], ['Agents', 8], ['Accounts', 10], ['Overdue', 14, INR], ['Contacted today', 10],
    ['Visits', 8], ['Calls', 8], ['PTP obtained', 9], ['No contact', 9], ["Today's collection", 13, INR], ['Month to date', 13, INR],
    ['Month target', 13, INR], ['Recovery %', 10, PCT]];
  const rollRow = (r) => [r.name, r.code, r.agents, r.accounts, r.overdue, r.contacted, r.visits, r.calls, r.ptpObtained, r.noContact,
    r.collectedToday, r.collectedMonth, r.monthTarget || null, r.recoveryPct];
  if (data.regions.length) sheet('Regions', rollCols(postName(data.settings, 'state_head')), data.regions.map(rollRow));
  if (data.areas.length) sheet('Areas', rollCols(postName(data.settings, 'coordinator')), data.areas.map(rollRow));
  const listCols = [['Loan no', 16], ['Borrower', 24], ['Phone', 12], [agentPost, 20], ['Client', 8], ['District', 16], ['Pincode', 8],
    ['Overdue', 13, INR], ['DPD', 7], ['PTP date', 11], ['PTP ₹', 11, INR], ['Last contact', 17], ['Last outcome', 22], ['Case', 16], ['Case note', 40]];
  const listRow = (r) => [r.loanNo, r.name, r.phone, r.officerName || r.officerCode || 'Unassigned', r.client, r.district, r.pincode, r.overdue, r.dpd,
    r.ptpDate, r.ptpAmount, r.lastAt ? `${r.lastAt.replace('T', ' ').slice(0, 16)} ${r.lastType || ''}` : 'Never', r.lastOutcome ? outcomeLabel(r.lastOutcome) : '',
    CASE_LEVEL[r.caseLevel] || '', r.caseNote || ''];
  for (const [key, name] of [['ptpToday', 'PTP due today'], ['broken', 'Broken PTP'], ['noContact', 'No contact'], ['highValue', 'High value'], ['difficult', 'Difficult cases']]) {
    sheet(name, listCols, data.lists[key].map(listRow));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- routes ----------

/**
 * Field app (supervisors): /api/desk…   Admin console: /api/admin/desk…, /api/admin/settings, /api/admin/cases/:id.
 * `authed(req, role)` checks the session and role.
 */
export function mountDesk(router, { pool, authed, readJson }) {
  const field = async (req) => (await authed(req, 'supervisor')).user;
  const admin = async (req) => (await authed(req, 'admin')).user;
  const q = (query) => ({ date: query.get('date') || isoDate(), under: (query.get('under') || '').toUpperCase() || null });

  router.add('GET', '/api/desk', async (req, res, params, query) => deskData(pool, await field(req), q(query)));
  router.add('POST', '/api/desk/targets', async (req) => setTargets(pool, await field(req), await readJson(req)));
  router.add('POST', '/api/desk/assign', async (req) => assignWithinTeam(pool, await field(req), await readJson(req)));
  router.add('POST', '/api/desk/cases/:id', async (req, res, { id }) => caseAction(pool, await field(req), id, await readJson(req)));

  router.add('GET', '/api/admin/desk', async (req, res, params, query) => deskData(pool, await admin(req), q(query)));
  router.add('GET', '/api/admin/desk.xlsx', async (req, res, params, query) => {
    const data = await deskData(pool, await admin(req), q(query));
    send(res, 200, await deskWorkbook(data), {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="recovery-report-${data.date}${data.scope ? `-${data.scope.code}` : ''}.xlsx"`,
    });
  });
  router.add('POST', '/api/admin/desk/targets', async (req) => setTargets(pool, await admin(req), await readJson(req)));
  router.add('POST', '/api/admin/cases/:id', async (req, res, { id }) => caseAction(pool, await admin(req), id, await readJson(req)));
  router.add('GET', '/api/admin/cases/:id', async (req, res, { id }) => {
    const user = await admin(req);
    return { events: await caseHistory(pool, user.companyId, id) };
  });

  router.add('GET', '/api/admin/settings', async (req) => getSettings(pool, (await admin(req)).companyId));
  router.add('PUT', '/api/admin/settings', async (req) => {
    const user = await admin(req);
    const b = await readJson(req);
    const labels = {};
    for (const k of Object.keys(POSTS)) {
      const v = str(b.posts?.[k], 40);
      if (v) labels[k] = v;
    }
    const per = Number(b.accountsPerAgent);
    if (!(Number.isInteger(per) && per >= 1 && per <= 2000)) throw new HttpError(400, 'Accounts per agent must be a whole number from 1 to 2000.');
    const high = Number(b.highValue);
    if (!(Number.isFinite(high) && high >= 0)) throw new HttpError(400, 'The high-value mark must be an amount of 0 or more.');
    await pool.query(
      `INSERT INTO company_settings (company_id, post_labels, accounts_per_agent, high_value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE post_labels = VALUES(post_labels), accounts_per_agent = VALUES(accounts_per_agent), high_value = VALUES(high_value),
         updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [user.companyId, JSON.stringify(labels), per, money(high), user.code, now()]);
    await audit(pool, user, 'settings_updated', null, { posts: labels, accountsPerAgent: per, highValue: money(high) });
    return getSettings(pool, user.companyId);
  });
}
