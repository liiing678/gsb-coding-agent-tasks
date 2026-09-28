// 内存查询引擎。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/query.test.js、test/agg.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { QueryError } from './errors.js';

export const DEFAULTS = {
  limit: null,
  offset: 0,
};

export const CONDITION_OPS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'is-null', 'not-null'];
export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'];
export const JOIN_TYPES = ['inner', 'left'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNullish = (value) => value === null || value === undefined;
const normalize = (value) => (value === undefined ? null : value);

function fail(code, message, details) {
  throw new QueryError(code, message, details);
}

const badQuery = (message) => fail('ERR_BAD_QUERY', message);
const badConfig = (message) => fail('ERR_BAD_CONFIG', message);
const badAgg = (message) => fail('ERR_BAD_AGG', message);
const unknownTable = (name) => fail('ERR_UNKNOWN_TABLE', `库里没有表 ${name}`, { table: name });
const unknownColumn = (name) => fail('ERR_UNKNOWN_COLUMN', `引用了不存在的列 ${name}`, { column: name });

function conditionShapeOk(condition) {
  if (!isObject(condition) || typeof condition.column !== 'string' || condition.column === '') return false;
  if (!CONDITION_OPS.includes(condition.op)) return false;
  if (condition.op === 'in' && !Array.isArray(condition.values)) return false;
  return true;
}

// 三值比较：返回 true / false，null 表示 unknown。
function compare3(left, op, right) {
  if (isNullish(left) || isNullish(right)) return null;
  if (typeof left !== typeof right) return null;
  switch (op) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (typeof left === 'boolean') return null;
      if (op === '<') return left < right;
      if (op === '<=') return left <= right;
      if (op === '>') return left > right;
      return left >= right;
    default:
      return null;
  }
}

// 条件是否通过：只有 true 通过，false 和 unknown 都不通过。
function conditionPasses(row, condition) {
  const left = row[condition.column];
  if (condition.op === 'is-null') return isNullish(left);
  if (condition.op === 'not-null') return !isNullish(left);
  if (condition.op === 'in') {
    if (isNullish(left)) return false;
    return condition.values.some((candidate) => compare3(left, '=', candidate) === true);
  }
  return compare3(left, condition.op, condition.value) === true;
}

