# seqmerge

同一份文本好几个人一起改：本地改是"在第几个字符上插/删"，改动要能直接发给别人，
别人收到之后不管先后顺序，最后所有人的文本都得一模一样。做法是给每个字符一个稳定 id，
插入挂到锚点字符下面，删除只做墓碑，冲突靠 id 定序。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
seqmerge/
├── lib/
│   ├── replica.js   createReplica 本体                    ← 还没实现
│   └── errors.js    ReplicaError 与全部错误码
├── test/            edit / merge 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 13 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 索引口径

所有 `index` / `length` 都是**当前可见文本**上的下标，单位是 **JS 字符串下标（UTF-16 码元）**，
不是码点。删除过的字符变成墓碑：看不见，但位置还留着，别人锚在它上面的插入也不受影响。

### 字符身份

- 每个字符有自己的 id：`${clientId}:${seq}:${offset}`，比如 `c1:2:0`。
- 一次 `insert` 是一个 op，op 的 id 是 `${clientId}:${seq}`，同一个副本的 `seq` 从 1 开始递增，
  所以同一个副本的 op 天然有先后。
- 新插入的字符挂在一个**锚点**上：插入位置前面那个可见字符的 id；插在最前面（`index === 0`）时
  锚点是 `null`（挂在根上）。一次插入多个字符时，第一个挂锚点，后面每个挂前一个。
- **同一个锚点下面的兄弟**按"seq 大的在前；seq 相同就 clientId 大的在前"排。
  这条规则就是并发插入的定序依据，两边算出来必须一样。
- 文本 = 从根开始按上面这个顺序深度优先走一遍，跳过墓碑。

### 本地编辑

`createReplica({ clientId })`：`clientId` 是不含冒号的非空字符串，否则 `ERR_BAD_CONFIG`。

- `insert(index, text)`：`index` 是 0 ~ 文本长度的整数，`text` 是非空字符串。
  本地立刻生效，返回可以发给别人的 op：

  ```js
  { id: 'c1:1', clientId: 'c1', seq: 1, type: 'insert', after: null,
    chars: [{ id: 'c1:1:0', ch: 'h' }, { id: 'c1:1:1', ch: 'i' }] }
  ```

- `delete(index, length)`：`index` 是 0 ~ 长度减一的整数，`length` 是正整数，
  而且 `index + length` 不能超出现有文本。返回：

  ```js
  { id: 'c1:2', clientId: 'c1', seq: 2, type: 'delete', ids: ['c1:1:0'] }
  ```

  被删的字符只是打上墓碑，`stats().chars` 把它算在内。
- `text` 读当前文本。

### 收别人的 op

`receive(op)`：

- op 的形状不对（`id` / `clientId` / `seq` / `type` / `after` / `chars` / `ids` 有问题）、
  或者 `op.clientId` 就是自己，一律 `ERR_BAD_OP`。
- 每个来源副本的 op 按 `seq` 连续应用：`seq` 比已经应用到的小或相等，算重复投递，
  `duplicates` 加一、返回 `false`、不改文本。
- `seq` 接不上（前面的还没到）就先**压在缓冲里**；锚点字符、或者 delete 要删的字符还没到，
  也先压着。等缺的补上之后自动按顺序落位，不需要调用方做什么。
- 返回值：`true` 表示**这一趟调用之后这个 op 被应用了**，`false` 表示它还在缓冲里或者是重复投递。

同一个 op 被投递多少次都不会生效两次；op 的到达顺序不影响最终文本。

### 统计

`stats()` → `{ clientId, local, received, buffered, duplicates, chars, visible }`：
`local` / `received` 是本地产生、远端应用成功的 op 数（累计），`buffered` 是此刻还压在缓冲里的 op 数，
`chars` 是含墓碑的字符数，`visible` 是可见文本长度。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 配置不是对象、`clientId` 不是不含冒号的非空字符串 |
| `ERR_BAD_OP` | 本地编辑下标/长度不合法；收到的 op 形状不对；收到自己发出去的 op |

## API

```js
import { createReplica, charId, DEFAULTS } from './lib/replica.js';

const a = createReplica({ clientId: 'c1' });
const b = createReplica({ clientId: 'c2' });

const op = a.insert(0, 'hello');   // 本地立刻生效，op 可以直接发出去
a.text;                            // 'hello'
b.receive(op);                     // true，b 也变成 'hello'

const removed = b.delete(0, 2);    // 删 'he'
a.insert(0, 'X');                  // 同时进行的插入
b.receive(...);                    // 两边把对方的 op 收下之后文本必须一致

a.stats();                         // -> { clientId, local, received, buffered, duplicates, chars, visible }
```

出错一律抛 `ReplicaError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里没有随机数，输出每一行都能对上：

```
seqmerge demo
[1] 一个人敲字
    c1 text=hello op=c1:1 chars=hello
[2] 把 op 投给另一个副本
    c2 text=hello
[3] 并发：c1 在最前面插 X，c2 把 hello 删掉
    c2 先收到插入 text=X
[4] 另一条路收到删除，两边一样
    c1 text=X c2 text=X
[5] 乱序到达：先收到 seq=2，只能先压着
    c3 先收 c1:2 -> false buffered=1
    补齐 c1:1 之后 text=Xhello buffered=0
[6] 同一个 op 再投一次不会生效两次
    c2 再收一次 -> false duplicates=1 text=X
[7] 统计
    {"clientId":"c1","local":2,"received":1,"buffered":0,"duplicates":0,"chars":6,"visible":1}
```
