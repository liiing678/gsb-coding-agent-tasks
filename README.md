# lexindex

内存里的倒排索引：支持词项、短语、前缀、字段限定和布尔组合，打分用 BM25，
文档能随时加、改、删。只用 Node 标准库，`node >= 20`。

```
lexindex/
├── lib/
│   ├── index.js     createIndex 本体：倒排、查询、打分       ← 还没实现
│   ├── tokenize.js  分词：字母数字成词，中日韩一字一词（带位置）
│   └── errors.js    IndexError 与全部错误码
├── test/            index / query / snapshot 三组用例
├── scripts/demo.mjs
└── package.json     npm test / npm run demo
```

```
npm test        # 20 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 文档

```js
{ id: 'note-1', title: 'Release notes 3.2', body: 'weekly release notes', tags: ['release'] }
```

- `id` 必须是非空字符串；`title` / `body` 是字符串（缺了当空串），`tags` 是字符串数组
  （不是数组就当字符串，最后都拼成一段文本）。
- 三个字段都进索引，字段之间不互相串（短语不能跨字段命中）。
- **每个字段内部**的位置从 0 开始数，短语查询靠这个位置。
- 同一个 id 加两次报 `ERR_DUP_ID`；改一个不存在的文档报 `ERR_UNKNOWN_DOC`。

### 分词（lib/tokenize.js，已经写好了）

连续的字母数字下划线算一个词，中日韩字符一个字一个词，其它字符都是分隔符；
全部小写化。所以 `周会纪要` 是 `周 / 会 / 纪 / 要` 四个词，`Release-Notes` 是
`release / notes` 两个词。

### 查询语法

| 写法 | 意思 |
|---|---|
| `alpha` | 词项，出现就算命中 |
| `alpha beta` | 空白分隔默认 AND，两个都要有 |
| `alpha \| beta` | 或者，两个 OR 组之间是「或」，组内是「与」 |
| `-alpha` | 排除；否定子句只过滤，不参与打分 |
| `title:alpha` | 只在 title 里找；字段只认 `title` / `body` / `tags` |
| `"alpha beta"` | 短语，位置挨着才算一次命中；可以带字段，`body:"alpha beta"` |
| `alph*` | 前缀，展开成所有以 `alph` 开头的词项 |

- 一个裸词按 tokenize 切成多个 token 时按 AND 处理（`周会` 就是「有周且会有」），
  所以中文查询不用加引号也能用。
- 星号只能出现在词尾，而且前缀只能是一个 token；短语里不能有星号。
- 空的查询、`|` 一边是空的、单独的 `-`、引号没关上、不认识的字段名、切不出词的字符串
  （比如 `!!!`）都报 `ERR_BAD_QUERY`。

### 打分

命中的文档按 BM25 打分，公式写死：

```
idf  = ln(1 + (N - df + 0.5) / (df + 0.5))
单个词项的分 = idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
```

- `k1 = 1.2`，`b = 0.75`。
- `N` 是索引里的文档数；`df` 是含有这个词项的文档数；`tf` 是这个词项在**这篇文档**里出现的次数；
  都按这个子句限定的字段算（没写字段就把三个字段合起来算）。
- `dl` 是这篇文档在这些字段上的 token 数，`avgdl` 是所有文档在这些字段上的平均 token 数
  （索引空的时候当 1，免得除零）。
- 文档分数 = 所有命中的**非否定**子句的分之和；一个文档同时命中多个 OR 组时，各组的分数相加。
- 短语整体当一个词项：`tf` 是短语出现的次数，`df` 是含这个短语的文档数。
- 前缀把展开出来的所有词项合起来当一个词项：`tf` 求和，`df` 是「含有其中任意一个」的文档数。
- 分数四舍五入到 6 位小数（`Math.round(x * 1e6) / 1e6`）。
- 排序：分数从高到低；分数一样按 `id` 升序（不然同一份数据两次查询的顺序会飘）。

### 删除和统计

- `remove` 之后这个文档再也查不到，而且**倒排里不能留空壳**：它的每个词项都要从倒排里摘掉，
  摘空的词项整条删掉。全删光之后 `stats()` 必须是 `{ docs: 0, terms: 0, postings: 0, tokens: 0 }`。
- `stats()`：`docs` 是文档数，`terms` 是词项数，`postings` 是「词项-文档」对数，`tokens` 是所有文档的 token 数之和。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_DOC` | `id` 不是非空字符串 |
| `ERR_DUP_ID` | 这个 id 已经在索引里了 |
| `ERR_UNKNOWN_DOC` | `update` / `remove` 找不到这个文档 |
| `ERR_BAD_QUERY` | 查询写坏了（见上面的清单） |
| `ERR_BAD_SNAPSHOT` | 快照版本不认识 |

