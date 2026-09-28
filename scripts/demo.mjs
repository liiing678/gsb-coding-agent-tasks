import { compile } from '../lib/exprvm.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const show = (label, source, env, options) => {
  try {
    line(label, JSON.stringify(compile(source, options).run(env)));
  } catch (err) {
    line(label, err.code);
  }
};

console.log('exprvm demo');
show('arithmetic', '1 + 2 * 3');
line('assembly', JSON.stringify(compile('1 + 2 * 3').assembly));
line('unoptimized', JSON.stringify(compile('1 + 2 * 3', { optimize: false }).assembly));
show('strings', '"n=" + 42');
show('compare', '(1 < 2) == true');
show('shortCircuit', 'false && (1 / 0)');
show('env', 'a + b * 2', { a: 1, b: 3 });
show('ternary', '0 ? "on" : "off"');
show('typeError', '1 - "a"');
show('divideByZero', '1 / 0');
try {
  compile('1 +\n* 2');
} catch (err) {
  line('syntaxError', JSON.stringify({ code: err.code, ...err.details }));
}
