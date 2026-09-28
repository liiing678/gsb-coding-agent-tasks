import { createHash } from 'node:crypto';

import { MerkleError } from './errors.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function sha256(chunks) {
  const hash = createHash('sha256');
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest();
}

function toHex(hash) {
  return hash.toString('hex');
}

function badArgument(message, details = {}) {
  return new MerkleError('ERR_BAD_ARGUMENT', message, details);
}

function outOfRange(message, details = {}) {
  return new MerkleError('ERR_OUT_OF_RANGE', message, details);
}

function isHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function assertHash(value, field) {
  if (!isHash(value)) {
    throw badArgument(`${field} must be a 64-character lowercase hexadecimal hash`, { field });
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw badArgument(`${field} must be a non-negative integer`, { field });
  }
}

function assertProofObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badArgument('proof must be an object', { field: 'proof' });
  }
}

function assertHashPath(value) {
  if (!Array.isArray(value) || !value.every(isHash)) {
    throw badArgument('path must be an array of 64-character lowercase hexadecimal hashes', {
      field: 'path',
    });
  }
}

function emptyRoot() {
  return toHex(sha256([]));
}

const EMPTY_ROOT = emptyRoot();

function splitLength(length) {
  let power = 1;
  while (power * 2 < length) {
    power *= 2;
  }
  return power;
}

export function leafHash(data) {
  if (typeof data !== 'string') {
    throw badArgument('data must be a string', { field: 'data' });
  }
  return toHex(sha256([Buffer.from([0x00]), Buffer.from(data, 'utf8')]));
}

export function nodeHash(left, right) {
  assertHash(left, 'left');
  assertHash(right, 'right');
  return toHex(sha256([
    Buffer.from([0x01]),
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex'),
  ]));
}

export function createLog() {
  const leaves = [];

  function rootAt(start, length) {
    if (length === 0) {
      return EMPTY_ROOT;
    }
    if (length === 1) {
      return leaves[start];
    }

    const split = splitLength(length);
    return nodeHash(rootAt(start, split), rootAt(start + split, length - split));
  }

  function inclusionPath(start, length, index) {
    if (length === 1) {
      return [];
    }

    const split = splitLength(length);
    if (index - start < split) {
      return [
        ...inclusionPath(start, split, index),
        rootAt(start + split, length - split),
      ];
    }
    return [
      ...inclusionPath(start + split, length - split, index),
      rootAt(start, split),
    ];
  }

  function consistencyPath(oldLength, start, length, whole) {
    if (oldLength === length) {
      return whole ? [] : [rootAt(start, length)];
    }

    const split = splitLength(length);
    if (oldLength <= split) {
      return [
        ...consistencyPath(oldLength, start, split, whole),
        rootAt(start + split, length - split),
      ];
    }
    return [
      ...consistencyPath(oldLength - split, start + split, length - split, false),
      rootAt(start, split),
    ];
  }

  return {
    append(data) {
      if (typeof data !== 'string') {
        throw badArgument('data must be a string', { field: 'data' });
      }
      const hash = leafHash(data);
      const index = leaves.length;
      leaves.push(hash);
      return { index, hash };
    },

    appendAll(items) {
      if (!Array.isArray(items)) {
        throw badArgument('items must be an array', { field: 'items' });
      }

      const start = leaves.length;
      const entries = items.map((data, offset) => {
        if (typeof data !== 'string') {
          throw badArgument('every item must be a string', { field: `items[${offset}]` });
        }
        return { index: start + offset, hash: leafHash(data) };
      });

      for (const entry of entries) {
        leaves.push(entry.hash);
      }
      return entries;
    },

    size() {
      return leaves.length;
    },

    root() {
      return rootAt(0, leaves.length);
    },

    leafAt(index) {
      assertNonNegativeInteger(index, 'index');
      if (index >= leaves.length) {
        throw outOfRange(`index must be within [0, ${leaves.length})`, { field: 'index' });
      }
      return leaves[index];
    },

    inclusionProof(index) {
      assertNonNegativeInteger(index, 'index');
      if (index >= leaves.length) {
        throw outOfRange(`index must be within [0, ${leaves.length})`, { field: 'index' });
      }
      return {
        index,
        size: leaves.length,
        path: inclusionPath(0, leaves.length, index),
      };
    },

    consistencyProof(fromSize) {
      assertNonNegativeInteger(fromSize, 'fromSize');
      if (fromSize > leaves.length) {
        throw outOfRange(`fromSize must not be greater than ${leaves.length}`, {
          field: 'fromSize',
        });
      }
      if (fromSize === 0 || fromSize === leaves.length) {
        return [];
      }
      return consistencyPath(fromSize, 0, leaves.length, true);
    },
  };
}

export function verifyInclusion(proof) {
  assertProofObject(proof);

  const {
    leaf, index, size, path, root,
  } = proof;
  assertHash(leaf, 'leaf');
  assertNonNegativeInteger(index, 'index');
  assertNonNegativeInteger(size, 'size');
  assertHashPath(path);
  assertHash(root, 'root');

  if (size === 0 || index >= size) {
    return false;
  }

  let cursor = 0;
  const nextHash = () => (cursor < path.length ? path[cursor++] : null);

  const rebuild = (start, length) => {
    if (length === 1) {
      return leaf;
    }

    const split = splitLength(length);
    if (index - start < split) {
      const left = rebuild(start, split);
      const right = nextHash();
      if (left === null || right === null) {
        return null;
      }
      return nodeHash(left, right);
    }

    const right = rebuild(start + split, length - split);
    const left = nextHash();
    if (left === null || right === null) {
      return null;
    }
    return nodeHash(left, right);
  };

  const candidate = rebuild(0, size);
  return candidate !== null && cursor === path.length && candidate === root;
}

export function verifyConsistency(proof) {
  assertProofObject(proof);

  const {
    fromSize, fromRoot, toSize, toRoot, path,
  } = proof;
  assertNonNegativeInteger(fromSize, 'fromSize');
  assertHash(fromRoot, 'fromRoot');
  assertNonNegativeInteger(toSize, 'toSize');
  assertHash(toRoot, 'toRoot');
  assertHashPath(path);

  if (fromSize > toSize) {
    return false;
  }
  if (fromSize === toSize) {
    return path.length === 0 && fromRoot === toRoot;
  }
  if (fromSize === 0) {
    return path.length === 0 && fromRoot === EMPTY_ROOT;
  }

  let cursor = 0;
  const nextHash = () => (cursor < path.length ? path[cursor++] : null);

  const rebuild = (oldLength, length, whole) => {
    if (oldLength === length) {
      const hash = whole ? fromRoot : nextHash();
      if (hash === null) {
        return null;
      }
      return { oldRoot: hash, newRoot: hash };
    }

    const split = splitLength(length);
    if (oldLength <= split) {
      const child = rebuild(oldLength, split, whole);
      const right = nextHash();
      if (child === null || right === null) {
        return null;
      }
      return {
        oldRoot: child.oldRoot,
        newRoot: nodeHash(child.newRoot, right),
      };
    }

    const child = rebuild(oldLength - split, length - split, false);
    const left = nextHash();
    if (child === null || left === null) {
      return null;
    }
    return {
      oldRoot: nodeHash(left, child.oldRoot),
      newRoot: nodeHash(left, child.newRoot),
    };
  };

  const candidate = rebuild(fromSize, toSize, true);
  return candidate !== null
    && cursor === path.length
    && candidate.oldRoot === fromRoot
    && candidate.newRoot === toRoot;
}
