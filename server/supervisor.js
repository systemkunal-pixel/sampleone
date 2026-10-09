// LoanDesk updater agent. The installers run this instead of server/index.js: it keeps the web server
// running (restarting it if it stops) and applies update packages that an overlord has verified and
// staged, with a backup and an automatic rollback when the new build doesn't come up healthy.
//
//   node server/supervisor.js
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { createPool, now } from './db.js';
import { applyUpdate } from './updater.js';
import { publicKeyFrom } from './patch.js';
import { APP_ROOT } from './version.js';

const POLL_MS = 10000;
const HEALTH_TIMEOUT_MS = 120000;
const UPDATES_DIR = join(APP_ROOT, 'updates');
const BACKUPS_DIR = join(APP_ROOT, 'backups');

const pool = createPool({ ...config.db, connectionLimit: 2 });
const say = (msg) => console.log(`[agent ${now()}] ${msg}`);
const currentVersion = () => JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version;

// ---------- the web server as a child process ----------

let child = null;
let wanted = true; // false while an update has the server stopped on purpose
let restartDelay = 2000;
let crashes = 0; // unexpected exits since the last deliberate start

function startApp() {
  if (!wanted) crashes = 0;
  wanted = true;
  if (child) return Promise.resolve();
  child = spawn(process.execPath, [join(APP_ROOT, 'server', 'index.js')], { cwd: APP_ROOT, stdio: 'inherit', env: process.env });
  const started = Date.now();
  child.on('exit', (code, signal) => {
    child = null;
    if (!wanted) return;
    crashes += 1;
    if (Date.now() - started > 60000) restartDelay = 2000;
    say(`server stopped (${signal || `code ${code}`}); restarting in ${restartDelay / 1000}s`);
    setTimeout(() => wanted && !child && startApp(), restartDelay);
    restartDelay = Math.min(restartDelay * 2, 30000);
  });
  return Promise.resolve();
}

function stopApp() {
  wanted = false;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const c = child;
    const timer = setTimeout(() => c.kill('SIGKILL'), 15000);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

async function healthy(version) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (crashes >= 2) return false; // keeps crashing: no point waiting the full two minutes
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(3000) });
      const body = await res.json();
      if (res.ok && body.ok && body.version === version) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ---------- tools: npm and the MariaDB client ----------

function run(cmd, args, { stdin, stdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: APP_ROOT, stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'inherit', 'inherit'], env: process.env });
    if (stdin) createReadStream(stdin).pipe(p.stdin);
    if (stdout) p.stdout.pipe(createWriteStream(stdout));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.split(/[\\/]/).pop()} exited with code ${code}`))));
  });
}

function npmCli() {
  const dir = dirname(process.execPath);
  return [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
}

async function installDeps() {
  const cli = npmCli();
  if (!cli) throw new Error('npm was not found next to Node.js.');
  await run(process.execPath, [cli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']);
}

function dbTool(names) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const dirs = [process.env.DB_BIN_DIR, ...String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')].filter(Boolean);
  for (const n of names) for (const d of dirs) if (existsSync(join(d, n + exe))) return join(d, n + exe);
  throw new Error(`${names[0]} was not found. Set DB_BIN_DIR in .env to the MariaDB bin folder.`);
}

/** Runs a MariaDB client tool with the password in a temporary option file (never on the command line). */
async function withDbOptions(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'loandesk-'));
  const file = join(dir, 'my.cnf');
  writeFileSync(file, `[client]\nuser=${config.db.user}\npassword="${String(config.db.password).replace(/"/g, '\\"')}"\nhost=${config.db.host}\nport=${config.db.port}\n`, { mode: 0o600 });
  try {
    return await fn(`--defaults-extra-file=${file}`);
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
}

// The dump re-creates the whole database, so a restore also removes tables a failed update added.
const dumpDb = (file) => withDbOptions((opt) =>
  run(dbTool(['mariadb-dump', 'mysqldump']), [opt, '--single-transaction', '--routines', '--triggers', '--add-drop-database', '--databases', config.db.database], { stdout: file }));
const restoreDb = (file) => withDbOptions((opt) => run(dbTool(['mariadb', 'mysql']), [opt], { stdin: file }));

// ---------- the loop ----------

async function setState(k, v) {
  await pool.query('REPLACE INTO platform_state (k, v, updated_at) VALUES (?, ?, ?)', [k, v, now()]);
}

async function event(updateId, action, outcome, detail) {
  await pool.query('INSERT INTO platform_update_events (at, actor, action, outcome, update_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [now(), 'updater agent', action, outcome, updateId, detail]).catch(() => {});
}

async function tick() {
  await setState('agent_seen', JSON.stringify({ at: now(), pid: process.pid, version: currentVersion() }));
  const [job] = await pool.query("SELECT * FROM platform_updates WHERE status = 'staged' ORDER BY id LIMIT 1");
  if (!job) return;
  const claimed = await pool.query("UPDATE platform_updates SET status = 'applying', started_at = ? WHERE id = ? AND status = 'staged'", [now(), job.id]);
  if (!claimed.affectedRows) return;
  say(`applying update ${job.from_version} → ${job.to_version}`);
  const steps = []; // kept in memory: a database restore during rollback would erase them
  let result;
  try {
    result = await applyUpdate(
      { root: APP_ROOT, packageFile: join(UPDATES_DIR, `${job.sha256}.ldpatch`), backupsDir: BACKUPS_DIR },
      {
        publicKey: publicKeyFrom(process.env.UPDATE_PUBLIC_KEY),
        currentVersion: currentVersion(),
        log: (action, outcome, detail) => {
          say(`${action}: ${detail}`);
          steps.push({ at: now(), action, outcome, detail });
          return event(job.id, action, outcome, detail);
        },
        stopApp, startApp, healthy, dumpDb, restoreDb, installDeps,
      });
  } catch (err) {
    // Nothing was changed yet (the package failed its checks or the backup failed).
    result = { status: 'failed', detail: `Not applied: ${err.message}` };
    await event(job.id, 'apply', 'failed', result.detail);
    if (!child) await startApp();
  }
  if (/database restored/.test(result.detail)) {
    // The restored database predates this attempt: put its log lines back.
    await pool.query('DELETE FROM platform_update_events WHERE update_id = ? AND actor = ?', [job.id, 'updater agent']);
    for (const s of steps) {
      await pool.query('INSERT INTO platform_update_events (at, actor, action, outcome, update_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
        [s.at, 'updater agent', s.action, s.outcome, job.id, s.detail]);
    }
  }
  await pool.query('UPDATE platform_updates SET status = ?, finished_at = ?, detail = ? WHERE id = ?', [result.status, now(), result.detail, job.id]);
  if (result.status === 'applied') await setState('deployed_at', now());
  say(result.detail);
}

let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    await tick();
  } catch (err) {
    say(`check failed: ${err.message}`);
  } finally {
    busy = false;
  }
}

say(`LoanDesk updater agent ${currentVersion()} starting the server`);
// An update that was running when the agent stopped can't be resumed safely: report it.
await pool.query(
  "UPDATE platform_updates SET status = 'failed', finished_at = ?, detail = 'The updater agent stopped during this update. Check that the site works; backups are in the backups folder.' WHERE status = 'applying'",
  [now()]).catch(() => {});
await startApp();
setTimeout(loop, 5000);
setInterval(loop, POLL_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await stopApp();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
