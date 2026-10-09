// Overlord "Update & diagnostics": what this server runs, and signed update packages.
// Verify only inspects a package; Stage queues it for the updater agent (server/supervisor.js),
// which backs up, installs, health-checks and rolls back. Every press is logged, refusals included.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http.js';
import { now } from './db.js';
import { verifyPatch, publicKeyFrom, keyFingerprint, sha256, PatchError, MAX_PATCH_BYTES } from './patch.js';
import { APP_ROOT, VERSION, STARTED_AT } from './version.js';
import { localTimestamp } from '../src/js/logic.js';

const UPDATES_DIR = join(APP_ROOT, 'updates');
const AGENT_STALE_MS = 60000;
const runningVersion = () => JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version;

function signingKey() {
  try {
    const key = publicKeyFrom(process.env.UPDATE_PUBLIC_KEY);
    return key ? { key, fingerprint: keyFingerprint(key) } : null;
  } catch {
    return { key: null, error: 'UPDATE_PUBLIC_KEY in .env is not a valid key.' };
  }
}

function freeDisk() {
  try {
    const s = statfsSync(APP_ROOT);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

export function registerUpdateRoutes(R, { pool, readJson }) {
  const event = (ctx, action, outcome, extra = {}) => pool.query(
    'INSERT INTO platform_update_events (at, actor, action, outcome, file_name, size, update_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [now(), ctx.overlord.email, action, outcome, extra.fileName ?? null, extra.size ?? null, extra.updateId ?? null, extra.detail ?? null]);

  const describe = (s) => `Package checked: ${s.from} → ${s.version} (${s.files} files, ${s.changed} changed${s.removed ? `, ${s.removed} removed` : ''})` +
    `${s.schemaChanges ? '. Changes the database: the agent backs it up first and restores it if the update is rolled back' : ''}` +
    `${s.dependencyChanges ? '. Installs new packages' : ''}.`;

  R('GET', '/updates', async () => {
    const key = signingKey();
    const state = Object.fromEntries((await pool.query('SELECT k, v, updated_at FROM platform_state')).map((r) => [r.k, r]));
    let agent = null;
    try {
      agent = state.agent_seen ? JSON.parse(state.agent_seen.v) : null;
    } catch {}
    const agentAt = agent ? Date.parse(String(agent.at).replace(' ', 'T')) : 0;
    const [db] = await pool.query('SELECT VERSION() AS v');
    const since = localTimestamp(new Date(Date.now() - 15 * 60000)).replace('T', ' ');
    const [activity] = await pool.query(
      `SELECT COUNT(DISTINCT x.company_id, x.officer_code) AS officers, COUNT(*) AS records FROM (
         SELECT company_id, officer_code FROM payments WHERE received_at >= ?
         UNION ALL SELECT l.company_id, v.officer_code FROM visits v JOIN loans l ON l.id = v.loan_id WHERE v.received_at >= ?) x`,
      [since, since]);
    const [pending] = await pool.query("SELECT COUNT(*) AS n FROM payments WHERE verification = 'pending'");
    const history = await pool.query('SELECT * FROM platform_updates ORDER BY id DESC LIMIT 20');
    const events = await pool.query('SELECT * FROM platform_update_events ORDER BY id DESC LIMIT 40');
    return {
      diagnostics: {
        version: runningVersion(), processVersion: VERSION,
        deployedAt: state.deployed_at?.v || null, startedAt: localTimestamp(STARTED_AT),
        environment: process.env.APP_ENV || 'Production',
        database: `MariaDB ${String(db.v).split('-')[0]}`, serverTime: now(), timezone: process.env.TZ || 'local',
        disk: freeDisk(), node: process.versions.node,
        agent: agent ? { seenAt: agent.at, version: agent.version, live: Date.now() - agentAt < AGENT_STALE_MS } : null,
        signingKey: key?.key ? { configured: true, fingerprint: key.fingerprint } : { configured: false, error: key?.error || null },
        activity: { officers15m: activity.officers, records15m: activity.records, pendingDeposits: pending.n },
      },
      active: history.find((h) => h.status === 'staged' || h.status === 'applying') || null,
      history: history.filter((h) => h.status !== 'staged'),
      events,
    };
  });

  R('POST', '/updates/verify', async ({ req, ctx }) => {
    const { fileName, base64 } = await readJson(req, Math.ceil(MAX_PATCH_BYTES * 1.4) + 1024);
    const name = String(fileName || '').slice(0, 200) || 'package.ldpatch';
    if (typeof base64 !== 'string' || !base64) throw new HttpError(400, 'Choose a .ldpatch file.');
    const buf = Buffer.from(base64, 'base64');
    const key = signingKey();
    let result;
    try {
      result = verifyPatch(buf, { publicKey: key?.key, current: { version: runningVersion(), root: APP_ROOT } });
    } catch (err) {
      if (!(err instanceof PatchError)) throw err;
      await event(ctx, 'verify', 'refused', { fileName: name, size: buf.length, detail: err.message });
      throw new HttpError(400, err.message);
    }
    const hash = sha256(buf);
    mkdirSync(UPDATES_DIR, { recursive: true });
    writeFileSync(join(UPDATES_DIR, `${hash}.ldpatch`), buf);
    await event(ctx, 'verify', 'ok', { fileName: name, size: buf.length, detail: describe(result.summary) });
    return { sha256: hash, fileName: name, summary: result.summary };
  });

  R('POST', '/updates/stage', async ({ req, ctx }) => {
    const { sha256: hash, fileName, confirm } = await readJson(req);
    if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) throw new HttpError(400, 'Verify a package first.');
    const file = join(UPDATES_DIR, `${hash}.ldpatch`);
    if (!existsSync(file)) throw new HttpError(400, 'Verify the package again — it is no longer on the server.');
    const buf = readFileSync(file);
    const name = String(fileName || '').slice(0, 200) || `${hash.slice(0, 12)}.ldpatch`;
    const refuse = async (msg, status = 400) => {
      await event(ctx, 'stage', 'refused', { fileName: name, size: buf.length, detail: msg });
      throw new HttpError(status, msg);
    };
    let summary;
    try {
      ({ summary } = verifyPatch(buf, { publicKey: signingKey()?.key, current: { version: runningVersion(), root: APP_ROOT } }));
    } catch (err) {
      if (err instanceof PatchError) await refuse(err.message);
      throw err;
    }
    if (String(confirm || '').trim() !== summary.version) await refuse(`Type the new version (${summary.version}) to confirm.`);
    const [busy] = await pool.query("SELECT id, to_version, status FROM platform_updates WHERE status IN ('staged', 'applying')");
    if (busy) await refuse(`Update to ${busy.to_version} is already ${busy.status}.`, 409);
    const res = await pool.query(
      `INSERT INTO platform_updates (from_version, to_version, file_name, sha256, size, schema_changes, staged_by, staged_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged')`,
      [summary.from, summary.version, name, hash, buf.length, summary.schemaChanges, ctx.overlord.email, now()]);
    await event(ctx, 'stage', 'ok', { fileName: name, size: buf.length, updateId: res.insertId, detail: `Staged ${summary.from} → ${summary.version} and queued for the updater agent.` });
    return { id: res.insertId };
  });

  R('POST', '/updates/:id/cancel', async ({ params, ctx }) => {
    const r = await pool.query("UPDATE platform_updates SET status = 'cancelled', finished_at = ?, detail = ? WHERE id = ? AND status = 'staged'",
      [now(), `Cancelled by ${ctx.overlord.email} before the agent started.`, Number(params.id) || 0]);
    if (!r.affectedRows) throw new HttpError(409, 'Only an update that is still waiting can be cancelled.');
    await event(ctx, 'cancel', 'ok', { updateId: Number(params.id), detail: 'Staged update cancelled.' });
    return { ok: true };
  });
}
