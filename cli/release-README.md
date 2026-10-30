# cxsign — 超星学习通签到 CLI

## 运行方式(三选一)

1. **单文件**(需要 Node.js ≥ 20):`node cxsign.mjs --help`
2. **压缩包** `cxsign-cli-v*.tar.gz` / `.zip`:解压后 `bin/cxsign --help`(Windows: `bin\cxsign.cmd --help`)。
   内含二维码/图片解码依赖和滑块模型;要用 `--captcha-auto`,在解压目录执行 `npm install onnxruntime-node`。
3. **独立可执行文件**(不需要 Node):`cxsign-v*-linux-x64` / `-darwin-arm64` / `-darwin-x64` / `-windows-x64.exe`。
   macOS 首次运行可能需要 `xattr -d com.apple.quarantine <文件>`;Linux/macOS 先 `chmod +x`。
   独立版不含图片解码与滑块识别(`qrcode from-image`、`--captcha-auto` 需用压缩包版)。

## 快速开始

```bash
cxsign login --phone <手机号>            # 密码走 CXSIGN_PASSWORD 或交互输入
cxsign activities pending --json         # 正在进行的签到
cxsign sign location --active <id> --class <c> --course <k> --auto   # 先 dry-run 看选点
cxsign sign location ... --auto --confirm                             # 确认后真正签到
cxsign locations learn --confirm         # 从历史签到学习每门课的位置
```

所有有副作用的命令默认 dry-run,加 `--confirm` 才执行。状态保存在 `~/.config/cxsign`(或 `CXSIGN_HOME`),发布包里不含任何账号数据。
