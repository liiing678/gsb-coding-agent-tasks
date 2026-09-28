// 内存倒排索引。
//
// 倒排结构：inverted[term][field] = Map(docId -> { positions })
// 每个字段内部位置从 0 开始，短语相邻判定靠它；字段之间不串。

import { tokenize } from './tokenize.js';
import { IndexError } from './errors.js';

const FIELDS = ['title', 'body', 'tags'];
const ALL_FIELDS_TEXT = FIELDS.join(',');
const K1 = 1.2;
const B = 0.75;
const SNAPSHOT_VERSION = 1;

const fail = (code, message) => {
  throw new IndexError(code, message);
};

const normalizeDoc = (doc) => {
  if (!doc || typeof doc.id !== 'string' || doc.id.length === 0) {
    fail('ERR_BAD_DOC', 'id 必须是非空字符串');
  }
  const tags = Array.isArray(doc.tags)
    ? doc.tags.map((tag) => String(tag)).join(' ')
    : doc.tags == null
      ? ''
      : String(doc.tags);
  return {
    id: doc.id,
    title: doc.title == null ? '' : String(doc.title),
    body: doc.body == null ? '' : String(doc.body),
    tags,
  };
};

const fieldTokens = (doc) => {
  const fields = {};
  for (const field of FIELDS) {
    fields[field] = tokenize(doc[field]);
  }
  return fields;
};

const intersectSets = (sets) => {
  if (sets.length === 0) return new Set();
  let result = sets[0];
  for (let i = 1; i < sets.length; i += 1) {
    const next = sets[i];
    const [small, large] = result.size <= next.size ? [result, next] : [next, result];
    const merged = new Set();
    for (const id of small) {
      if (large.has(id)) merged.add(id);
    }
    result = merged;
  }
  return result;
};

