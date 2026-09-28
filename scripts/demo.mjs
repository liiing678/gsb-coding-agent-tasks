import { createIndex } from '../lib/typemap.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const index = createIndex([['cat', 5], ['car', 3], ['card', 9], ['dog', 1], ['do', 2], 'dot']);

console.log('typemap demo');
line('stats', JSON.stringify(index.stats()));
line('prefix-c', JSON.stringify(index.prefix('c', 3)));
line('prefix-car', JSON.stringify(index.prefix('car', 3)));
line('prefix-z', JSON.stringify(index.prefix('z')));
line('top-2', JSON.stringify(index.top(2)));
line('fuzzy-cot-2', JSON.stringify(index.fuzzy('cot', 2, 3)));
line('fuzzy-cat-0', JSON.stringify(index.fuzzy('cat', 0, 5)));
line('remove-card', index.remove('card'));
line('after-remove', JSON.stringify(index.prefix('ca', 5)));
line('stats', JSON.stringify(index.stats()));
line('reinsert-card', index.insert('card', 9));
line('stats', JSON.stringify(index.stats()));
try {
  index.fuzzy('cat', 2, 5, { maxVisits: 2 });
} catch (err) {
  line('budget', `${err.code} ${JSON.stringify(err.details)}`);
}
