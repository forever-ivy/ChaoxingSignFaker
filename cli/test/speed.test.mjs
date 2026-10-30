import { describe, it, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "../src/main.mjs"
import { resetCache, load } from "../src/store.mjs"
import { transport, options, hedgedFetch, request, stats } from "../src/http.mjs"
import * as api from "../src/api.mjs"
import { mapLimit, cachedGeocode, ACTIVITY_SCAN_CONCURRENCY } from "../src/commands.mjs"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-speed-"))
const realFetch = transport.fetch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const resp = (body, status = 200) => new Response(body, { status })
const session = { phoneNumber: "13800000001", password: "ENC", cookies: [{ name: "UID", value: "1", host: "chaoxing.com" }], deviceCode: "x", androidId: "a", puid: 7, user: { puid: 7, uid: 7, name: "n", fidList: [] } }
const fakeClient = (reqFn) => ({ phone: "13800000001", puid: 7, label: "self", req: reqFn, relogin: async () => true })

after(() => { transport.fetch = realFetch; fs.rmSync(ROOT, { recursive: true, force: true }) })

describe("speed: transport", () => {
  beforeEach(() => { options.hedgeMs = 2500; options.retries = 0; stats.hedged = 0 })

  it("hedged GET returns the faster attempt and aborts the slow one", async () => {
    let calls = 0, isSlowAborted = false
    transport.fetch = (url, init) => {
      calls++
      if (calls === 1) return new Promise((_, rej) => init.signal.addEventListener("abort", () => { isSlowAborted = true; rej(new Error("aborted")) }))
      return Promise.resolve(resp("fast"))
    }
    const t = Date.now()
    const r = await hedgedFetch("https://x.chaoxing.com/a", { method: "GET", signal: AbortSignal.timeout(5000) }, 30)
    assert.equal(await r.text(), "fast")
    assert.equal(calls, 2)
    assert.ok(Date.now() - t < 1000)
    await sleep(5)
    assert.equal(isSlowAborted, true)
    assert.equal(stats.hedged, 1)
  })

  it("no hedge when the first answer is quick", async () => {
    let calls = 0
    transport.fetch = async () => { calls++; return resp("ok") }
    const r = await hedgedFetch("https://x.chaoxing.com/a", { method: "GET" }, 50)
    assert.equal(await r.text(), "ok")
    await sleep(80)
    assert.equal(calls, 1)
  })

  it("sign request (noRetry) and POSTs are never hedged or duplicated", async () => {
    options.hedgeMs = 10
    let calls = 0
    transport.fetch = async () => { calls++; await sleep(60); return resp("success") }
    await request(null, { url: "https://mobilelearn.chaoxing.com/pptSign/stuSignajax", noRetry: true, hedge: true })
    await request(null, { method: "POST", url: "https://mobilelearn.chaoxing.com/x", form: "a=1", hedge: true })
    assert.equal(calls, 2)
  })

  it("preSign POST is retried once after a connection reset; plain POST is not", async () => {
    options.retries = 1
    let calls = 0
    transport.fetch = async () => { calls++; if (calls === 1) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }); return resp("ok") }
    const r = await request(null, { method: "POST", url: "https://mobilelearn.chaoxing.com/newsign/preSign", form: "ext=", idempotent: true })
    assert.equal(r.text, "ok")
    assert.equal(calls, 2)
    calls = 0
    await assert.rejects(request(null, { method: "POST", url: "https://mobilelearn.chaoxing.com/x", form: "a" }))
    assert.equal(calls, 1)
  })

  it("--trace adds a timing breakdown without query strings", async () => {
    process.env.CXSIGN_HOME = fs.mkdtempSync(path.join(ROOT, "h-"))
    resetCache()
    transport.fetch = async () => resp(JSON.stringify([]))
    const r = await run(["banlist", "--json", "--trace"])
    const j = JSON.parse(r.stdout)
    assert.equal(j.ok, true)
    assert.ok(j.meta.trace.processStartupMs >= 0)
    assert.equal(j.meta.trace.requests.length, 1)
    assert.ok(!JSON.stringify(j.meta.trace).includes("?"))
  })
})

