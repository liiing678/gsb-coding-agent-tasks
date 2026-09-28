// 有序集合内核：按（分数升序，成员升序）排队，外加名次与几种区间查询。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/zset.test.js、test/query.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/skipzset.js 还没实现，口径见 README 的《口径》和《API》';

export class Zset {
  add(member, score) {
    void member;
    void score;
    throw new Error(NOT_IMPLEMENTED);
  }

  remove(member) {
    void member;
    throw new Error(NOT_IMPLEMENTED);
  }

  score(member) {
    void member;
    throw new Error(NOT_IMPLEMENTED);
  }

  size() {
    throw new Error(NOT_IMPLEMENTED);
  }

  clear() {
    throw new Error(NOT_IMPLEMENTED);
  }

  rank(member) {
    void member;
    throw new Error(NOT_IMPLEMENTED);
  }

  revRank(member) {
    void member;
    throw new Error(NOT_IMPLEMENTED);
  }

  range(start, stop) {
    void start;
    void stop;
    throw new Error(NOT_IMPLEMENTED);
  }

  rangeByScore(min, max) {
    void min;
    void max;
    throw new Error(NOT_IMPLEMENTED);
  }

  countByScore(min, max) {
    void min;
    void max;
    throw new Error(NOT_IMPLEMENTED);
  }

  rangeByLex(min, max) {
    void min;
    void max;
    throw new Error(NOT_IMPLEMENTED);
  }

  entries() {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export function createZset() {
  return new Zset();
}