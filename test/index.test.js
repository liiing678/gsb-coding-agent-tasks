import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex } from '../lib/index.js';
import { tokenize } from '../lib/tokenize.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'IndexError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const ids = (out) => out.map((item) => item.id);

function seeded() {
  const index = createIndex();
  index.add({ id: 'd1', title: 'Alpha Beta', body: 'beta gamma', tags: ['news'] });
  index.add({ id: 'd2', title: 'Beta', body: 'alpha gamma' });
  index.add({ id: 'd3', title: 'Gamma report', body: 'nothing here' });
  return index;
}

test('单词项查询：命中哪些文档、按什么顺序', () => {
  const index = seeded();
  const out = index.search('gamma');
  assert.deepEqual(ids(out).sort(), ['d1', 'd2', 'd3']);
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i - 1].score >= out[i].score, true);
  }
  assert.equal(out[0].id, 'd2'); // 最短的文档分最高
});

test('分数按 README 里的 BM25 算', () => {
  const index = seeded();
  const expected = (tf, dl, df, n, avg) => {
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    const norm = 1 - 0.75 + (0.75 * dl) / avg;
    return Math.round(((idf * (tf * 2.2)) / (tf + 1.2 * norm)) * 1e6) / 1e6;
  };
  const all = index.search('alpha');
  const avgAll = (5 + 3 + 4) / 3; // 三篇文档 title+body+tags 的 token 数
  assert.equal(all.find((item) => item.id === 'd1').score, expected(1, 5, 2, 3, avgAll));
  assert.equal(all.find((item) => item.id === 'd2').score, expected(1, 3, 2, 3, avgAll));

  const titled = index.search('title:alpha');
  assert.deepEqual(ids(titled), ['d1']);
  const avgTitle = (2 + 1 + 2) / 3;
  assert.equal(titled[0].score, expected(1, 2, 1, 3, avgTitle));
});

test('多个词项默认是 AND，两次出现分数更高', () => {
  const index = seeded();
  assert.deepEqual(ids(index.search('alpha beta')).sort(), ['d1', 'd2']);
  assert.deepEqual(ids(index.search('alpha gamma')).sort(), ['d1', 'd2']);
  assert.deepEqual(ids(index.search('alpha nope')), []);
  const once = index.search('gamma').find((item) => item.id === 'd1').score;
  const twice = index.search('gamma gamma').find((item) => item.id === 'd1').score;
  assert.equal(twice > once, true);
});

test('| 是或者，- 是排除且不参与打分', () => {
  const index = seeded();
  assert.deepEqual(ids(index.search('alpha | gamma')).sort(), ['d1', 'd2', 'd3']);
  assert.deepEqual(ids(index.search('gamma -beta')).sort(), ['d3']);
  const withNot = index.search('gamma -beta').find((item) => item.id === 'd3');
  const plain = index.search('gamma').find((item) => item.id === 'd3');
  assert.equal(withNot.score, plain.score);
});

test('字段限定只在该字段里找', () => {
  const index = seeded();
  assert.deepEqual(ids(index.search('title:beta')).sort(), ['d1', 'd2']);
  assert.deepEqual(ids(index.search('body:beta')), ['d1']);
  assert.deepEqual(ids(index.search('tags:news')), ['d1']);
  assert.deepEqual(ids(index.search('body:news')), []);
});

test('短语要挨着才算，跨字段不算', () => {
  const index = createIndex();
  index.add({ id: 'a', body: 'alpha beta gamma' });
  index.add({ id: 'b', body: 'beta alpha' });
  index.add({ id: 'c', title: 'alpha', body: 'beta' });
  assert.deepEqual(ids(index.search('"alpha beta"')), ['a']);
  assert.deepEqual(ids(index.search('"beta alpha"')), ['b']);
  assert.deepEqual(ids(index.search('body:"alpha beta"')), ['a']);
  assert.deepEqual(ids(index.search('"alpha beta gamma"')), ['a']);
});

