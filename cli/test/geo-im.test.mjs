import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as geo from "../src/geo.mjs"
import { watchIM, backoffMs } from "../src/imwatch.mjs"
import { classifyGroups, parseRoamingMessages } from "../src/api.mjs"
import { run } from "../src/main.mjs"
import { resetCache } from "../src/store.mjs"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-geo-"))
process.env.CXSIGN_HOME = HOME
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

describe("coordinate conversion", () => {
  it("wgs84 -> bd09 matches known Yanshan University point", () => {
    const p = geo.convert(39.9052143, 119.5336655, "wgs84", "bd09")
    near(p.lat, 39.912592, 2e-6); near(p.lon, 119.546017, 2e-6)
  })
  it("round trips within 1e-5 degrees", () => {
    for (const [f, t] of [["bd09", "gcj02"], ["gcj02", "wgs84"], ["bd09", "wgs84"]]) {
      const p = geo.convert(39.9, 119.5, f, t), q = geo.convert(p.lat, p.lon, t, f)
      near(q.lat, 39.9, 1e-5); near(q.lon, 119.5, 1e-5)
    }
  })
  it("outside China wgs84 equals gcj02", () => {
    assert.deepEqual(geo.convert(51.5, -0.12, "wgs84", "gcj02"), { lat: 51.5, lon: -0.12 })
  })
  it("normalizes aliases and rejects unknown", () => {
    assert.equal(geo.normalizeSystem("BD09LL"), "bd09")
    assert.equal(geo.normalizeSystem("GCJ-02"), "gcj02")
    assert.equal(geo.normalizeSystem("gps"), "wgs84")
    assert.throws(() => geo.normalizeSystem("utm"), /未知坐标系/)
  })
})

describe("sign range centre", () => {
  it("centre + radius uses centre", () => {
    const t = geo.resolveSignTarget({ locationLatitude: "39.91", locationLongitude: "119.54", locationRange: "100", locationText: "A" })
    assert.equal(t.method, "center"); assert.equal(t.radius, 100); assert.equal(t.latitude, 39.91); assert.equal(t.address, "A")
  })
  it("two-point range uses midpoint", () => {
    const t = geo.resolveSignTarget({ locationRange: "39.90,119.50;39.92,119.54" })
    assert.equal(t.method, "midpoint"); near(t.latitude, 39.91); near(t.longitude, 119.52)
  })
  it("min/max object uses midpoint", () => {
    const t = geo.resolveSignTarget({ locationArea: { minLat: 39.9, maxLat: 39.92, minLng: 119.5, maxLng: 119.56 } })
    near(t.latitude, 39.91); near(t.longitude, 119.53)
  })
  it("polygon uses area centroid not vertex average", () => {
    const pts = [[39, 119], [39, 121], [41, 121], [41, 119], [40.9, 119]]
    const t = geo.resolveSignTarget({ locationPoints: JSON.stringify(pts.map(([lat, lng]) => ({ lat, lng }))) })
    assert.equal(t.method, "centroid")
    near(t.latitude, 40, 1e-3); near(t.longitude, 120, 1e-3)
  })
  it("lon,lat order is detected", () => {
    const t = geo.resolveSignTarget({ locationRange: [[119.5, 39.9], [119.54, 39.92]] })
    near(t.latitude, 39.91); near(t.longitude, 119.52)
  })
  it("gcj02 _gd centre is converted to bd09", () => {
    const t = geo.resolveSignTarget({ locationLatitude: "", locationLongitude: "", locationLatitude_gd: "39.9", locationLongitude_gd: "119.5", locationRange: "50" })
    const exp = geo.convert(39.9, 119.5, "gcj02", "bd09")
    near(t.latitude, exp.lat, 1e-6); assert.equal(t.radius, 50)
  })
  it("nothing usable returns null", () => {
    assert.equal(geo.resolveSignTarget({ locationLatitude: "", locationLongitude: "", locationRange: "100" }), null)
    assert.equal(geo.resolveSignTarget({ locationLatitude: 0, locationLongitude: 0 }), null)
  })
  it("isInsideRadius", () => {
    const t = { latitude: 39.9, longitude: 119.5, radius: 100 }
    assert.equal(geo.isInsideRadius(t, 39.9005, 119.5), true)
    assert.equal(geo.isInsideRadius(t, 39.902, 119.5), false)
  })
  it("addressVariants strips country/province/town", () => {
    const v = geo.addressVariants("中国河北省秦皇岛市海港区西港镇山东堡路辅路")
    assert.ok(v.includes("秦皇岛市海港区山东堡路"))
  })
})

