import { ExprError } from './errors.js';

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.\d+|\d+|\.\d+)(?:[eE][+-]?\d+)?)/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

const BINARY_OPS = {
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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function badArgument() {
  return new ExprError('ERR_BAD_ARGUMENT', 'invalid argument', {});
}

function typeTag(value) {
  return value === null ? 'null' : typeof value;
}

function isTruthy(value) {
  return value !== false && value !== null && value !== 0 && value !== '';
}

function isRuntimeValue(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number';
}

function textify(value) {
  if (value === null) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function safeBinary(op, left, right) {
  if (op === 'add') {
    if (typeof left === 'number' && typeof right === 'number') {
      const value = left + right;
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    if (typeof left === 'string' || typeof right === 'string') {
      return { ok: true, value: textify(left) + textify(right) };
    }
    return { ok: false };
  }

  if (op === 'eq' || op === 'ne') {
    if (typeTag(left) !== typeTag(right)) {
      return { ok: false };
    }
    const equal = left === right;
    return { ok: true, value: op === 'eq' ? equal : !equal };
  }

  if (op === 'lt' || op === 'le' || op === 'gt' || op === 'ge') {
    if (typeof left === 'number' && typeof right === 'number') {
      return {
        ok: true,
        value: op === 'lt' ? left < right
          : op === 'le' ? left <= right
          : op === 'gt' ? left > right
          : left >= right,
      };
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return {
        ok: true,
        value: op === 'lt' ? left < right
          : op === 'le' ? left <= right
          : op === 'gt' ? left > right
          : left >= right,
      };
    }
    return { ok: false };
  }

  if (typeof left !== 'number' || typeof right !== 'number') {
    return { ok: false };
  }
  if ((op === 'div' || op === 'mod') && right === 0) {
    return { ok: false };
  }

  let value;
  if (op === 'sub') {
    value = left - right;
  } else if (op === 'mul') {
    value = left * right;
  } else if (op === 'div') {
    value = left / right;
  } else {
    value = left % right;
  }
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

class Parser {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.tokens = [];
    this.tokenIndex = 0;
    this.tokenize();
  }

  syntaxError(index) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < index; i += 1) {
      const code = this.source.charCodeAt(i);
      if (code === 10 || code === 13) {
        line += 1;
        if (code === 13 && this.source.charCodeAt(i + 1) === 10) {
          i += 1;
        }
        lineStart = i + 1;
      }
    }
    return new ExprError(
      'ERR_BAD_SYNTAX',
      'invalid expression',
      { index, line, column: index - lineStart + 1 },
    );
  }

  tokenize() {
    const source = this.source;
    while (this.pos < source.length) {
      const code = source.charCodeAt(this.pos);
      if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11) {
        this.pos += 1;
        continue;
      }

      const char = source[this.pos];
      const isDigit = code >= 48 && code <= 57;
      const isDecimalStart = isDigit || (char === '.' && source.charCodeAt(this.pos + 1) >= 48);

      if (isDecimalStart) {
        const match = NUMBER_RE.exec(source.slice(this.pos));
        const value = Number(match[0]);
        if (!Number.isFinite(value)) {
          throw this.syntaxError(this.pos);
        }
        this.tokens.push({ type: 'number', value, pos: this.pos });
        this.pos += match[0].length;
        continue;
      }

      if (char === '"' || char === "'") {
        this.readString(char);
        continue;
      }

      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95) {
        const match = NAME_RE.exec(source.slice(this.pos));
        const name = match[0];
        const pos = this.pos;
        this.pos += name.length;
        if (name === 'true' || name === 'false' || name === 'null') {
          this.tokens.push({
            type: 'literal',
            value: name === 'true' ? true : name === 'false' ? false : null,
            pos,
          });
        } else {
          this.tokens.push({ type: 'name', value: name, pos });
        }
        continue;
      }

      const two = source.slice(this.pos, this.pos + 2);
      if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) {
        this.tokens.push({ type: two, pos: this.pos });
        this.pos += 2;
        continue;
      }

      if ('+-*/%<>!?:()'.includes(char)) {
        this.tokens.push({ type: char, pos: this.pos });
        this.pos += 1;
        continue;
      }

      throw this.syntaxError(this.pos);
    }
  }

  readString(quote) {
    const start = this.pos;
    this.pos += 1;
    let value = '';

    while (this.pos < this.source.length) {
      const char = this.source[this.pos];
      if (char === quote) {
        this.pos += 1;
        this.tokens.push({ type: 'string', value, pos: start });
        return;
      }
      if (char === '\n' || char === '\r') {
        throw this.syntaxError(start);
      }
      if (char === '\\') {
        const escapePos = this.pos;
        this.pos += 1;
        if (this.pos >= this.source.length) {
          throw this.syntaxError(start);
        }
        const escaped = this.source[this.pos];
        if (escaped === 'n') {
          value += '\n';
        } else if (escaped === 't') {
          value += '\t';
        } else if (escaped === 'r') {
          value += '\r';
        } else if (escaped === '\\') {
          value += '\\';
        } else if (escaped === '"' || escaped === "'") {
          value += escaped;
        } else {
          throw this.syntaxError(escapePos);
        }
        this.pos += 1;
        continue;
      }
      value += char;
      this.pos += 1;
    }

    throw this.syntaxError(start);
  }

  current() {
    return this.tokens[this.tokenIndex] ?? null;
  }

  currentPosition() {
    return this.current()?.pos ?? this.source.length;
  }

  expect(type) {
    const token = this.current();
    if (!token || token.type !== type) {
      throw this.syntaxError(this.currentPosition());
    }
    this.tokenIndex += 1;
  }

  parse() {
    const expression = this.parseTernary();
    if (this.current()) {
      throw this.syntaxError(this.currentPosition());
    }
    return expression;
  }

  parseTernary() {
    const condition = this.parseLogicalOr();
    if (this.current()?.type === '?') {
      this.tokenIndex += 1;
      const consequent = this.parseTernary();
      this.expect(':');
      const alternate = this.parseTernary();
      return { kind: 'ternary', condition, consequent, alternate };
    }
    return condition;
  }

  parseLogicalOr() {
    let left = this.parseLogicalAnd();
    while (this.current()?.type === '||') {
      this.tokenIndex += 1;
      const right = this.parseLogicalAnd();
      left = { kind: 'logical', op: '||', left, right };
    }
    return left;
  }

  parseLogicalAnd() {
    let left = this.parseEquality();
    while (this.current()?.type === '&&') {
      this.tokenIndex += 1;
      const right = this.parseEquality();
      left = { kind: 'logical', op: '&&', left, right };
    }
    return left;
  }

  parseEquality() {
    return this.parseBinary(this.parseRelational.bind(this), ['==', '!=']);
  }

  parseRelational() {
    return this.parseBinary(this.parseAdditive.bind(this), ['<', '<=', '>', '>=']);
  }

  parseAdditive() {
    return this.parseBinary(this.parseMultiplicative.bind(this), ['+', '-']);
  }

  parseMultiplicative() {
    return this.parseBinary(this.parseUnary.bind(this), ['*', '/', '%']);
  }

  parseBinary(parseOperand, operators) {
    let left = parseOperand();
    while (this.current() && operators.includes(this.current().type)) {
      const operator = this.current().type;
      this.tokenIndex += 1;
      const right = parseOperand();
      left = { kind: 'binary', op: BINARY_OPS[operator], left, right };
    }
    return left;
  }

  parseUnary() {
    const token = this.current();
    if (token?.type === '-' || token?.type === '!') {
      this.tokenIndex += 1;
      const operand = this.parseUnary();
      return {
        kind: 'unary',
        op: token.type === '-' ? 'neg' : 'not',
        operand,
      };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.current();
    if (!token) {
      throw this.syntaxError(this.source.length);
    }

    if (token.type === 'number' || token.type === 'string' || token.type === 'literal') {
      this.tokenIndex += 1;
      return { kind: 'literal', value: token.value };
    }
    if (token.type === 'name') {
      this.tokenIndex += 1;
      return { kind: 'name', name: token.value };
    }
    if (token.type === '(') {
      this.tokenIndex += 1;
      const expression = this.parseTernary();
      this.expect(')');
      return expression;
    }

    throw this.syntaxError(token.pos);
  }
}