test('前缀是把展开出来的词当一个词算', () => {
  const index = seeded();
  assert.deepEqual(ids(index.search('gam*')).sort(), ['d1', 'd2', 'd3']);
  assert.deepEqual(ids(index.search('title:gam*')), ['d3']);
  const prefix = index.search('gam*').find((item) => item.id === 'd1');
  const exact = index.search('gamma').find((item) => item.id === 'd1');
  assert.equal(prefix.score, exact.score);
});

test('explain 说清楚每个词项命中了多少文档', () => {
  const index = seeded();
  const out = index.explain('title:beta gamma');
  assert.equal(out.groups, 1);
  assert.equal(out.candidates, 2);
  assert.deepEqual(
    out.clauses.map((clause) => [clause.text, clause.field, clause.df]),
    [
      ['beta', 'title', 2],
      ['gamma', 'title,body,tags', 3],
    ],
  );
});

test('中文一个字一个词，没写引号就按 AND', () => {
  const index = createIndex();
  index.add({ id: 'm1', title: '周会纪要' });
  index.add({ id: 'm2', title: '周报' });
  assert.deepEqual(ids(index.search('周会')), ['m1']);
  assert.deepEqual(ids(index.search('会')), ['m1']);
  assert.deepEqual(ids(index.search('"周会"')), ['m1']);
  assert.deepEqual(ids(index.search('周 会')), ['m1']);
});

test('update 换内容，remove 之后查不到，倒排里也不留空壳', () => {
  const index = seeded();
  index.update({ id: 'd3', title: 'Nothing at all', body: '' });
  assert.deepEqual(ids(index.search('gamma')).sort(), ['d1', 'd2']);
  assert.deepEqual(ids(index.search('nothing')), ['d3']);
  index.remove('d3');
  assert.deepEqual(ids(index.search('nothing')), []);
  expectError(() => index.remove('d3'), 'ERR_UNKNOWN_DOC');
  assert.equal(index.get('d3'), null);
  assert.deepEqual(index.get('d1').title, 'Alpha Beta');
});

test('重复 id、缺 id、改不存在的文档', () => {
  const index = seeded();
  expectError(() => index.add({ id: 'd1', body: 'x' }), 'ERR_DUP_ID');
  expectError(() => index.add({ body: 'x' }), 'ERR_BAD_DOC');
  expectError(() => index.add({ id: '', body: 'x' }), 'ERR_BAD_DOC');
  expectError(() => index.update({ id: 'nope', body: 'x' }), 'ERR_UNKNOWN_DOC');
});

test('limit 和同分时的顺序', () => {
  const index = createIndex();
  index.add({ id: 'b', body: 'same words here' });
  index.add({ id: 'a', body: 'same words here' });
  index.add({ id: 'c', body: 'same words here too' });
  const out = index.search('same', { limit: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(ids(out), ['a', 'b']);
  assert.equal(out[0].score, out[1].score);
  assert.equal(index.search('same', { limit: null }).length, 3);
});

test('stats 数得对，删干净就归零', () => {
  const index = seeded();
  const stats = index.stats();
  assert.equal(stats.docs, 3);
  assert.equal(stats.tokens, 5 + 3 + 4);
  assert.equal(stats.terms, new Set(tokenize('alpha beta gamma news report nothing here').map((t) => t.term)).size);
  assert.equal(stats.postings > 0, true);
  index.remove('d1');
  index.remove('d2');
  index.remove('d3');
  assert.deepEqual(index.stats(), { docs: 0, terms: 0, postings: 0, tokens: 0 });
  assert.deepEqual(index.search('alpha'), []);
});

test('命中的文档带上每句的 tf 明细', () => {
  const index = seeded();
  const hit = index.search('beta').find((item) => item.id === 'd1');
  assert.deepEqual(hit.hits, [{ clause: 'beta', field: 'title,body,tags', tf: 2 }]);
});
