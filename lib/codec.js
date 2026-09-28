// 日志帧的编解码：一帧 = 4 字节长度 + 4 字节 crc32 + 1 字节类型 + 负载（JSON）。
// 这里只负责"一段字节能不能算一帧"，帧是什么意思要看 lib/store.js。

const TYPE_IDS = { PUT: 1, DEL: 2, COMMIT: 3, SNAPSHOT: 4 };
const TYPE_NAMES = { 1: 'PUT', 2: 'DEL', 3: 'COMMIT', 4: 'SNAPSHOT' };
export const HEADER_BYTES = 9;

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFrame(type, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt32BE(crc32(payload), 4);
  header.writeUInt8(TYPE_IDS[type], 8);
  return Buffer.concat([header, payload]);
}

// 从头往后读，读到一半断了 / 校验不过就停在那一帧之前，把原因说出来。
// 返回的 end 是"能安全保留的字节数"。
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  let reason = 'clean';
  while (offset < buffer.length) {
    if (buffer.length - offset < HEADER_BYTES) {
      reason = 'torn';
      break;
    }
    const length = buffer.readUInt32BE(offset);
    const checksum = buffer.readUInt32BE(offset + 4);
    const typeId = buffer.readUInt8(offset + 8);
    const name = TYPE_NAMES[typeId];
    if (!name) {
      reason = 'bad-frame';
      break;
    }
    if (buffer.length - offset - HEADER_BYTES < length) {
      reason = 'torn';
      break;
    }
    const payload = buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
    if (crc32(payload) !== checksum) {
      reason = 'bad-crc';
      break;
    }
    frames.push({
      type: name,
      body: JSON.parse(payload.toString('utf8')),
      start: offset,
      end: offset + HEADER_BYTES + length,
    });
    offset += HEADER_BYTES + length;
  }
  return { frames, end: offset, reason };
}
