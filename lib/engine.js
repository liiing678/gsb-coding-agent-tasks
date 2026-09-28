// 内存查询引擎。
//
// 口径全部以 README 的《口径》和《API》两节为准：三值条件、left join 补 null、
// 聚合空集、输出键名、稳定排序、分页顺序、统计字段与错误码。

import { QueryError } from './errors.js';

export const DEFAULTS = {
  limit: null,
  offset: 0,
};

export const CONDITION_OPS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'is-null', 'not-null'];
export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'];
export const JOIN_TYPES = ['inner', 'left'];

const BINARY_OPS = ['=', '!=', '<', '<=', '>', '>='];
const NULLISH_OPS = new Set(['is-null', 'not-null']);

function fail(code, message, details = {}) {
  throw new QueryError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

// ---- 建库 ----------------------------------------------------------------

function inferColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function loadSchema(config) {
  if (!isPlainObject(config) || !isPlainObject(config.tables)) {
    fail('ERR_BAD_CONFIG', 'tables 必须是一个对象');
  }
  const tables = new Map();
  for (const [name, def] of Object.entries(config.tables)) {
    let columns;
    let rows;
    if (Array.isArray(def)) {
      if (def.some((row) => !isPlainObject(row))) {
        fail('ERR_BAD_CONFIG', `表 ${name} 的每一行都必须是对象`);
      }
      columns = inferColumns(def);
      rows = def;
    } else if (isPlainObject(def)) {
      if (!Array.isArray(def.columns) || def.columns.some((col) => typeof col !== 'string')) {
        fail('ERR_BAD_CONFIG', `表 ${name} 的 columns 必须是字符串数组`);
      }
      if (!Array.isArray(def.rows) || def.rows.some((row) => !isPlainObject(row))) {
        fail('ERR_BAD_CONFIG', `表 ${name} 的 rows 必须是对象数组`);
      }
      columns = def.columns.slice();
      rows = def.rows;
    } else {
      fail('ERR_BAD_CONFIG', `表 ${name} 的定义不合法`);
    }
    tables.set(name, { columns, rows });
  }
  return tables;
}

// ---- 三值逻辑 ------------------------------------------------------------
// 返回 'true' / 'false' / 'unknown'，只有 true 才能通过过滤。

function ternaryCompare(left, right, op) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return 'unknown';
  }
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== rightType) {
    return 'unknown';
  }
  if (op === '=' || op === '!=') {
    if (leftType !== 'number' && leftType !== 'string' && leftType !== 'boolean') {
      return 'unknown';
    }
    const equal = left === right;
    return op === '=' ? (equal ? 'true' : 'false') : (equal ? 'false' : 'true');
  }
  // 大小比较不支持布尔，也不支持别的类型。
  if (leftType !== 'number' && leftType !== 'string') {
    return 'unknown';
  }
  let ordered;
  if (left < right) ordered = -1;
  else if (left > right) ordered = 1;
  else ordered = 0;
  let pass;
  switch (op) {
    case '<': pass = ordered < 0; break;
    case '<=': pass = ordered <= 0; break;
    case '>': pass = ordered > 0; break;
    case '>=': pass = ordered >= 0; break;
    default: return 'unknown';
  }
  return pass ? 'true' : 'false';
}

function ternaryCondition(value, cond) {
  if (cond.op === 'is-null') {
    return value === null || value === undefined ? 'true' : 'false';
  }
  if (cond.op === 'not-null') {
    return value === null || value === undefined ? 'false' : 'true';
  }
  if (cond.op === 'in') {
    if (value === null || value === undefined) {
      return 'unknown';
    }
    for (const candidate of cond.values) {
      if (ternaryCompare(value, candidate, '=') === 'true') {
        return 'true';
      }
    }
    return 'false';
  }
  return ternaryCompare(value, cond.value, cond.op);
}

function conditionPasses(row, cond) {
  return ternaryCondition(row[cond.key], cond) === 'true';
}

// 带类型标签的签名，保证 1 和 '1'、null 和 '' 不会撞键。
function valueSignature(value) {
  if (value === null || value === undefined) return 'n:';
  return `${typeof value}:${String(value)}`;
}

function rowSignature(row, keys) {
  return keys.map((key) => valueSignature(row[key])).join('\u001f');
}

