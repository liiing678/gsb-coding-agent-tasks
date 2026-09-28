// 点版本向量内核：时钟的规范化、比较、合并、缺哪些 dot，以及因果投递节点。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/vclock.test.js、test/delivery.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/vclock.js 还没实现，口径见 README 的《口径》和《API》';

export function empty() {
  throw new Error(NOT_IMPLEMENTED);
}

export function tick(clock, id) {
  void clock;
  void id;
  throw new Error(NOT_IMPLEMENTED);
}

export function merge(...clocks) {
  void clocks;
  throw new Error(NOT_IMPLEMENTED);
}

export function compare(left, right) {
  void left;
  void right;
  throw new Error(NOT_IMPLEMENTED);
}

export function dots(clock) {
  void clock;
  throw new Error(NOT_IMPLEMENTED);
}

export function contains(clock, dot) {
  void clock;
  void dot;
  throw new Error(NOT_IMPLEMENTED);
}

export function missing(clock, other) {
  void clock;
  void other;
  throw new Error(NOT_IMPLEMENTED);
}

export function createNode(id) {
  void id;
  throw new Error(NOT_IMPLEMENTED);
}
