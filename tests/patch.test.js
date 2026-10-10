// Signed update packages and the apply / rollback sequence, on throwaway folders (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { generateSigningKeys, buildPatch, verifyPatch, publicKeyFrom, compareVersions, MAGIC, PatchError } from '../server/patch.js';
import { applyUpdate } from '../server/updater.js';

function app(version, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ld-patch-'));
  const files = {
    'package.json': JSON.stringify({ name: 'loandesk', version }),
    'server/index.js': `// v${version}`,
    'server/schema.sql': 'CREATE TABLE t (id INT)',
    'src/index.html': `<h1>${version}</h1>`,
    ...extra,
  };
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  writeFileSync(join(root, '.env'), 'SECRET=keep-me');
  return root;
}

const keys = generateSigningKeys();
const pub = publicKeyFrom(keys.publicKey);

test('versions compare numerically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0);
});

test('a signed package verifies and reports what changes', () => {
  const next = app('1.1.0', { 'server/schema.sql': 'CREATE TABLE t (id INT, x INT)', 'src/new.js': 'new' });
  const current = app('1.0.0');
  const { summary } = verifyPatch(buildPatch(next, keys.privatePem), { publicKey: pub, current: { version: '1.0.0', root: current } });
  assert.equal(summary.version, '1.1.0');
  assert.equal(summary.files, 5, '.env and other unmanaged files are never packaged');
  assert.equal(summary.schemaChanges, true);
});

test('tampering, a foreign key, an old version or unsafe paths are refused', () => {
  const root = app('1.1.0');
  const good = buildPatch(root, keys.privatePem);
  const body = () => JSON.parse(gunzipSync(good.subarray(MAGIC.length)).toString());
  const repack = (b) => Buffer.concat([Buffer.from(MAGIC), gzipSync(JSON.stringify(b))]);
  const check = (buf, current = { version: '1.0.0' }) => assert.throws(() => verifyPatch(buf, { publicKey: pub, current }), PatchError);

  const changedFile = body();
  changedFile.files['server/index.js'] = Buffer.from('evil()').toString('base64');
  check(repack(changedFile));

  const changedManifest = body();
  changedManifest.manifest = changedManifest.manifest.replace('"1.1.0"', '"9.9.9"');
  check(repack(changedManifest));

  const other = generateSigningKeys();
  assert.throws(() => verifyPatch(good, { publicKey: publicKeyFrom(other.publicKey), current: null }), /Signature/);
  assert.throws(() => verifyPatch(good, { publicKey: null, current: null }), /signing key/);
  check(good, { version: '1.1.0' });
  check(Buffer.from('not a patch'));

  const evil = app('1.1.0', { 'server/x.js': 'x' });
  const traversal = buildPatch(evil, keys.privatePem);
  const t = JSON.parse(gunzipSync(traversal.subarray(MAGIC.length)).toString());
  t.manifest = t.manifest.replace('"server/x.js"', '"server/../../etc/x.js"');
  check(repack(t));
});

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    publicKey: pub, currentVersion: '1.0.0',
    log: (step, outcome) => calls.push(`${step}:${outcome}`),
    stopApp: async () => calls.push('stop'),
    startApp: async () => calls.push('start'),
    healthy: async () => true,
    dumpDb: async (file) => writeFileSync(file, '-- dump'),
    restoreDb: async () => calls.push('restoreDb'),
    installDeps: async () => calls.push('npm'),
    ...overrides,
  };
}

function staged(currentRoot, next) {
  const pkg = join(currentRoot, 'next.ldpatch');
  writeFileSync(pkg, buildPatch(next, keys.privatePem));
  return { root: currentRoot, packageFile: pkg, backupsDir: join(currentRoot, 'backups') };
}

test('applying replaces managed files, removes stale ones and keeps .env', async () => {
  const current = app('1.0.0', { 'src/old.js': 'old' });
  const next = app('1.1.0', { 'src/new.js': 'new' });
  const d = deps();
  const result = await applyUpdate(staged(current, next), d);
  assert.equal(result.status, 'applied');
  assert.equal(JSON.parse(readFileSync(join(current, 'package.json'))).version, '1.1.0');
  assert.ok(existsSync(join(current, 'src/new.js')));
  assert.ok(!existsSync(join(current, 'src/old.js')));
  assert.equal(readFileSync(join(current, '.env'), 'utf8'), 'SECRET=keep-me');
  assert.deepEqual(d.calls.filter((c) => ['stop', 'start', 'restoreDb'].includes(c)), ['stop', 'start']);
});

test('an unhealthy update is rolled back: files and database restored', async () => {
  const current = app('1.0.0', { 'src/old.js': 'old' });
  const next = app('1.1.0', { 'server/schema.sql': 'ALTER something', 'src/new.js': 'new' });
  const d = deps({ healthy: async (v) => v === '1.0.0' });
  const result = await applyUpdate(staged(current, next), d);
  assert.equal(result.status, 'rolled_back');
  assert.match(result.detail, /database restored/);
  assert.equal(JSON.parse(readFileSync(join(current, 'package.json'))).version, '1.0.0');
  assert.ok(existsSync(join(current, 'src/old.js')));
  assert.ok(!existsSync(join(current, 'src/new.js')));
  assert.ok(d.calls.includes('restoreDb'));
});

test('a package that fails its checks changes nothing', async () => {
  const current = app('1.0.0');
  const next = app('1.1.0');
  const job = staged(current, next);
  const d = deps({ publicKey: publicKeyFrom(generateSigningKeys().publicKey) });
  await assert.rejects(applyUpdate(job, d), PatchError);
  assert.equal(JSON.parse(readFileSync(join(current, 'package.json'))).version, '1.0.0');
  assert.ok(!d.calls.includes('stop'));
});

test('a private key pasted as UPDATE_PUBLIC_KEY is refused with a clear message', () => {
  const { privatePem } = generateSigningKeys();
  const body = privatePem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  assert.throws(() => publicKeyFrom(body), /PRIVATE key/);
  assert.throws(() => publicKeyFrom(privatePem), /PRIVATE key/);
});