function foldNode(node) {
  if (node.kind === 'literal' || node.kind === 'name') {
    return node;
  }

  if (node.kind === 'unary') {
    const operand = foldNode(node.operand);
    if (operand.kind === 'literal') {
      if (node.op === 'not') {
        return { kind: 'literal', value: !isTruthy(operand.value) };
      }
      if (typeof operand.value === 'number') {
        const value = -operand.value;
        if (Number.isFinite(value)) {
          return { kind: 'literal', value };
        }
      }
    }
    return { ...node, operand };
  }

  if (node.kind === 'binary') {
    const left = foldNode(node.left);
    const right = foldNode(node.right);
    if (left.kind === 'literal' && right.kind === 'literal') {
      const result = safeBinary(node.op, left.value, right.value);
      if (result.ok) {
        return { kind: 'literal', value: result.value };
      }
    }
    return { ...node, left, right };
  }

  if (node.kind === 'logical') {
    const left = foldNode(node.left);
    const right = foldNode(node.right);
    if (left.kind === 'literal') {
      if (node.op === '&&') {
        return isTruthy(left.value) ? right : left;
      }
      return isTruthy(left.value) ? left : right;
    }
    return { ...node, left, right };
  }

  const condition = foldNode(node.condition);
  const consequent = foldNode(node.consequent);
  const alternate = foldNode(node.alternate);
  if (condition.kind === 'literal') {
    return isTruthy(condition.value) ? consequent : alternate;
  }
  return { ...node, condition, consequent, alternate };
}

