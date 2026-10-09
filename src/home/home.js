// Home page: translates every [data-i18n] element (its English HTML is the key) and sends demo requests.
import { t, tr, loadLang, langSelect, bindLangSelect } from '/i18n/i18n.js';

// Phones that installed the field app when it lived at / open here: send them to the app.
if (matchMedia('(display-mode: standalone)').matches) location.replace('/app/');

const nodes = [...document.querySelectorAll('[data-i18n]')];
for (const el of nodes) el.dataset.en = el.innerHTML.trim().replace(/\s+/g, ' ');

function apply() {
  // Keys are the page's own English; translations come from our dictionaries, never from user input.
  for (const el of nodes) el.innerHTML = t(el.dataset.en);
  document.title = t('LoanDesk · Loan collection app for Indian lenders');
  document.getElementById('lang-slot').innerHTML = langSelect('', t('Language'));
  bindLangSelect();
}

await loadLang();
apply();
window.addEventListener('langchange', apply);
document.getElementById('year').textContent = new Date().getFullYear();

const form = document.getElementById('demo-form');
const msg = document.getElementById('demo-msg');
form.onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  msg.className = 'form-msg';
  if (!data.name.trim() || !data.company.trim() || !data.phone.trim()) {
    msg.className = 'form-msg bad';
    msg.textContent = t('Please fill in your name, organisation and mobile number.');
    return;
  }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, lang: document.documentElement.lang }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || t('Something went wrong. Please try again.'));
    form.reset();
    msg.className = 'form-msg ok';
    msg.textContent = t('Thank you! We’ll call you within one working day.');
  } catch (err) {
    msg.className = 'form-msg bad';
    msg.textContent = err instanceof TypeError ? t('Cannot reach the server. Check your connection.') : tr(err.message);
  } finally {
    btn.disabled = false;
  }
};
