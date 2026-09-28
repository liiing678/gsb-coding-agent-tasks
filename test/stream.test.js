import test from 'node:test';
import assert from 'node:assert/strict';

import { createScanner } from '../lib/matchgrid.js';
import { code, fmt } from './util.js';

test('跨块的匹配等到结尾那一块才报', () => {
  const scanner = createScanner(['abc']);
  assert.deepEqual(scanner.push('ab'), []);
  assert.deepEqual(scanner.push('c').map(fmt), ['abc@0+3']);
  assert.deepEqual(scanner.state(),
    { fed: 3, pending: 0, total: 1, truncated: false, closed: false });
});

test('代理对被切成两半也只算一个字符', () => {
  const scanner = createScanner(['😀', 'a😀']);
  assert.deepEqual(scanner.push('a\uD83D'), []);
  assert.deepEqual(scanner.push('\uDE00').map(fmt), ['a😀@0+2', '😀@1+1']);
  assert.equal(scanner.state().fed, 2);
  assert.equal(scanner.state().pending, 0);
});

test('跨块的位置接着数，all() 按报出来的顺序拼', () => {
  const scanner = createScanner(['ab', 'b']);
  assert.deepEqual(scanner.push('xa'), []);
  const second = scanner.push('bxab');
  assert.deepEqual(second.map(fmt), ['ab@1+2', 'b@2+1', 'ab@4+2', 'b@5+1']);
  assert.deepEqual(scanner.all().map(fmt), second.map(fmt));
  assert.equal(scanner.state().fed, 6);
  assert.equal(scanner.state().total, 4);
});

test('pending 是还悬着的尾巴长度，封口之后再 push 就报错', () => {
  const scanner = createScanner(['abcd', 'bc']);
  scanner.push('xab');
  assert.deepEqual(scanner.state(),
    { fed: 3, pending: 2, total: 0, truncated: false, closed: false });
  const ended = scanner.end();
  assert.deepEqual(ended, { fed: 3, pending: 2, total: 0, truncated: false, closed: true });
  assert.equal(code(() => scanner.push('c')), 'ERR_STREAM_CLOSED');
  assert.deepEqual(scanner.end(), ended);
});

test('maxMatches 在流里也管用，跨块算总数', () => {
  const scanner = createScanner(['a'], { maxMatches: 2 });
  assert.deepEqual(scanner.push('aa').map(fmt), ['a@0+1', 'a@1+1']);
  assert.deepEqual(scanner.push('a'), []);
  const state = scanner.state();
  assert.equal(state.total, 2);
  assert.equal(state.truncated, true);
  assert.deepEqual(scanner.all().map(fmt), ['a@0+1', 'a@1+1']);
});

test('扫描器的模式和块参数也各有各的码', () => {
  assert.equal(code(() => createScanner(['ab', 'aB'], { ignoreCase: true })), 'ERR_BAD_PATTERNS');
  const scanner = createScanner(['ab']);
  assert.equal(code(() => scanner.push(null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => scanner.push(['a'])), 'ERR_BAD_ARGS');
});
