// Translations for the field app, the admin console and the home page (the overlord console stays English).
//
// The English text is the key: t('Collect payment') looks it up in the current language's dictionary
// (src/i18n/<lang>.js) and falls back to English. Placeholders: t('{n} records waiting', { n: 3 }).
// Messages from the server arrive in English; tr() also matches keys that contain placeholders, so
// 'Try again in {n} minutes.' translates 'Try again in 15 minutes.'.

export const LANGS = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'mr', name: 'Marathi', native: 'मराठी' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ' },
];
const CODES = LANGS.map((l) => l.code);
const KEY = 'loandesk:lang';

let lang = 'en';
let dict = {};
let patterns = null;

function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The saved choice, else the browser's language if we have it, else English. */
export function preferredLang() {
  const saved = stored();
  if (CODES.includes(saved)) return saved;
  const nav = (navigator.languages || [navigator.language || 'en']).map((l) => String(l).slice(0, 2).toLowerCase());
  return nav.find((l) => CODES.includes(l)) || 'en';
}

export const getLang = () => lang;

/** Loads a language's dictionary. Call (and await) before the first render. */
export async function loadLang(code = preferredLang()) {
  const next = CODES.includes(code) ? code : 'en';
  let d = {};
  if (next !== 'en') {
    try {
      d = (await import(`./${next}.js`)).default;
    } catch {
      d = {};
    }
  }
  lang = next;
  dict = d;
  patterns = null;
  document.documentElement.lang = next;
  return next;
}

/** Saves the choice, loads it and tells the page to re-render (event 'langchange' on window). */
export async function setLang(code) {
  try {
    localStorage.setItem(KEY, code);
  } catch {}
  await loadLang(code);
  window.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** Translates a UI string. */
export function t(text, vars) {
  return fill(dict[text] ?? text, vars);
}

/** Translates a message that may already have its values filled in (server errors). */
export function tr(message) {
  const msg = String(message ?? '');
  if (lang === 'en' || !msg) return msg;
  if (dict[msg]) return dict[msg];
  patterns ||= Object.keys(dict)
    .filter((k) => /\{\w+\}/.test(k))
    .map((k) => {
      const names = [];
      const re = new RegExp(`^${k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\w+)\\?\}/g, (m, n) => (names.push(n), '(.+?)'))}$`);
      return { re, names, key: k, fixed: k.replace(/\{\w+\}/g, '').length };
    })
    // Most specific first: 'Officer {code} is deactivated.' must win over '{code} is deactivated.'.
    .sort((a, b) => b.fixed - a.fixed);
  for (const p of patterns) {
    const m = p.re.exec(msg);
    if (m) return fill(dict[p.key], Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])));
  }
  return msg;
}

/** A <select> for choosing the language; wire it with bindLangSelect(). */
export const langSelect = (cls = '', label = 'Language') => `
  <label class="lang-select ${cls}"><span class="sr-only">${label}</span>
    <select data-lang-select aria-label="${label}">${LANGS.map((l) => `<option value="${l.code}" ${l.code === lang ? 'selected' : ''}>${l.native}</option>`).join('')}</select>
  </label>`;

export function bindLangSelect(root = document) {
  root.querySelectorAll('[data-lang-select]').forEach((s) => {
    s.onchange = () => setLang(s.value);
  });
}
