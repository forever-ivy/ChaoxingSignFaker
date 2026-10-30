import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-learn-"))
process.env.CXSIGN_HOME = ROOT
const { clusterPoints, pickLearnedTarget } = await import("../src/learn.mjs")
const api = await import("../src/api.mjs")
const { saveLearned, learnedTarget, learnScan } = await import("../src/commands.mjs")
const { resetCache, load } = await import("../src/store.mjs")
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const P = (lat, lon, extra = {}) => ({ latitude: lat, longitude: lon, address: "A", locationText: "T", activeId: Math.random(), startTime: 1, ...extra })

describe("locations learn", () => {
  it("parseAttendInfo keeps submitted coords and drops empty/-1", () => {
    assert.deepEqual(api.parseAttendInfo({ data: { status: 1, latitude: 39.9, longitude: 119.5, title: "X" } }).latitude, 39.9)
    assert.equal(api.parseAttendInfo({ data: { status: 0, latitude: null, longitude: null } }).latitude, null)
    assert.equal(api.parseAttendInfo({ data: { status: 1, latitude: -1, longitude: -1 } }).latitude, null)
    assert.equal(api.parseAttendInfo({}), null)
  })

  it("clusters nearby points and orders by count", () => {
    const pts = [P(39.9130, 119.5340), P(39.9131, 119.5341), P(39.9132, 119.5339), P(39.9200, 119.5290, { locationText: "U" })]
    const c = clusterPoints(pts, 80)
    assert.equal(c.length, 2)
    assert.equal(c[0].count, 3)
    assert.ok(c[0].spreadMeters < 30)
    assert.deepEqual(c[1].locationTexts, ["U"])
  })

  it("pickLearnedTarget prefers matching locationText, then class top cluster", () => {
    const learned = { 1: { clusters: [{ latitude: 1, longitude: 1, locationTexts: ["a"] }, { latitude: 2, longitude: 2, locationTexts: ["b"] }] }, 9: { clusters: [{ latitude: 9, longitude: 9, locationTexts: ["z"] }] } }
    assert.equal(pickLearnedTarget(learned, { classId: 1, locationText: "b" }).cluster.latitude, 2)
    assert.equal(pickLearnedTarget(learned, { classId: 1, locationText: "z" }).match, "locationText")
    assert.equal(pickLearnedTarget(learned, { classId: 1, locationText: "?" }).match, "class")
    assert.equal(pickLearnedTarget(learned, { classId: 5, locationText: "?" }), null)
  })

  it("saveLearned stores per-class clusters and favorites without clobbering user favorites", () => {
    resetCache()
    const st = load()
    st.locations.push({ label: "历史:课", latitude: 0, longitude: 0, address: "mine" })
    const saved = saveLearned(st, [{ classId: 7, courseId: 8, courseName: "课", favoriteLabel: "历史:课", clusters: [{ latitude: 1, longitude: 2, count: 3, address: "x", locationTexts: ["T"], activeIds: [1] }, { latitude: 3, longitude: 4, count: 1, address: "y", locationTexts: [], activeIds: [2] }] }])
    assert.deepEqual(saved, ["历史:课#2"])
    assert.equal(st.locations.find((l) => l.label === "历史:课").address, "mine")
    assert.equal(st.learnedLocations["7"].clusters[0].count, 3)
    assert.equal(st.learnedLocations["7"].clusters[0].activeIds, undefined)
    const t = learnedTarget(st, { locationText: "T", locationRange: "100", clazzid: 7 }, 7)
    assert.equal(t.source, "learned"); assert.equal(t.radius, 100); assert.equal(t.latitude, 1)
  })

  it("learnScan only reads (GET) and counts usable coordinates", async () => {
    const seen = []
    const now = 2_000_000_000_000
    const c = { phone: "1", puid: 7, label: "self", relogin: async () => true, req: async (r) => {
      seen.push(r.method ?? "GET")
      const json = (o) => ({ ok: true, status: 200, text: JSON.stringify(o), json: () => o })
      if (r.url === api.URL_COURSE_LIST) return json({ result: 1, channelList: [{ cataName: "课程", key: 11, content: { id: 11, name: "C", course: { data: [{ id: 22, name: "课", teacherfactor: "t" }] } } }] })
      if (r.url.startsWith(api.URL_ACTIVITY_LOAD)) return json({ data: { activeList: [
        { id: 1, type: 2, otherId: 4, status: 2, startTime: now - 86400000 }, { id: 2, type: 2, otherId: 4, status: 2, startTime: now - 86400000 },
        { id: 3, type: 2, otherId: 0, status: 2, startTime: now }, { id: 4, type: 2, otherId: 4, status: 2, startTime: now - 400 * 86400000 }] } })
      if (r.url === api.URL_ATTEND_INFO) return json({ data: r.query.activeId === 1 ? { status: 1, latitude: 39.9, longitude: 119.5, title: "X" } : { status: 0, latitude: null } })
      if (r.url === api.URL_SIGN_INFO) return json({ data: { locationText: "T" } })
      throw new Error("unexpected " + r.url)
    } }
    const r = await learnScan({ args: { days: 180 } }, c, now)
    assert.ok(seen.every((m) => m === "GET"))
    assert.equal(r.locationActivities, 2)
    assert.equal(r.withCoordinates, 1)
    assert.equal(r.proposals[0].clusters[0].latitude, 39.9)
  })
})
