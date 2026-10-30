# cxsign — ChaoxingSignFaker CLI

随地大小签的 agent 友好终端客户端。完整说明见仓库根目录 [`AGENT.md`](../AGENT.md)。

```bash
node bin/cxsign --help
node bin/cxsign schema --json
cd "$(dirname "$0")" && npm test
```

环境变量:`CXSIGN_PHONE` / `CXSIGN_PASSWORD` / `CXSIGN_HOME` / `CXSIGN_JSON` / `CXSIGN_TIMEOUT_MS` / `CXSIGN_RETRIES` / `CXSIGN_VERBOSE` / `CXSIGN_AS` / `CXSIGN_ORT_MODEL`。

## 位置与地图选点

```bash
cxsign activity location --active <id> --json          # 教师设置的目标点/半径/地址 + 推荐坐标
cxsign sign location --active <id> --class <c> --course <k> --auto --json   # dry-run 显示选中的点和理由
cxsign locations search --keyword 燕山大学 --city 秦皇岛 --json   # 输出 bd09
cxsign locations reverse --lat 39.9126 --lon 119.546 --json
cxsign locations convert --lat 39.905 --lon 119.533 --from wgs84 --to bd09 --json
cxsign locations add --label 教室 --search "燕山大学 西校区" --pick 0 --confirm --json
```

范围取中:两点/最小最大 → 中点;多边形 → 面积质心;中心+半径 → 中心;只有高德 `_gd` 坐标 → gcj02 转 bd09;只有地址 → 地理编码(近似)。环境变量 `CXSIGN_BAIDU_AK` 切换百度检索,`CXSIGN_NOMINATIM_URL` 换 Nominatim 实例。

## 群聊实时监听

```bash
cxsign im watch --timeout 20 --json                     # 只连一下
cxsign im watch --interval 10 --notify-cmd 'cat >> ~/signs.ndjson'
cxsign im watch --auto-sign --confirm                   # 自动签到,默认关闭
```

stdout 每行一个 JSON 事件(`connected`/`ready`/`sign`/`disconnected`/`reconnected`/`auto-sign`/`stopped`)。最后一行是标准 envelope。
