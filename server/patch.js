// LoanDesk update packages (.ldpatch): a complete build of the app's code, signed with Ed25519.
//
// File layout: "LDPATCH1\n" + gzip(JSON { manifest: "<JSON string>", signature, files: { path: base64 } }).
// The manifest lists every file with its size and SHA-256; the signature covers the manifest string,
// so changing any file, adding one or editing the manifest breaks verification.
// The private key stays with whoever builds releases; servers only hold the public key (UPDATE_PUBLIC_KEY).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const MAGIC = 'LDPATCH1\n';
export const PRODUCT = 'loandesk';
export const MAX_PATCH_BYTES = 30 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

/** The parts of the app a package replaces. Everything else (.env, node_modules, logs, backups) is never touched. */
export const MANAGED_DIRS = ['server/', 'src/', 'scripts/', 'deploy/'];
export const MANAGED_FILES = ['package.json', 'package-lock.json', 'README.md', '.env.example'];
export const isManaged = (p) => MANAGED_FILES.includes(p) || MANAGED_DIRS.some((d) => p.startsWith(d));

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------- versions ----------

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
export const validVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v));

// ---------- keys ----------

/** New signing key pair: the private key as PEM (keep it secret), the public key as one base64 line for .env. */
export function generateSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export function publicKeyFrom(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.includes('BEGIN PUBLIC KEY')) return createPublicKey(t);
  return createPublicKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'spki' });
}

export const keyFingerprint = (key) =>
  sha256(key.export({ type: 'spki', format: 'der' })).slice(0, 16).replace(/(.{4})(?!$)/g, '$1:');

// ---------- the files of a build ----------

/** Managed files of the app at `root`, as POSIX paths. Uses git when available so untracked files stay out. */
export function listAppFiles(root) {
  let paths = null;
  if (existsSync(join(root, '.git'))) {
    try {
      paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch {
      paths = null;
    }
  }
  if (!paths) {
    paths = [];
    const walk = (dir) => {
      for (const name of readdirSync(join(root, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const rel = dir ? `${dir}/${name}` : name;
        if (statSync(join(root, rel)).isDirectory()) walk(rel);
        else paths.push(rel);
      }
    };
    for (const d of MANAGED_DIRS) if (existsSync(join(root, d))) walk(d.slice(0, -1));
    for (const f of MANAGED_FILES) if (existsSync(join(root, f))) paths.push(f);
  }
  return paths.filter(isManaged).filter((p) => existsSync(join(root, p))).sort();
}

// ---------- build ----------

export function buildPatch(root, privatePem, { notes = '' } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!validVersion(pkg.version)) throw new Error(`package.json version "${pkg.version}" is not x.y.z`);
  const files = {};
  const list = [];
  for (const p of listAppFiles(root)) {
    const buf = readFileSync(join(root, p));
    files[p] = buf.toString('base64');
    list.push({ path: p, size: buf.length, sha256: sha256(buf) });
  }
  const manifest = JSON.stringify({
    product: PRODUCT, format: 1, version: pkg.version, createdAt: new Date().toISOString(), notes: String(notes).slice(0, 2000), files: list,
  });
  const signature = sign(null, Buffer.from(manifest), createPrivateKey(privatePem)).toString('base64');
  return Buffer.concat([Buffer.from(MAGIC), gzipSync(JSON.stringify({ manifest, signature, files }))]);
}

// ---------- verify ----------

export class PatchError extends Error {}

/**
 * Checks a package without writing anything: signature, product, version, every file's hash, and that
 * every path stays inside the managed parts of the app. Returns { manifest, files: Map<path, Buffer>, summary }.
 * `current` = { version, root } of this server, used to report what the update changes.
 */
export function verifyPatch(buf, { publicKey, current }) {
  const fail = (msg) => {
    throw new PatchError(msg);
  };
  if (!publicKey) fail('No update signing key is configured on this server (UPDATE_PUBLIC_KEY in .env).');
  if (!Buffer.isBuffer(buf) || buf.length > MAX_PATCH_BYTES) fail('Package is empty or larger than 30 MB.');
  if (buf.subarray(0, MAGIC.length).toString() !== MAGIC) fail('Not a LoanDesk update package (.ldpatch).');
  let body;
  try {
    body = JSON.parse(gunzipSync(buf.subarray(MAGIC.length), { maxOutputLength: MAX_UNPACKED_BYTES }).toString('utf8'));
  } catch {
    fail('Package is damaged and cannot be read.');
  }
  if (typeof body?.manifest !== 'string' || typeof body.signature !== 'string' || typeof body.files !== 'object') fail('Package is damaged.');
  let good = false;
  try {
    good = verify(null, Buffer.from(body.manifest), publicKey, Buffer.from(body.signature, 'base64'));
  } catch {
    good = false;
  }
  if (!good) fail('Signature check failed: this package was not signed with the LoanDesk release key, or it was altered.');
  const m = JSON.parse(body.manifest);
  if (m.product !== PRODUCT || m.format !== 1) fail(`This package is for "${m.product}", not LoanDesk.`);
  if (!validVersion(m.version)) fail('Package version is invalid.');
  if (current?.version && compareVersions(m.version, current.version) <= 0) {
    fail(`Package is version ${m.version}; this server already runs ${current.version}. Only newer versions can be installed.`);
  }
  const files = new Map();
  const listed = new Set();
  for (const f of m.files || []) {
    const p = String(f.path);
    if (p !== posix.normalize(p) || p.startsWith('/') || p.includes('..') || p.includes('\\') || !isManaged(p)) fail(`Unsafe file path in package: ${p}`);
    if (listed.has(p)) fail(`File listed twice: ${p}`);
    listed.add(p);
    const data = Buffer.from(body.files[p] ?? '', 'base64');
    if (body.files[p] === undefined || data.length !== f.size || sha256(data) !== f.sha256) fail(`File ${p} does not match its checksum.`);
    files.set(p, data);
  }
  if (Object.keys(body.files).some((p) => !listed.has(p))) fail('Package contains files that are not in its manifest.');
  for (const need of ['package.json', 'server/index.js', 'server/schema.sql']) if (!files.has(need)) fail(`Package is incomplete: ${need} is missing.`);
  if (JSON.parse(files.get('package.json').toString('utf8')).version !== m.version) fail('package.json inside the package has a different version.');

  // What changes compared with this server.
  const differs = (p) => {
    if (!current?.root) return true;
    try {
      return sha256(readFileSync(join(current.root, p))) !== sha256(files.get(p));
    } catch {
      return true;
    }
  };
  let changed = 0;
  for (const p of files.keys()) if (differs(p)) changed++;
  const removed = current?.root ? listAppFiles(current.root).filter((p) => !files.has(p)).length : 0;
  return {
    manifest: m,
    files,
    summary: {
      version: m.version, from: current?.version || null, createdAt: m.createdAt, notes: m.notes || '',
      files: files.size, changed, removed, bytes: buf.length,
      schemaChanges: differs('server/schema.sql'), dependencyChanges: differs('package-lock.json'),
    },
  };
}

export const toPosix = (p) => p.split(sep).join('/');
export const relPosix = (root, abs) => toPosix(relative(root, abs));
