// 表达式编译器与栈式虚拟机：把源码编成指令，再拿环境跑出结果。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/compile.test.js、test/edge.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》《指令集》《API》 三节
// 写好了。那些约定不要改，把这里补出来。

import { ExprError } from './errors.js';

export function compile(source, options = {}) {
  // 实现在文件后半部分，编译管线见下方各节。
  return compileProgram(source, options);
}

// ---------- 入参校验 ----------

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
};

const typeError = (details = {}) =>
  new ExprError('ERR_TYPE', '类型不对：值只能是数字、字符串、布尔或 null', details);

const divideByZero = () => new ExprError('ERR_DIVIDE_BY_ZERO', '除数是 0', {});

const badArgument = () =>
  new ExprError('ERR_BAD_ARGUMENT', '参数不合法：source 须是字符串，options / env 须是普通对象', {});

// ---------- 词法 ----------

const isDigit = (c) => c >= '0' && c <= '9';
const isHex = (c) =>
  (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isIdentStart = (c) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

const KEYWORDS = { true: true, false: false, null: null };
const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };

const syntaxError = (source, pos) => {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < pos; i++) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  const column = pos - lineStart + 1;
  return new ExprError(
    'ERR_BAD_SYNTAX',
    `语法错误：第 ${line} 行第 ${column} 列`,
    { index: pos, line, column },
  );
};

function tokenize(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    const start = i;

    // 数字：.5 / 1.5 / 1e3 / 1e-3 / 0x1f；1.、1e、0x 后缺东西都算错
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        i += 2;
        const hexStart = i;
        while (i < source.length && isHex(source[i])) i += 1;
        if (i === hexStart) throw syntaxError(source, start);
        tokens.push({ type: 'num', value: Number(source.slice(start, i)), pos: start });
        continue;
      }
      while (i < source.length && isDigit(source[i])) i += 1;
      if (source[i] === '.') {
        if (!isDigit(source[i + 1])) throw syntaxError(source, i);
        i += 1;
        while (i < source.length && isDigit(source[i])) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        if (!isDigit(source[j])) throw syntaxError(source, i);
        i = j;
        while (i < source.length && isDigit(source[i])) i += 1;
      }
      tokens.push({ type: 'num', value: Number(source.slice(start, i)), pos: start });
      continue;
    }

    // 字符串：只认 \n \t \r \\ \" \' 这几种转义
    if (c === '"' || c === "'") {
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (!Object.hasOwn(ESCAPES, esc)) throw syntaxError(source, i);
          value += ESCAPES[esc];
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw syntaxError(source, start);
      i += 1;
      tokens.push({ type: 'str', value, pos: start });
      continue;
    }

    // 名字 / 关键字
    if (isIdentStart(c)) {
      while (i < source.length && isIdentPart(source[i])) i += 1;
      const word = source.slice(start, i);
      if (Object.hasOwn(KEYWORDS, word)) {
        tokens.push({ type: 'kw', value: KEYWORDS[word], pos: start });
      } else {
        tokens.push({ type: 'name', value: word, pos: start });
      }
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>='
      || two === '&&' || two === '||') {
      tokens.push({ type: two, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/%<>()?:!'.includes(c)) {
      tokens.push({ type: c, pos: start });
      i += 1;
      continue;
    }

    throw syntaxError(source, i); // 单个 =、@、[ 等
  }

  tokens.push({ type: 'eof', pos: source.length });
  return tokens;
}

// ---------- 语法（优先级：?: < || < && < == != < 比较 < + - < * / % < 一元） ----------

const PREC = {
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

const BIN_OP = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'mod',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
  '==': 'eq',
  '!=': 'ne',
};