function distinctValues(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = isNullish(value) ? 'null' : `${typeof value}:${JSON.stringify(value)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(isNullish(value) ? null : value);
    }
  }
  return out;
}

function computeAggregate(rows, spec) {
  if (spec.fn === 'count') {
    if (!spec.column) return rows.length;
    let values = rows.map((row) => row[spec.column]).filter((value) => !isNullish(value));
    if (spec.distinct) values = distinctValues(values);
    return values.length;
  }

  let values = rows.map((row) => row[spec.column]).filter((value) => !isNullish(value));
  if (spec.distinct) values = distinctValues(values);
  if (values.length === 0) return null;

  if (spec.fn === 'sum' || spec.fn === 'avg') {
    if (values.some((value) => typeof value !== 'number')) {
      badAgg(`${spec.fn} 只认数字，碰到了非数字值`);
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return spec.fn === 'sum' ? total : total / values.length;
  }

  const kind = typeof values[0];
  if ((kind !== 'number' && kind !== 'string') || values.some((value) => typeof value !== kind)) {
    badAgg(`${spec.fn} 只能在全数字或全字符串上算，值的类型混了`);
  }
  return values.reduce((acc, value) => {
    if (spec.fn === 'min') return value < acc ? value : acc;
    return value > acc ? value : acc;
  });
}

function groupKey(values) {
  return JSON.stringify(values.map((value) => (isNullish(value) ? null : value)));
}

function rowSignature(row) {
  return JSON.stringify(Object.keys(row).sort().map((key) => [key, normalize(row[key])]));
}

// 排序键比较：null / undefined 永远排最后（asc / desc 都一样），非空值类型对不上就报错。
function compareOrderingKeys(left, right, direction) {
  const leftNull = isNullish(left);
  const rightNull = isNullish(right);
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  if (typeof left !== typeof right) badQuery('排序时两个值的类型对不上');
  let cmp = 0;
  if (left < right) cmp = -1;
  else if (left > right) cmp = 1;
  return direction === 'desc' ? -cmp : cmp;
}

export function createEngine(config = {}) {
  if (!isObject(config) || !isObject(config.tables)) {
    badConfig('createEngine 需要 { tables }，tables 必须是对象');
  }

  const schema = new Map();
  for (const [name, definition] of Object.entries(config.tables)) {
    let columns;
    let rows;
    if (Array.isArray(definition)) {
      rows = definition;
      columns = [];
      for (const row of rows) {
        if (!isObject(row)) badConfig(`表 ${name} 里有行不是对象`);
        for (const key of Object.keys(row)) {
          if (!columns.includes(key)) columns.push(key);
        }
      }
    } else if (isObject(definition)) {
      columns = definition.columns;
      rows = definition.rows;
      if (!Array.isArray(columns) || columns.some((column) => typeof column !== 'string')) {
        badConfig(`表 ${name} 的 columns 必须是字符串数组`);
      }
      if (!Array.isArray(rows)) badConfig(`表 ${name} 的 rows 必须是数组`);
      if (rows.some((row) => !isObject(row))) badConfig(`表 ${name} 里有行不是对象`);
    } else {
      badConfig(`表 ${name} 的定义不合法`);
    }
    schema.set(name, { columns, rows });
  }

  return { execute };

  function execute(query) {
    return runQuery(query, schema);
  }
}

function runQuery(query, schema) {
  if (!isObject(query)) badQuery('query 必须是对象');
  if (typeof query.from !== 'string' || query.from === '') badQuery('query 缺 from');
  const fromName = query.from;
  if (!schema.has(fromName)) unknownTable(fromName);
  const leftTable = schema.get(fromName);

  // join 的形状与右表
  let joinSpec = null;
  if (query.join !== undefined) {
    const join = query.join;
    if (!isObject(join) || typeof join.table !== 'string') {
      badQuery('join 写法不对：要有 table 和 on');
    }
    const type = join.type === undefined ? 'inner' : join.type;
    if (!JOIN_TYPES.includes(type)) badQuery(`join.type 只能是 ${JOIN_TYPES.join(' / ')}`);
    if (!Array.isArray(join.on) || join.on.length === 0) badQuery('join.on 至少要有一个条件');
    const on = join.on.map((clause) => {
      if (!isObject(clause) || typeof clause.left !== 'string' || typeof clause.right !== 'string') {
        badQuery('join.on 的每个条件都要有 left / right');
      }
      const op = clause.op === undefined ? '=' : clause.op;
      if (!CONDITION_OPS.includes(op)) badQuery(`join.on 不支持 op ${op}`);
      return { left: clause.left, right: clause.right, op };
    });
    if (!schema.has(join.table)) unknownTable(join.table);
    joinSpec = { table: join.table, type, on };
  }
  const rightTable = joinSpec ? schema.get(joinSpec.table) : null;
  const joined = !!joinSpec;

  if (
    (query.where !== undefined && (!Array.isArray(query.where) || !query.where.every(conditionShapeOk))) ||
    (query.having !== undefined && (!Array.isArray(query.having) || !query.having.every(conditionShapeOk)))
  ) {
    badQuery('where / having 必须是条件数组，条件形如 { column, op, value }');
  }
  const where = query.where;
  const having = query.having;

  // groupBy / aggregates 的形状
  let groupBy;
  if (query.groupBy !== undefined) {
    if (!Array.isArray(query.groupBy) || query.groupBy.some((column) => typeof column !== 'string')) {
      badQuery('groupBy 必须是列引用数组');
    }
    groupBy = query.groupBy;
  }

  let aggregates;
  if (query.aggregates !== undefined) {
    if (!Array.isArray(query.aggregates)) badQuery('aggregates 必须是数组');
    const aliases = new Set();
    for (const agg of query.aggregates) {
      if (!isObject(agg) || typeof agg.as !== 'string' || agg.as === '' || typeof agg.fn !== 'string') {
        badQuery('每个聚合都要有字符串 as 和 fn');
      }
      if (agg.column !== undefined && typeof agg.column !== 'string') {
        badQuery('聚合的 column 必须是列引用字符串');
      }
      if (agg.distinct !== undefined && typeof agg.distinct !== 'boolean') {
        badQuery('聚合的 distinct 必须是布尔值');
      }
      if (aliases.has(agg.as)) badQuery(`聚合别名 ${agg.as} 重复了`);
      aliases.add(agg.as);
    }
    for (const agg of query.aggregates) {
      if (!AGGREGATES.includes(agg.fn)) badAgg(`不认识的聚合函数 ${agg.fn}`);
      if (agg.fn !== 'count' && !agg.column) badAgg(`${agg.fn} 必须给 column`);
    }
    aggregates = query.aggregates;
  }

  const isAggregate = !!groupBy || !!aggregates;
  const isGrouped = !!groupBy && groupBy.length > 0;

  // select 的形状（聚合查询里 select 会被忽略）
  let select;
  if (!isAggregate && query.select !== undefined) {
    if (!Array.isArray(query.select) || query.select.some((column) => typeof column !== 'string')) {
      badQuery('select 必须是列引用数组');
    }
    select = query.select;
  }

  // orderBy 的形状
  let orderBy;
  if (query.orderBy !== undefined) {
    if (!Array.isArray(query.orderBy)) badQuery('orderBy 必须是数组');
    orderBy = query.orderBy.map((clause) => {
      if (!isObject(clause) || typeof clause.column !== 'string' || clause.column === '') {
        badQuery('orderBy 的每一项都要有 column');
      }
      const direction = clause.direction === undefined ? 'asc' : clause.direction;
      if (direction !== 'asc' && direction !== 'desc') {
        badQuery("orderBy.direction 只能是 'asc' / 'desc'");
      }
      return { column: clause.column, direction };
    });
  }

  // distinct / offset / limit
  if (query.distinct !== undefined && typeof query.distinct !== 'boolean') {
    badQuery('distinct 必须是布尔值');
  }
  const distinct = query.distinct === true;
  const offset = query.offset === undefined ? DEFAULTS.offset : query.offset;
  if (!Number.isInteger(offset) || offset < 0) badQuery('offset 必须是不小于 0 的整数');
  const limit = query.limit === undefined ? DEFAULTS.limit : query.limit;
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    badQuery('limit 必须是 null 或不小于 0 的整数');
  }

  // 列引用解析：有 join 一律 “表名.列名”，没 join 只能写短名。
  function resolveColumn(reference) {
    if (joined) {
      const dot = reference.indexOf('.');
      if (dot <= 0) return unknownColumn(reference);
      const tableName = reference.slice(0, dot);
      const columnName = reference.slice(dot + 1);
      const table = tableName === fromName ? leftTable : tableName === joinSpec.table ? rightTable : null;
      if (!table || !table.columns.includes(columnName)) return unknownColumn(reference);
      return;
    }
    if (reference.includes('.') || !leftTable.columns.includes(reference)) unknownColumn(reference);
  }

  if (where) where.forEach((condition) => resolveColumn(condition.column));
  if (joinSpec) {
    for (const clause of joinSpec.on) {
      if (!leftTable.columns.includes(clause.left)) unknownColumn(`${fromName}.${clause.left}`);
      if (!rightTable.columns.includes(clause.right)) unknownColumn(`${joinSpec.table}.${clause.right}`);
    }
  }
  if (groupBy) groupBy.forEach(resolveColumn);
  if (aggregates) {
    for (const agg of aggregates) {
      if (agg.column) resolveColumn(agg.column);
    }
  }
  if (select) select.forEach(resolveColumn);

  const defaultColumns = joined
    ? [...leftTable.columns.map((column) => `${fromName}.${column}`),
       ...rightTable.columns.map((column) => `${joinSpec.table}.${column}`)]
    : leftTable.columns;
  const outputKeys = isAggregate
    ? [...(groupBy ?? []), ...(aggregates ?? []).map((agg) => agg.as)]
    : select ?? defaultColumns;
  const outputKeySet = new Set(outputKeys);
  if (having) {
    for (const condition of having) {
      if (!outputKeySet.has(condition.column)) unknownColumn(condition.column);
    }
  }
  if (orderBy) {
    for (const clause of orderBy) {
      if (!outputKeySet.has(clause.column)) unknownColumn(clause.column);
    }
  }

  const scanned = leftTable.rows.length;

  return buildPipeline();

  function buildPipeline() {
    // 连接：嵌套循环，左连接给没匹配上的左行补一行右表列全 null。
    let workRows;
    if (joinSpec) {
      workRows = [];
      for (const leftRow of leftTable.rows) {
        let matched = false;
        for (const rightRow of rightTable.rows) {
          const ok = joinSpec.on.every((clause) => onCondition(clause, leftRow, rightRow));
          if (ok) {
            matched = true;
            workRows.push(combine(leftRow, rightRow));
          }
        }
        if (!matched && joinSpec.type === 'left') {
          workRows.push(combine(leftRow, null));
        }
      }
    } else {
      workRows = leftTable.rows.map((row) => {
        const out = {};
        for (const column of leftTable.columns) out[column] = normalize(row[column]);
        return out;
      });
    }

    const joinedCount = workRows.length;

    // where：三值逻辑，只有 true 通过。
    if (where) workRows = workRows.filter((row) => where.every((condition) => conditionPasses(row, condition)));
    const filteredCount = workRows.length;

    let outputRows;
    let groupsCount;

    if (isAggregate) {
      outputRows = aggregateRows(workRows);
      groupsCount = outputRows.length;
    } else {
      outputRows = workRows.map((row) => {
        const out = {};
        for (const key of outputKeys) out[key] = normalize(row[key]);
        return out;
      });
      groupsCount = 0;
    }

    // having 只看输出行的键。
    if (having) {
      outputRows = outputRows.filter((row) => having.every((condition) => conditionPasses(row, condition)));
    }

    // 稳定排序，null / undefined 永远最后（列存在性已在前面按输出键校验过）。
    if (orderBy) {
      const indexed = outputRows.map((row, index) => ({ row, index }));
      indexed.sort((a, b) => {
        for (const clause of orderBy) {
          const cmp = compareOrderingKeys(a.row[clause.column], b.row[clause.column], clause.direction);
          if (cmp !== 0) return cmp;
        }
        return a.index - b.index;
      });
      outputRows = indexed.map((entry) => entry.row);
    }

    // distinct 按整行值去重（列顺序不影响）。
    if (distinct) {
      const seen = new Set();
      outputRows = outputRows.filter((row) => {
        const signature = rowSignature(row);
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      });
    }

    // 顺序：排序 → 去重 → offset → limit。
    if (offset > 0) outputRows = outputRows.slice(offset);
    if (limit !== null) outputRows = outputRows.slice(0, limit);

    return {
      rows: outputRows,
      stats: {
        scanned,
        joined: joinedCount,
        filtered: filteredCount,
        groups: groupsCount,
        returned: outputRows.length,
      },
    };

    function onCondition(clause, leftRow, rightRow) {
      return conditionPasses(
        { [clause.left]: normalize(leftRow[clause.left]) },
        { column: clause.left, op: clause.op, value: normalize(rightRow[clause.right]) },
      );
    }

    function combine(leftRow, rightRow) {
      const out = {};
      for (const column of leftTable.columns) {
        out[`${fromName}.${column}`] = normalize(leftRow[column]);
      }
      for (const column of rightTable.columns) {
        out[`${joinSpec.table}.${column}`] = rightRow === null ? null : normalize(rightRow[column]);
      }
      return out;
    }

    function aggregateRows(rows) {
      if (!isGrouped) {
        const row = {};
        for (const agg of aggregates) row[agg.as] = computeAggregate(rows, agg);
        return [row];
      }

      const buckets = new Map();
      for (const row of rows) {
        const keyValues = groupBy.map((column) => normalize(row[column]));
        const key = groupKey(keyValues);
        if (!buckets.has(key)) buckets.set(key, { keyValues, rows: [] });
        buckets.get(key).rows.push(row);
      }

      const out = [];
      for (const bucket of buckets.values()) {
        const row = {};
        groupBy.forEach((column, index) => {
          row[column] = bucket.keyValues[index];
        });
        for (const agg of aggregates) row[agg.as] = computeAggregate(bucket.rows, agg);
        out.push(row);
      }
      return out;
    }
  }
}
