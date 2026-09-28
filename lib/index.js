// 内存倒排索引：词项 / 短语 / 前缀 / 字段限定 / 布尔组合，BM25 打分。

import { tokenize } from './tokenize.js';
import { IndexError } from './errors.js';

const FIELDS = ['title', 'body', 'tags'];
const ALL_FIELDS = 'title,body,tags';
const K1 = 1.2;
const B = 0.75;
const SNAPSHOT_VERSION = 1;

export function createIndex() {
  // 原始文档（normalize 后的形态），便于 get / snapshot。
  const docs = new Map();
  // 倒排：terms[field][term] = Map(docId -> 位置数组)
  const terms = { title: new Map(), body: new Map(), tags: new Map() };
  // 每篇文档各字段的 token 数：docLen[docId][field]
  const docLen = new Map();
  let totalTokens = 0;

  function fail(code, message, details = {}) {
    throw new IndexError(code, message, details);
  }

  function normalize(doc) {
    const id = doc?.id;
    if (typeof id !== 'string' || id.length === 0) {
      fail('ERR_BAD_DOC', '文档 id 必须是非空字符串', { id });
    }
    const tags = Array.isArray(doc.tags)
      ? doc.tags.map((tag) => String(tag)).join(' ')
      : doc.tags === undefined
        ? ''
        : String(doc.tags);
    return {
      id,
      title: doc.title === undefined ? '' : String(doc.title),
      body: doc.body === undefined ? '' : String(doc.body),
      tags,
    };
  }

  function indexDoc(doc) {
    const lengths = { title: 0, body: 0, tags: 0 };
    for (const field of FIELDS) {
      const tokens = tokenize(doc[field]);
      lengths[field] = tokens.length;
      let table = terms[field];
      for (const { term, position } of tokens) {
        let posting = table.get(term);
        if (!posting) {
          posting = new Map();
          table.set(term, posting);
        }
        let positions = posting.get(doc.id);
        if (!positions) {
          positions = [];
          posting.set(doc.id, positions);
        }
        positions.push(position);
      }
    }
    docLen.set(doc.id, lengths);
    totalTokens += lengths.title + lengths.body + lengths.tags;
    return lengths;
  }

  function removeDoc(id) {
    const lengths = docLen.get(id);
    if (!lengths) fail('ERR_UNKNOWN_DOC', `文档不存在：${id}`, { id });
    for (const field of FIELDS) {
      const table = terms[field];
      for (const [term, posting] of table) {
        if (posting.delete(id) && posting.size === 0) table.delete(term);
      }
    }
    docLen.delete(id);
    docs.delete(id);
    totalTokens -= lengths.title + lengths.body + lengths.tags;
  }

  function add(doc) {
    const normalized = normalize(doc);
    if (docs.has(normalized.id)) {
      fail('ERR_DUP_ID', `文档 id 已存在：${normalized.id}`, { id: normalized.id });
    }
    docs.set(normalized.id, normalized);
    const lengths = indexDoc(normalized);
    return { id: normalized.id, tokens: lengths.title + lengths.body + lengths.tags };
  }

  function update(doc) {
    const normalized = normalize(doc);
    if (!docs.has(normalized.id)) {
      fail('ERR_UNKNOWN_DOC', `文档不存在：${normalized.id}`, { id: normalized.id });
    }
    removeDoc(normalized.id);
    docs.set(normalized.id, normalized);
    const lengths = indexDoc(normalized);
    return { id: normalized.id, tokens: lengths.title + lengths.body + lengths.tags };
  }

  function remove(id) {
    if (typeof id !== 'string' || !docs.has(id)) {
      fail('ERR_UNKNOWN_DOC', `文档不存在：${id}`, { id });
    }
    removeDoc(id);
    return { id };
  }

  function get(id) {
    const doc = docs.get(id);
    return doc ? { ...doc } : null;
  }

  function stats() {
    const uniqueTerms = new Set();
    const mergedPostings = new Map();
    for (const field of FIELDS) {
      for (const [term, posting] of terms[field]) {
        uniqueTerms.add(term);
        let merged = mergedPostings.get(term);
        if (!merged) {
          merged = new Set();
          mergedPostings.set(term, merged);
        }
        for (const id of posting.keys()) merged.add(id);
      }
    }
    let postings = 0;
    for (const ids of mergedPostings.values()) postings += ids.size;
    return { docs: docs.size, terms: uniqueTerms.size, postings, tokens: totalTokens };
  }

  // ---------------- 查询解析 ----------------

  function badQuery(message, details = {}) {
    fail('ERR_BAD_QUERY', message, details);
  }

  // 切成 OR 组：| 只在引号外起作用，组内保留空白分隔的原子。
  function splitGroups(query) {
    const groups = [[]];
    let atom = '';
    const chars = [...query];
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < chars.length && chars[j] !== '"') j += 1;
        if (j === chars.length) badQuery('短语引号没有关上');
        atom += chars.slice(i, j + 1).join('');
        i = j;
        continue;
      }
      if (ch === '|') {
        groups[groups.length - 1].push(atom);
        atom = '';
        groups.push([]);
        continue;
      }
      if (/\s/.test(ch)) {
        groups[groups.length - 1].push(atom);
        atom = '';
        continue;
      }
      atom += ch;
    }
    groups[groups.length - 1].push(atom);
    return groups.map((raw) =>
      raw.map((token) => token.trim()).filter((token) => token.length > 0),
    );
  }

  function parseAtom(raw) {
    let rest = raw;
    let negated = false;
    if (rest.startsWith('-')) {
      negated = true;
      rest = rest.slice(1);
      if (rest.length === 0) badQuery('单独的否定符没有内容');
    }

    let field = null;
    const colon = rest.indexOf(':');
    if (colon !== -1) {
      const name = rest.slice(0, colon).toLowerCase();
      if (!FIELDS.includes(name)) badQuery(`不认识的字段名：${rest.slice(0, colon)}`);
      field = name;
      rest = rest.slice(colon + 1);
      if (rest.length === 0) badQuery('字段限定后面没有查询内容');
    }

    if (rest.startsWith('"')) {
      if (!rest.endsWith('"') || rest.length < 2) badQuery('短语引号没有关上');
      const inner = rest.slice(1, -1);
      if (inner.includes('*')) badQuery('短语里不能有星号');
      const tokens = tokenize(inner).map((token) => token.term);
      if (tokens.length === 0) badQuery('短语里切不出任何词');
      return {
        text: tokens.join(' '),
        kind: 'phrase',
        field,
        negated,
        terms: tokens,
      };
    }

    if (rest.includes('"')) badQuery('引号没有成对出现');

    if (rest.endsWith('*')) {
      const prefix = rest.slice(0, -1);
      if (prefix.length === 0 || prefix.includes('*')) badQuery('星号只能出现在一个词的末尾');
      const tokens = tokenize(prefix).map((token) => token.term);
      if (tokens.length !== 1 || tokens[0] !== prefix) {
        badQuery('前缀只能是一个切得出来的词');
      }
      return { text: `${tokens[0]}*`, kind: 'prefix', field, negated, prefix: tokens[0] };
    }

    if (rest.includes('*')) badQuery('星号只能出现在词尾');

    const tokens = tokenize(rest).map((token) => token.term);
    if (tokens.length === 0) badQuery(`切不出任何词：${rest}`);
    return { text: tokens.join(' '), kind: 'term', field, negated, terms: tokens };
  }

  function parseQuery(query) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      badQuery('查询不能为空');
    }
    const rawGroups = splitGroups(query);
    if (rawGroups.length === 0 || rawGroups.some((group) => group.length === 0)) {
      badQuery('OR 组的一边是空的');
    }
    const groups = rawGroups.map((group) => group.map(parseAtom));
    return groups;
  }

  // ---------------- 查询执行 ----------------

  const fieldsOf = (clause) => (clause.field ? [clause.field] : FIELDS);

  function expandPrefix(prefix, fieldList) {
    const expanded = new Set();
    for (const field of fieldList) {
      for (const term of terms[field].keys()) {
        if (term.startsWith(prefix)) expanded.add(term);
      }
    }
    return [...expanded];
  }

  // 短语必须在同一个字段内位置相邻；返回出现次数。
  function phraseTf(field, phraseTerms, id, firstPositions) {
    const first = firstPositions;
    if (!first) return 0;
    let count = 0;
    for (const start of first) {
      let adjacent = true;
      for (let k = 1; k < phraseTerms.length; k += 1) {
        const positions = terms[field].get(phraseTerms[k])?.get(id);
        if (!positions || !positions.includes(start + k)) {
          adjacent = false;
          break;
        }
      }
      if (adjacent) count += 1;
    }
    return count;
  }

  // 计算一个子句：df（含子句的文档数）、每篇文档的合并 tf、命中文档集合。
  function evalClause(clause) {
    const fieldList = fieldsOf(clause);
    const tfById = new Map();

    const addTf = (id, value) => {
      if (value > 0) tfById.set(id, (tfById.get(id) ?? 0) + value);
    };

    if (clause.kind === 'phrase') {
      for (const field of fieldList) {
        const posting = terms[field].get(clause.terms[0]);
        if (!posting) continue;
        for (const [id, firstPositions] of posting) {
          addTf(id, phraseTf(field, clause.terms, id, firstPositions));
        }
      }
    } else {
      let termList;
      let pool = false;
      if (clause.kind === 'prefix') {
        termList = expandPrefix(clause.prefix, fieldList);
        pool = true;
      } else {
        termList = clause.terms;
        // 裸词切成多个 token（如「周会」）：组内 AND 过滤，但 tf 合并、df 取交集。
        pool = termList.length === 1;
      }

      for (const field of fieldList) {
        for (const term of termList) {
          const posting = terms[field].get(term);
          if (!posting) continue;
          for (const [id, positions] of posting) addTf(id, positions.length);
        }
      }

      if (!pool) {
        // 多 token 词项子句：文档必须在限定字段里含全部 token。
        for (const id of [...tfById.keys()]) {
          const hasAll = termList.every((term) =>
            fieldList.some((field) => terms[field].get(term)?.has(id)),
          );
          if (!hasAll) tfById.delete(id);
        }
      }
    }

    return { tfById, df: tfById.size };
  }

  function bm25(tf, df, dl, avgdl) {
    const idf = Math.log(1 + (docs.size - df + 0.5) / (df + 0.5));
    const norm = 1 - B + (B * dl) / avgdl;
    return (idf * tf * (K1 + 1)) / (tf + K1 * norm);
  }

  function docLength(id, fieldList) {
    const lengths = docLen.get(id);
    return fieldList.reduce((sum, field) => sum + lengths[field], 0);
  }

  function avgDocLength(fieldList) {
    if (docs.size === 0) return 1;
    let sum = 0;
    for (const lengths of docLen.values()) {
      sum += fieldList.reduce((acc, field) => acc + lengths[field], 0);
    }
    const avg = sum / docs.size;
    return avg === 0 ? 1 : avg;
  }

  function search(query, { limit = 20 } = {}) {
    const groups = parseQuery(query);
    const scores = new Map();
    const hitsById = new Map();

    for (const clauses of groups) {
      const evaluated = clauses.map((clause) => ({ clause, result: evalClause(clause) }));
      const positives = clauses.filter((clause) => !clause.negated);

      // 组内 AND：先取正向子句候选，再被否定子句过滤；否定只过滤、不打分。
      let candidates;
      if (positives.length === 0) {
        candidates = new Set(docs.keys());
      } else {
        const positiveEntries = evaluated.filter((entry) => !entry.clause.negated);
        candidates = new Set(positiveEntries[0].result.tfById.keys());
        for (const entry of positiveEntries.slice(1)) {
          for (const id of [...candidates]) {
            if (!entry.result.tfById.has(id)) candidates.delete(id);
          }
        }
      }

      for (const entry of evaluated) {
        if (entry.clause.negated) {
          for (const id of entry.result.tfById.keys()) candidates.delete(id);
        }
      }

      // 过滤完再打分：同一文档命中多个 OR 组时，分数累加。
      for (const { clause, result } of evaluated) {
        if (clause.negated) continue;
        const fieldList = fieldsOf(clause);
        const avgdl = avgDocLength(fieldList);
        for (const id of candidates) {
          const tf = result.tfById.get(id);
          if (tf === undefined) continue;
          scores.set(id, (scores.get(id) ?? 0) + bm25(tf, result.df, docLength(id, fieldList), avgdl));
          const hits = hitsById.get(id) ?? [];
          hits.push({ clause: clause.text, field: clause.field ?? ALL_FIELDS, tf });
          hitsById.set(id, hits);
        }
      }
    }

    const ranked = [...scores.entries()]
      .map(([id, score]) => ({ id, score, hits: hitsById.get(id) }))
      .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const limited = limit === null || limit === undefined ? ranked : ranked.slice(0, limit);
    return limited.map((item) => ({
      id: item.id,
      score: Math.round(item.score * 1e6) / 1e6,
      hits: item.hits,
    }));
  }

  function explain(query) {
    const groups = parseQuery(query);
    const clausesOut = [];
    const candidateIds = new Set();
    for (const clauses of groups) {
      const evaluated = clauses.map((clause) => ({ clause, result: evalClause(clause) }));
      let groupCandidates = null;
      for (const { clause, result } of evaluated) {
        clausesOut.push({
          text: clause.text,
          kind: clause.kind,
          field: clause.field ?? ALL_FIELDS,
          negated: clause.negated,
          df: result.df,
        });
        if (clause.negated) continue;
        if (groupCandidates === null) groupCandidates = new Set(result.tfById.keys());
        else {
          for (const id of [...groupCandidates]) {
            if (!result.tfById.has(id)) groupCandidates.delete(id);
          }
        }
      }
      if (groupCandidates === null) groupCandidates = new Set(docs.keys());
      for (const { clause, result } of evaluated) {
        if (clause.negated) {
          for (const id of result.tfById.keys()) groupCandidates.delete(id);
        }
      }
      if (groupCandidates) for (const id of groupCandidates) candidateIds.add(id);
    }
    return { clauses: clausesOut, candidates: candidateIds.size, groups: groups.length };
  }

  // ---------------- 快照 ----------------

  function snapshot() {
    return { version: SNAPSHOT_VERSION, docs: [...docs.values()].map((doc) => ({ ...doc })) };
  }

  function restore(state) {
    if (!state || state.version !== SNAPSHOT_VERSION || !Array.isArray(state.docs)) {
      fail('ERR_BAD_SNAPSHOT', '快照版本不认识或格式不对');
    }
    docs.clear();
    docLen.clear();
    totalTokens = 0;
    for (const field of FIELDS) terms[field].clear();
    for (const doc of state.docs) {
      const normalized = normalize(doc);
      if (docs.has(normalized.id)) fail('ERR_BAD_SNAPSHOT', '快照里有重复的文档 id');
      docs.set(normalized.id, normalized);
      indexDoc(normalized);
    }
    return { docs: docs.size };
  }

  return { add, update, remove, get, search, explain, stats, snapshot, restore };
}