function parse(tokens, source) {
  let pos = 0;
  const at = () => tokens[pos];
  const fail = (token) => {
    throw syntaxError(source, token.pos);
  };

  // minPrec=1 给三元用，保证它压过同一层里所有二元运算；右结合靠右枝用 1 递归
  function parseExpression(minPrec) {
    let left = parseUnary();
    for (;;) {
      const token = at();
      if (token.type === '?' && minPrec <= 1) {
        pos += 1;
        const thenBranch = parseExpression(0);
        if (at().type !== ':') fail(at());
        pos += 1;
        const elseBranch = parseExpression(1);
        left = { kind: 'cond', cond: left, then: thenBranch, else: elseBranch };
      } else if (PREC[token.type] !== undefined && PREC[token.type] >= minPrec) {
        const prec = PREC[token.type];
        pos += 1;
        const right = parseExpression(prec + 1); // 同一层左结合
        if (token.type === '&&' || token.type === '||') {
          left = { kind: 'log', op: token.type, left, right };
        } else {
          left = { kind: 'bin', op: BIN_OP[token.type], left, right };
        }
      } else {
        break;
      }
    }
    return left;
  }

  function parseUnary() {
    const token = at();
    if (token.type === '-' || token.type === '!') {
      pos += 1;
      return {
        kind: 'unary',
        op: token.type === '-' ? 'neg' : 'not',
        operand: parseUnary(), // 一元可以叠加：- -1、!!x
      };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = at();
    switch (token.type) {
      case 'num':
      case 'str':
        pos += 1;
        return { kind: 'lit', value: token.value };
      case 'kw':
        pos += 1;
        return { kind: 'lit', value: token.value };
      case 'name':
        pos += 1;
        return { kind: 'var', name: token.value };
      case '(': {
        pos += 1;
        const node = parseExpression(0);
        if (at().type !== ')') fail(at());
        pos += 1;
        return node;
      }
      default:
        fail(token);
    }
  }

  const ast = parseExpression(0);
  if (at().type !== 'eof') fail(at()); // 1 2、) 多出来等
  return ast;
}

// ---------- 运行时规则（常量折叠与虚拟机共用，保证两模式等价） ----------

const typeTag = (v) => (v === null ? 'null' : typeof v);

const isValue = (v) =>
  v === null
  || typeof v === 'number'
  || typeof v === 'string'
  || typeof v === 'boolean';

// 假值只有 false、0、-0、""、null；NaN 不在其中，按真算
const isTruthy = (v) => {
  if (v === false || v === null || v === '') return false;
  if (typeof v === 'number' && v === 0) return false;
  return true;
};

// 文本化：null -> 空串，布尔 -> "true"/"false"，数字 String(v)，字符串原样
const toText = (v) => {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

function applyBinary(op, left, right) {
  if (op === 'add') {
    if (typeof left === 'number' && typeof right === 'number') return left + right;
    if (typeof left === 'string' || typeof right === 'string') {
      return toText(left) + toText(right);
    }
    throw typeError();
  }

  if (op === 'sub' || op === 'mul' || op === 'div' || op === 'mod') {
    if (typeof left !== 'number' || typeof right !== 'number') throw typeError();
    if ((op === 'div' || op === 'mod') && right === 0) throw divideByZero();
    switch (op) {
      case 'sub':
        return left - right;
      case 'mul':
        return left * right;
      case 'div':
        return left / right;
      default:
        return left % right; // JS 的 % 符号本来就跟被除数走：-7 % 3 === -1
    }
  }

  if (op === 'eq' || op === 'ne') {
    if (typeTag(left) !== typeTag(right)) throw typeError();
    const equal = left === right;
    return op === 'eq' ? equal : !equal;
  }

  // 比较：必须同类型；数字比数字，字符串按码元比
  if (typeTag(left) !== typeTag(right)) throw typeError();
  let a = left;
  let b = right;
  if (typeof left === 'boolean') {
    a = Number(left);
    b = Number(right);
  } else if (left === null) {
    a = 0;
    b = 0;
  }
  switch (op) {
    case 'lt':
      return a < b;
    case 'le':
      return a <= b;
    case 'gt':
      return a > b;
    default:
      return a >= b;
  }
}

function applyNegate(value) {
  if (typeof value !== 'number') throw typeError();
  return -value;
}

// ---------- 优化器：只做常量折叠与常量条件分支消除 ----------

function tryFoldBinary(op, left, right) {
  try {
    return { ok: true, value: applyBinary(op, left, right) };
  } catch (err) {
    if (err instanceof ExprError) return { ok: false }; // 会抛错的组合不折
    throw err;
  }
}

function fold(node) {
  switch (node.kind) {
    case 'lit':
    case 'var':
      return node;

    case 'unary': {
      const operand = fold(node.operand);
      if (operand.kind !== 'lit') return { ...node, operand };
      if (node.op === 'not') {
        return { kind: 'lit', value: !isTruthy(operand.value) };
      }
      if (typeof operand.value === 'number') {
        return { kind: 'lit', value: -operand.value };
      }
      return { ...node, operand }; // -"a"、-null 留到运行时才抛
    }

    case 'bin': {
      const left = fold(node.left);
      const right = fold(node.right);
      if (left.kind === 'lit' && right.kind === 'lit') {
        const result = tryFoldBinary(node.op, left.value, right.value);
        if (result.ok) return { kind: 'lit', value: result.value };
      }
      return { ...node, left, right };
    }

    case 'log': {
      const left = fold(node.left);
      const right = fold(node.right);
      if (left.kind === 'lit') {
        const leftTruthy = isTruthy(left.value);
        if (node.op === '&&') {
          return leftTruthy ? right : { kind: 'lit', value: left.value };
        }
        return leftTruthy ? { kind: 'lit', value: left.value } : right;
      }
      return { ...node, left, right };
    }

    case 'cond': {
      const cond = fold(node.cond);
      if (cond.kind === 'lit') {
        return isTruthy(cond.value) ? fold(node.then) : fold(node.else);
      }
      return {
        ...node,
        cond,
        then: fold(node.then),
        else: fold(node.else),
      };
    }

    default:
      return node;
  }
}

// ---------- 代码生成：栈式指令，跳转目标为绝对下标 ----------

function generate(node) {
  const code = [];

  const emit = (op, arg) => {
    code.push({ op, arg });
    return code.length - 1;
  };

  function gen(value) {
    switch (value.kind) {
      case 'lit':
        emit('CONST', value.value);
        return;
      case 'var':
        emit('LOAD', value.name);
        return;
      case 'unary':
        gen(value.operand);
        emit('UNARY', value.op);
        return;
      case 'bin':
        gen(value.left);
        gen(value.right);
        emit('BIN', value.op);
        return;
      case 'log': {
        // 左值留在栈上当结果：短路就直接跳过 POP+右值
        gen(value.left);
        emit('DUP');
        const jump = emit(value.op === '&&' ? 'JUMPF' : 'JUMPT', null);
        emit('POP');
        gen(value.right);
        code[jump].arg = code.length;
        return;
      }
      case 'cond':
        gen(value.cond);
        const jumpFalse = emit('JUMPF', null);
        gen(value.then);
        const jumpEnd = emit('JUMP', null);
        code[jumpFalse].arg = code.length;
        gen(value.else);
        code[jumpEnd].arg = code.length;
        return;
    }
  }

  gen(node);
  emit('RET');
  return code;
}

const formatInstruction = (instruction) => {
  switch (instruction.op) {
    case 'CONST':
      return `CONST ${JSON.stringify(instruction.arg)}`;
    case 'LOAD':
      return `LOAD ${instruction.arg}`;
    case 'UNARY':
      return `UNARY ${instruction.arg}`;
    case 'BIN':
      return `BIN ${instruction.arg}`;
    case 'JUMP':
    case 'JUMPF':
    case 'JUMPT':
      return `${instruction.op} ${instruction.arg}`;
    default:
      return instruction.op;
  }
};

// ---------- 虚拟机 ----------

function execute(code, env) {
  const stack = [];
  let ip = 0;

  while (ip < code.length) {
    const instruction = code[ip];
    switch (instruction.op) {
      case 'CONST':
        stack.push(instruction.arg);
        break;
      case 'LOAD': {
        const name = instruction.arg;
        if (!Object.hasOwn(env, name)) {
          throw new ExprError('ERR_UNKNOWN_NAME', `环境里没有名字 ${name}`, { name });
        }
        const value = env[name];
        if (!isValue(value)) {
          throw typeError({ name });
        }
        stack.push(value);
        break;
      }
      case 'UNARY': {
        const value = stack.pop();
        stack.push(
          instruction.arg === 'neg' ? applyNegate(value) : !isTruthy(value),
        );
        break;
      }
      case 'BIN': {
        const right = stack.pop();
        const left = stack.pop();
        stack.push(applyBinary(instruction.arg, left, right));
        break;
      }
      case 'DUP':
        stack.push(stack[stack.length - 1]);
        break;
      case 'POP':
        stack.pop();
        break;
      case 'JUMP':
        ip = instruction.arg;
        continue;
      case 'JUMPF': {
        const value = stack.pop();
        if (!isTruthy(value)) {
          ip = instruction.arg;
          continue;
        }
        break;
      }
      case 'JUMPT': {
        const value = stack.pop();
        if (isTruthy(value)) {
          ip = instruction.arg;
          continue;
        }
        break;
      }
      case 'RET':
        return stack.pop();
    }
    ip += 1;
  }

  throw new ExprError('ERR_BAD_SYNTAX', '指令缺少 RET', {});
}

// ---------- 入口 ----------

function compileProgram(source, options) {
  if (typeof source !== 'string') throw badArgument();
  if (options === undefined) {
    options = {};
  } else if (!isPlainObject(options)) {
    throw badArgument();
  }
  const optimize = options.optimize === undefined ? true : options.optimize;
  if (typeof optimize !== 'boolean') throw badArgument();

  const tokens = tokenize(source);
  let ast = parse(tokens, source);
  if (optimize) ast = fold(ast);
  const code = generate(ast);
  const assembly = code.map(formatInstruction);

  return {
    source,
    assembly,
    run(env = {}) {
      if (!isPlainObject(env)) throw badArgument();
      return execute(code, env);
    },
  };
}
