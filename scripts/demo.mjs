import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSorter, DEFAULTS } from '../lib/extmerge.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extmerge-demo-'));
const sorter = createSorter({
  compare: (left, right) => left.key - right.key,
  maxInMemory: 8,
  fanIn: 3,
  spillDir: dir,
});

for (const key of [5, 3, 9, 1, 7, 2, 8, 4, 6, 0,
  15, 13, 19, 11, 17, 12, 18, 14, 16, 10,
  25, 23, 29, 21, 27, 22, 28, 24, 26, 20]) {
  sorter.push({ key, tag: `#${key}` });
}

console.log('extmerge demo');
console.log(`  defaults maxInMemory=${DEFAULTS.maxInMemory} fanIn=${DEFAULTS.fanIn}`);
console.log(`  runs on disk ${fs.readdirSync(dir).sort().join(' ')}`);
console.log(`  head of run-0001 ${fs.readFileSync(path.join(dir, 'run-0001.jsonl'), 'utf8').split('\n')[0]}`);

const back = sorter.finish();
console.log(`  sorted ${back.map((one) => one.key).join(' ')}`);
console.log(`  marks ${back.slice(0, 3).map((one) => one.tag).join(' ')}`);
console.log(`  stats ${JSON.stringify(sorter.stats())}`);
console.log(`  left on disk ${fs.readdirSync(dir).length}`);

fs.rmSync(dir, { recursive: true, force: true });
