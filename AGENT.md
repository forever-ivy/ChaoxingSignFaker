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
| 活动详情 / preSign 状态 | `activity info` · `activity presign` |
| 位置签到 | `sign location --lat --lon [--favorite] [--face-*] [--captcha-*]` |
| 签到码 / 手势 | `sign password --code` · `sign gesture --code` · `sign-code check` |
| 拍照 / 普通签到 | `sign photo [--image]` |
| 二维码签到 | `sign qrcode --qr` · `qrcode parse` · `qrcode from-image` · `qrcode check-expired` |
| 滑块验证码 | `captcha conf` · `captcha fetch [--predict]` · `captcha check --x` · `captcha model` |
| 云盘上传 | `cloud upload --file` |
| 人脸 | `face profile` · `face list` · `face add` · `face remove` |
| 课表 | `schedule refresh` · `schedule list` · `schedule current` · `schedule recommend` |
| 群聊签到发现 | `im groups` · `im signs` |
| 代签用户 | `users list` · `users add` · `users import` · `users share --out` · `users remove` · `users relogin` · `users tag` |
| 收藏位置 | `locations list` · `locations add` · `locations remove` · `locations remember` |
| 设备码 | `device-code show` · `device-code reset` |
| 公开排行榜 | `rank summary` · `rank top` · `rank me` · `rank upload` |
| 封禁名单 / 捐赠 | `banlist` · `sponsors` |
| 配置 / 统计 | `config get` · `config set` · `stats` · `capabilities` |

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