function emit(instructions, name, operand = null) {
  const instruction = { name, operand, target: null };
  instructions.push(instruction);
  return instruction;
}

function markLabel(instructions, label) {
  instructions.push({ label });
}

function generateNode(node, instructions) {
  if (node.kind === 'literal') {
    emit(instructions, 'CONST', node.value);
    return;
  }

  if (node.kind === 'name') {
    emit(instructions, 'LOAD', node.name);
    return;
  }

  if (node.kind === 'unary') {
    generateNode(node.operand, instructions);
    emit(instructions, 'UNARY', node.op);
    return;
  }

  if (node.kind === 'binary') {
    generateNode(node.left, instructions);
    generateNode(node.right, instructions);
    emit(instructions, 'BIN', node.op);
    return;
  }

  if (node.kind === 'logical') {
    const endLabel = Symbol('end');
    generateNode(node.left, instructions);
    emit(instructions, 'DUP');
    const jump = emit(instructions, node.op === '&&' ? 'JUMPF' : 'JUMPT', endLabel);
    emit(instructions, 'POP');
    generateNode(node.right, instructions);
    jump.operand = endLabel;
    markLabel(instructions, endLabel);
    return;
  }

  const endLabel = Symbol('end');
  generateNode(node.condition, instructions);
  const jumpFalse = emit(instructions, 'JUMPF', null);
  generateNode(node.consequent, instructions);
  const jumpEnd = emit(instructions, 'JUMP', null);
  const alternateLabel = Symbol('alternate');
  jumpFalse.operand = alternateLabel;
  markLabel(instructions, alternateLabel);
  generateNode(node.alternate, instructions);
  jumpEnd.operand = endLabel;
  markLabel(instructions, endLabel);
}

function resolveInstructions(rawInstructions) {
  const labels = new Map();
  let index = 0;
  for (const instruction of rawInstructions) {
    if (instruction.label) {
      labels.set(instruction.label, index);
    } else {
      index += 1;
    }
  }

  const instructions = rawInstructions.filter((instruction) => !instruction.label);
  for (const instruction of instructions) {
    if (instruction.name === 'JUMP' || instruction.name === 'JUMPF' || instruction.name === 'JUMPT') {
      instruction.target = labels.get(instruction.operand);
    }
  }
  return instructions;
}

function renderInstruction(instruction) {
  if (instruction.name === 'CONST') {
    return `CONST ${JSON.stringify(instruction.operand)}`;
  }
  if (instruction.name === 'LOAD') {
    return `LOAD ${instruction.operand}`;
  }
  if (instruction.name === 'UNARY') {
    return `UNARY ${instruction.operand}`;
  }
  if (instruction.name === 'BIN') {
    return `BIN ${instruction.operand}`;
  }
  if (instruction.name === 'JUMP' || instruction.name === 'JUMPF' || instruction.name === 'JUMPT') {
    return `${instruction.name} ${instruction.target}`;
  }
  return instruction.name;
}

