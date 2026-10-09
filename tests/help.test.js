import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOPICS, CATEGORIES, ROLES, topicsFor, topicById, topicHtml } from '../src/help/content.js';

const root = new URL('..', import.meta.url).pathname;

test('every help topic is complete and has a unique id', () => {
  const ids = new Set();
  const cats = new Set(CATEGORIES.map((c) => c.id));
  for (const t of TOPICS) {
    assert.match(t.id, /^[a-z0-9-]+$/, t.id);
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
    assert.ok(cats.has(t.category), `${t.id}: unknown category ${t.category}`);
    assert.ok(t.title && t.summary, `${t.id}: needs title and summary`);
    assert.ok(t.audience.length && t.audience.every((r) => r in ROLES), `${t.id}: bad audience`);
    assert.ok(t.body || t.steps, `${t.id}: needs body or steps`);
    assert.ok(topicHtml(t).length > 80, `${t.id}: too short`);
  }
});

test('every role has guides in every main category', () => {
  for (const role of Object.keys(ROLES)) {
    const cats = new Set(topicsFor(role).map((t) => t.category));
    for (const c of ['start', 'howto', 'faq', 'glossary']) assert.ok(cats.has(c), `${role} has no ${c} topics`);
  }
});

test('search finds topics by words in their steps', () => {
  assert.ok(topicsFor('officer', 'slip photo').some((t) => t.id === 'record-bank-deposit'));
  assert.ok(topicsFor('admin', 'unassigned').some((t) => t.id === 'assign-loans'));
  assert.equal(topicsFor('officer', 'import').some((t) => t.id === 'import-loans'), false, 'officers do not see admin topics');
});

test('every help link in the apps points to an existing topic', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.endsWith('content.js')) files.push(p);
    }
  };
  walk(join(root, 'src'));
  const refs = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of [/#\/help\/([a-z0-9-]+)/g, /topic=([a-z0-9-]+)/g, /helpButton\('([a-z0-9-]+)'/g, /guide: '([a-z0-9-]+)'/g]) {
      for (const m of src.matchAll(re)) refs.push([f, m[1]]);
    }
    // header(title, back, 'topic') and header(..., cond ? 'a' : 'b')
    for (const line of src.split('\n').filter((l) => /\bheader\(/.test(l))) {
      const args = line.slice(line.indexOf('header('));
      const tail = args.split(',').slice(2).join(',');
      for (const m of tail.matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)) refs.push([f, m[1]]);
    }
  }
  assert.ok(refs.length >= 20, `found only ${refs.length} help links`);
  for (const [f, id] of refs) assert.ok(topicById(id), `${f.replace(root, '')} links to missing help topic "${id}"`);
});
