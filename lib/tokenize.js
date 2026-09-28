// 分词：连续的字母数字算一个词，中日韩字符一个字一个词，别的都是分隔符。
// 位置是每个字段内部从 0 开始数的词序，短语查询靠它。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u3040-\u30ff]/;
const WORD = /[a-z0-9_]/;

export function tokenize(text) {
  const chars = [...String(text ?? '')].map((ch) => ch.toLowerCase());
  const out = [];
  let position = 0;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (CJK.test(ch)) {
      out.push({ term: ch, position: position++ });
      i += 1;
      continue;
    }
    if (WORD.test(ch)) {
      let j = i;
      while (j < chars.length && WORD.test(chars[j])) j += 1;
      out.push({ term: chars.slice(i, j).join(''), position: position++ });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}