function applyBinary(op, left, right) {
  if (op === 'add') {
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }
    if (typeof left === 'string' || typeof right === 'string') {
      return textify(left) + textify(right);
    }
    throw new ExprError('ERR_TYPE', 'type error', {});
  }

  if (op === 'eq' || op === 'ne') {
    if (typeTag(left) !== typeTag(right)) {
      throw new ExprError('ERR_TYPE', 'type error', {});
    }
    const equal = left === right;
    return op === 'eq' ? equal : !equal;
  }

  if (op === 'lt' || op === 'le' || op === 'gt' || op === 'ge') {
    if (typeof left !== typeof right || (typeTag(left) !== 'number' && typeTag(left) !== 'string')) {
      throw new ExprError('ERR_TYPE', 'type error', {});
    }
    if (op === 'lt') return left < right;
    if (op === 'le') return left <= right;
    if (op === 'gt') return left > right;
    return left >= right;
  }

  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new ExprError('ERR_TYPE', 'type error', {});
  }
  if ((op === 'div' || op === 'mod') && right === 0) {
    throw new ExprError('ERR_DIVIDE_BY_ZERO', 'divide by zero', {});
  }

  if (op === 'sub') return left - right;
  if (op === 'mul') return left * right;
  if (op === 'div') return left / right;
  return left % right;
}

function runInstructions(instructions, env) {
  const stack = [];
  let pc = 0;

  while (pc < instructions.length) {
    const instruction = instructions[pc];
    pc += 1;

    if (instruction.name === 'CONST') {
      stack.push(instruction.operand);
    } else if (instruction.name === 'LOAD') {
      const name = instruction.operand;
      if (!Object.prototype.hasOwnProperty.call(env, name)) {
        throw new ExprError('ERR_UNKNOWN_NAME', `unknown name: ${name}`, { name });
      }
      const value = env[name];
      if (value === undefined || !isRuntimeValue(value)) {
        throw new ExprError('ERR_TYPE', `invalid value: ${name}`, { name });
      }
      stack.push(value);
    } else if (instruction.name === 'UNARY') {
      const value = stack.pop();
      if (instruction.operand === 'neg') {
        if (typeof value !== 'number') {
          throw new ExprError('ERR_TYPE', 'type error', {});
        }
        stack.push(-value);
      } else {
        stack.push(!isTruthy(value));
      }
    } else if (instruction.name === 'BIN') {
      const right = stack.pop();
      const left = stack.pop();
      stack.push(applyBinary(instruction.operand, left, right));
    } else if (instruction.name === 'DUP') {
      stack.push(stack[stack.length - 1]);
    } else if (instruction.name === 'POP') {
      stack.pop();
    } else if (instruction.name === 'JUMP') {
      pc = instruction.target;
    } else if (instruction.name === 'JUMPF') {
      const value = stack.pop();
      if (!isTruthy(value)) {
        pc = instruction.target;
      }
    } else if (instruction.name === 'JUMPT') {
      const value = stack.pop();
      if (isTruthy(value)) {
        pc = instruction.target;
      }
    } else {
      return stack.pop();
    }
  }
}

export function compile(source, options = {}) {
  if (typeof source !== 'string') {
    throw badArgument();
  }
  if (!isPlainObject(options)) {
    throw badArgument();
  }
  const optimize = options.optimize === undefined ? true : options.optimize;
  if (typeof optimize !== 'boolean') {
    throw badArgument();
  }

  let ast = new Parser(source).parse();
  if (optimize) {
    ast = foldNode(ast);
  }

  const rawInstructions = [];
  generateNode(ast, rawInstructions);
  emit(rawInstructions, 'RET');
  const instructions = resolveInstructions(rawInstructions);
  const assembly = instructions.map(renderInstruction);

  return {
    source,
    assembly,
    run(env = {}) {
      if (!isPlainObject(env)) {
        throw badArgument();
      }
      return runInstructions(instructions, env);
    },
  };
}
