import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex } from '../lib/index.js';

function seeded() {
  const index = createIndex();
  index.add({ id: 'd1', title: 'Alpha Beta', body: 'beta gamma', tags: ['news'] });
  index.add({ id: 'd2', title: 'Beta', body: 'alpha gamma' });
  return index;
}

test('快照搬过去之后，查询结果和统计都一样', () => {
  const index = seeded();
  const before = index.search('beta');
  const state = JSON.parse(JSON.stringify(index.snapshot()));
  const revived = createIndex();
  assert.deepEqual(revived.restore(state), { docs: 2 });
  assert.deepEqual(revived.search('beta'), before);
  assert.deepEqual(revived.stats(), index.stats());
  assert.equal(revived.get('d1').tags, 'news');
  revived.add({ id: 'd3', body: 'beta' });
  assert.equal(revived.search('beta').length, 3);
  assert.equal(index.search('beta').length, 2);
});

test('快照版本不对就报错', () => {
  const index = createIndex();
  let code = '';
  try {
    index.restore({ version: 7 });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, 'ERR_BAD_SNAPSHOT');
});
