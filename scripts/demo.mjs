import { clip, displayWidth, wrap } from '../lib/wrapfold.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const show = (label, result) => {
  line(label, `overflow=${result.overflow}`);
  for (const item of result.lines) {
    console.log(`    ${JSON.stringify(item.text)} ${item.width}`);
  }
};

console.log('wrapfold demo');
line('width', `中文 abc=${displayWidth('中文 abc')} a+组合=${displayWidth('a\u0301')}`);

show('english', wrap('the quick brown fox jumps', { width: 10 }));
show('cjk', wrap('折行的时候汉字之间可以断开', { width: 8 }));
show('forbidden', wrap('abcd ，efg', { width: 9 }));
show('indent', wrap('the quick brown fox', { width: 12, indent: '>>', hangingIndent: '>>>>' }));
show('long', wrap('supercalifragilistic', { width: 6 }));
show('hard', wrap('supercalifragilistic', { width: 6, breakLongWords: true }));

line('clip', JSON.stringify(clip('这是一句很长的话', 7)));