export function createIndex() {
  // 归一化后的原文（snapshot 存这些），带上分词缓存 _tokens。
  const docs = new Map();
  // inverted[term][field] = Map(docId -> { positions })
  const inverted = new Map();
  let totalTokens = 0;

  const fieldLen = (doc, fields) => {
    let length = 0;
    for (const field of fields) length += doc._tokens[field].length;
    return length;
  };

  const indexDoc = (doc) => {
    doc._tokens = fieldTokens(doc);
    for (const field of FIELDS) {
      for (const { term, position } of doc._tokens[field]) {
        let byField = inverted.get(term);
        if (!byField) {
          byField = {};
          inverted.set(term, byField);
        }
        let byDoc = byField[field];
        if (!byDoc) {
          byDoc = new Map();
          byField[field] = byDoc;
        }
        let posting = byDoc.get(doc.id);
        if (!posting) {
          posting = { positions: [] };
          byDoc.set(doc.id, posting);
        }
        posting.positions.push(position);
        totalTokens += 1;
      }
    }
  };

  // 摘倒排：删空的 posting 删字段，字段都空了整条 term 删掉，不留壳。
  const unindexDoc = (doc) => {
    for (const field of FIELDS) {
      for (const { term } of doc._tokens[field]) {
        const byField = inverted.get(term);
        const byDoc = byField && byField[field];
        if (!byDoc || !byDoc.has(doc.id)) continue;
        totalTokens -= byDoc.get(doc.id).positions.length;
        byDoc.delete(doc.id);
        if (byDoc.size === 0) {
          delete byField[field];
          if (Object.keys(byField).length === 0) inverted.delete(term);
        }
      }
    }
  };

  const plainDoc = (doc) => ({
    id: doc.id,
    title: doc.title,
    body: doc.body,
    tags: doc.tags,
  });

  // ---------- 查询解析 ----------

  const parseAtom = (raw) => {
    let text = raw;
    let negated = false;
    if (text.charCodeAt(0) === 45) {
      // '-'：否定子句只过滤，不参与打分。
      negated = true;
      text = text.slice(1);
      if (text.length === 0) fail('ERR_BAD_QUERY', '否定子句不能为空');
    }

    let field = null;
    const quoteAt = text.indexOf('"');
    const colonAt = text.indexOf(':');
    if (colonAt !== -1 && (quoteAt === -1 || colonAt < quoteAt)) {
      const name = text.slice(0, colonAt).toLowerCase();
      if (!FIELDS.includes(name)) fail('ERR_BAD_QUERY', `不认识的字段名：${name}`);
      field = name;
      text = text.slice(colonAt + 1);
      if (text.length === 0) fail('ERR_BAD_QUERY', '字段限定后面不能为空');
    }

    if (text.includes('"')) {
      // 必须整体被一对引号包住，引号里切得出词，且短语里不能有星号。
      if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) {
        fail('ERR_BAD_QUERY', '引号位置不合法');
      }
      if (text.includes('*')) fail('ERR_BAD_QUERY', '短语里不能有星号');
      const terms = tokenize(text.slice(1, -1)).map((token) => token.term);
      if (terms.length === 0) fail('ERR_BAD_QUERY', '空短语');
      return { kind: 'phrase', text: terms.join(' '), field, negated, terms };
    }

    const starAt = text.indexOf('*');
    if (starAt !== -1) {
      // 星号只能有一个且紧贴词尾；前缀本体必须恰好切成一个 token。
      if (starAt !== text.length - 1 || text.lastIndexOf('*') !== starAt) {
        fail('ERR_BAD_QUERY', '星号只能出现在词尾');
      }
      const base = text.slice(0, -1);
      const baseTokens = tokenize(base).map((token) => token.term);
      const wordChars = [...base].filter((ch) => /[a-z0-9_]/.test(ch)).length;
      if (baseTokens.length !== 1 || baseTokens[0].length !== wordChars) {
        fail('ERR_BAD_QUERY', '前缀只能是一个 token');
      }
      return {
        kind: 'prefix',
        text: `${baseTokens[0]}*`,
        field,
        negated,
        prefix: baseTokens[0],
      };
    }

    const terms = tokenize(text).map((token) => token.term);
    if (terms.length === 0) fail('ERR_BAD_QUERY', '查询里切不出任何词');
    // 一个裸词切成多个 token（比如没加引号的中文）：合起来当一个词项，
    // 命中要求每个 token 都在（AND），tf 求和、df 按「都含有的文档」算。
    return { kind: 'term', text: terms.join(' '), field, negated, terms };
  };

  // 按 | 切 OR 组（| 只在引号外算数），组内空白分隔的子句全是 AND。
  const parseQuery = (query) => {
    if (typeof query !== 'string' || query.trim().length === 0) {
      fail('ERR_BAD_QUERY', '查询不能为空');
    }
    const groups = [[]];
    let atom = '';
    let inQuote = false;
    const pushAtom = () => {
      if (atom.trim().length > 0) {
        groups[groups.length - 1].push(parseAtom(atom.trim()));
        atom = '';
      }
    };
    for (const ch of [...query]) {
      if (ch === '"') {
        inQuote = !inQuote;
        atom += ch;
      } else if (ch === '|' && !inQuote) {
        pushAtom();
        if (groups[groups.length - 1].length === 0) fail('ERR_BAD_QUERY', '| 一侧为空');
        groups.push([]);
      } else if (/\s/.test(ch) && !inQuote) {
        pushAtom();
      } else {
        atom += ch;
      }
    }
    if (inQuote) fail('ERR_BAD_QUERY', '引号没关上');
    pushAtom();
    if (groups[groups.length - 1].length === 0) fail('ERR_BAD_QUERY', '| 一侧为空');
    return groups;
  };

  // ---------- 子句命中 ----------

  const scopeFields = (clause) => (clause.field ? [clause.field] : FIELDS);

  // 单个词项在限定字段范围内的合计词频：Map(docId -> tf)。
  const termTf = (term, fields) => {
    const result = new Map();
    const byField = inverted.get(term);
    if (!byField) return result;
    for (const field of fields) {
      const byDoc = byField[field];
      if (!byDoc) continue;
      for (const [docId, posting] of byDoc) {
        result.set(docId, (result.get(docId) || 0) + posting.positions.length);
      }
    }
    return result;
  };

  // 短语：同一字段内部位置必须连续递增才算一次，跨字段不拼。
  const phraseTf = (terms, fields) => {
    const result = new Map();
    const first = inverted.get(terms[0]);
    if (!first) return result;
    for (const field of fields) {
      const byDoc = first[field];
      if (!byDoc) continue;
      for (const [docId, posting] of byDoc) {
        let count = 0;
        for (const start of posting.positions) {
          let ok = true;
          for (let offset = 1; offset < terms.length; offset += 1) {
            const byField = inverted.get(terms[offset]);
            const candidate = byField && byField[field] && byField[field].get(docId);
            if (!candidate || !candidate.positions.includes(start + offset)) {
              ok = false;
              break;
            }
          }
          if (ok) count += 1;
        }
        if (count > 0) result.set(docId, (result.get(docId) || 0) + count);
      }
    }
    return result;
  };

  // 前缀展开出的所有词项合起来当一个词项：
  // tf 求和，df 是「含有其中任意一个展开词」的文档数。
  const prefixTf = (prefix, fields) => {
    const result = new Map();
    for (const term of inverted.keys()) {
      if (!term.startsWith(prefix)) continue;
      for (const [docId, freq] of termTf(term, fields)) {
        result.set(docId, (result.get(docId) || 0) + freq);
      }
    }
    return result;
  };

  const matchClause = (clause) => {
    const fields = scopeFields(clause);
    if (clause.kind === 'phrase') return phraseTf(clause.terms, fields);
    if (clause.kind === 'prefix') return prefixTf(clause.prefix, fields);
    if (clause.terms.length === 1) return termTf(clause.terms[0], fields);
    const perTerm = clause.terms.map((term) => termTf(term, fields));
    const docsWithAll = intersectSets(perTerm.map((tf) => new Set(tf.keys())));
    const result = new Map();
    for (const docId of docsWithAll) {
      let freq = 0;
      for (const tf of perTerm) freq += tf.get(docId);
      result.set(docId, freq);
    }
    return result;
  };

  // ---------- BM25 与检索 ----------

  const avgLenCache = new Map();
  const avgDl = (fields) => {
    const key = fields.join(',');
    if (avgLenCache.has(key)) return avgLenCache.get(key);
    const n = docs.size;
    let avg = 1;
    if (n > 0) {
      let sum = 0;
      for (const doc of docs.values()) sum += fieldLen(doc, fields);
      avg = sum / n;
    }
    avgLenCache.set(key, avg);
    return avg;
  };

  const scoreClause = (clause, docId, tf, fields, n, avg) => {
    const idf = Math.log(1 + (n - clause.df + 0.5) / (clause.df + 0.5));
    const dl = fieldLen(docs.get(docId), fields);
    const norm = 1 - B + (B * dl) / avg;
    return (idf * tf * (K1 + 1)) / (tf + K1 * norm);
  };

  const runGroups = (groups) => {
    avgLenCache.clear();
    const scores = new Map();
    const hits = new Map();
    const n = docs.size;

    for (const clauses of groups) {
      const positiveIndexes = [];
      clauses.forEach((clause, index) => {
        if (!clause.negated) positiveIndexes.push(index);
      });
      if (positiveIndexes.length === 0) continue;

      const matches = clauses.map((clause) => {
        const tf = matchClause(clause);
        clause.df = tf.size;
        return tf;
      });

      let candidates = intersectSets(
        positiveIndexes.map((index) => new Set(matches[index].keys())),
      );
      clauses.forEach((clause, index) => {
        if (clause.negated) {
          for (const docId of matches[index].keys()) candidates.delete(docId);
        }
      });

      for (const docId of candidates) {
        let groupScore = 0;
        const docHits = [];
        for (const index of positiveIndexes) {
          const clause = clauses[index];
          const fields = scopeFields(clause);
          const tf = matches[index].get(docId);
          groupScore += scoreClause(clause, docId, tf, fields, n, avgDl(fields));
          docHits.push({
            clause: clause.text,
            field: clause.field || ALL_FIELDS_TEXT,
            tf,
          });
        }
        scores.set(docId, (scores.get(docId) || 0) + groupScore);
        if (!hits.has(docId)) hits.set(docId, []);
        hits.get(docId).push(...docHits);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score: Math.round(score * 1e6) / 1e6, hits: hits.get(id) }))
      .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  const collectCandidates = (groups) => {
    const candidates = new Set();
    for (const clauses of groups) {
      const positive = clauses.filter((clause) => !clause.negated);
      if (positive.length === 0) continue;
      const docsWithAll = intersectSets(
        positive.map((clause) => new Set(matchClause(clause).keys())),
      );
      for (const docId of docsWithAll) {
        let excluded = false;
        for (const clause of clauses) {
          if (clause.negated && matchClause(clause).has(docId)) excluded = true;
        }
        if (!excluded) candidates.add(docId);
      }
    }
    return candidates;
  };

  // ---------- 对外 API ----------

  const add = (rawDoc) => {
    const doc = normalizeDoc(rawDoc);
    if (docs.has(doc.id)) fail('ERR_DUP_ID', `id 已存在：${doc.id}`);
    docs.set(doc.id, doc);
    indexDoc(doc);
    return { id: doc.id, tokens: fieldLen(doc, FIELDS) };
  };

  const update = (rawDoc) => {
    const doc = normalizeDoc(rawDoc);
    const old = docs.get(doc.id);
    if (!old) fail('ERR_UNKNOWN_DOC', `文档不存在：${doc.id}`);
    unindexDoc(old);
    docs.set(doc.id, doc);
    indexDoc(doc);
    return { id: doc.id, tokens: fieldLen(doc, FIELDS) };
  };

  const remove = (id) => {
    const doc = docs.get(id);
    if (!doc) fail('ERR_UNKNOWN_DOC', `文档不存在：${id}`);
    unindexDoc(doc);
    docs.delete(id);
    return { id };
  };

  const get = (id) => {
    const doc = docs.get(id);
    return doc ? plainDoc(doc) : null;
  };

  const search = (query, { limit = 20 } = {}) => {
    const groups = parseQuery(query);
    const ranked = runGroups(groups);
    return limit == null ? ranked : ranked.slice(0, limit);
  };

  const explain = (query) => {
    const groups = parseQuery(query);
    const clauseList = [];
    const candidates = new Set();
    for (const clauses of groups) {
      const matched = clauses.map((clause) => {
        const tf = matchClause(clause);
        clause.df = tf.size;
        return tf;
      });
      const positiveIndexes = [];
      clauses.forEach((clause, index) => {
        if (!clause.negated) positiveIndexes.push(index);
      });
      if (positiveIndexes.length > 0) {
        let groupCandidates = intersectSets(
          positiveIndexes.map((index) => new Set(matched[index].keys())),
        );
        clauses.forEach((clause, index) => {
          if (clause.negated) {
            for (const docId of matched[index].keys()) groupCandidates.delete(docId);
          }
        });
        for (const docId of groupCandidates) candidates.add(docId);
      }
      for (const clause of clauses) clauseList.push(clause);
    }
    return {
      clauses: clauseList.map((clause) => ({
        text: clause.text,
        kind: clause.kind,
        field: clause.field || ALL_FIELDS_TEXT,
        negated: clause.negated,
        df: clause.df,
      })),
      candidates: candidates.size,
      groups: groups.length,
    };
  };

  const stats = () => {
    let postings = 0;
    for (const byField of inverted.values()) {
      // postings 是「词项-文档」对：同一个词在一篇文档的多个字段里出现只算一对。
      const docIds = new Set();
      for (const field of FIELDS) {
        if (byField[field]) {
          for (const docId of byField[field].keys()) docIds.add(docId);
        }
      }
      postings += docIds.size;
    }
    return { docs: docs.size, terms: inverted.size, postings, tokens: totalTokens };
  };

  const snapshot = () => ({
    version: SNAPSHOT_VERSION,
    docs: [...docs.values()].map(plainDoc),
  });

  const restore = (state) => {
    if (!state || state.version !== SNAPSHOT_VERSION || !Array.isArray(state.docs)) {
      fail('ERR_BAD_SNAPSHOT', '快照版本不认识');
    }
    docs.clear();
    inverted.clear();
    totalTokens = 0;
    for (const rawDoc of state.docs) {
      const doc = normalizeDoc(rawDoc);
      if (docs.has(doc.id)) fail('ERR_BAD_SNAPSHOT', `快照里 id 重复：${doc.id}`);
      docs.set(doc.id, doc);
      indexDoc(doc);
    }
    return { docs: docs.size };
  };

  return { add, update, remove, get, search, explain, stats, snapshot, restore };
}
