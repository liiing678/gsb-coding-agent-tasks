// 变长整数二进制编解码：口径见 README 的《口径》和《API》。

import { CodecError } from './errors.js';

export const WIRE_TYPES = {
  VARINT: 0,
  FIXED64: 1,
  BYTES: 2,
  FIXED32: 5,
};

const MAX_FIELD_ID = (1 << 29) - 1;
const UINT32_MAX = 0xffffffff;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

const KNOWN_WIRE_TYPES = new Set([
  WIRE_TYPES.VARINT,
  WIRE_TYPES.FIXED64,
  WIRE_TYPES.BYTES,
  WIRE_TYPES.FIXED32,
]);

const FIELD_WIRE_TYPE = {
  uint32: WIRE_TYPES.VARINT,
  int32: WIRE_TYPES.VARINT,
  bool: WIRE_TYPES.VARINT,
  string: WIRE_TYPES.BYTES,
  bytes: WIRE_TYPES.BYTES,
};
const FIELD_TYPES = new Set(Object.keys(FIELD_WIRE_TYPE));

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function validateSchema(schema) {
  if (!Array.isArray(schema)) {
    throw new CodecError('ERR_BAD_SCHEMA', 'schema 必须是字段数组');
  }
  const seenIds = new Set();
  const fields = [];
  for (const item of schema) {
    if (!isPlainObject(item)) {
      throw new CodecError('ERR_BAD_SCHEMA', 'schema 里的每条字段都得是对象');
    }
    const { id, name, type } = item;
    if (!Number.isInteger(id) || id < 1 || id > MAX_FIELD_ID) {
      throw new CodecError('ERR_BAD_SCHEMA', `字段 id 必须是 1..2^29-1 的整数：${String(id)}`);
    }
    if (seenIds.has(id)) {
      throw new CodecError('ERR_BAD_SCHEMA', `字段 id 重复：${id}`, { id });
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new CodecError('ERR_BAD_SCHEMA', `字段 ${id} 的 name 必须是非空字符串`);
    }
    if (!FIELD_TYPES.has(type)) {
      throw new CodecError('ERR_BAD_SCHEMA', `字段 ${name} 的 type 不认识：${String(type)}`, { name });
    }
    const repeated = item.repeated === undefined ? false : item.repeated;
    const required = item.required === undefined ? false : item.required;
    if (typeof repeated !== 'boolean' || typeof required !== 'boolean') {
      throw new CodecError('ERR_BAD_SCHEMA', `字段 ${name} 的 repeated / required 必须是布尔值`, { name });
    }
    if (repeated && required) {
      throw new CodecError('ERR_BAD_SCHEMA', `字段 ${name} 不能同时 repeated 和 required`, { name });
    }
    seenIds.add(id);
    fields.push({ id, name, type, repeated, required });
  }
  return fields;
}

function appendVarint(bytes, value) {
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
}

function readVarint(buffer, start) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const position = start + index;
    if (position >= buffer.length) {
      throw new CodecError('ERR_TRUNCATED', '变长整数读到一半没了');
    }
    const byte = buffer[position];
    if (index === 4 && (byte & 0x7f) > 0x0f) {
      throw new CodecError('ERR_VARINT_OVERFLOW', '变长整数的第 5 个字节超出了 32 位范围');
    }
    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, offset: position + 1 };
    }
  }
  throw new CodecError('ERR_VARINT_OVERFLOW', '变长整数超过 5 个字节');
}

function encodeField(field, value) {
  const wireType = FIELD_WIRE_TYPE[field.type];
  const head = [];
  appendVarint(head, (field.id << 3) | wireType);

  if (wireType === WIRE_TYPES.VARINT) {
    let number;
    if (field.type === 'uint32') {
      if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
        throw new CodecError('ERR_BAD_VALUE', `字段 ${field.name} 需要 0..2^32-1 的整数`, { name: field.name });
      }
      number = value;
    } else if (field.type === 'int32') {
      if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
        throw new CodecError('ERR_BAD_VALUE', `字段 ${field.name} 需要 32 位有符号整数`, { name: field.name });
      }
      number = ((value << 1) ^ (value >> 31)) >>> 0;
    } else {
      if (typeof value !== 'boolean') {
        throw new CodecError('ERR_BAD_VALUE', `字段 ${field.name} 需要布尔值`, { name: field.name });
      }
      number = value ? 1 : 0;
    }
    appendVarint(head, number);
    return Uint8Array.from(head);
  }

  let content;
  if (field.type === 'string') {
    if (typeof value !== 'string') {
      throw new CodecError('ERR_BAD_VALUE', `字段 ${field.name} 需要字符串`, { name: field.name });
    }
    content = utf8Encoder.encode(value);
  } else {
    if (!(value instanceof Uint8Array)) {
      throw new CodecError('ERR_BAD_VALUE', `字段 ${field.name} 需要 Uint8Array`, { name: field.name });
    }
    content = value;
  }
  appendVarint(head, content.length);
  const chunk = new Uint8Array(head.length + content.length);
  chunk.set(head, 0);
  chunk.set(content, head.length);
  return chunk;
}

