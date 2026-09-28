import test from 'node:test';
import assert from 'node:assert/strict';

import { compress, decompress, checksum, DEFAULTS } from '../lib/lzpack.js';
import { bytes, concat, hex, noisy, repeat } from './util.js';

const text = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(3));

test('空输入就是十二个字节的固定头', () => {
  const packed = compress(bytes());
  assert.equal(hex(packed), '4c 5a 50 31 00 00 00 00 c5 9d 1c 81');
  assert.deepEqual(decompress(packed), bytes());
  assert.equal(checksum(bytes()), 0x811c9dc5);
});

test('短输入全走字面量，标志位从最低位开始排', () => {
  assert.equal(hex(compress(bytes(0x41, 0x42))), '4c 5a 50 31 02 00 00 00 8a 21 d5 2c 03 41 42');
  // 只有四个字节，"ABA" 凑不满三字节的匹配，全是字面量
  assert.equal(hex(compress(bytes(0x41, 0x42, 0x41, 0x42))),
    '4c 5a 50 31 04 00 00 00 29 02 1c 9d 0f 41 42 41 42');
});

test('重复串走匹配，长度按 maxMatch 切开', () => {
  assert.equal(DEFAULTS.minMatch, 3);
  assert.equal(DEFAULTS.maxMatch, 18);
  assert.equal(DEFAULTS.window, 4096);
  // 1 个字面量 + 一个长度 18 的匹配 + 1 个字面量 = 20
  assert.equal(hex(compress(repeat(0x41, 20))),
    '4c 5a 50 31 14 00 00 00 49 98 61 61 05 41 00 f0 41');
  // 40 个字节：1 + 18 + 18 + 3，第三个匹配长度只有 3
  assert.equal(hex(compress(repeat(0x41, 40))),
    '4c 5a 50 31 28 00 00 00 8d 50 1a d0 01 41 00 f0 00 f0 00 00');
  // 100 个字节：1 + 18*5 + 9
  assert.equal(hex(compress(repeat(0x41, 100))),
    '4c 5a 50 31 64 00 00 00 d9 52 92 5e 01 41 00 f0 00 f0 00 f0 00 f0 00 f0 00 60');
});

test('匹配长度相同的时候取离得近的那个', () => {
  // "ABQ" 出现两次、后面接的长度一样，只能挑离得近的：距离 3 的那个
  const data = new TextEncoder().encode('ABQABQABQ');
  assert.equal(hex(compress(data)),
    '4c 5a 50 31 09 00 00 00 d1 0d 70 ac 07 41 42 51 02 30');
  assert.deepEqual([...decompress(compress(data))], [...data]);
});

test('窗口是 4096：正好 4096 还能匹配，再远就只能当字面量', () => {
  const pad = noisy(4096);
  const near = concat(pad, pad.subarray(0, 3));
  const far = concat(pad, bytes(0x00), pad.subarray(0, 3));
  assert.equal(compress(near).length, 4621);
  assert.equal(compress(far).length, 4624);
  assert.deepEqual(decompress(compress(near)), near);
  assert.deepEqual(decompress(compress(far)), far);
});

test('大块重复能压得很小', () => {
  const flat = repeat(0x7a, 4096);
  const packed = compress(flat);
  assert.ok(packed.length < 800, `4096 个一样的字节压出来只有 ${packed.length} 字节`);
  assert.deepEqual(decompress(packed), flat);
});

test('同一份输入压出来必须一模一样', () => {
  const data = concat(text, noisy(600, 7), text);
  assert.deepEqual(compress(data), compress(data));
  assert.notDeepEqual(compress(data), compress(concat(text, noisy(600, 8), text)));
});

test('文字、混排与随机数据都能原样绕回来', () => {
  const samples = [
    text,
    concat(text, text),
    noisy(1500, 3),
    concat(noisy(300, 5), repeat(9, 200), noisy(300, 6)),
    bytes(...Array.from({ length: 256 }, (_, index) => index)),
  ];
  for (const sample of samples) {
    const back = decompress(compress(sample));
    assert.equal(back.length, sample.length);
    assert.deepEqual([...back], [...sample]);
  }
});
