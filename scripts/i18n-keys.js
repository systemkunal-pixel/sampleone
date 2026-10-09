#!/usr/bin/env node
// Lists every translatable English string (the dictionary keys) and checks the language files.
//
//   node scripts/i18n-keys.js            → writes src/i18n/keys.json (sorted list of keys)
//   node scripts/i18n-keys.js --check    → per language: missing keys, unused keys, placeholder mismatches
//
// Keys come from: literal t('…') calls in the field app, admin console and home page (including
// /* i18n: t('…') */ comments), the [data-i18n] elements of the home page, and src/i18n/server-messages.js.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCES = ['src/js', 'src/admin/js', 'src/home'];
export const LANGS = ['hi', 'bn'];

function files(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(ROOT, p)).isDirectory() ? files(p) : [p];
  });
}

const unescape = (s, q) => s.replace(new RegExp(`\\\\${q}`, 'g'), q).replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

export async function collectKeys() {
  const keys = new Set();
  for (const f of SOURCES.flatMap(files).filter((p) => p.endsWith('.js'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1], "'"));
    for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1], '"'));
    for (const m of src.matchAll(/\bt\(\s*`((?:[^`\\$]|\\.)*)`/g)) keys.add(unescape(m[1], '`'));
  }
  for (const f of files('src/home').filter((p) => p.endsWith('.html'))) {
    const html = readFileSync(join(ROOT, f), 'utf8');
    for (const m of html.matchAll(/<(\w+)([^>]*\sdata-i18n(?:[\s=][^>]*)?)>([\s\S]*?)<\/\1>/g)) keys.add(m[3].trim().replace(/\s+/g, ' '));
  }
  const server = (await import(pathToFileURL(join(ROOT, 'src/i18n/server-messages.js')).href)).default;
  for (const k of server) keys.add(k);
  keys.delete('');
  return [...keys].sort();
}

export const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

export async function check() {
  const keys = await collectKeys();
  const report = {};
  for (const lang of LANGS) {
    const dict = (await import(pathToFileURL(join(ROOT, `src/i18n/${lang}.js`)).href)).default;
    report[lang] = {
      missing: keys.filter((k) => !(k in dict)),
      unused: Object.keys(dict).filter((k) => !keys.includes(k)),
      badPlaceholders: Object.keys(dict).filter((k) => keys.includes(k) && placeholders(k) !== placeholders(dict[k])),
    };
  }
  return { keys, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const { keys, report } = await check();
    console.log(`${keys.length} keys`);
    for (const [lang, r] of Object.entries(report)) {
      console.log(`${lang}: ${keys.length - r.missing.length}/${keys.length} translated, ${r.unused.length} unused, ${r.badPlaceholders.length} placeholder mismatches`);
      for (const k of r.missing.slice(0, 15)) console.log(`   missing: ${k}`);
      for (const k of r.badPlaceholders) console.log(`   placeholders differ: ${k}`);
    }
  } else {
    const keys = await collectKeys();
    writeFileSync(join(ROOT, 'src/i18n/keys.json'), `${JSON.stringify(keys, null, 1)}\n`);
    console.log(`Wrote ${keys.length} keys to src/i18n/keys.json`);
  }
}