export function createCodec(config = {}) {
  if (!isPlainObject(config)) {
    throw new CodecError('ERR_BAD_ARGS', 'createCodec 的配置得是对象');
  }
  const schema = validateSchema(config.schema);
  const fieldsById = new Map(schema.map((field) => [field.id, field]));

  function encode(message, options) {
    if (!isPlainObject(message)) {
      throw new CodecError('ERR_BAD_ARGS', 'encode 的消息得是普通对象');
    }

    let unknownEntries = [];
    if (options !== undefined) {
      if (!isPlainObject(options)) {
        throw new CodecError('ERR_BAD_ARGS', 'encode 的第二个参数得是对象');
      }
      if (options.unknownFields !== undefined) {
        if (!Array.isArray(options.unknownFields)) {
          throw new CodecError('ERR_BAD_ARGS', 'unknownFields 必须是数组');
        }
        for (const entry of options.unknownFields) {
          if (!isPlainObject(entry)
            || !Number.isInteger(entry.id)
            || entry.id < 1
            || entry.id > MAX_FIELD_ID
            || !KNOWN_WIRE_TYPES.has(entry.wireType)
            || !(entry.raw instanceof Uint8Array)) {
            throw new CodecError('ERR_BAD_ARGS', 'unknownFields 的每条都得是 { id, wireType, raw }');
          }
        }
        unknownEntries = options.unknownFields;
      }
    }

    const items = [];
    for (const field of schema) {
      const value = message[field.name];
      if (value === undefined || value === null) {
        if (field.required) {
          throw new CodecError('ERR_MISSING_REQUIRED', `必填字段 ${field.name} 没给`, {
            name: field.name,
            id: field.id,
          });
        }
        continue;
      }
      if (field.repeated) {
        if (!Array.isArray(value)) {
          throw new CodecError('ERR_BAD_VALUE', `字段 ${field.name} 是 repeated，值得是数组`, {
            name: field.name,
          });
        }
        for (const element of value) {
          if (element === undefined || element === null) continue;
          items.push({ id: field.id, bytes: encodeField(field, element) });
        }
      } else {
        items.push({ id: field.id, bytes: encodeField(field, value) });
      }
    }
    for (const entry of unknownEntries) {
      items.push({ id: entry.id, bytes: entry.raw });
    }
    items.sort((a, b) => a.id - b.id);

    const totalLength = items.reduce((sum, item) => sum + item.bytes.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const item of items) {
      output.set(item.bytes, offset);
      offset += item.bytes.length;
    }
    return output;
  }

  function decode(input) {
    if (!(input instanceof Uint8Array)) {
      throw new CodecError('ERR_BAD_ARGS', 'decode 的输入得是 Uint8Array');
    }

    const value = {};
    const unknownFields = [];
    let offset = 0;

    while (offset < input.length) {
      const segmentStart = offset;
      const keyRead = readVarint(input, offset);
      offset = keyRead.offset;
      const fieldNumber = keyRead.value >>> 3;
      const wireType = keyRead.value & 0x07;

      if (fieldNumber === 0 || !KNOWN_WIRE_TYPES.has(wireType)) {
        throw new CodecError(
          'ERR_BAD_WIRE_TYPE',
          `字段号或 wire type 不合法：field=${fieldNumber} wireType=${wireType}`,
          { field: fieldNumber, wireType },
        );
      }

      const field = fieldsById.get(fieldNumber);
      if (field && FIELD_WIRE_TYPE[field.type] !== wireType) {
        throw new CodecError(
          'ERR_BAD_WIRE_TYPE',
          `字段 ${field.name} 的 wireType 跟 schema 对不上：收到 ${wireType}`,
          { name: field.name, id: fieldNumber, wireType },
        );
      }

      let varintValue;
      let contentStart = 0;
      let contentEnd = 0;
      if (wireType === WIRE_TYPES.VARINT) {
        const payload = readVarint(input, offset);
        varintValue = payload.value;
        offset = payload.offset;
      } else if (wireType === WIRE_TYPES.FIXED64) {
        if (offset + 8 > input.length) {
          throw new CodecError('ERR_TRUNCATED', 'fixed64 载荷不够 8 个字节');
        }
        offset += 8;
      } else if (wireType === WIRE_TYPES.FIXED32) {
        if (offset + 4 > input.length) {
          throw new CodecError('ERR_TRUNCATED', 'fixed32 载荷不够 4 个字节');
        }
        offset += 4;
      } else {
        const lengthRead = readVarint(input, offset);
        offset = lengthRead.offset;
        contentStart = offset;
        contentEnd = offset + lengthRead.value;
        if (contentEnd > input.length) {
          throw new CodecError('ERR_TRUNCATED', 'length-delimited 载荷比剩下的字节长');
        }
        offset = contentEnd;
      }

      if (!field) {
        unknownFields.push({
          id: fieldNumber,
          wireType,
          raw: input.slice(segmentStart, offset),
        });
        continue;
      }

      let decoded;
      if (field.type === 'uint32') {
        decoded = varintValue;
      } else if (field.type === 'int32') {
        decoded = (varintValue >>> 1) ^ -(varintValue & 1);
      } else if (field.type === 'bool') {
        if (varintValue !== 0 && varintValue !== 1) {
          throw new CodecError('ERR_BAD_VALUE', `布尔字段 ${field.name} 只认 0 和 1`, {
            name: field.name,
          });
        }
        decoded = varintValue === 1;
      } else if (field.type === 'bytes') {
        decoded = input.slice(contentStart, contentEnd);
      } else {
        const bytes = input.slice(contentStart, contentEnd);
        try {
          decoded = utf8Decoder.decode(bytes);
        } catch {
          throw new CodecError('ERR_BAD_UTF8', `字符串字段 ${field.name} 不是合法 UTF-8`, {
            name: field.name,
          });
        }
      }

      if (field.repeated) {
        if (!Array.isArray(value[field.name])) value[field.name] = [];
        value[field.name].push(decoded);
      } else {
        value[field.name] = decoded;
      }
    }

    for (const field of schema) {
      if (field.required && !Object.hasOwn(value, field.name)) {
        throw new CodecError('ERR_MISSING_REQUIRED', `必填字段 ${field.name} 没出现`, {
          name: field.name,
          id: field.id,
        });
      }
    }

    return { value, unknownFields };
  }

  return {
    encode,
    decode,
    fields: () => schema.map((field) => ({ ...field })),
  };
}