## API

```js
import { createIndex } from './lib/index.js';
const index = createIndex();
```

| 方法 | 说明 |
|---|---|
| `add(doc)` | 返回 `{ id, tokens }`；重复 id 报错 |
| `update(doc)` | 换掉整篇文档（重新分词），返回 `{ id, tokens }` |
| `remove(id)` | 返回 `{ id }`；文档不存在报错 |
| `get(id)` | `{ id, title, body, tags }` 或 `null` |
| `search(query, { limit } = {})` | `limit` 默认 20，给 `null` 就是不限 |
| `explain(query)` | `{ clauses: [{ text, kind, field, negated, df }], candidates, groups }` |
| `stats()` | 见《删除和统计》 |
| `snapshot()` / `restore(state)` | 快照是能 `JSON.stringify` 的普通对象（存原始文档），恢复时重建索引 |

`search` 返回的每一项：

```js
{
  id: 'note-1',
  score: 1.015325,
  hits: [ { clause: 'release', field: 'title,body,tags', tf: 3 } ],  // 命中的非否定子句
}
```

`hits` 里 `clause` 是子句的原文（短语是切完词再拼回去的样子，前缀带 `*`），
`field` 是生效的字段（没限定就是 `title,body,tags`），`tf` 是这次命中的词频。

## demo 跑出来应该长这样

`npm run demo` 里的文档和查询都是写死的，分数是 6 位小数，输出每一行都能对上：

```
lexindex demo
[1] 两个词，默认 AND
    release notes: 3 条
      note-1 score=1.015325 release@title,body,tagsx3 notes@title,body,tagsx2
      note-2 score=0.940613 release@title,body,tagsx3 notes@title,body,tagsx1
      note-3 score=0.776916 release@title,body,tagsx1 notes@title,body,tagsx1
[2] 加了引号就要挨着
    "release notes": 1 条
      note-1 score=1.591518 release notes@title,body,tagsx2
    "notes release": 0 条
[3] 字段限定和前缀
    title:release: 3 条
      note-3 score=0.423274 release@titlex1
      note-2 score=0.368264 release@titlex1
      note-1 score=0.325907 release@titlex1
    rel*: 3 条
      note-2 score=0.570977 rel*@title,body,tagsx3
      note-1 score=0.543841 rel*@title,body,tagsx3
      note-3 score=0.388458 rel*@title,body,tagsx1
[4] 或者、排除
    checklist | 周会: 2 条
      note-4 score=1.591518 周 会@title,body,tagsx2
      note-3 score=1.311258 checklist@title,body,tagsx1
    release -slipped: 2 条
      note-1 score=0.543841 release@title,body,tagsx3
      note-3 score=0.388458 release@title,body,tagsx1
[5] explain 说清楚每个词项命中几篇
    release field=title kind=term df=3 negated=false
    notes field=title,body,tags kind=term df=3 negated=false
    候选 3 篇，1 个 or 组
[6] 删掉一篇，倒排里不留东西
    before docs=4 terms=26 postings=30
    after  docs=3 terms=22 postings=24
    release: 2 条
      note-1 score=0.721401 release@title,body,tagsx3
      note-3 score=0.517004 release@title,body,tagsx1
```
