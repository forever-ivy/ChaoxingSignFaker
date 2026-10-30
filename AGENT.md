# AGENT.md — ChaoxingSignFaker CLI (`cxsign`)

给 agent / 自动化用的非交互命令行。覆盖随地大小签 App 的全部功能(登录、课程、五种签到、验证码、人脸、云盘、课表、群聊发现、代签用户、收藏位置、设备码、公开排行榜)。

协议逻辑移植自 `app/src/main/java/org/aquamarine5/brainspark/chaoxingsignfaker/`(Kotlin/OkHttp)。本 CLI 是纯 Node.js(≥18),零必选依赖;滑块自动识别与图片二维码为可选依赖。

## 安装

```bash
# 在仓库根目录
node cli/bin/cxsign --help
# 或
cd cli && npm link   # 把 cxsign 链到 PATH
```

可选依赖(按需):

```bash
cd cli && npm install          # 装 onnxruntime-node / jsqr / jpeg-js / pngjs
# 验证码模型默认复用 app/src/main/assets/captcha.ort,也可用 CXSIGN_ORT_MODEL 指定
```

## 约定(与 ysu CLI 对齐)

| 项 | 规则 |
|---|---|
| 输出 | 默认人类可读;加 `--json`(或 `CXSIGN_JSON=1`)输出 `{ok,command,data,meta}` / `{ok:false,error}` 信封 |
| 退出码 | 0 成功;1 未知;2 用法;3 需登录/会话过期;4 需人工(验证码);5 网络/超时(可重试);6 业务错误;7 不支持;8 未找到;9 限流;10 dry-run |
| 写操作 | 签到 / 上传 / 排行榜上传 / 登出 / 改配置 / 代签用户增删 等默认 **dry-run**,必须加 `--confirm` 才真正执行;`--dry-run` 优先于 `--confirm` |
| 非交互 | 所有参数用 `--name value`;密码用 `--password-stdin` 或环境变量,永不出现在 argv 日志里 |
| 会话 | `~/.config/cxsign/state.json`(可用 `--home` / `CXSIGN_HOME` 改),目录 0700、文件 0600、原子写入 |
| 机密 | 密码 / cookie / token / enc / validate / 分享 URL **永不**出现在 stdout / stderr / `--verbose` 日志;`users share` 只写到 0600 文件 |
| 重试 | 仅 GET(且非签到请求)对网络错误与 502–504 指数退避重试;签到 / POST 从不重试 |
| 分页 | 列表命令支持 `--limit` / `--offset`(客户端分页,meta.page) |
| 自动重登 | 会话 403 / `result==0` 时用保存的 AES 密码重登一次;`--no-relogin` 关闭 |
| 多账号 | `--as self`(默认)或 `--as <代签手机号>` |

机器可读的完整清单:`cxsign schema --json`。

## 功能 → 命令

| App 功能 | CLI |
|---|---|
| 登录 / 登出 / 重登 / 学校单位 | `auth login` · `auth status [--check]` · `auth logout` · `auth relogin` · `auth schools` · `auth set-fid` |
| 用户资料 | `user info` |
| 课程列表 | `courses list` |
| 签到活动列表 / 近期可签 | `activities list` · `activities available` |
| 活动详情 / preSign 状态 | `activity info` · `activity presign` · `activity location`(目标点/半径/地址) |
| 位置签到 | `sign location [--auto] [--lat --lon --coord] [--favorite] [--face-*] [--captcha-*]` |
| 签到码 / 手势 | `sign password --code` · `sign gesture --code` · `sign-code check` |
| 拍照 / 普通签到 | `sign photo [--image]` |
| 二维码签到 | `sign qrcode --qr` · `qrcode parse` · `qrcode from-image` · `qrcode check-expired` |
| 滑块验证码 | `captcha conf` · `captcha fetch [--predict]` · `captcha check --x` · `captcha model` |
| 云盘上传 | `cloud upload --file` |
| 人脸 | `face profile` · `face list` · `face add` · `face remove` |
| 课表 | `schedule refresh` · `schedule list` · `schedule current` · `schedule recommend` |
| 群聊签到发现 / 实时监听 | `im groups` · `im signs` · `im watch` · `im mute` · `im unmute [--pin]` · `im lists` |
| 代签用户 | `users list` · `users add` · `users import` · `users share --out` · `users remove` · `users relogin` · `users tag` |
| 收藏位置 / 地图选点 | `locations list` · `locations add [--search]` · `locations remove` · `locations remember` · `locations search` · `locations reverse` · `locations convert` |
| 设备码 | `device-code show` · `device-code reset` |
| 公开排行榜 | `rank summary` · `rank top` · `rank me` · `rank upload` |
| 封禁名单 / 捐赠 | `banlist` · `sponsors` |
| 配置 / 统计 | `config get` · `config set` · `stats` · `capabilities` |

## 位置:目标点与范围取中

- 签到接口和 App 内地图都使用 **BD-09(bd09ll)**。CLI 所有输出坐标都是 bd09;`--coord gcj02|wgs84` 可让输入自动转换。
- `sign location` 选点顺序:`--lat/--lon/--location` → `--favorite` → **活动设置的位置**(`--auto` 强制,`--no-auto` 关闭)→ 班级记住的位置。dry-run 的 `plan.position` 给出选中的点和 `reason`。
- 活动位置解析(`getPPTActiveInfo`):
  1. `locationRange`/`locationArea`/`locationPoints`/`locationPolygon` 等若是两点或 min/max → 取**中点**;多边形 → 取**面积质心**。
  2. `locationLatitude/locationLongitude`(bd09)+ `locationRange`(半径米) → 取**中心点**。
  3. 只有 `locationLatitude_gd/_gd`(高德 gcj02) → 转为 bd09 后取中心点。
  4. 坐标为空但 `ifopenAddress=1` 且有 `locationText` → 地理编码该地址(`isApproximate: true`,请核对)。