describe("geocoders (mocked)", () => {
  it("nominatim results are converted to bd09", async () => {
    let url
    const fetchImpl = async (u) => { url = String(u); return { ok: true, json: async () => [{ lat: "39.9052143", lon: "119.5336655", display_name: "燕山大学(东校区), 秦皇岛", name: "燕山大学(东校区)" }] } }
    const r = await geo.searchPlaces("燕山大学", { city: "秦皇岛", env: {}, fetchImpl })
    assert.match(url, /nominatim/)
    assert.equal(r.provider, "nominatim"); assert.equal(r.results[0].coordSystem, "bd09")
    near(r.results[0].latitude, 39.912592, 2e-6)
  })
  it("baidu ak from env uses baidu and keeps bd09", async () => {
    let url
    const fetchImpl = async (u) => { url = String(u); return { ok: true, json: async () => ({ status: 0, results: [{ name: "燕山大学", address: "河北大街", location: { lat: 39.92, lng: 119.55 } }] }) } }
    const r = await geo.searchPlaces("燕山大学", { env: { CXSIGN_BAIDU_AK: "k" }, fetchImpl })
    assert.match(url, /api\.map\.baidu\.com/)
    assert.equal(r.results[0].latitude, 39.92)
  })
  it("baidu error status raises", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 240, message: "APP 服务被禁用" }) })
    await assert.rejects(geo.searchPlaces("x", { env: { CXSIGN_BAIDU_AK: "k" }, fetchImpl }), /240/)
  })
  it("http failure maps to NETWORK_ERROR", async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 })
    await assert.rejects(geo.searchPlaces("x", { env: {}, fetchImpl }), (e) => e.code === "NETWORK_ERROR")
  })
  it("geocodeAddress falls back to shorter variants", async () => {
    const seen = []
    const fetchImpl = async (u) => { const q = new URL(String(u)).searchParams.get("q"); seen.push(q); return { ok: true, json: async () => q === "秦皇岛市海港区山东堡路" ? [{ lat: "39.9", lon: "119.5", display_name: "x" }] : [] } }
    const r = await geo.geocodeAddress("中国河北省秦皇岛市海港区西港镇山东堡路辅路", { env: {}, fetchImpl })
    assert.equal(r.query, "秦皇岛市海港区山东堡路"); assert.ok(seen.length > 1)
  })
})

describe("cli locations", () => {
  it("convert command", async () => {
    resetCache()
    const r = await run(["locations", "convert", "--lat", "39.9052143", "--lon", "119.5336655", "--from", "wgs84", "--json"])
    assert.equal(r.exitCode, 0)
    const d = JSON.parse(r.stdout).data
    assert.equal(d.to, "bd09"); near(d.latitude, 39.912592, 2e-6)
  })
  it("locations add with gcj02 input is dry-run and converted", async () => {
    resetCache()
    const r = await run(["locations", "add", "--label", "x", "--lat", "39.9", "--lon", "119.5", "--coord", "gcj02", "--json"])
    assert.equal(r.exitCode, 10)
    const p = JSON.parse(r.stdout).plan.location
    const e = geo.convert(39.9, 119.5, "gcj02", "bd09")
    near(p.latitude, e.lat, 1e-6); assert.equal(p.coordSystem, "bd09")
  })
  it("im watch --auto-sign without --confirm is a usage error", async () => {
    resetCache()
    const r = await run(["im", "watch", "--auto-sign", "--json"])
    assert.equal(JSON.parse(r.stdout).error.code, r.exitCode === 2 ? "USAGE" : JSON.parse(r.stdout).error.code)
    assert.notEqual(r.exitCode, 0)
  })
  it("schema lists new commands", () => {
    resetCache()
    return run(["schema", "--json"]).then((r) => {
      const names = JSON.parse(r.stdout).data.commands.map((c) => c.name)
      for (const n of ["activity location", "locations search", "locations reverse", "locations convert", "im watch"]) assert.ok(names.includes(n), n)
    })
  })
})

function fakeClock() {
  let t = 1_700_000_000_000
  return { now: () => t, sleep: async (ms) => { t += ms } }
}
const DAY = 86400000
const res = (signs = [], lastMessageTs = 0) => ({ signs, messageCount: signs.length, newCount: signs.length, lastMessageTs, lastSignTs: signs.reduce((a, x) => Math.max(a, x.messageTimestamp || 0), 0) })

