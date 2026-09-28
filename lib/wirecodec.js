// 变长整数二进制编解码。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/encode.test.js、test/decode.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { CodecError } from './errors.js';

export const WIRE_TYPES = {
  VARINT: 0,
  FIXED64: 1,
  BYTES: 2,
  FIXED32: 5,
};

const MAX_FIELD_ID = (1 << 29) - 1;
const MAX_UINT32 = 0xffffffff;
const MIN_INT32 = -0x80000000;
const MAX_INT32 = 0x7fffffff;

const FIELD_TYPES = new Set(['uint32', 'int32', 'bool', 'string', 'bytes']);
const WIRE_TYPE_OF = {
  uint32: WIRE_TYPES.VARINT,
  int32: WIRE_TYPES.VARINT,
  bool: WIRE_TYPES.VARINT,
  string: WIRE_TYPES.BYTES,
  bytes: WIRE_TYPES.BYTES,
};
const LEGACY_WIRE_TYPES = new Set([
  WIRE_TYPES.VARINT,
  WIRE_TYPES.FIXED64,
  WIRE_TYPES.BYTES,
  WIRE_TYPES.FIXED32,
]);

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const fail = (code, message, details) => {
  throw new CodecError(code, message, details);
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFieldId = (value) =>
  Number.isInteger(value) && value >= 1 && value <= MAX_FIELD_ID;

function writeVarint(bytes, value) {
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
}

function readVarint(buf, pos) {
  let result = 0;
  for (let count = 0; ; count += 1) {
    if (pos >= buf.length) {
      fail('ERR_TRUNCATED', '变长整数还没收尾就到末尾了');
    }
    const byte = buf[pos];
    pos += 1;
    if (count === 4) {
      if ((byte & 0x80) !== 0 || byte > 0x0f) {
        fail('ERR_VARINT_OVERFLOW', '变长整数超出 32 位范围');
      }
      return { value: (result | (byte << 28)) >>> 0, pos };
    }
    result |= (byte & 0x7f) << (count * 7);
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, pos };
    }
  }
}

function validateSchema(schema) {
  if (!Array.isArray(schema)) {
    fail('ERR_BAD_SCHEMA', 'schema 必须是字段数组');
  }
  const seenIds = new Set();
  return schema.map((raw) => {
    if (!isPlainObject(raw)) {
      fail('ERR_BAD_SCHEMA', 'schema 里的每条字段都得是对象');
    }
    if (!isFieldId(raw.id)) {
      fail('ERR_BAD_SCHEMA', `字段 id 不合法：${String(raw.id)}`);
    }
    if (seenIds.has(raw.id)) {
      fail('ERR_BAD_SCHEMA', `字段 id 重复：${raw.id}`);
    }
    seenIds.add(raw.id);
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
      fail('ERR_BAD_SCHEMA', `字段 ${raw.id} 的 name 必须是非空字符串`);
    }
    if (!FIELD_TYPES.has(raw.type)) {
      fail('ERR_BAD_SCHEMA', `字段 ${raw.name} 的 type 不认识：${String(raw.type)}`);
    }
    const repeated = raw.repeated === undefined ? false : raw.repeated;
    const required = raw.required === undefined ? false : raw.required;
    if (typeof repeated !== 'boolean' || typeof required !== 'boolean') {
      fail('ERR_BAD_SCHEMA', `字段 ${raw.name} 的 repeated / required 必须是布尔`);
    }
    if (repeated && required) {
      fail('ERR_BAD_SCHEMA', `字段 ${raw.name} 不能同时 repeated 和 required`);
    }
    return {
      id: raw.id,
      name: raw.name,
      type: raw.type,
      wireType: WIRE_TYPE_OF[raw.type],
      repeated,
      required,
    };
  });
}

