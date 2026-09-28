# tokenkeeper 起始环境

会话令牌这块。**要写的那块是空的**：`src/tokens.js` 里的 `createTokenService`
现在只是抛 `NotImplementedError`，其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                      # node --test 跑 test/ 下的用例
node src/server.js --config configs/dev.json  # 起服务（默认读 configs/dev.json）
```

起了服务之后：

```
curl -s -XPOST -d '{"sub":"u1"}' http://127.0.0.1:8080/v1/token
curl -s -XPOST -d '{"refresh_token":"<上一步的 refresh_token>"}' http://127.0.0.1:8080/v1/token/refresh
curl -s -XPOST -d '{"token":"<access_token>"}' http://127.0.0.1:8080/v1/verify
curl -s -XPOST -d '{"token":"<refresh_token>","scope":"session"}' http://127.0.0.1:8080/v1/revoke
curl -s http://127.0.0.1:8080/healthz
```

第三条应该回 `{"valid":true,...}`；把第二条换来的新 refresh 再用一次（也就是拿旧的那把再
refresh 一次），应该回 401 并且 `error` 是 `refresh_replayed`，之后这条会话里所有令牌在
`/v1/verify` 上都不认了。

## 目录

| 路径 | 说明 |
|---|---|
| `src/server.js` | HTTP 入口：路由、JSON 收发、错误 code 到状态码的映射 |
| `src/config.js` | 读配置、校验字段，密钥集合走 `src/keys.js` 归一化 |
| `src/keys.js` | 密钥集合的解析与选取（`normalizeKeys` / `signingKey` / `findKey`） |
| `src/metrics.js` | 计数器 |
| `src/errors.js` | `TokenError` 与错误 code 清单 |
| `src/tokens.js` | **要你写的部分**，`createTokenService({ config, metrics, keys, now, random })` |
| `test/tokens.test.js` | 令牌格式、验签、过期与密钥轮换的用例 |
| `test/refresh.test.js` | refresh 轮换与重放检测的用例 |
| `test/revoke.test.js` | 撤销、上限与会话清理的用例 |
| `test/support/` | 假时钟、定种子伪随机、起服务的小工具 |
| `configs/dev.json` | 本地开发用的配置 |

服务对象上要有这些方法，`server.js` 已经按这个形状在调了：

| 方法 | 说明 |
|---|---|
| `issue({ sub })` | 发一对新令牌，返回 `{ accessToken, refreshToken, sid, accessExpiresAt, refreshExpiresAt }` |
| `refresh({ refreshToken })` | 拿 refresh 换一对新的，返回同上 |
| `verify(token, { typ = 'access' })` | 通过就返回 claims，不通过抛 `TokenError` |
| `revoke({ token, scope = 'token' })` | 撤销，返回 `{ revoked, scope, reason? }` |
| `reloadKeys(rawKeys)` | 换一套密钥（滚动密钥用），原始数组，内部走 `normalizeKeys` |
| `snapshot()` | 返回 `{ signingKid, sessions, revocations, counters }` |

`now` / `random` 都从外面注入，默认是 `() => Date.now()` 和 `Math.random`；实现里不许直接出现
`Date.now`、`new Date`、`Math.random`，测试会塞假时钟和定种子的伪随机进来。

## 配置字段

| 字段 | 说明 |
|---|---|
| `listen.host` / `listen.port` | 监听地址，端口给 0 表示随机 |
| `tokens.issuer` | 签发者，校验时要对得上 |
| `tokens.accessTtlMs` | access token 的有效期 |
| `tokens.refreshTtlMs` | refresh token 的有效期 |
| `tokens.clockSkewMs` | 时钟容差，见下面的过期口径 |
| `tokens.revocationCapacity` | 撤销表里未过期条目的上限 |
| `keys[].kid` / `keys[].secret` | 密钥 id 与密钥内容（HMAC 的 secret，utf-8） |
| `keys[].state` | `active`（在签也用它验）或 `verifyOnly`（只验不签，过渡期用） |
| `keys[].verifyUntil` | `verifyOnly` 的过渡期截止（ISO 时间字符串），`null` 表示不过期 |

`state` 为 `active` 的密钥有且只能有一把。

## 令牌长什么样

三段，用点连起来：

```
base64url(header) . base64url(payload) . base64url(签名)
```

- base64url 一律不带 `=` padding；签名是 `HMAC-SHA256(secret, 前两段原样拼起来)` 的结果，
  这里的「前两段原样拼起来」就是 `base64url(header) + "." + base64url(payload)` 这个字符串。
- `header` = `{"alg":"HS256","typ":"JWT","kid":"<这把密钥的 kid>"}`。
- access 的 `payload` = `{"iss","sub","sid","typ":"access","jti","iat","exp"}`。
- refresh 的 `payload` = `{"iss","sub","sid","typ":"refresh","jti","iat","exp"}`。
- `iat` / `exp` 都是毫秒时间戳，跟 `now()` 一个单位；`sid` 是同一条会话共用的 id，
  `jti` 是这张令牌自己的 id，每张都不一样。
- `iss` 就是配置里的 `tokens.issuer`。

## 口径

### 签发

`issue({ sub })`：`sub` 必须是非空字符串，否则抛 `invalid_request`。发出来的 access 和 refresh
共用一个新建的 `sid`。`exp` 分别是 `iat + accessTtlMs` 和 `iat + refreshTtlMs`。
签名一律用当前 `state === 'active'` 的那把密钥。

### 校验

`verify(token, { typ })` 按这个顺序来，第一个不过的就抛对应的 code（顺序别换，用例按这个断言）：

1. 不是三段、base64url 解不开、JSON 解不开：`invalid_token`。
2. `header.alg` 不是 `HS256`：`invalid_token`；`header.kid` 在当前密钥集合里找不到：`unknown_kid`。
3. 找到的这把是 `verifyOnly` 而且 `verifyUntilMs` 已经过了：`key_expired`。
4. 签名对不上：`bad_signature`。
5. `iss` 跟配置里的 `issuer` 不一样：`wrong_issuer`。
6. `typ` 跟这次要验的类型不一样（比如拿 refresh 当 access 验）：`wrong_typ`。
7. `iat > now + clockSkewMs`：`not_yet_valid`。
8. `now > exp + clockSkewMs`：`expired`。
9. 这张的 `jti` 被单独撤过：`revoked`；这条会话的 `sid` 被撤过：`session_revoked`。

通过就返回 payload（claims），并计一次 `verify_ok_total`；上面任何一步不过都计一次
`verify_rejected_total`。

时钟容差的写法就是 7、8 两条：`iat` 只要没跑到容差外面的未来就算合法，`exp` 到了以后
还要再等 `clockSkewMs` 才算过期。

### 密钥轮换

滚动密钥的时候是「新的上来签、老的留着只验」。`reloadKeys(rawKeys)` 换一整套密钥回去
（`verifyUntilMs` 由 `normalizeKeys` 归一化），下一张签发出来的令牌就要用新的 active 密钥签名，
校验也按新集合来：

- 老密钥（`verifyOnly`）签出来的、还没过期的令牌：过渡期内照样验得过。
- 过了过渡期：`key_expired`。
- 老密钥直接从集合里拿掉：`unknown_kid`。

### refresh 轮换与重放

refresh 的校验顺序跟 `verify` 一样：先把令牌本身看一遍（格式、kid、密钥可用性、签名、
issuer、typ、iat、exp），再看会话状态。所以一张自己已经过期的 refresh，报的是 `expired`，
不是会话作废。

每张 refresh 只能成功换一次：

- 拿会话当前那张来换：发新的一对，老的那张立刻作废，新的那张成为会话当前的那张，
  计 `refresh_ok_total`。
- 拿已经被换掉的老的那张再来（不管中间隔了多久、是不是同时进来）：抛 `refresh_replayed`，
  计 `refresh_replayed_total`，并且**整条会话立刻作废**（计 `session_revoked_total`）——
  已经是发出去的 access 也一起不认了。这是有意的：宁可让客户端重新登录，也不能让抄走的那份
  和手里的这份各跑各的。
- 同一张 refresh 连着来两次：只能成功一次，另一次按重放处理；成功那次换出来的新令牌也会
  随着会话作废而失效。
- 会话已经作废了再拿 refresh 来：`session_revoked`。
- refresh 自己过期了：`expired`。

### 撤销

`revoke({ token, scope })`：

- 令牌本身要能过校验的前 5 步（格式、kid、密钥可用性、签名、issuer），否则抛对应的 code，
  不算撤销成功。已经过期（上面的第 8 步）的令牌不占容量也不报错，直接返回
  `{ revoked: false, scope, reason: 'expired' }`，计 `revoke_skipped_total`。
- `scope = 'token'`：只拉黑这张令牌的 `jti`，拉黑到它的 `exp + clockSkewMs` 为止，
  同一条会话里其它令牌不受影响，计 `token_revoked_total`。
- `scope = 'session'`：拉黑这条会话的 `sid`，这条会话里的 access 和 refresh 全部不认，
  计 `session_revoked_total`。
- 撤销表里未过期的条目到 `revocationCapacity`：不再接受新的撤销，抛
  `revocation_capacity_exceeded`，计 `revocation_rejected_total`。**不许为了塞新条目把还没过期的
  旧条目挤掉**——宁可拒绝新的，也不要把已经撤销过的悄悄放行。过期的条目倒是随时可以清掉。
- 撤销成功返回 `{ revoked: true, scope }`。

撤销条目的寿命就是 `exp + clockSkewMs`：撤单条用的是这张令牌自己的 `exp`，撤整条会话用的是
这条会话 refresh 的 `exp`（会话记录本身也留到那个时候，refresh 一过期就该清掉）。注意别把
容差算两遍：写进表里的截止时间已经含容差了，清理的时候直接跟 `now()` 比就行。

### 会话与内存

服务不用落盘，重启就没了，这是现状。但内存得收敛：

- 每次进服务（`issue` / `refresh` / `verify` / `revoke` 都算）顺手把已经过期的会话和已经过期的
  撤销条目清掉：refresh 也过期了（`exp + clockSkewMs`）的会话再留着没有意义。
- `snapshot()` 里的 `sessions` 是还在跟踪的会话条数，`revocations` 是撤销表里还没过期的
  条目数，`signingKid` 是当前签发用的 kid，`counters` 就是计数器快照。

## 错误 code

| code | 什么时候 |
|---|---|
| `invalid_request` | 参数不对，比如 `sub` 不是非空字符串 |
| `invalid_token` | 格式不对：段数不对、base64url 解不开、JSON 解不开、`alg` 不是 HS256 |
| `unknown_kid` | `kid` 不在当前密钥集合里 |
| `key_expired` | 用的是一把已经过了过渡期的 `verifyOnly` 密钥 |
| `bad_signature` | 签名对不上 |
| `expired` | `now > exp + clockSkewMs` |
| `not_yet_valid` | `iat` 跑到容差外面的未来去了 |
| `wrong_typ` | access / refresh 用错了地方 |
| `wrong_issuer` | `iss` 跟配置对不上 |
| `revoked` | 这张令牌的 `jti` 被单独撤过 |
| `session_revoked` | 这条会话被撤过（显式撤的，或者重放触发的） |
| `refresh_replayed` | 拿已经换掉的 refresh 再来 |
| `revocation_capacity_exceeded` | 撤销表顶到上限了 |

HTTP 那边：`invalid_request` 回 400，`revocation_capacity_exceeded` 回 409，
其它 `TokenError` 回 401，没实现回 501。

## 计数器

`metrics.snapshot()` 里能读到的名字就这些，别改名、也别再发明别的：

| 名字 | 什么时候加 |
|---|---|
| `access_issued_total` | 每发一张 access（含 refresh 换出来的） |
| `refresh_issued_total` | 每发一张 refresh（含轮换换出来的） |
| `refresh_ok_total` | 每次成功用 refresh 换新 |
| `refresh_replayed_total` | 每次拿已经作废的 refresh 再来 |
| `verify_ok_total` | 每次校验通过 |
| `verify_rejected_total` | 每次校验没过（任何一种 code 都算） |
| `token_revoked_total` | 按 `scope = 'token'` 撤销成功 |
| `session_revoked_total` | 会话作废的次数（显式撤销、重放触发都算） |
| `revoke_skipped_total` | 拿已经过期的令牌来撤销、被跳过 |
| `revocation_rejected_total` | 撤销表顶到上限、拒绝新的撤销 |

## 自检

`npm test` 全绿就算过关。三个用例文件里的注释写了每条在验什么。

`configs/dev.json` 和 `test/` 里的用例是评测用的，不要改、不要补、不要删。
