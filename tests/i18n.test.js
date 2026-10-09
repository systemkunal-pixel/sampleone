// Translations: lookup and server-message matching, and the completeness of every language file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectKeys, placeholders, LANGS } from '../scripts/i18n-keys.js';
import { TOPICS } from '../src/help/content.js';

// i18n.js runs in browsers; give it the few globals it touches.
for (const [k, v] of Object.entries({
  document: { documentElement: {} },
  navigator: { languages: ['en-IN'] },
  localStorage: { getItem: () => null, setItem: () => {} },
})) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
const i18n = await import('../src/i18n/i18n.js');

test('t() falls back to English and fills placeholders; tr() matches filled-in server messages', async () => {
  await i18n.loadLang('en');
  assert.equal(i18n.t('{n} loans', { n: 3 }), '3 loans');
  await i18n.loadLang('hi');
  const dict = (await import('../src/i18n/hi.js')).default;
  const key = 'Too many wrong attempts. Try again in {n} minutes.';
  if (dict[key]) {
    assert.equal(i18n.tr('Too many wrong attempts. Try again in 15 minutes.'), dict[key].replace('{n}', '15'));
  }
  assert.equal(i18n.tr('A message nobody translated.'), 'A message nobody translated.');
  // The more specific template wins.
  const specific = 'Officer {code} is deactivated.';
  if (dict[specific]) assert.equal(i18n.tr('Officer FO27 is deactivated.'), dict[specific].replace('{code}', 'FO27'));
  await i18n.loadLang('en');
});

test('every language translates every UI and server string, keeping placeholders', async () => {
  const keys = await collectKeys();
  assert.ok(keys.length > 300, `only ${keys.length} keys found`);
  for (const lang of LANGS) {
    const dict = (await import(`../src/i18n/${lang}.js`)).default;
    const missing = keys.filter((k) => !(k in dict));
    assert.deepEqual(missing.slice(0, 10), [], `${lang}: ${missing.length} untranslated, e.g. the ones listed`);
    for (const k of keys) assert.equal(placeholders(dict[k]), placeholders(k), `${lang}: placeholders differ in "${k}"`);
    for (const v of Object.values(dict)) assert.ok(!/<script|javascript:|on\w+=/i.test(v), `${lang}: unsafe markup in "${v}"`);
  }
});

test('every language has the whole help manual with the same structure', async () => {
  const tags = (s) => [...String(s).matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).join(' ');
  for (const lang of LANGS) {
    const help = (await import(`../src/help/i18n/${lang}.js`)).default;
    for (const t of TOPICS) {
      const tr = help.topics[t.id];
      assert.ok(tr?.title && tr.summary, `${lang}: topic ${t.id} missing`);
      for (const f of ['steps', 'tips']) assert.equal(tr[f]?.length, t[f]?.length, `${lang}: ${t.id}.${f} length`);
      assert.equal(Boolean(tr.body), Boolean(t.body), `${lang}: ${t.id}.body`);
      if (t.body) assert.equal(tags(tr.body), tags(t.body), `${lang}: ${t.id} body markup`);
    }
  }
});
