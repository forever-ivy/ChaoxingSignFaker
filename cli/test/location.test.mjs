import { test } from "node:test"
import assert from "node:assert/strict"
import * as geo from "../src/geo.mjs"
import * as api from "../src/api.mjs"
import { resolveSignPosition, rangeCheck } from "../src/commands.mjs"

// 带目标:教师设置了中心点(bd09) + 半径
const WITH_TARGET = { ifopenAddress: 1, locationText: "第一教学楼", locationLatitude: "39.917112", locationLongitude: "119.508123", locationLatitude_gd: "39.911", locationLongitude_gd: "119.501", locationRange: "50" }
// 只有高德坐标
const GD_ONLY = { ifopenAddress: 1, locationText: "图书馆", locationLatitude_gd: "39.911000", locationLongitude_gd: "119.501000", locationRange: 30 }
// 不限位置
const NO_TARGET = { ifopenAddress: 0, locationText: "", locationRange: "" }

const ctxOf = (args) => ({ args: { active: 1, class: 77, course: 9, ...args } })
const deps = (raw, state = {}) => ({ activityTarget: async () => ({ raw, target: geo.resolveSignTarget(raw) }), state: { classSelectedLocation: {}, classRememberedLocation: {}, learnedLocations: {}, locations: [], ...state } })

test("有目标:选中心点,抖动后仍在半径内,地址用教师设置的", async () => {
  for (let i = 0; i < 200; i++) {
    const r = await resolveSignPosition(ctxOf({ auto: true }), null, null, deps(WITH_TARGET))
    assert.equal(r.source, "activity")
    assert.equal(r.pos.address, "第一教学楼")
    assert.equal(r.pos.latitude, 39.917112)
    assert.ok(r.check.insideRadius)
    assert.ok(r.check.distanceMeters <= 50 * 0.3 + 0.5, String(r.check.distanceMeters))
  }
})

test("抖动固定:latitude 参数与 locationResult 一致", () => {
  const p = new api.SignLocation(39.9, 119.5, "x")
  assert.equal(p.randomizedLatitude, p.randomizedLatitude)
  const s = new api.Signer({}, { activeId: 1, classId: 1, courseId: 1 })
  const j = JSON.parse(s.locationJson(p, true))
  assert.equal(j.latitude, Number(p.randomizedLatitude.toFixed(6)))
})

test("小半径时抖动收紧", () => {
  const p = new api.SignLocation(39.9, 119.5, "x", { maxJitterMeters: 3 })
  for (let i = 0; i < 100; i++) { p.rejitter(); assert.ok(geo.distanceMeters({ lat: 39.9, lon: 119.5 }, { lat: p.randomizedLatitude, lon: p.randomizedLongitude }) <= 3.01) }
})

test("只有高德坐标:转为 bd09", async () => {
  const r = await resolveSignPosition(ctxOf({ auto: true }), null, null, deps(GD_ONLY))
  const bd = geo.convert(39.911, 119.501, "gcj02", "bd09")
  assert.ok(Math.abs(r.pos.latitude - bd.lat) < 1e-5 && Math.abs(r.pos.longitude - bd.lon) < 1e-5)
  assert.equal(r.target.radius, 30)
})

test("命令行坐标超出半径:check 标记 outside", async () => {
  const r = await resolveSignPosition(ctxOf({ lat: 39.93, lon: 119.52 }), null, null, deps(WITH_TARGET))
  assert.equal(r.source, "args")
  assert.equal(r.check.insideRadius, false)
  assert.ok(r.check.distanceMeters > 1000)
})

test("无目标 --auto 报 DATA_NOT_FOUND", async () => {
  await assert.rejects(resolveSignPosition(ctxOf({ auto: true }), null, null, deps(NO_TARGET)), (e) => e.code === "DATA_NOT_FOUND")
})

test("无目标:按班级保存 > 记住 > 学到 的顺序回退", async () => {
  const sel = { latitude: 1, longitude: 2, address: "保存" }, rem = { latitude: 3, longitude: 4, address: "记住" }
  const learned = { 77: { clusters: [{ latitude: 5, longitude: 6, address: "学到", count: 4 }] } }
  let r = await resolveSignPosition(ctxOf({}), null, null, deps(NO_TARGET, { classSelectedLocation: { 77: sel }, classRememberedLocation: { 77: rem }, learnedLocations: learned }))
  assert.equal(r.source, "class-selected"); assert.equal(r.pos.address, "保存"); assert.equal(r.check, null)
  r = await resolveSignPosition(ctxOf({}), null, null, deps(NO_TARGET, { classRememberedLocation: { 77: rem }, learnedLocations: learned }))
  assert.equal(r.source, "remembered")
  r = await resolveSignPosition(ctxOf({}), null, null, deps(NO_TARGET, { learnedLocations: learned }))
  assert.equal(r.source, "learned"); assert.equal(r.pos.latitude, 5)
  await assert.rejects(resolveSignPosition(ctxOf({}), null, null, deps(NO_TARGET)), (e) => e.code === "USAGE_ERROR" || /需要/.test(e.message))
})

test("rangeCheck 无半径时 insideRadius 为 null", () => {
  const c = rangeCheck({ latitude: 1, longitude: 1, radius: null }, new api.SignLocation(1, 1, ""))
  assert.equal(c.insideRadius, null)
})
