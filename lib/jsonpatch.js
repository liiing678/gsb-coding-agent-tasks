// JSON 指针、patch、merge patch、diff 与反向 patch。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/pointer.test.js、test/patch.test.js、
// test/diff.test.js）、演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README
// 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/jsonpatch.js 还没实现，口径见 README 的《口径》和《API》';

export function parsePointer(text) {
  void text;
  throw new Error(NOT_IMPLEMENTED);
}

export function formatPointer(tokens) {
  void tokens;
  throw new Error(NOT_IMPLEMENTED);
}

export function get(doc, pointer) {
  void doc;
  void pointer;
  throw new Error(NOT_IMPLEMENTED);
}

export function apply(doc, patch) {
  void doc;
  void patch;
  throw new Error(NOT_IMPLEMENTED);
}

export function diff(left, right) {
  void left;
  void right;
  throw new Error(NOT_IMPLEMENTED);
}

export function mergePatch(target, patchDoc) {
  void target;
  void patchDoc;
  throw new Error(NOT_IMPLEMENTED);
}

export function invert(patch, doc) {
  void patch;
  void doc;
  throw new Error(NOT_IMPLEMENTED);
}

export function equals(left, right) {
  void left;
  void right;
  throw new Error(NOT_IMPLEMENTED);
}
