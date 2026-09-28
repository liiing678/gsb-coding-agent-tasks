// 切行 / 拼行。行尾的 \r 在比较时当作不存在（CRLF 和 LF 当成同一行），
// 输出统一用 \n 拼。末尾换行会产生最后一个空行，那也算一行。
export function splitLines(text) {
  if (typeof text !== 'string') throw new TypeError('splitLines 只接受字符串');
  if (text === '') return [];
  return text.split('\n').map(stripCr);
}

export function joinLines(lines) {
  return lines.join('\n');
}

export function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export function sameLines(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}
