#!/bin/sh
# 打包可下载的 cxsign:单文件 cxsign.mjs(Node>=20)+ 压缩包 + bun 独立可执行文件。产物在 cli/release/
set -e
cd "$(dirname "$0")/.."
V=$(node -p 'require("./package.json").version')
OUT=release; rm -rf "$OUT"; mkdir -p "$OUT"
npx --yes esbuild@0.28.2 src/bin.mjs --bundle --platform=node --format=esm --target=node20 --outfile="$OUT/cxsign.mjs" \
  --external:onnxruntime-node --external:jsqr --external:jpeg-js --external:pngjs
P="cxsign-cli-v$V"; D="$OUT/$P"; mkdir -p "$D/bin" "$D/node_modules"
cp "$OUT/cxsign.mjs" "$D/"; cp ../app/src/main/assets/captcha.ort "$D/"
for m in jsqr jpeg-js pngjs; do cp -r "node_modules/$m" "$D/node_modules/"; done
printf '#!/bin/sh\nD="$(cd "$(dirname "$0")/.." && pwd -P)"\nexec node "$D/cxsign.mjs" "$@"\n' > "$D/bin/cxsign"; chmod +x "$D/bin/cxsign"
printf '@echo off\r\nnode "%%~dp0..\\cxsign.mjs" %%*\r\n' > "$D/bin/cxsign.cmd"
cp release-README.md "$D/README.md"
(cd "$OUT" && tar czf "$P.tar.gz" "$P" && python3 -m zipfile -c "$P.zip" "$P")
for t in linux-x64 darwin-arm64 darwin-x64 windows-x64; do
  ext=""; [ "$t" = windows-x64 ] && ext=".exe"
  bun build --compile --target=bun-$t "$OUT/cxsign.mjs" --outfile "$OUT/cxsign-v$V-$t$ext" >/dev/null
done
rm -rf "$D"
(cd "$OUT" && sha256sum cxsign.mjs *.tar.gz *.zip cxsign-v* > SHA256SUMS)
ls -la "$OUT"