describe("speed: sign path", () => {
  beforeEach(() => {
    process.env.CXSIGN_HOME = fs.mkdtempSync(path.join(ROOT, "h-"))
    fs.writeFileSync(path.join(process.env.CXSIGN_HOME, "state.json"), JSON.stringify({ loginSession: session }))
    resetCache()
  })

  it("class membership is cached after one course list fetch", async () => {
    let courseCalls = 0
    const c = fakeClient(async (r) => { courseCalls++; return { status: 200, ok: true, text: JSON.stringify({ result: 1, channelList: [{ content: { id: 42 } }] }) } })
    assert.equal(await api.isClassMember(c, 42), true)
    assert.equal(await api.isClassMember(c, 42), true)
    assert.equal(courseCalls, 1)
    assert.equal(await api.isClassMember(c, 99), false)
    assert.equal(courseCalls, 2, "a cache miss for a class not in the list always re-checks")
  })

  it("class cache expires", () => {
    const c = fakeClient(null)
    api.rememberClassIds(c, [{ content: { id: 5 } }], 1000)
    assert.deepEqual(api.cachedClassIds(c, 1000 + 60_000), [5])
    assert.equal(api.cachedClassIds(c, 1000 + api.CLASS_CACHE_TTL_MS + 1), null)
  })

  it("checkSignStatus runs preSign and the class check concurrently, keeping preSign → analysis → analysis2 order", async () => {
    const log = []
    const c = fakeClient(async (r) => {
      const p = new URL(r.url).pathname
      log.push(`start ${p}`)
      await sleep(p.includes("backclazzdata") ? 80 : 20)
      log.push(`end ${p}`)
      if (p.includes("backclazzdata")) return { status: 200, ok: true, text: JSON.stringify({ result: 1, channelList: [{ content: { id: 3 } }] }) }
      if (p === "/pptSign/analysis") return { status: 200, ok: true, text: "code='+'abc123'" }
      return { status: 200, ok: true, text: "" }
    })
    const s = new api.Signer(c, { activeId: 1, classId: 3, courseId: 2 })
    const t = Date.now()
    assert.equal(await s.checkSignStatus(), "READY_TO_SIGN")
    const order = log.filter((x) => x.startsWith("start")).map((x) => x.slice(6))
    assert.deepEqual(order.filter((p) => !p.includes("backclazzdata")), ["/newsign/preSign", "/pptSign/analysis", "/pptSign/analysis2"])
    assert.ok(log.indexOf("start /mycourse/backclazzdata") < log.indexOf("end /newsign/preSign"))
    assert.ok(Date.now() - t < 140)
  })

  it("expired activity still reports SIGN_EXPIRED even if the class check is slow", async () => {
    const c = fakeClient(async (r) => {
      const p = new URL(r.url).pathname
      if (p.includes("backclazzdata")) { await sleep(200); return { status: 200, ok: true, text: JSON.stringify({ result: 1, channelList: [] }) } }
      if (p === "/pptSign/analysis") return { status: 200, ok: true, text: "code='+'ab'" }
      return { status: 200, ok: true, text: p === "/newsign/preSign" ? "下次早点哦" : "" }
    })
    await assert.rejects(new api.Signer(c, { activeId: 1, classId: 3, courseId: 2 }).checkSignStatus(), { code: "SIGN_EXPIRED" })
  })

  it("not a member → SIGN_NO_PERMISSION", async () => {
    const c = fakeClient(async (r) => {
      const p = new URL(r.url).pathname
      if (p.includes("backclazzdata")) return { status: 200, ok: true, text: JSON.stringify({ result: 1, channelList: [{ content: { id: 9 } }] }) }
      if (p === "/pptSign/analysis") return { status: 200, ok: true, text: "code='+'ab'" }
      return { status: 200, ok: true, text: "" }
    })
    await assert.rejects(new api.Signer(c, { activeId: 1, classId: 3, courseId: 2 }).checkSignStatus(), { code: "SIGN_NO_PERMISSION" })
  })

  it("geocode results are cached per provider and address", async () => {
    let calls = 0
    const lookup = async () => { calls++; return { latitude: 1, longitude: 2, provider: "osm", query: "q" } }
    const a = await cachedGeocode("燕山大学西校区", {}, lookup, 1000)
    const b = await cachedGeocode("燕山大学西校区", {}, lookup, 2000)
    assert.equal(calls, 1)
    assert.equal(b.isCached, true)
    assert.equal(a.latitude, b.latitude)
    await cachedGeocode("燕山大学西校区", { baiduAk: "k" }, lookup, 2000)
    assert.equal(calls, 2)
    assert.ok(!JSON.stringify(load().speedCache).includes("\"k\""))
  })

  it("mapLimit keeps result order and caps concurrency", async () => {
    let live = 0, peak = 0
    const r = await mapLimit([...Array(20).keys()], ACTIVITY_SCAN_CONCURRENCY, async (x) => { live++; peak = Math.max(peak, live); await sleep(5); live--; return x * 2 })
    assert.deepEqual(r, [...Array(20).keys()].map((x) => x * 2))
    assert.equal(peak, ACTIVITY_SCAN_CONCURRENCY)
  })
})
