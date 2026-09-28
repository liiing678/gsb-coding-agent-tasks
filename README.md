# reqsign

请求签名：把一次请求（方法、路径、查询串、请求头、正文）按钉死的口径规范化成一段字符串，
再拿派生的签名密钥签出来，最后拼成 `Authorization` 头，或者拼成一个预签名的 URL。
路子跟 AWS 的 SigV4 是一套，规则以这份 README 为准。只用 Node 标准库，`node >= 20`。

```
reqsign/
├── lib/
│   ├── reqsign.js   canonicalRequest / sign / presign   ← 还没实现
│   └── errors.js    ReqsignError 与全部错误码
├── test/            canonical / sign 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 10 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 编码

只留 `A-Za-z0-9-._~` 这几种，别的（包括空格、`*`、`!`、`'`、`(`、`)`）一律按 UTF-8 编成
`%XX`，十六进制字母**大写**。注意 `encodeURIComponent` 不会编码 `!'()*`，这四个得自己补上。

- **路径**：按 `/` 切开，**每段各自编码**，段之间的 `/` 留着，空的段也留着（`//` 不折叠）。
  不给路径就是 `/`；给了就得是 `/` 开头的字符串。
- **查询串**：`query` 是 `{ 名: 值 | [值, ...] }`，名和值都按上面那套编码；
  值为 `null` / `undefined` 或者空串都算空串（编出来是 `名=`）。排完序用 `&` 连成一行：
  先按**编码后的名**比字典序，名一样再按**编码后的值**比；名相同、值相同的多条都留着，别去重。
  不给 `query` 就是空串。
  比的是字符串本身（UTF-16 码元顺序），所以大写开头的 `X-Amz-*` 会排在全部小写名前面。

### 请求头

`headers` 是 `{ 名: 值 | [值, ...] }`：

- 名字一律按**小写**看：`Host` 和 `host` 是同一个头，同一个头出现两次（哪怕大小写写得不一样）
  就把值按出现顺序用 `,` 接起来。
- 值先去掉首尾空白，再把中间的连续空白（空格 / 制表 / 换行）压成一个空格；数组按顺序用 `,` 连，
  **数组内部不排序**。
- `authorization`、`user-agent` 这两个头不参与签名（`DEFAULTS.unsigned`），写了也当没看见。
- `headers` 里**必须有 `host`**，少了就报错。
- 参与签名的头按名字排字典序，每行 `名:值`，行尾换行；`SignedHeaders` 就是这些名字用 `;` 连起来。

### 正文

- `payload` 不给就当空串，`payloadHash` 是空串的 sha256
  （`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）。
- `payload` 给了就得是字符串，算它的 sha256（十六进制小写）。
- `payload: UNSIGNED_PAYLOAD`（导出的常量 `'UNSIGNED-PAYLOAD'`）就原样写进 `payloadHash`。

### 时间与密钥

- `timestamp` 收 `Date`、epoch 毫秒的数字、或者能解析出时间的字符串；结果统一转成 UTC，
  再取 `YYYYMMDDTHHMMSSZ`（`amzDate`）和 `YYYYMMDD`（`date`）两段。解析不出来就报错。
- `credentials` 是 `{ accessKeyId, secretAccessKey, region, service }`，四个都得是非空字符串。
- 范围（scope）是 `<date>/<region>/<service>/aws4_request`。
- 签名密钥是这一串 HMAC：
  `AWS4<secret>` → `date` → `region` → `service` → `aws4_request`，每步都用 sha256 的 HMAC、
  输入是上一步的**字节**（不是十六进制）。

### 规范请求与签名串

`canonicalRequest(request)` 就是这几行拼起来（`\n` 连接，注意请求头那段后面还有一行空的）：

```
大写的方法
编码后的路径
排好序的查询串
名:值
名:值
（这一行是空的）
SignedHeaders
payloadHash
```

`stringToSign` 是四行：

```
AWS4-HMAC-SHA256
amzDate
scope
sha256(规范请求)      <- 十六进制小写
```

签名就是 `hex(HMAC(signingKey, stringToSign))`。

## API

```js
import { canonicalRequest, sign, presign, UNSIGNED_PAYLOAD, DEFAULTS } from './lib/reqsign.js';

