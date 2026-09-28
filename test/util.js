import { ExprError } from '../lib/errors.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ExprError ? err.code : `NOT_EXPR:${err.message}`;
  }
};

// 跑一次，结果或错误码都拿出来，方便两种模式对着比
export const outcome = (compile, source, env, options) => {
  try {
    return { value: compile(source, options).run(env) };
  } catch (err) {
    return { error: err instanceof ExprError ? err.code : `NOT_EXPR:${err.message}` };
  }
};

export const details = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.details;
  }
  return null;
};
