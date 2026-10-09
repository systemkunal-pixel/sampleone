// Help & guides inside the field app (works offline: the content is cached with the app).
import { CATEGORIES, topicsFor, topicById, topicHtml } from '../help/content.js';
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
  return topicsFor(null, query).filter((t) => t.audience.some((a) => r.includes(a)));
}

export function viewHelp() {
  const list = visibleTopics();
  const back = store.getState().session ? '#/settings' : '#/';
  return `
    ${header('Help & guides', back)}
    <div class="search"><input id="help-search" type="search" placeholder="Search help, e.g. receipt, deposit, PIN" value="${esc(query)}"></div>
    ${list.length ? CATEGORIES.map((c) => {
      const items = list.filter((t) => t.category === c.id);
      if (!items.length) return '';
      return `<h2>${esc(c.label)}</h2>${items.map((t) => `
        <a class="card help-item" href="#/help/${esc(t.id)}">
          <strong>${esc(t.title)}</strong>
          <span class="muted small">${esc(t.summary)}</span>
        </a>`).join('')}`;
    }).join('') : '<p class="empty card">No help topics match. Try another word.</p>'}`;
}

export function viewHelpTopic(id) {
  const t = topicById(id);
  if (!t) return viewHelp();
  const related = visibleTopics().filter((x) => x.category === t.category && x.id !== t.id).slice(0, 4);
  return `
    ${header(t.title, '#/help')}
    <article class="card help-article">
      <p class="muted">${esc(t.summary)}</p>
      ${topicHtml(t)}
    </article>
    <div class="actions"><button class="btn" data-action="print">🖨 Print / save as PDF</button><a class="btn" href="#/help">All help topics</a></div>
    ${related.length ? `<h2>Related</h2>${related.map((r) => `<a class="card help-item" href="#/help/${esc(r.id)}"><strong>${esc(r.title)}</strong><span class="muted small">${esc(r.summary)}</span></a>`).join('')}` : ''}`;
}

export const setHelpQuery = (q) => (query = q);
