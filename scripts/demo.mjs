import { createIndex } from '../lib/index.js';

const index = createIndex();
index.add({ id: 'note-1', title: 'Release notes 3.2', body: 'weekly release notes and fixes', tags: ['release'] });
index.add({ id: 'note-2', title: 'Notes on release', body: 'the release slipped again', tags: ['release'] });
index.add({ id: 'note-3', title: 'Release checklist', body: 'notes taken by hand', tags: ['process'] });
index.add({ id: 'note-4', title: '周会纪要', body: '发布节奏 review', tags: ['meeting'] });

const show = (label, out) => {
  console.log(`    ${label}: ${out.length} 条`);
  for (const hit of out) {
    const detail = hit.hits.map((item) => `${item.clause}@${item.field}x${item.tf}`).join(' ');
    console.log(`      ${hit.id} score=${hit.score.toFixed(6)} ${detail}`);
  }
};

console.log('lexindex demo');
console.log('[1] 两个词，默认 AND');
show('release notes', index.search('release notes'));

console.log('[2] 加了引号就要挨着');
show('"release notes"', index.search('"release notes"'));
show('"notes release"', index.search('"notes release"'));

console.log('[3] 字段限定和前缀');
show('title:release', index.search('title:release'));
show('rel*', index.search('rel*'));

console.log('[4] 或者、排除');
show('checklist | 周会', index.search('checklist | 周会'));
show('release -slipped', index.search('release -slipped'));

console.log('[5] explain 说清楚每个词项命中几篇');
const plan = index.explain('title:release notes');
for (const clause of plan.clauses) {
  console.log(`    ${clause.text} field=${clause.field} kind=${clause.kind} df=${clause.df} negated=${clause.negated}`);
}
console.log(`    候选 ${plan.candidates} 篇，${plan.groups} 个 or 组`);

console.log('[6] 删掉一篇，倒排里不留东西');
console.log(`    before docs=${index.stats().docs} terms=${index.stats().terms} postings=${index.stats().postings}`);
index.remove('note-2');
console.log(`    after  docs=${index.stats().docs} terms=${index.stats().terms} postings=${index.stats().postings}`);
show('release', index.search('release'));
