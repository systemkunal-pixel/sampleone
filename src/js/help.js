// Help & guides inside the field app (works offline: the content is cached with the app).
import { CATEGORIES, topicsFor, topicById, topicHtml, categoryLabel } from '../help/content.js';
import { t } from '../i18n/i18n.js';
import * as store from './store.js';
import { esc, header } from './ui.js';

let query = '';

/** Roles whose topics to show: the signed-in user's, or both field roles before sign-in. */
function roles() {
  const role = store.getState().session?.user?.role;
  return role ? [role] : ['officer', 'supervisor'];
}

function visibleTopics() {
  const r = roles();
  return topicsFor(null, query).filter((x) => x.audience.some((a) => r.includes(a)));
}

export function viewHelp() {
  const list = visibleTopics();
  const back = store.getState().session ? '#/settings' : '#/';
  return `
    ${header(t('Help & guides'), back)}
    <div class="search"><input id="help-search" type="search" placeholder="${esc(t('Search help, e.g. receipt, deposit, PIN'))}" aria-label="${esc(t('Search help'))}" value="${esc(query)}"></div>
    ${list.length ? CATEGORIES.map((c) => {
      const items = list.filter((x) => x.category === c.id);
      if (!items.length) return '';
      return `<h2>${esc(categoryLabel(c))}</h2>${items.map((x) => `
        <a class="card help-item" href="#/help/${esc(x.id)}">
          <strong>${esc(x.title)}</strong>
          <span class="muted small">${esc(x.summary)}</span>
        </a>`).join('')}`;
    }).join('') : `<p class="empty card">${t('No help topics match. Try another word.')}</p>`}`;
}

export function viewHelpTopic(id) {
  const topic = topicById(id);
  if (!topic) return viewHelp();
  const related = visibleTopics().filter((x) => x.category === topic.category && x.id !== topic.id).slice(0, 4);
  return `
    ${header(topic.title, '#/help')}
    <article class="card help-article">
      <p class="muted">${esc(topic.summary)}</p>
      ${topicHtml(topic)}
    </article>
    <div class="actions"><button class="btn" data-action="print">🖨 ${t('Print / save as PDF')}</button><a class="btn" href="#/help">${t('All help topics')}</a></div>
    ${related.length ? `<h2>${t('Related')}</h2>${related.map((r) => `<a class="card help-item" href="#/help/${esc(r.id)}"><strong>${esc(r.title)}</strong><span class="muted small">${esc(r.summary)}</span></a>`).join('')}` : ''}`;
}

export const setHelpQuery = (q) => (query = q);