export function createEngine(config = {}) {
  const tables = loadSchema(config);

  function execute(query) {
    if (!isPlainObject(query)) {
      fail('ERR_BAD_QUERY', 'query 必须是一个对象');
    }
    if (typeof query.from !== 'string' || query.from === '') {
      fail('ERR_BAD_QUERY', 'query 必须给出字符串形式的 from');
    }
    if (!tables.has(query.from)) {
      fail('ERR_UNKNOWN_TABLE', `表 ${query.from} 不存在`, { table: query.from });
    }

    const distinct = query.distinct === undefined ? false : query.distinct;
    if (typeof distinct !== 'boolean') {
      fail('ERR_BAD_QUERY', 'distinct 必须是布尔值');
    }
    const offset = query.offset === undefined ? DEFAULTS.offset : query.offset;
    const limit = query.limit === undefined ? DEFAULTS.limit : query.limit;
    if (!isNonNegativeInteger(offset)) {
      fail('ERR_BAD_QUERY', 'offset 必须是非负整数');
    }
    if (limit !== null && !isNonNegativeInteger(limit)) {
      fail('ERR_BAD_QUERY', 'limit 必须是 null 或非负整数');
    }

    const leftName = query.from;
    const leftTable = tables.get(leftName);

    // -- join 形状校验 ----------------------------------------------------
    let joinSpec = null;
    if (query.join !== undefined) {
      const join = query.join;
      if (!isPlainObject(join) || typeof join.table !== 'string' || join.table === '') {
        fail('ERR_BAD_QUERY', 'join 必须给出 table');
      }
      if (!tables.has(join.table)) {
        fail('ERR_UNKNOWN_TABLE', `表 ${join.table} 不存在`, { table: join.table });
      }
      const type = join.type === undefined ? 'inner' : join.type;
      if (!JOIN_TYPES.includes(type)) {
        fail('ERR_BAD_QUERY', `join.type 只能是 ${JOIN_TYPES.join(' / ')}`);
      }
      if (!Array.isArray(join.on) || join.on.length === 0) {
        fail('ERR_BAD_QUERY', 'join.on 至少要有一个条件');
      }
      const rightTable0 = tables.get(join.table);
      const onConds = join.on.map((entry) => {
        if (!isPlainObject(entry) || typeof entry.left !== 'string' || typeof entry.right !== 'string') {
          fail('ERR_BAD_QUERY', 'join.on 的每一项都要有字符串形式的 left 和 right');
        }
        const op = entry.op === undefined ? '=' : entry.op;
        if (!BINARY_OPS.includes(op)) {
          fail('ERR_BAD_QUERY', `join.on.op 只能是 ${BINARY_OPS.join(' / ')}`);
        }
        if (!leftTable.columns.includes(entry.left)) {
          fail('ERR_UNKNOWN_COLUMN', `左表 ${leftName} 没有列 ${entry.left}`);
        }
        if (!rightTable0.columns.includes(entry.right)) {
          fail('ERR_UNKNOWN_COLUMN', `右表 ${join.table} 没有列 ${entry.right}`);
        }
        return { left: entry.left, right: entry.right, op };
      });
      joinSpec = { table: join.table, type, on: onConds };
    }

    const joined = joinSpec !== null;
    const rightTable = joined ? tables.get(joinSpec.table) : null;
    const participating = new Set([leftName, ...(joined ? [joinSpec.table] : [])]);

    // 查询里的列引用解析成内部行上的键：没 join 用短名，有 join 必须带表名。
    const resolveRef = (ref) => {
      if (typeof ref !== 'string' || ref === '') {
        fail('ERR_BAD_QUERY', '列引用必须是非空字符串');
      }
      const dot = ref.indexOf('.');
      if (joined) {
        if (dot < 0) {
          fail('ERR_UNKNOWN_COLUMN', `有 join 时列引用必须写成 表名.列名：${ref}`);
        }
        const tableName = ref.slice(0, dot);
        const column = ref.slice(dot + 1);
        if (!tables.has(tableName)) {
          fail('ERR_UNKNOWN_TABLE', `表 ${tableName} 不存在`, { table: tableName });
        }
        if (!participating.has(tableName)) {
          fail('ERR_UNKNOWN_COLUMN', `表 ${tableName} 没有参与这次查询`);
        }
        if (!tables.get(tableName).columns.includes(column)) {
          fail('ERR_UNKNOWN_COLUMN', `表 ${tableName} 没有列 ${column}`);
        }
        return ref;
      }
      if (dot >= 0) {
        const tableName = ref.slice(0, dot);
        if (tables.has(tableName)) {
          fail('ERR_UNKNOWN_COLUMN', `表 ${tableName} 没有参与这次查询`);
        }
        fail('ERR_UNKNOWN_TABLE', `表 ${tableName} 不存在`, { table: tableName });
      }
      if (!leftTable.columns.includes(ref)) {
        fail('ERR_UNKNOWN_COLUMN', `表 ${leftName} 没有列 ${ref}`);
      }
      return ref;
    };

    const validateCondition = (cond) => {
      if (!isPlainObject(cond) || typeof cond.column !== 'string' || cond.column === '') {
        fail('ERR_BAD_QUERY', '条件必须是带 column 的对象');
      }
      if (!CONDITION_OPS.includes(cond.op)) {
        fail('ERR_BAD_QUERY', `不认识的条件操作符：${cond.op}`);
      }
      if (cond.op === 'in') {
        if (!Array.isArray(cond.values)) {
          fail('ERR_BAD_QUERY', 'op 为 in 时必须给 values 数组');
        }
      } else if (!NULLISH_OPS.has(cond.op) && !('value' in cond)) {
        fail('ERR_BAD_QUERY', `op 为 ${cond.op} 时必须给 value`);
      }
      return { ...cond, key: resolveRef(cond.column) };
    };

    // -- where ------------------------------------------------------------
    let whereConds = [];
    if (query.where !== undefined) {
      if (!Array.isArray(query.where)) {
        fail('ERR_BAD_QUERY', 'where 必须是条件数组');
      }
      whereConds = query.where.map(validateCondition);
    }

    // -- groupBy / aggregates ---------------------------------------------
    let groupBy = [];
    if (query.groupBy !== undefined) {
      if (!Array.isArray(query.groupBy) || query.groupBy.some((col) => typeof col !== 'string')) {
        fail('ERR_BAD_QUERY', 'groupBy 必须是列引用数组');
      }
      groupBy = query.groupBy.map(resolveRef);
    }

    let aggregateSpecs = [];
    if (query.aggregates !== undefined) {
      if (!Array.isArray(query.aggregates)) {
        fail('ERR_BAD_QUERY', 'aggregates 必须是数组');
      }
      const aliases = new Set();
      aggregateSpecs = query.aggregates.map((agg) => {
        if (!isPlainObject(agg) || typeof agg.as !== 'string' || agg.as === '') {
          fail('ERR_BAD_QUERY', '每个聚合都要有字符串形式的 as');
        }
        if (aliases.has(agg.as)) {
          fail('ERR_BAD_QUERY', `聚合别名重复：${agg.as}`);
        }
        aliases.add(agg.as);
        if (!AGGREGATES.includes(agg.fn)) {
          fail('ERR_BAD_AGG', `不认识的聚合函数：${agg.fn}`);
        }
        if (agg.distinct !== undefined && typeof agg.distinct !== 'boolean') {
          fail('ERR_BAD_QUERY', '聚合的 distinct 必须是布尔值');
        }
        if (agg.fn !== 'count' && (typeof agg.column !== 'string' || agg.column === '')) {
          fail('ERR_BAD_AGG', `${agg.fn} 聚合必须指定 column`);
        }
        if (agg.column !== undefined && typeof agg.column !== 'string') {
          fail('ERR_BAD_QUERY', '聚合的 column 必须是字符串');
        }
        return {
          as: agg.as,
          fn: agg.fn,
          key: agg.column === undefined ? null : resolveRef(agg.column),
          distinct: agg.distinct === true,
        };
      });
    }

    const isAggregate = groupBy.length > 0 || aggregateSpecs.length > 0;

    // -- 输出有哪些键（聚合查询里 select 被忽略） --------------------------
    let outputKeys;
    if (isAggregate) {
      outputKeys = [...groupBy, ...aggregateSpecs.map((agg) => agg.as)];
    } else if (query.select !== undefined) {
      if (!Array.isArray(query.select) || query.select.some((col) => typeof col !== 'string')) {
        fail('ERR_BAD_QUERY', 'select 必须是列引用数组');
      }
      outputKeys = query.select.map(resolveRef);
    } else if (joined) {
      outputKeys = [
        ...leftTable.columns.map((col) => `${leftName}.${col}`),
        ...rightTable.columns.map((col) => `${joinSpec.table}.${col}`),
      ];
    } else {
      outputKeys = leftTable.columns.slice();
    }

    // -- having（只认输出行里的键） ----------------------------------------
    let havingConds = [];
    if (query.having !== undefined) {
      if (!Array.isArray(query.having)) {
        fail('ERR_BAD_QUERY', 'having 必须是条件数组');
      }
      havingConds = query.having.map((cond) => {
        if (!isPlainObject(cond) || typeof cond.column !== 'string' || cond.column === '') {
          fail('ERR_BAD_QUERY', '条件必须是带 column 的对象');
        }
        if (!CONDITION_OPS.includes(cond.op)) {
          fail('ERR_BAD_QUERY', `不认识的条件操作符：${cond.op}`);
        }
        if (cond.op === 'in') {
          if (!Array.isArray(cond.values)) {
            fail('ERR_BAD_QUERY', 'op 为 in 时必须给 values 数组');
          }
        } else if (!NULLISH_OPS.has(cond.op) && !('value' in cond)) {
          fail('ERR_BAD_QUERY', `op 为 ${cond.op} 时必须给 value`);
        }
        if (!outputKeys.includes(cond.column)) {
          fail('ERR_UNKNOWN_COLUMN', `having 引用了没输出的列：${cond.column}`);
        }
        return { ...cond, key: cond.column };
      });
    }

    // -- orderBy（只认输出行里的键，引用别的列报 ERR_UNKNOWN_COLUMN） ------
    let sortSpecs = [];
    if (query.orderBy !== undefined) {
      if (!Array.isArray(query.orderBy)) {
        fail('ERR_BAD_QUERY', 'orderBy 必须是数组');
      }
      sortSpecs = query.orderBy.map((entry) => {
        if (!isPlainObject(entry) || typeof entry.column !== 'string' || entry.column === '') {
          fail('ERR_BAD_QUERY', 'orderBy 的每一项都要有 column');
        }
        const direction = entry.direction === undefined ? 'asc' : entry.direction;
        if (direction !== 'asc' && direction !== 'desc') {
          fail('ERR_BAD_QUERY', 'direction 只能是 asc 或 desc');
        }
        if (!outputKeys.includes(entry.column)) {
          fail('ERR_UNKNOWN_COLUMN', `orderBy 引用了没输出的列：${entry.column}`);
        }
        return { key: entry.column, direction };
      });
    }

    // ===== 下面开始真正执行 ==============================================

    // 1) 扫描 + 嵌套循环连接。
    let joinedRows;
    if (!joined) {
      joinedRows = leftTable.rows.slice();
    } else {
      joinedRows = [];
      const nullRight = Object.fromEntries(
        rightTable.columns.map((col) => [`${joinSpec.table}.${col}`, null]),
      );
      for (const leftRow of leftTable.rows) {
        let matched = 0;
        for (const rightRow of rightTable.rows) {
          const pair = {};
          for (const col of leftTable.columns) pair[`${leftName}.${col}`] = leftRow[col];
          for (const col of rightTable.columns) pair[`${joinSpec.table}.${col}`] = rightRow[col];
          const ok = joinSpec.on.every((on) => ternaryCompare(
            pair[`${leftName}.${on.left}`],
            pair[`${joinSpec.table}.${on.right}`],
            on.op,
          ) === 'true');
          if (ok) {
            joinedRows.push(pair);
            matched += 1;
          }
        }
        if (matched === 0 && joinSpec.type === 'left') {
          joinedRows.push({
            ...Object.fromEntries(leftTable.columns.map((col) => [`${leftName}.${col}`, leftRow[col]])),
            ...nullRight,
          });
        }
      }
    }

    // 2) where（三值逻辑，只有 true 通过）。
    const filteredRows = whereConds.length === 0
      ? joinedRows
      : joinedRows.filter((row) => whereConds.every((cond) => conditionPasses(row, cond)));

    // 3) 分组 + 聚合。
    let resultRows;
    let groupCount;
    if (isAggregate) {
      const groups = new Map();
      const order = [];
      for (const row of filteredRows) {
        const signature = groupBy.map((key) => valueSignature(row[key])).join('\u001f');
        if (!groups.has(signature)) {
          groups.set(signature, { keys: groupBy.map((key) => row[key]), rows: [] });
          order.push(signature);
        }
        groups.get(signature).rows.push(row);
      }
      // 不分组时整张表算一组，一行都没有也照样给一行。
      if (groupBy.length === 0) {
        order.length = 0;
        order.push('');
        groups.set('', { keys: [], rows: filteredRows });
      }

      const computeAggregate = (spec, memberRows) => {
        if (spec.fn === 'count') {
          if (spec.key === null) {
            return memberRows.length;
          }
          let values = memberRows.map((row) => row[spec.key]).filter((value) => value !== null && value !== undefined);
          if (spec.distinct) {
            values = values.filter((value, index, all) => all.findIndex((other) => valueSignature(other) === valueSignature(value)) === index);
          }
          return values.length;
        }

        let values = memberRows.map((row) => row[spec.key]).filter((value) => value !== null && value !== undefined);
        if (spec.distinct) {
          values = values.filter((value, index, all) => all.findIndex((other) => valueSignature(other) === valueSignature(value)) === index);
        }
        if (values.length === 0) {
          return null;
        }

        const type = typeof values[0];
        if (spec.fn === 'sum' || spec.fn === 'avg') {
          if (values.some((value) => typeof value !== 'number')) {
            fail('ERR_BAD_AGG', `${spec.fn} 只能对数字计算（${spec.as}）`);
          }
          const total = values.reduce((sum, value) => sum + value, 0);
          return spec.fn === 'sum' ? total : total / values.length;
        }

        // min / max：必须全是数字或全是字符串。
        if (values.some((value) => typeof value !== type || (type !== 'number' && type !== 'string'))) {
          fail('ERR_BAD_AGG', `${spec.fn} 要求全是数字或全是字符串（${spec.as}）`);
        }
        return values.reduce((acc, value) => {
          if (spec.fn === 'min') return value < acc ? value : acc;
          return value > acc ? value : acc;
        });
      };

      resultRows = order.map((signature) => {
        const group = groups.get(signature);
        const outRow = {};
        groupBy.forEach((key, index) => {
          outRow[key] = group.keys[index] === undefined ? null : group.keys[index];
        });
        for (const spec of aggregateSpecs) {
          outRow[spec.as] = computeAggregate(spec, group.rows);
        }
        return outRow;
      });
      groupCount = resultRows.length;

      // 4) having（作用在聚合结果上，判定规则和 where 一样）。
      if (havingConds.length > 0) {
        resultRows = resultRows.filter((row) => havingConds.every((cond) => conditionPasses(row, cond)));
      }
    } else {
      groupCount = 0;
      resultRows = filteredRows.map((row) => {
        const outRow = {};
        for (const key of outputKeys) outRow[key] = row[key];
        return outRow;
      });
      if (havingConds.length > 0) {
        resultRows = resultRows.filter((row) => havingConds.every((cond) => conditionPasses(row, cond)));
      }
    }

    // 5) 排序：null / undefined 永远排最后；类型对不上抛 ERR_BAD_QUERY；
    //    多键全部相等时保持输入顺序（稳定）。
    if (sortSpecs.length > 0) {
      const decorated = resultRows.map((row, index) => ({ row, index }));
      decorated.sort((x, y) => {
        for (const spec of sortSpecs) {
          const a = x.row[spec.key];
          const b = y.row[spec.key];
          const aNull = a === null || a === undefined;
          const bNull = b === null || b === undefined;
          if (aNull && bNull) continue;
          if (aNull) return 1;
          if (bNull) return -1;
          if (typeof a !== typeof b) {
            fail('ERR_BAD_QUERY', `排序列 ${spec.key} 的值类型对不上`);
          }
          let cmp;
          if (a < b) cmp = -1;
          else if (a > b) cmp = 1;
          else cmp = 0;
          if (cmp !== 0) {
            return spec.direction === 'desc' ? -cmp : cmp;
          }
        }
        return x.index - y.index;
      });
      resultRows = decorated.map((item) => item.row);
    }

    // 6) distinct：按整行值去重（列顺序不影响），保留第一次出现的行。
    if (distinct) {
      const seen = new Set();
      resultRows = resultRows.filter((row) => {
        const signature = rowSignature(row, outputKeys);
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      });
    }

    // 7) offset -> limit。
    resultRows = resultRows.slice(offset, limit === null ? undefined : offset + limit);

    return {
      rows: resultRows,
      stats: {
        scanned: leftTable.rows.length,
        joined: joinedRows.length,
        filtered: filteredRows.length,
        groups: groupCount,
        returned: resultRows.length,
      },
    };
  }

  return { execute };
}