describe("group activity filter", () => {
  const now = 1_700_000_000_000
  const groups = ["a", "b", "c", "d", "e"].map((groupId) => ({ groupId, name: groupId }))
  const activity = { a: res([], now - 2 * DAY), b: res([], now - 40 * DAY), c: res([], 0), d: res([], now - DAY), e: res([], now - DAY) }
  const courses = { e: { isEnded: true } }
  it("default keeps only recently active, non-ended groups", () => {
    const r = Object.fromEntries(classifyGroups(groups, { activity, courses, now }).map((g) => [g.groupId, g.reason]))
    assert.deepEqual(r, { a: "active", b: "inactive", c: "no-recent-messages", d: "active", e: "course-ended" })
  })
  it("--active-days widens the window", () => {
    const g = classifyGroups(groups, { activity, courses, now, activeDays: 60 }).find((x) => x.groupId === "b")
    assert.equal(g.isWatched, true)
  })
  it("--all ignores activity but mute still wins; pin forces", () => {
    const r = classifyGroups(groups, { activity, courses, now, isAll: true, muted: ["a"], pinned: [] })
    assert.deepEqual(r.filter((g) => g.isWatched).map((g) => g.groupId), ["b", "c", "d", "e"])
    const p = classifyGroups(groups, { activity, courses, now, pinned: ["c"], muted: ["d"] })
    assert.deepEqual(p.filter((g) => g.isWatched).map((g) => g.groupId), ["a", "c"])
  })
  it("--group forces exactly those groups even if muted or inactive", () => {
    const r = classifyGroups(groups, { activity, now, forced: ["b"], muted: ["b"] })
    assert.deepEqual(r.filter((g) => g.isWatched).map((g) => g.groupId), ["b"])
  })
  it("sign timestamp counts as activity", () => {
    const r = classifyGroups([{ groupId: "x" }], { activity: { x: { lastMessageTs: 0, lastSignTs: now - DAY } }, now })
    assert.equal(r[0].isWatched, true)
  })
  it("parseRoamingMessages skips messages older than cursor", () => {
    const r = parseRoamingMessages([], { groupId: "g" }, { since: 5 })
    assert.equal(r.messageCount, 0); assert.equal(r.lastMessageTs, 0)
  })
})

