import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable, parseAddress, parsePrefix } from '../lib/cidrroute.js';
import { code, prefixes, table } from './util.js';

test('insert / exact / has / size', () => {
  const t = createTable();
  assert.equal(t.size(), 0);
  assert.deepEqual(t.insert('10.0.0.0/8', 'a'), { prefix: '10.0.0.0/8', replaced: false });
  assert.deepEqual(t.insert('10.0.0.0/8', 'b'), { prefix: '10.0.0.0/8', replaced: true });
  assert.deepEqual(t.exact('10.0.0.0/8'), { prefix: '10.0.0.0/8', value: 'b' });
  assert.equal(t.exact('10.0.0.0/16'), null);
  assert.equal(t.has('10.0.0.0/8'), true);
  assert.equal(t.has('10.0.0.0/16'), false);
  assert.equal(t.size(), 1);

  const parsed = parsePrefix('2001:db8::/32');
  assert.deepEqual(t.insert(parsed, null), { prefix: '2001:db8::/32', replaced: false });
  assert.deepEqual(t.exact(parsed), { prefix: '2001:db8::/32', value: null });
  assert.equal(t.size(), 2);

  assert.equal(code(() => t.insert('10.0.0.0/8')), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => t.insert(42, 'x')), 'ERR_BAD_PREFIX');
  assert.equal(code(() => t.exact({ family: 4, bits: 8, value: 1 })), 'ERR_BAD_PREFIX');
});

test('最长前缀匹配：更具体的赢，没命中就 null', () => {
  const t = table([
    ['0.0.0.0/0', 'default'], ['10.0.0.0/8', 'eight'],
    ['10.1.0.0/16', 'sixteen'], ['10.1.4.0/22', 'twentytwo'],
  ]);
  assert.deepEqual(t.lookup('10.1.4.9'), { prefix: '10.1.4.0/22', value: 'twentytwo' });
  assert.deepEqual(t.lookup('10.1.6.9'), { prefix: '10.1.4.0/22', value: 'twentytwo' });
  assert.deepEqual(t.lookup('10.1.9.9'), { prefix: '10.1.0.0/16', value: 'sixteen' });
  assert.deepEqual(t.lookup('10.9.0.1'), { prefix: '10.0.0.0/8', value: 'eight' });
  assert.deepEqual(t.lookup('172.16.0.1'), { prefix: '0.0.0.0/0', value: 'default' });
  assert.equal(createTable().lookup('10.0.0.1'), null);
  assert.equal(code(() => t.lookup('10.0.0')), 'ERR_BAD_ADDRESS');
  assert.equal(code(() => t.lookup(42)), 'ERR_BAD_ADDRESS');
});

test('entries 按家族、地址、长度排序', () => {
  const t = table([
    ['10.1.0.0/16', 'b'], ['10.0.0.0/8', 'a'], ['192.168.0.0/16', 'c'],
    ['10.0.0.0/12', 'd'], ['2001:db8::/32', 'v6'], ['::/0', 'v6default'],
  ]);
  assert.deepEqual(t.entries(), [
    { prefix: '10.0.0.0/8', value: 'a' },
    { prefix: '10.0.0.0/12', value: 'd' },
    { prefix: '10.1.0.0/16', value: 'b' },
    { prefix: '192.168.0.0/16', value: 'c' },
    { prefix: '::/0', value: 'v6default' },
    { prefix: '2001:db8::/32', value: 'v6' },
  ]);
});

test('remove 之后回落到上一层，摘空的前缀会被剪掉', () => {
  const t = table([['10.0.0.0/8', 'eight'], ['10.1.0.0/16', 'sixteen']]);
  assert.deepEqual(t.lookup('10.1.2.3'), { prefix: '10.1.0.0/16', value: 'sixteen' });
  assert.equal(t.remove('10.1.0.0/16'), true);
  assert.equal(t.remove('10.1.0.0/16'), false);
  assert.deepEqual(t.lookup('10.1.2.3'), { prefix: '10.0.0.0/8', value: 'eight' });
  assert.equal(t.exact('10.1.0.0/16'), null);
  assert.equal(t.size(), 1);
  assert.equal(t.remove('0.0.0.0/0'), false);
  assert.equal(code(() => t.remove('bad/8')), 'ERR_BAD_PREFIX');

  assert.equal(t.remove('10.0.0.0/8'), true);
  assert.equal(t.size(), 0);
  assert.equal(t.lookup('10.1.2.3'), null);
  assert.deepEqual(t.insert('10.0.0.0/8', 'again'), { prefix: '10.0.0.0/8', replaced: false });
  assert.equal(t.size(), 1);
});

