# heapfit

一块定长的区间，自己当成堆来分：空闲块切分、首次 / 最佳适配、释放以后跟左右合并。只用 Node 标准库，
`node >= 20`。不真的去申请内存，读写就是它自己记着（粒度到字节就行）。

```
heapfit/
├── lib/
│   ├── heapfit.js   createHeap 与 alloc / free / 读写 / 快照        ← 还没实现
│   └── errors.js    HeapError 与错误码
├── test/            heap / edge 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 11 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 堆长什么样

- `createHeap({ size, strategy = 'best' })`：`size` 是总字节数（正整数），`strategy` 是 `'first'` 或 `'best'`。
- 堆从头到尾就是一块一块的区域，每块要么占用要么空闲，一路严丝合缝铺满：`dump()` 里第一块的
  `offset` 是 0，块大小加起来正好是 `size`，谁跟谁都不重叠。
- 每块前面有 **8 字节头**，调用方拿不到。所以申请 `n` 字节，真正占掉的是
  `ceil((n + 8) / 8) * 8` 字节，这个数记作 `slot`。
- 返回的指针 = 块的 `offset` + 8。所以指针一定是 8 的倍数，最小是 8 —— `0` 永远不是合法指针。

### 分配

- `alloc(n)`：`n` 是非负整数，`0` 也合法（那就只占一个头）。
- 挑块：`'first'` 挑**第一块**装得下 `slot` 的空闲块；`'best'` 挑装得下的里面**最小**的那块，
  大小一样就取 `offset` 小的。空堆就一整块空闲。
- 挑中以后：如果这块减掉 `slot` 之后**剩不到 16 字节**，就别切了，整块都算它的，多出来那点算浪费；
  剩下的有 16 及以上才切出一块空闲块。
- 一块都挑不出来就抛 `ERR_OUT_OF_MEMORY`，`details.slot` 是这一笔要占的字节数。

### 释放与合并

- `free(p)`：还回去，返回这块的字节数（块大小，含头）。
- 还回去以后要跟**左右相邻的空闲块合并**，合完接着往下合 —— 所以空闲块之间永远不会挨在一起。
- `p` 不是「分配出来、还活着的」指针就是 `ERR_BAD_POINTER`：重复释放、野指针、`0`、没对齐、
  拿字符串或者别的类型来糊弄，都是这个码。

### 读写

- `write(p, data)`：`data` 得是 `Uint8Array`（`Buffer` 本来就是它的子类，算）；
  比这块的容量大就是 `ERR_OUT_OF_BOUNDS`；短的只盖前面那几个字节，后面保持原样。
- `read(p, length = 这块的容量)`：返回一份 `Uint8Array` **拷贝**（改它不影响堆里的那份）；
  `length` 超过容量就是 `ERR_OUT_OF_BOUNDS`。
- 没写过的地方读出来是 0；相邻两块各写各的，不许串味。
- 指针先查：`p` 不活着就是 `ERR_BAD_POINTER`，这时候 `length` / `data` 合不合法轮不到查。

### 快照与统计

- `capacity(p)`：这块当初申请了多少字节。
- `dump()`：按 `offset` 升序给所有块 `{ offset, size, used, capacity }`。占用块的 `capacity`
  是当初要的字节数（一定 `size >= capacity + 8`），空闲块固定是 0。给的是拷贝，改它动不了内部。
- `stats()`：`{ size, used, free, blocks, freeBlocks, largestFree }`。`used` 是占用块的字节和
  （含头），`free` 是空闲字节和，`used + free` 永远等于 `size`；一个空闲块都没有时 `largestFree` 是 0。

### 出错的地方

| 错误码 | 什么时候抛 | `details` |
|---|---|---|
| `ERR_BAD_ARGUMENT` | `createHeap` 的参数不是普通对象、`size` 不是正整数、`strategy` 不是 `first` / `best`；`alloc` 的不是非负整数；`read` 的 `length` 不是非负整数；`write` 的 `data` 不是 `Uint8Array` | `{}` |
| `ERR_OUT_OF_MEMORY` | 没有装得下这一笔的空闲块 | `{ slot }` |
| `ERR_BAD_POINTER` | `free` / `capacity` / `read` / `write` 拿到的不是活着的指针 | `{}` |
| `ERR_OUT_OF_BOUNDS` | 读 / 写的范围超出这块的容量 | `{ requested, capacity }` |

## API

| 入口 | 说明 |
|---|---|
| `createHeap({ size, strategy = 'best' })` | 建堆；建的时候就校验，不合法直接抛 |
| `alloc(n)` | 返回指针；装不下抛 `ERR_OUT_OF_MEMORY` |
| `free(p)` | 还回去，返回块大小 |
| `capacity(p)` | 这块当初申请的字节数 |
| `read(p, length = capacity)` | 返回 `Uint8Array` 拷贝 |
| `write(p, data)` | 写进去 |
| `dump()` | 块列表快照 |
| `stats()` | 计数快照 |

## demo 跑出来应该长这样

```
heapfit demo
  fresh {"size":256,"used":0,"free":256,"blocks":1,"freeBlocks":1,"largestFree":256}
  pointers [8,16,32]
  dump [{"offset":0,"size":8,"used":true,"capacity":0},{"offset":8,"size":16,"used":true,"capacity":8},{"offset":24,"size":32,"used":true,"capacity":24},{"offset":56,"size":200,"used":false,"capacity":0}]
  stats {"size":256,"used":56,"free":200,"blocks":4,"freeBlocks":1,"largestFree":200}
  read [9,2,3,0,0,0,0,0]
  read-short [9,2]
  oob ["ERR_OUT_OF_BOUNDS",{"requested":25,"capacity":24}]
  free 16
  double-free ERR_BAD_POINTER
  after-free [{"offset":0,"size":8,"used":true,"capacity":0},{"offset":8,"size":16,"used":false,"capacity":0},{"offset":24,"size":32,"used":true,"capacity":24},{"offset":56,"size":200,"used":false,"capacity":0}]
  best-fit 464
  first-fit 8
  no-split [{"offset":0,"size":100,"used":true,"capacity":80}]
  out-of-memory ERR_OUT_OF_MEMORY
```