describe("im watch (mocked)", () => {
  const act = (id, ts = 1_700_000_000_000) => ({ activeId: id, title: "签到", classId: 1, courseId: 2, courseName: "C", startTimeTitle: "10-30 10:00", activeTypeName: "位置签到", signType: "location", groupId: "g", groupName: "G", messageTimestamp: ts })
  const base = (clk, lines, extra = {}) => ({
    ...clk, noSignals: true, write: (l) => lines.push(JSON.parse(l)), getCourses: async () => [],
    getConfig: async () => ({ accessToken: "SECRET", username: "u" }), getGroups: async () => [{ groupId: "g", name: "G" }, { groupId: "old", name: "Old" }], ...extra,
  })
  it("only polls active groups, ready reports watched/skipped, emits new signs once", async () => {
    const clk = fakeClock(); const lines = []; const polled = []; let n = 0
    const r = await watchIM({ args: { interval: 5, once: true, timeout: 600 } }, {}, base(clk, lines, {
      fetchMessages: async (im, g, o) => {
        polled.push([g.groupId, o.since ?? 0])
        if (g.groupId === "old") return res([], clk.now() - 100 * DAY)
        return ++n < 3 ? res([act(1)], clk.now()) : res([act(1), act(2)], clk.now())
      },
    }))
    const ready = lines.find((l) => l.type === "ready")
    assert.equal(ready.watched, 1); assert.equal(ready.skipped, 1); assert.deepEqual(ready.skippedByReason, { inactive: 1 })
    assert.equal(polled.filter(([g]) => g === "old").length, 1)
    assert.ok(polled.filter(([g]) => g === "g").slice(1).every(([, since]) => since > 0))
    assert.deepEqual(lines.filter((l) => l.type === "sign").map((s) => s.activeId), [2])
    assert.equal(r.stopped, "once")
    assert.ok(!JSON.stringify(lines).includes("SECRET"))
  })
  it("ended courses are skipped via chatId", async () => {
    const clk = fakeClock(); const lines = []
    await watchIM({ args: { interval: 5, timeout: 4 } }, {}, base(clk, lines, {
      getCourses: async () => [{ chatId: "g", isEnded: true }],
      fetchMessages: async (im, g) => res([], g.groupId === "g" ? clk.now() : 0),
    }))
    assert.deepEqual(lines.find((l) => l.type === "ready").skippedByReason, { "course-ended": 1, "no-recent-messages": 1 })
  })
  it("rescan picks up a group that became active", async () => {
    const clk = fakeClock(); const lines = []; const start = clk.now()
    await watchIM({ args: { interval: 60, timeout: 3 * 3600, "rescan-minutes": 60 } }, {}, base(clk, lines, {
      fetchMessages: async (im, g) => (g.groupId === "old" && clk.now() - start > 30 * 60000 ? res([act(5)], clk.now()) : res([], g.groupId === "g" ? clk.now() : 0)),
    }))
    const rs = lines.filter((l) => l.type === "rescan")
    assert.ok(rs.length >= 1); assert.deepEqual(rs[0].added, ["old"])
    assert.ok(lines.some((l) => l.type === "sign" && l.activeId === 5))
  })
  it("muted list and --all", async () => {
    const clk = fakeClock(); const lines = []
    await watchIM({ args: { interval: 5, timeout: 4, all: true } }, {}, base(clk, lines, { lists: { muted: ["g"], pinned: [] }, fetchMessages: async () => res([], 0) }))
    const ready = lines.find((l) => l.type === "ready")
    assert.equal(ready.watched, 1); assert.equal(ready.watchedGroups[0].groupId, "old"); assert.deepEqual(ready.skippedByReason, { muted: 1 })
  })
  it("include-existing emits history", async () => {
    const clk = fakeClock(); const lines = []
    await watchIM({ args: { interval: 5, timeout: 4, "include-existing": true } }, {}, base(clk, lines, { fetchMessages: async (im, g) => res(g.groupId === "g" ? [act(7)] : [], clk.now()) }))
    assert.equal(lines.filter((l) => l.type === "sign")[0].existing, true)
  })
  it("reconnects with backoff after failures", async () => {
    const clk = fakeClock(); const lines = []; let n = 0
    const r = await watchIM({ args: { interval: 10, timeout: 60 } }, {}, base(clk, lines, {
      getConfig: async () => { if (++n <= 2) throw Object.assign(new Error("boom"), { code: "NETWORK_ERROR" }); return { accessToken: "t", username: "u" } },
      fetchMessages: async () => res([], 0),
    }))
    assert.deepEqual(lines.filter((l) => l.type === "disconnected").map((x) => x.retryInMs), [2000, 4000])
    assert.equal(r.isConnected, true)
  })
  it("401 on poll forces re-login", async () => {
    const clk = fakeClock(); const lines = []; let cfg = 0, f = 0
    await watchIM({ args: { interval: 5, timeout: 30, group: "g" } }, {}, base(clk, lines, {
      getConfig: async () => { cfg++; return { accessToken: "t", username: "u" } },
      fetchMessages: async () => { if (++f === 2) throw Object.assign(new Error("HTTP 401"), { status: 401 }); return res([], clk.now()) },
    }))
    assert.ok(cfg >= 2); assert.ok(lines.some((l) => l.type === "reconnected"))
  })
  it("notify-cmd and autoSign hooks run per event", async () => {
    const clk = fakeClock(); const lines = []; const notified = []; const signed = []; let poll = 0
    await watchIM({ args: { interval: 5, once: true, timeout: 100, "notify-cmd": "cat", group: "g" } }, {}, base(clk, lines, {
      fetchMessages: async () => (++poll === 1 ? res([], clk.now()) : res([act(9)], clk.now())),
      notify: async (cmd, ev) => { notified.push([cmd, ev.activeId]); return { exitCode: 0 } },
      autoSign: async (ev) => { signed.push(ev.activeId); return { ok: true } },
    }))
    assert.deepEqual(notified, [["cat", 9]]); assert.deepEqual(signed, [9])
  })
  it("backoff caps", () => {
    assert.equal(backoffMs(1, 1000), 1000); assert.equal(backoffMs(4, 1000), 8000); assert.equal(backoffMs(30, 1000), 300000)
  })
})

describe("im mute/unmute", () => {
  it("dry-run then confirm persists lists", async () => {
    resetCache()
    let r = await run(["im", "mute", "--group", "123", "--json"])
    assert.equal(r.exitCode, 10)
    resetCache(); r = await run(["im", "mute", "--group", "123", "--confirm", "--json"])
    assert.equal(r.exitCode, 0); assert.deepEqual(JSON.parse(r.stdout).data.muted, ["123"])
    resetCache(); r = await run(["im", "unmute", "--group", "123", "--pin", "--confirm", "--json"])
    assert.deepEqual(JSON.parse(r.stdout).data, { muted: [], pinned: ["123"] })
    resetCache(); r = await run(["im", "lists", "--json"])
    assert.deepEqual(JSON.parse(r.stdout).data.pinned, ["123"])
  })
})