const validateScalar = (field, value) => {
  switch (field.type) {
    case 'uint32':
      if (typeof value !== 'number' || !Number.isInteger(value)
        || value < 0 || value > MAX_UINT32) {
        fail('ERR_BAD_VALUE', `${field.name} 必须是 0..2^32-1 的整数`);
      }
      return value;
    case 'int32':
      if (typeof value !== 'number' || !Number.isInteger(value)
        || value < MIN_INT32 || value > MAX_INT32) {
        fail('ERR_BAD_VALUE', `${field.name} 必须是 32 位有符号整数`);
      }
      return ((value << 1) ^ (value >> 31)) >>> 0;
    case 'bool':
      if (typeof value !== 'boolean') {
        fail('ERR_BAD_VALUE', `${field.name} 必须是布尔值`);
      }
      return value ? 1 : 0;
    case 'string':
      if (typeof value !== 'string') {
        fail('ERR_BAD_VALUE', `${field.name} 必须是字符串`);
      }
      return null;
    case 'bytes':
      if (!(value instanceof Uint8Array)) {
        fail('ERR_BAD_VALUE', `${field.name} 必须是 Uint8Array`);
      }
      return null;
    default:
      fail('ERR_BAD_VALUE', `${field.name} 的类型不支持`);
  }
};

const appendPayload = (chunks, field, value) => {
  const head = [];
  writeVarint(head, (field.id << 3) | field.wireType);
  if (field.wireType === WIRE_TYPES.VARINT) {
    writeVarint(head, validateScalar(field, value));
    chunks.push(Uint8Array.from(head));
    return;
  }
  let content;
  if (field.type === 'string') {
    validateScalar(field, value);
    content = new TextEncoder().encode(value);
  } else {
    validateScalar(field, value);
    content = value;
  }
  writeVarint(head, content.length);
  chunks.push(Uint8Array.from(head), content);
};

