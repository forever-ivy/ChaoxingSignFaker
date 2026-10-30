import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "../src/main.mjs"
import { resetCache } from "../src/store.mjs"
import { transport, stats, checkResponse } from "../src/http.mjs"
import { toErrorPayload } from "../src/errors.mjs"
import * as geo from "../src/geo.mjs"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-fix-"))
process.env.CXSIGN_HOME = HOME
const realFetch = transport.fetch
after(() => { transport.fetch = realFetch; fs.rmSync(HOME, { recursive: true, force: true }) })

describe("回归:--version / 5xx 错误分类 / 地理编码计数", () => {
  it("--version 输出版本号而不是帮助", async () => {
    const r = await run(["--version"])
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /^cxsign \d+\.\d+\.\d+ \(app /)
    const j = JSON.parse((await run(["--version", "--json"])).stdout)
    assert.equal(j.command, "version")
    assert.ok(j.data.cli)
  })

  it("HTTP 5xx → BACKEND_UNAVAILABLE,exit 6,可重试", () => {
    let err
    try { checkResponse({ ok: false, status: 500, url: "https://x.test/a", text: "oops" }) } catch (e) { err = e }
    const p = toErrorPayload(err)
    assert.equal(p.code, "BACKEND_UNAVAILABLE")
    assert.equal(p.exitCode, 6)
    assert.equal(p.retryable, true)
    assert.equal(p.status, 500)
  })

  it("HTTP 4xx 仍是不可重试的业务错误", () => {
    let err
    try { checkResponse({ ok: false, status: 403, url: "https://x.test/a", text: "" }) } catch (e) { err = e }
    const p = toErrorPayload(err)
    assert.equal(p.code, "BACKEND_BUSINESS_ERROR")
    assert.equal(p.retryable, false)
  })

  it("banlist / sponsors 服务端 500 → 类型化、可重试、带 status", async () => {
    transport.fetch = async (url) => new Response("err", { status: 500, headers: { "content-type": "text/plain" } })
    try {
      for (const cmd of ["banlist", "sponsors"]) {
        resetCache()
        const r = await run([cmd, "--json", "--retries", "0"])
        const e = JSON.parse(r.stdout).error
        assert.equal(r.exitCode, 6, r.stdout)
        assert.equal(e.code, "BACKEND_UNAVAILABLE")
        assert.equal(e.retryable, true)
        assert.equal(e.status, 500)
      }
    } finally { transport.fetch = realFetch }
  })

  it("地理编码请求计入 stats.requests", async () => {
    const before = stats.requests
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] })
    await geo.searchPlaces("燕山大学", { env: {}, fetchImpl })
    await geo.reverseGeocode(39.9, 119.5, { env: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ display_name: "x" }) }) })
    assert.equal(stats.requests - before, 2)
  })

  it("地理编码 HTTP 503 → NETWORK_ERROR 且可重试", async () => {
    await assert.rejects(geo.searchPlaces("x", { env: {}, fetchImpl: async () => ({ ok: false, status: 503 }) }), (e) => toErrorPayload(e).retryable === true)
  })
})
