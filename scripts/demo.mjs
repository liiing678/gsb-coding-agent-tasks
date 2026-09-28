import { createZset } from '../lib/skipzset.js';

const line = (label, value) => console.log(`  ${label} ${value}`);

const zset = createZset();

console.log('skipzset demo');
line('add.fig', zset.add('fig', 1));
line('add.apple', zset.add('apple', 2));
line('add.pear', zset.add('pear', 2));
line('add.date', zset.add('date', 5));
line('again.pear', zset.add('pear', 2));
line('size', zset.size());
line('entries', JSON.stringify(zset.entries()));
line('range.0.-1', JSON.stringify(zset.range(0, -1)));
line('range.1.2', JSON.stringify(zset.range(1, 2)));
line('rank.pear', zset.rank('pear'));
line('revRank.pear', zset.revRank('pear'));
line('score.missing', String(zset.score('missing')));
line('byScore.2.5', JSON.stringify(zset.rangeByScore(2, 5)));
line('count.2.5', zset.countByScore(2, 5));
line('byLex.b.d', JSON.stringify(zset.rangeByLex('[b', '[d')));
line('byLex.afterCherry', JSON.stringify(zset.rangeByLex('(cherry', '+')));
line('remove.date', zset.remove('date'));
line('size.after', zset.size());

try {
  zset.add('', 1);
} catch (err) {
  line('badMember.code', err.code);
}

try {
  zset.rangeByLex('b', '+');
} catch (err) {
  line('badBound.code', err.code);
}