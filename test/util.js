import assert from 'node:assert/strict';

import { CodecError } from '../lib/errors.js';

export const hex = (bytes) => [...bytes].map((one) => one.toString(16).padStart(2, '0')).join(' ');

export const fromHex = (text) => {
  const trimmed = text.trim();
  if (trimmed === '') return new Uint8Array(0);
  return Uint8Array.from(trimmed.split(/\s+/).map((one) => Number.parseInt(one, 16)));
};

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof CodecError || err instanceof Error, '抛出来的得是 Error');
    return err.code;
  }
};

export const err = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};