test('aggregate 把同值的兄弟前缀合并，并一直合到不能再合', () => {
  const t = table([
    ['10.0.0.0/10', { via: 'east' }], ['10.64.0.0/10', { via: 'east' }],
    ['10.128.0.0/9', { via: 'east' }], ['192.168.0.0/16', { via: 'west' }],
  ]);
  assert.equal(t.size(), 4);
  assert.equal(t.aggregate(), 2);
  assert.deepEqual(prefixes(t), ['10.0.0.0/8', '192.168.0.0/16']);
  assert.deepEqual(t.lookup('10.99.0.1'), { prefix: '10.0.0.0/8', value: { via: 'east' } });
  assert.equal(t.aggregate(), 0);
  assert.deepEqual(prefixes(t), ['10.0.0.0/8', '192.168.0.0/16']);
});

test('aggregate 遇到值不同、有更深条目、或父条目值不同就不动', () => {
  const differing = table([['10.0.0.0/9', 'a'], ['10.128.0.0/9', 'b']]);
  assert.equal(differing.aggregate(), 0);
  assert.equal(differing.size(), 2);

  const deeper = table([
    ['10.0.0.0/9', 'a'], ['10.128.0.0/9', 'a'], ['10.64.0.0/10', 'a'],
  ]);
  assert.equal(deeper.aggregate(), 0);
  assert.equal(deeper.size(), 3);

  const blocked = table([
    ['10.0.0.0/8', 'other'], ['10.0.0.0/9', 'a'], ['10.128.0.0/9', 'a'],
  ]);
  assert.equal(blocked.aggregate(), 0);
  assert.equal(blocked.size(), 3);
  assert.deepEqual(blocked.exact('10.0.0.0/8'), { prefix: '10.0.0.0/8', value: 'other' });
});

test('值按结构比较：键序不同也算相等，合并成父前缀', () => {
  const t = table([
    ['10.0.0.0/9', { a: 1, b: [2, 3] }], ['10.128.0.0/9', { b: [2, 3], a: 1 }],
  ]);
  assert.equal(t.aggregate(), 1);
  assert.deepEqual(prefixes(t), ['10.0.0.0/8']);
  assert.deepEqual(t.lookup('10.1.2.3').value, { a: 1, b: [2, 3] });

  const different = table([['10.0.0.0/9', [1, 2]], ['10.128.0.0/9', [2, 1]]]);
  assert.equal(different.aggregate(), 0);
  assert.equal(different.size(), 2);
});

test('两族互不干扰，非法参数各报各的码', () => {
  const t = table([['10.0.0.0/8', 'v4'], ['2001:db8::/32', 'v6'], ['::/0', 'v6any']]);
  assert.equal(t.size(), 3);
  assert.equal(t.lookup('2001:db8:1::1').prefix, '2001:db8::/32');
  assert.equal(t.lookup('2001:db9::1').prefix, '::/0');
  assert.equal(t.lookup('10.1.1.1').prefix, '10.0.0.0/8');
  assert.equal(t.exact('::/0').value, 'v6any');
  assert.equal(t.lookup('::ffff:1:2').prefix, '::/0');
  assert.equal(t.remove('10.0.0.0/8'), true);
  assert.equal(t.size(), 2);
  assert.equal(code(() => t.lookup('nope')), 'ERR_BAD_ADDRESS');
  assert.equal(code(() => createTable().insert('10.0.0.0/8', undefined)), 'ERR_BAD_ARGUMENT');
});