- 实际提交时仍和 App 一样加 ±0.00005° 随机抖动(半径 100 米内约 ±5 米)。
- 地理编码:设置 `CXSIGN_BAIDU_AK`(百度 Web 服务 ak)则用百度地点检索;否则用 OpenStreetMap Nominatim(WGS-84 → bd09),可用 `CXSIGN_NOMINATIM_URL` 换自建实例。App 内嵌的百度 ak 是 Android SDK 专用,Web API 返回 240,不可用。

## 群聊实时监听 `im watch`

- 用 App 同样的环信 token 接口登录,周期拉取各课程群的 messageroaming(默认 15 秒,`--interval`),解析签到附件,**每个新签到输出一行 NDJSON** `{"type":"sign",...}`;另有 `connected`/`ready`/`disconnected`/`reconnected`/`stopped` 事件。断线指数退避重连(2s 起,最长 5 分钟),401 自动重取 token。
- **只监听活跃群**(默认):启动时并发扫描全部群的最近漫游消息,最近 `--active-days`(默认 30)天内有消息或签到的群才轮询;课程列表里 `state=1`(已结课)或 `isFiled=1`(归档)的课程群(按 `chatid` 对应)直接跳过;扫描失败的群保守地先监听。每 `--rescan-minutes`(默认 60)分钟重新评估,新活跃的群会被加入(`rescan` 事件里的 `added`)。
  - 环信群列表接口不返回加入时间,所以用"最近消息时间"判断。漫游接口每次固定返回最近 50 条,无法再缩小;轮询时只解析比上次游标新的消息,并发请求。
  - 实测 43 个群:6 个最近 7 天内有消息,33 个漫游里没有任何消息,4 个已结课。30 天能跨过一次节假日/考试周的停课,又能排除上学期的老群。
  - 覆盖:`--all` 关闭活跃度过滤(排除列表仍生效);`--group a,b` 强制只监听指定群;`im mute --group` 永久排除,`im unmute --group [--pin]` 取消排除,`--pin` 表示无论活跃与否都监听。
  - `ready` 事件给出 `watched`/`skipped`/`skippedByReason`/`watchedGroups`;`im groups` 显示每个群的 `lastActivity`、`isWatched` 和 `reason`。
- `--timeout <秒>` 到时退出(此命令里单位是秒),`--once` 收到第一条新签到即退出,`--include-existing` 把启动时已有的签到也输出。
- `--notify-cmd '<shell>'`:每个事件执行一次,事件 JSON 走 stdin 和 `CXSIGN_EVENT`。
- `--auto-sign` 默认关闭,**必须同时 `--confirm`**;只会自动做普通签到和位置签到(`--auto` 选点),其余类型输出 skipped。
- App 用原生环信 SDK 的长连接推送;Node 侧没有官方 SDK,CLI 以轮询漫游消息实现,延迟约等于 `--interval`。

## 典型流程

```bash
# 1. 登录(密码走 stdin)
printf %s "$CXSIGN_PASSWORD" | cxsign auth login --phone "$CXSIGN_PHONE" --password-stdin --json

# 2. 看课与近期签到
cxsign courses list --json
cxsign activities available --json

# 3. 位置签到(先 dry-run 看 plan,再 --confirm)
cxsign sign location --active 123 --class 456 --course 789 \
  --lat 30.1 --lon 120.2 --address "教学楼" --json
cxsign sign location --active 123 --class 456 --course 789 \
  --lat 30.1 --lon 120.2 --address "教学楼" --confirm --json

# 4. 遇到 validate_ → 验证码
cxsign captcha fetch --active 123 --class 456 --course 789 --predict --json
# 若模型不可用:打开 shade.jpg,量缺口 x,再
cxsign captcha check --x 142 --json   # 得到 validate
cxsign sign location ... --validate '<validate>' --confirm --json
# 或直接 --captcha-auto / --captcha-x

# 5. 代签
printf %s "$PWD" | cxsign users add --phone 139... --password-stdin --confirm --json
cxsign sign location ... --as 139... --confirm --json
```

## 安全

- 绝不要把 `CXSIGN_PASSWORD`、state.json、分享 URL 文件提交到 git 或贴到聊天。
- `users share` / 导入链接里的 `pwd=` 是 AES 密文,仍然明文密码同等敏感。
- 测试时**禁止**用假密码撞登录接口;写操作必须保持 dry-run。
- 本工具仅供账号所有者在合法授权下使用。

## 源码对应

| CLI 模块 | Kotlin 源 |
|---|---|
| `cli/src/client.mjs` | `api/ChaoxingHttpClient.kt` |
| `cli/src/api.mjs` | `api/Chaoxing{Course,Activity,Sign,Face,CloudDrive,Lesson,IM,Captcha*}Helper.kt` + `signer/*` |
| `cli/src/cxcrypto.mjs` | `encryptByAES` / `desDecrypt` / `decryptClientId` / `randomizedDeviceCode` / face `signToken` |
| `cli/src/image.mjs` | `api/ChaoxingCaptchaPredictor.kt` |
| `cli/src/store.mjs` | `app/src/main/proto/datastore.proto` |

## 测试

```bash
cd cli && npm test
# unit: 加解密 / 解析 / dry-run / 退出码(离线)
# live: rank summary/top、captcha conf、banlist/sponsors(公开只读;CDN 5xx 不硬失败)
```
