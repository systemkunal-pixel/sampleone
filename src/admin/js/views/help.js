import { CATEGORIES, TOPICS, topicsFor, topicById, topicHtml, categoryLabel, roleLabel } from '../../../help/content.js';
import { esc, icon, emptyState } from '../ui.js';
import { t } from '../../../i18n/i18n.js';
import { setQuery } from '../main.js';

// Role filter: English labels, translated where shown.
/* i18n: t('All roles') t('Admins') t('Supervisors') t('Field officers') */
const AUDIENCES = [['', 'All roles'], ['admin', 'Admins'], ['supervisor', 'Supervisors'], ['officer', 'Field officers']];

function audienceBadges(topic) {
  return topic.audience.map((r) => `<span class="badge">${esc(roleLabel(r))}</span>`).join(' ');
}

/** Prints every topic in the list, fully expanded, as a training handout. */
function printGuide(list, role) {
  const area = document.createElement('div');
  area.id = 'print-area';
  const printed = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  area.innerHTML = `
    <h1>${esc(role ? t('LoanDesk — {role} guide', { role: roleLabel(role) }) : t('LoanDesk — Complete guide'))}</h1>
    <p class="muted">${esc(t('Printed {date}', { date: printed }))}</p>
    ${CATEGORIES.map((c) => {
      const items = list.filter((topic) => topic.category === c.id);
      return items.length ? `<h2 class="print-cat">${esc(categoryLabel(c))}</h2>${items.map((topic) => `
        <section class="help-article print-topic"><h3>${esc(topic.title)}</h3><p class="muted">${esc(topic.summary)}</p>${topicHtml(topic)}</section>`).join('')}` : '';
    }).join('')}`;
  document.body.append(area);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    area.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => document.body.contains(area) && done(), 60000);
}

export async function render(el, q) {
  const role = q.get('role') || '';
  const text = q.get('q') || '';
  const list = topicsFor(role || null, text);
  const current = topicById(q.get('topic') || '') || (text ? list[0] : topicById(role === 'officer' ? 'welcome' : role === 'supervisor' ? 'verify-deposit' : 'admin-first-day'));
  const audienceLabel = t(AUDIENCES.find(([r]) => r === role)[1]);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(t('Help & guides'))}</h1><p>${t('The user manual: how-to guides, daily routines, a rollout plan, troubleshooting and a glossary — for every role.')}</p></div>
      <div class="page-actions">
        <button class="btn" data-act="print" title="${esc(t('Print or save as PDF - for training handouts'))}">${icon('file')} ${role ? esc(t('Print guide for {role}', { role: audienceLabel.toLowerCase() })) : t('Print guide (all roles)')}</button>
      </div>
    </div>
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">${t('Search help')}</span>${icon('search')}<input class="input" name="q" type="search" placeholder="${esc(t('Search, e.g. import, PIN, deposit'))}" value="${esc(text)}"></label>
      <div class="seg" role="tablist" aria-label="${esc(t('Show topics for'))}">
        ${AUDIENCES.map(([r, label]) => `<button type="button" class="seg-btn ${r === role ? 'active' : ''}" data-role="${r}" role="tab" aria-selected="${r === role}">${esc(t(label))}</button>`).join('')}
      </div>
    </form>
    <div class="help-layout ${current ? 'has-topic' : ''}">
      <nav class="card help-index" aria-label="${esc(t('Help topics'))}">
        ${list.length ? CATEGORIES.map((c) => {
          const items = list.filter((topic) => topic.category === c.id);
          if (!items.length) return '';
          return `<div class="help-cat">${esc(categoryLabel(c))}</div>${items.map((topic) => `
            <a href="#/help?${new URLSearchParams({ ...(role ? { role } : {}), ...(text ? { q: text } : {}), topic: topic.id })}"
               class="help-link ${current?.id === topic.id ? 'active' : ''}">${esc(topic.title)}</a>`).join('')}`;
        }).join('') : emptyState(t('Nothing found'), t('Try another word.'), 'search')}
      </nav>
      <article class="card help-content">
        ${current ? `
          <div class="card-head"><div><h2>${esc(current.title)}</h2><p>${esc(current.summary)}</p></div>
            <div class="help-for">${audienceBadges(current)}</div></div>
          <div class="card-body help-article">${topicHtml(current)}</div>`
        : emptyState(t('Choose a topic'), t('Pick a guide from the list.'), 'file')}
      </article>
    </div>
    <p class="muted small">${t('{n} topics. Field officers and supervisors see their guides in the phone app under <b>?</b> or Settings → Help.', { n: TOPICS.length })}</p>`;

  const form = el.querySelector('#filters');
  let timer;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const pos = e.target.selectionStart;
      setQuery({ role, q: e.target.value }, { replace: true });
      setTimeout(() => {
        const input = el.querySelector('input[name=q]');
        input?.focus();
        input?.setSelectionRange(pos, pos);
      }, 60);
    }, 250);
  };
  el.onsubmit = (e) => e.preventDefault();
  el.onclick = (e) => {
    const r = e.target.closest('[data-role]');
    if (r) return setQuery({ role: r.dataset.role, q: form.q.value });
    if (e.target.closest('[data-act=print]')) printGuide(list, role);
    if (e.target.closest('.help-link') && window.innerWidth < 1024) setTimeout(() => el.querySelector('.help-content')?.scrollIntoView({ behavior: 'smooth' }), 80);
  };
}