const request = {
  method: 'post',
  path: '/v1/items/中文 name',
  query: { b: '2', a: ['1', '3'], empty: '' },
  headers: { Host: 'api.example.com', 'Content-Type': 'text/plain; charset=utf-8' },
  payload: 'hello',
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    region: 'cn-north-1',
    service: 'demo',
  },
  timestamp: '2013-05-24T00:00:00Z',
};

canonicalRequest(request);   // -> 规范请求那段字符串

sign(request);
// -> {
//      method, path, query, payloadHash, signedHeaders, scope,
//      canonicalRequest, stringToSign, signature,
//      authorization: 'AWS4-HMAC-SHA256 Credential=<ak>/<scope>, SignedHeaders=<...>, Signature=<hex>',
//    }

presign(request);
// -> { url, query, path, signedHeaders, payloadHash, scope, canonicalRequest, stringToSign,
//      signature, expires }
```

`presign` 的口径：

- 查询串里补上 `X-Amz-Algorithm`（`AWS4-HMAC-SHA256`）、`X-Amz-Credential`
  （`<accessKeyId>/<scope>`）、`X-Amz-Date`、`X-Amz-Expires`、`X-Amz-SignedHeaders`
  这几条，**和调用方给的查询串一起排序**之后再当规范请求算签名；
- 正文一律按 `UNSIGNED-PAYLOAD` 算；
- 算出来的签名**追加在查询串最后**：`X-Amz-Signature=<hex>`，`url` 就是
  `编码后的路径 + '?' + 那串查询`；
- `expires` 不给自己取 `DEFAULTS.maxExpires`（604800 秒，七天），给了得是正整数且不能超上限。

出错一律抛 `ReqsignError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_REQUEST` | 请求形状不对：不是对象、`method` 不是非空字符串、`path` 不是字符串或不以 `/` 开头、`query` / `headers` 不是对象、头或查询的值不是字符串（`null` 当空串不算错）、`headers` 里没有 `host`、`payload` 既不是字符串也不是 `UNSIGNED-PAYLOAD` |
| `ERR_BAD_CREDENTIALS` | `credentials` 不是对象，或者四个字段里有不是非空字符串的 |
| `ERR_BAD_TIMESTAMP` | `timestamp` 没给，或者解析不出一个合法时间 |
| `ERR_BAD_ARGS` | `presign` 的 `expires` 不是正整数，或者超过 `DEFAULTS.maxExpires` |

## demo 跑出来应该长这样

```
reqsign demo
  canonical "POST\n/v1/items/%E4%B8%AD%E6%96%87%20name\na=1&a=3&b=2&empty=&star=%2A\ncontent-type:text/plain; charset=utf-8\nhost:api.example.com\nx-trace:t2,t1\n\ncontent-type;host;x-trace\n2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  signedHeaders content-type;host;x-trace
  scope 20130524/cn-north-1/demo/aws4_request
  stringToSign "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/cn-north-1/demo/aws4_request\n864e9e2374b77276171dca031b8c558709d7801e7b73300374069d70c57bf13a"
  signature f8643d9a753e950d0ca4f86a157b5b7db8f87b1c040379a2219c9a3b0b5d36c6
  authorization AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/cn-north-1/demo/aws4_request, SignedHeaders=content-type;host;x-trace, Signature=f8643d9a753e950d0ca4f86a157b5b7db8f87b1c040379a2219c9a3b0b5d36c6
  presignUrl /v1/items/%E4%B8%AD%E6%96%87%20name?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20130524%2Fcn-north-1%2Fdemo%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=content-type%3Bhost%3Bx-trace&a=1&a=3&b=2&empty=&star=%2A&X-Amz-Signature=12f2cd494bd0d39aa40013837df90ff21e790043324fa314302ff988f84cfffe
  presignSignature 12f2cd494bd0d39aa40013837df90ff21e790043324fa314302ff988f84cfffe
  presignExpires 604800
  unsignedPayload UNSIGNED-PAYLOAD
  maxExpires 604800
```
