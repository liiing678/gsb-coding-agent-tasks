import { createMap } from '../lib/avlmap.js';

const line = (label, value) => console.log(`  ${label} ${value}`);

console.log('avlmap demo');

const map = createMap();
for (const key of [5, 3, 8, 1, 4, 7, 9, 2, 6, 10]) map.set(key, `v${key}`);
line('size', map.size());
line('height', map.height());
line('entries', JSON.stringify(map.entries()));
line('min', JSON.stringify(map.min()));
line('max', JSON.stringify(map.max()));
line('at.3', JSON.stringify(map.at(3)));
line('indexOf.7', map.indexOf(7));
line('indexOf.99', map.indexOf(99));
line('range.3.7', JSON.stringify(map.range(3, 7)));
line('remove.5', map.remove(5));
line('remove.5.again', map.remove(5));
line('size.after', map.size());
line('height.after', map.height());

const increasing = createMap();
for (let key = 1; key <= 4096; key += 1) increasing.set(key, key);
line('increasing.height', increasing.height());
line('increasing.stats', JSON.stringify(increasing.stats()));

try {
  map.get('1');
} catch (err) {
  line('badKey.code', err.code);
}