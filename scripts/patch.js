#!/usr/bin/env node
// LoanDesk release tool: makes the signing key and builds signed update packages (.ldpatch).
//
//   node scripts/patch.js keygen                 once: creates your private signing key and prints the
//                                                public key line to put in each server's .env
//   node scripts/patch.js build [--notes "…"]    builds loandesk-<version>.ldpatch from this folder
//   node scripts/patch.js verify <file.ldpatch>  checks a package against UPDATE_PUBLIC_KEY (or --pub)
//
// The private key never goes into the repository or onto a server. Default location:
//   %USERPROFILE%\.loandesk\update-signing-key.pem   (Windows)   ~/.loandesk/update-signing-key.pem
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateSigningKeys, buildPatch, verifyPatch, publicKeyFrom, keyFingerprint } from '../server/patch.js';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_KEY = join(homedir(), '.loandesk', 'update-signing-key.pem');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { key: { type: 'string' }, out: { type: 'string' }, notes: { type: 'string' }, pub: { type: 'string' } },
});
const [cmd, file] = positionals;
const keyFile = values.key || DEFAULT_KEY;

try {
  if (cmd === 'keygen') {
    if (existsSync(keyFile)) throw new Error(`${keyFile} already exists. Delete it first only if you really want a new key — servers must then get the new public key.`);
    const { privatePem, publicKey } = generateSigningKeys();
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, privatePem, { mode: 0o600 });
    console.log(`Private signing key saved to ${keyFile}`);
    console.log('Keep it safe and private (a backup on a USB stick is a good idea). Anyone with it can sign updates.\n');
    console.log("Add this line to the .env file of every LoanDesk server, then restart LoanDesk:\n");
    console.log(`UPDATE_PUBLIC_KEY=${publicKey}\n`);
    console.log(`Key fingerprint: ${keyFingerprint(publicKeyFrom(publicKey))}`);
  } else if (cmd === 'build') {
    if (!existsSync(keyFile)) throw new Error(`No signing key at ${keyFile}. Run: node scripts/patch.js keygen`);
    const buf = buildPatch(ROOT, readFileSync(keyFile, 'utf8'), { notes: values.notes || '' });
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const out = resolve(values.out || ROOT, `loandesk-${version}.ldpatch`);
    writeFileSync(out, buf);
    console.log(`Built ${out} (${(buf.length / 1024 / 1024).toFixed(1)} MB, version ${version}).`);
    console.log('Upload it in the overlord console: Update & diagnostics → Verify → Stage.');
  } else if (cmd === 'verify') {
    if (!file) throw new Error('Give the package file.');
    try {
      process.loadEnvFile(join(ROOT, '.env'));
    } catch {}
    const key = publicKeyFrom(values.pub || process.env.UPDATE_PUBLIC_KEY);
    const { summary } = verifyPatch(readFileSync(file), { publicKey: key, current: null });
    console.log(`OK: LoanDesk ${summary.version}, ${summary.files} files, built ${summary.createdAt}, signed by key ${keyFingerprint(key)}.`);
  } else {
    console.log(readFileSync(import.meta.filename, 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