export function createCodec(config = {}) {
  if (!isPlainObject(config)) {
    fail('ERR_BAD_ARGS', 'createCodec 的配置必须是对象');
  }
  const fields = validateSchema(config.schema);
  const byId = new Map(fields.map((field) => [field.id, field]));

  const validateUnknownEntries = (options) => {
    if (options === undefined) {
      return [];
    }
    if (!isPlainObject(options) || (options.unknownFields !== undefined
      && !Array.isArray(options.unknownFields))) {
      fail('ERR_BAD_ARGS', 'encode 的第二个参数必须是 { unknownFields }');
    }
    const entries = options.unknownFields ?? [];
    for (const entry of entries) {
      if (!isPlainObject(entry) || !isFieldId(entry.id)
        || !LEGACY_WIRE_TYPES.has(entry.wireType)
        || !(entry.raw instanceof Uint8Array) || entry.raw.length === 0) {
        fail('ERR_BAD_ARGS', 'unknownFields 里的条目必须是 { id, wireType, raw }');
      }
    }
    return entries;
  };

  const encode = (message, options) => {
    if (!isPlainObject(message)) {
      fail('ERR_BAD_ARGS', 'encode 的消息必须是普通对象');
    }
    const unknownEntries = validateUnknownEntries(options);

    for (const field of fields) {
      const given = message[field.name];
      if ((given === undefined || given === null) && field.required) {
        fail('ERR_MISSING_REQUIRED', `必填字段 ${field.name} 没给`,
          { name: field.name, id: field.id });
      }
    }

    const parts = [];
    for (const field of fields) {
      const value = message[field.name];
      if (value === undefined || value === null) {
        continue;
      }
      if (field.repeated) {
        if (!Array.isArray(value)) {
          fail('ERR_BAD_VALUE', `${field.name} 是 repeated，值得是数组`);
        }
        for (const item of value) {
          const chunks = [];
          appendPayload(chunks, field, item);
          parts.push({ id: field.id, chunks });
        }
      } else {
        const chunks = [];
        appendPayload(chunks, field, value);
        parts.push({ id: field.id, chunks });
      }
    }
    for (const entry of unknownEntries) {
      parts.push({ id: entry.id, chunks: [entry.raw] });
    }

    parts.sort((a, b) => a.id - b.id);
    const out = [];
    for (const part of parts) {
      for (const chunk of part.chunks) {
        out.push(...chunk);
      }
    }
    return Uint8Array.from(out);
  };

  const skipPayload = (buf, pos, wireType) => {
    if (wireType === WIRE_TYPES.VARINT) {
      return readVarint(buf, pos).pos;
    }
    if (wireType === WIRE_TYPES.FIXED64) {
      if (pos + 8 > buf.length) {
        fail('ERR_TRUNCATED', 'fixed64 载荷不够 8 个字节');
      }
      return pos + 8;
    }
    if (wireType === WIRE_TYPES.FIXED32) {
      if (pos + 4 > buf.length) {
        fail('ERR_TRUNCATED', 'fixed32 载荷不够 4 个字节');
      }
      return pos + 4;
    }
    const length = readVarint(buf, pos);
    const contentStart = length.pos;
    const contentEnd = contentStart + length.value;
    if (contentEnd > buf.length) {
      fail('ERR_TRUNCATED', 'length-delimited 载荷比剩下的字节长');
    }
    return contentEnd;
  };

  const decode = (buf) => {
    if (!(buf instanceof Uint8Array)) {
      fail('ERR_BAD_ARGS', 'decode 的输入必须是 Uint8Array');
    }
    const value = {};
    const unknownFields = [];
    const seen = new Set();
    let pos = 0;

    while (pos < buf.length) {
      const fieldStart = pos;
      const key = readVarint(buf, pos);
      pos = key.pos;
      const fieldId = key.value >>> 3;
      const wireType = key.value & 7;

      if (fieldId === 0) {
        fail('ERR_BAD_WIRE_TYPE', '字段号不能是 0');
      }
      if (!LEGACY_WIRE_TYPES.has(wireType)) {
        fail('ERR_BAD_WIRE_TYPE', `wireType ${wireType} 不支持`);
      }

      const field = byId.get(fieldId);
      if (field !== undefined && field.wireType !== wireType) {
        fail('ERR_BAD_WIRE_TYPE',
          `字段 ${field.name} 的 wireType 跟 schema 对不上`);
      }

      if (field === undefined) {
        pos = skipPayload(buf, pos, wireType);
        unknownFields.push({
          id: fieldId,
          wireType,
          raw: buf.slice(fieldStart, pos),
        });
        continue;
      }

      seen.add(field.id);
      if (wireType === WIRE_TYPES.VARINT) {
        const raw = readVarint(buf, pos);
        pos = raw.pos;
        let scalar;
        if (field.type === 'uint32') {
          scalar = raw.value;
        } else if (field.type === 'int32') {
          scalar = (raw.value >>> 1) ^ -(raw.value & 1);
        } else {
          if (raw.value !== 0 && raw.value !== 1) {
            fail('ERR_BAD_VALUE', `布尔字段 ${field.name} 只认 0 和 1`);
          }
          scalar = raw.value === 1;
        }
        if (field.repeated) {
          (value[field.name] ??= []).push(scalar);
        } else {
          value[field.name] = scalar;
        }
      } else {
        const length = readVarint(buf, pos);
        const contentStart = length.pos;
        const contentEnd = contentStart + length.value;
        if (contentEnd > buf.length) {
          fail('ERR_TRUNCATED', 'length-delimited 载荷比剩下的字节长');
        }
        pos = contentEnd;
        let scalar;
        if (field.type === 'bytes') {
          scalar = buf.slice(contentStart, contentEnd);
        } else {
          try {
            scalar = utf8Decoder.decode(buf.slice(contentStart, contentEnd));
          } catch {
            fail('ERR_BAD_UTF8', `字符串字段 ${field.name} 不是合法 UTF-8`,
              { name: field.name });
          }
        }
        if (field.repeated) {
          (value[field.name] ??= []).push(scalar);
        } else {
          value[field.name] = scalar;
        }
      }
    }

    for (const field of fields) {
      if (field.required && !seen.has(field.id)) {
        fail('ERR_MISSING_REQUIRED', `必填字段 ${field.name} 没出现`,
          { name: field.name, id: field.id });
      }
    }

    return { value, unknownFields };
  };

  const fieldsSnapshot = () => fields.map((field) => ({ ...field }));

  return { encode, decode, fields: fieldsSnapshot };
}
