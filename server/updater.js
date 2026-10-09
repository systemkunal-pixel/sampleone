// Applies a staged update package: back up, swap files, restart, health-check, roll back if unhealthy.
// Used by the updater agent (supervisor.js). Process control and the database dump are passed in as
// functions so the sequence can be tested without a real server.
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listAppFiles, verifyPatch } from './patch.js';

/** Copies every managed file of the app into `dir`, keeping relative paths. Returns the list. */
export function backupFiles(root, dir) {
  const files = listAppFiles(root);
  for (const p of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    copyFileSync(join(root, p), join(dir, p));
  }
  writeFileSync(join(dir, '.files.json'), JSON.stringify(files));
  return files;
}

/** Makes the managed files of `root` exactly `files` (Map path → Buffer): writes them and deletes the rest. */
export function writeFiles(root, files) {
  for (const p of listAppFiles(root)) if (!files.has(p)) rmSync(join(root, p), { force: true });
  for (const [p, data] of files) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), data);
  }
}

/** Puts back the files saved by backupFiles. */
export function restoreFiles(root, dir) {
  const files = new Map(JSON.parse(readFileSync(join(dir, '.files.json'), 'utf8')).map((p) => [p, readFileSync(join(dir, p))]));
  writeFiles(root, files);
}

/** Keeps the newest `keep` backup folders and removes older ones. */
export function pruneBackups(backupsDir, keep = 5) {
  if (!existsSync(backupsDir)) return;
  const dirs = readdirSync(backupsDir).filter((d) => statSync(join(backupsDir, d)).isDirectory()).sort();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) rmSync(join(backupsDir, d), { recursive: true, force: true });
}

/**
 * Runs one update. `deps`:
 *   publicKey, currentVersion          to re-verify the package
 *   log(step, outcome, detail)         progress for the activity log
 *   stopApp(), startApp()              process control
 *   healthy(version) → Promise<bool>   waits for /api/health to report `version`
 *   dumpDb(file), restoreDb(file)      database backup (only used when the schema changes)
 *   installDeps()                      npm ci, when package-lock.json changes
 * Returns { status: 'applied' | 'rolled_back' | 'failed', detail }.
 */
export async function applyUpdate({ root, packageFile, backupsDir }, deps) {
  const { log } = deps;
  const { files, summary } = verifyPatch(readFileSync(packageFile), { publicKey: deps.publicKey, current: { version: deps.currentVersion, root } });
  log('verify', 'ok', `Package re-checked: ${summary.from} → ${summary.version}, ${summary.files} files.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(backupsDir, `${stamp}-from-${deps.currentVersion}`);
  mkdirSync(dir, { recursive: true });
  backupFiles(root, dir);
  let dbDump = null;
  if (summary.schemaChanges) {
    dbDump = join(dir, 'database.sql');
    await deps.dumpDb(dbDump);
    log('backup', 'ok', 'Files and database backed up.');
  } else {
    log('backup', 'ok', 'Files backed up (no database changes in this update).');
  }

  await deps.stopApp();
  let reason;
  try {
    writeFiles(root, files);
    log('install', 'ok', `Files replaced (${summary.changed} changed, ${summary.removed} removed).`);
    if (summary.dependencyChanges) {
      await deps.installDeps();
      log('install', 'ok', 'Dependencies installed.');
    }
    await deps.startApp();
    if (await deps.healthy(summary.version)) {
      pruneBackups(backupsDir);
      log('done', 'ok', `Running ${summary.version}.`);
      return { status: 'applied', detail: `Updated to ${summary.version} - healthy on ${summary.version}.` };
    }
    reason = `${summary.version} did not become healthy.`;
  } catch (err) {
    reason = err.message;
  }

  // Roll back: old files, old dependencies, old database.
  log('rollback', 'started', reason);
  try {
    await deps.stopApp();
    restoreFiles(root, dir);
    if (summary.dependencyChanges) await deps.installDeps();
    if (dbDump) await deps.restoreDb(dbDump);
    await deps.startApp();
    const ok = await deps.healthy(deps.currentVersion);
    log('rollback', ok ? 'ok' : 'failed', ok ? `Back on ${deps.currentVersion}.` : `${deps.currentVersion} did not come back healthy.`);
    return ok
      ? { status: 'rolled_back', detail: `${reason} Rolled back to ${deps.currentVersion}${dbDump ? ' (database restored)' : ''}.` }
      : { status: 'failed', detail: `${reason} Rollback did not come back healthy - check the server log. Backup: ${dir}` };
  } catch (err) {
    log('rollback', 'failed', err.message);
    return { status: 'failed', detail: `${reason} Rollback failed: ${err.message}. Backup: ${dir}` };
  }
}
