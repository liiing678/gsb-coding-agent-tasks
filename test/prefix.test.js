import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAddress, parseAddress, parsePrefix } from '../lib/cidrroute.js';
import { code } from './util.js';

test('IPv4 地址解析', () => {
  assert.deepEqual(parseAddress('10.1.2.3'), { family: 4, value: 0x0a010203n });
  assert.deepEqual(parseAddress('0.0.0.0'), { family: 4, value: 0n });
  assert.deepEqual(parseAddress('255.255.255.255'), { family: 4, value: 0xffffffffn });
  assert.equal(parseAddress('172.16.255.4').value, 0xac10ff04n);
});

test('IPv4 前缀解析与规范化', () => {
  assert.deepEqual(parsePrefix('10.1.0.0/16'), {
    family: 4, bits: 16, value: 0x0a010000n, text: '10.1.0.0/16',
  });
  assert.equal(parsePrefix('0.0.0.0/0').text, '0.0.0.0/0');
  assert.equal(parsePrefix('192.168.4.0/22').text, '192.168.4.0/22');
  assert.equal(parsePrefix('255.255.255.255/32').bits, 32);
});

test('IPv4 非法输入报 ERR_BAD_ADDRESS 或 ERR_BAD_PREFIX', () => {
  const badAddresses = [
    '10.1.2', '10.1.2.3.4', '010.1.2.3', '256.1.2.3', '10.1.2.-1',
    '', ' 10.1.2.3', '10.1.2.3 ', 'a.b.c.d', 42,
  ];
  for (const bad of badAddresses) {
    assert.equal(code(() => parseAddress(bad)), 'ERR_BAD_ADDRESS', String(bad));
  }
  const badPrefixes = [
    '10.1.2.3', '10.1.2.3/33', '10.1.2.3/16', '10.0.0.0/08', '10.0.0.0/-1',
    '10.0.0.0/16/8', 'x.y.z.w/8', '10.0.0.0/', '10.0.0.0/ 8', '300.0.0.0/8', '10.0.0.0',
  ];
  for (const bad of badPrefixes) {
    assert.equal(code(() => parsePrefix(bad)), 'ERR_BAD_PREFIX', bad);
  }
});

test('IPv6 解析与 RFC 5952 压缩', () => {
  assert.deepEqual(parseAddress('::'), { family: 6, value: 0n });
  assert.deepEqual(parseAddress('::1'), { family: 6, value: 1n });
  assert.equal(parseAddress('2001:DB8::1').value, 0x20010db8000000000000000000000001n);
  assert.equal(
    parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001').value,
    0x20010db8000000000000000000000001n,
  );
  assert.equal(formatAddress(6, 0x20010db8000000000000000000000001n), '2001:db8::1');
  assert.equal(formatAddress(6, 0n), '::');
  assert.equal(formatAddress(6, 1n), '::1');
  assert.equal(formatAddress(6, 0xffffffffffffffffffffffffffffffffn),
    'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
  assert.equal(formatAddress(6, 0x20010db8000100020000000000000003n), '2001:db8:1:2::3');
  assert.equal(formatAddress(4, 0x0a010203n), '10.1.2.3');
  assert.equal(formatAddress(4, 0n), '0.0.0.0');
});

test('IPv6 非法输入', () => {
  const badAddresses = [
    '2001:db8::1::2', '2001:db8:0:0:0:0:0', '2001:db8:0:0:0:0:0:1:2',
    '2001:db8::g', '::1.2.3.4', '2001:db8:::1', '1:2:3:4:5:6:7:8::', ':1:2',
  ];
  for (const bad of badAddresses) {
    assert.equal(code(() => parseAddress(bad)), 'ERR_BAD_ADDRESS', bad);
  }
  assert.equal(parseAddress('1:2:3:4:5:6:7::').value, 0x00010002000300040005000600070000n);
  assert.equal(parsePrefix('2001:0DB8:0000::/32').text, '2001:db8::/32');
  assert.equal(parsePrefix('2001:0DB8:0000::/32').bits, 32);
  assert.equal(code(() => parsePrefix('2001:db8::1/64')), 'ERR_BAD_PREFIX');
  assert.equal(code(() => parsePrefix('2001:db8::/129')), 'ERR_BAD_PREFIX');
});
