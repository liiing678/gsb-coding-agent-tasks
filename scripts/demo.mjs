import { mergeThreeWay } from '../lib/merge.js';
import { joinLines } from '../lib/lines.js';

const text = (...lines) => joinLines(lines);
const block = (label, value) => {
  console.log(`    ${label}`);
  for (const line of value.split('\n')) console.log(`      | ${line}`);
};
const summary = (out) => {
  const s = out.stats;
  console.log(
    `    clean=${out.clean} segments=${s.segments} conflicts=${s.conflicts} ` +
      `added=${s.addedLines} removed=${s.removedLines}`,
  );
};

console.log('mergeline demo');

console.log('[1] 两边改了不同的行，干净合进来');
const one = mergeThreeWay(
  text('server', 'port=8080', 'log level=info', 'done'),
  text('server', 'port=9090', 'log level=info', 'done'),
  text('server', 'port=8080', 'log level=info', 'done (shutdown)'),
);
block('text', one.text);
summary(one);

console.log('[2] 同一行两边各改各的，按 diff3 标出来');
const two = mergeThreeWay(
  text('server', 'port=8080', 'done'),
  text('server', 'port=9090', 'done'),
  text('server', 'port=7070', 'done'),
);
block('text', two.text);
summary(two);
console.log(`    conflict #${two.conflicts[0].index} 在第 ${two.conflicts[0].outputLine} 行开标记`);

console.log('[3] 一边删一边改，被删的那行留在 base 段里');
const three = mergeThreeWay(
  text('x', 'y', 'z'),
  text('x', 'z'),
  text('x', 'y!', 'z'),
);
block('text', three.text);
summary(three);

console.log('[4] 换成 union，冲突段的两个版本都留着');
const four = mergeThreeWay(
  text('a', 'x', 'y'),
  text('a', 'X', 'y'),
  text('a', 'XX', 'y'),
  { conflictStyle: 'union' },
);
block('text', four.text);
summary(four);

console.log('[5] 一万两千行里隔得很远的两处改动');
const lines = Array.from({ length: 12000 }, (_, i) => `line-${i}`);
const ours = [...lines];
const theirs = [...lines];
ours[3000] = 'line-3000-ours';
theirs[9000] = 'line-9000-theirs';
const five = mergeThreeWay(joinLines(lines), joinLines(ours), joinLines(theirs));
console.log(`    lines=${five.text.split('\n').length}`);
summary(five);
