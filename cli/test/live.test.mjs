import { describe, it } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { run } from "../src/main.mjs"
import { resetCache } from "../src/store.mjs"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-live-"))
process.env.CXSIGN_HOME = HOME

async function live(argv) {
  resetCache()
  statsReset()
  return run([...argv, "--json", "--timeout", "15000"])
}

function statsReset() {
}

// 网络 / 服务端不可用时显式 skip(带原因),而不是静默通过
const NET_EXIT = new Set([5, 9])
function skipIfUnavailable(t, r, { backend = false } = {}) {
  let err = null
  try { err = JSON.parse(r.stdout).error ?? null } catch {}
  const unavailable = NET_EXIT.has(r.exitCode) || (backend && r.exitCode === 6) || err?.code === "BACKEND_UNAVAILABLE"
  if (unavailable) { t.skip(`网络或服务端不可用: ${err?.code ?? "exit " + r.exitCode} ${err?.message ?? ""}`.trim()); return true }
  return false
}

// 真实会话:CXSIGN_LIVE_HOME 指定,或默认 ~/.config/cxsign 下已有登录状态;只跑只读命令
const SESSION_HOME = process.env.CXSIGN_LIVE_HOME || path.join(os.homedir(), ".config", "cxsign")
function hasSession() {
  try { return !!JSON.parse(fs.readFileSync(path.join(SESSION_HOME, "state.json"), "utf8"))?.loginSession } catch { return false }
}
async function withSession(argv) {
  const prev = process.env.CXSIGN_HOME
  process.env.CXSIGN_HOME = SESSION_HOME
  try { return await live(argv) } finally { process.env.CXSIGN_HOME = prev; resetCache() }
}

describe("live read-only", () => {
  it("locations search 燕山大学", async (t) => {
    const r = await live(["locations", "search", "--keyword", "燕山大学", "--city", "秦皇岛"])
    if (skipIfUnavailable(t, r, { backend: true })) return
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const d = JSON.parse(r.stdout).data
    assert.ok(d.length > 0)
    assert.equal(d[0].coordSystem, "bd09")
    assert.ok(Math.abs(d[0].latitude - 39.91) < 0.1 && Math.abs(d[0].longitude - 119.54) < 0.1)
  })
  it("rank summary", async (t) => {
    const r = await live(["rank", "summary"])
    if (skipIfUnavailable(t, r)) return
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const d = JSON.parse(r.stdout).data
    assert.ok(d.userCount > 0)
    assert.ok(d.totalRecordSignCount > 0)
  })
  it("rank top", async (t) => {
    const r = await live(["rank", "top", "--count", "3"])
    if (skipIfUnavailable(t, r)) return
    assert.equal(r.exitCode, 0, r.stdout)
    const d = JSON.parse(r.stdout).data
    assert.ok(Array.isArray(d) && d.length >= 1)
    assert.ok(d[0].totalSignCount >= 0)
  })
  it("captcha conf", async (t) => {
    const r = await live(["captcha", "conf"])
    if (skipIfUnavailable(t, r)) return
    assert.equal(r.exitCode, 0, r.stdout)
    const d = JSON.parse(r.stdout).data
    assert.ok(Number(d.t) > 0)
  })
  it("banlist (CDN may 5xx)", async (t) => {
    const r = await live(["banlist"])
    if (skipIfUnavailable(t, r)) return
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
  })
  it("sponsors (CDN may 5xx)", async (t) => {
    const r = await live(["sponsors"])
    if (skipIfUnavailable(t, r)) return
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
  })
  it("session: auth status --check", { skip: !hasSession() && "未找到已登录状态(CXSIGN_LIVE_HOME 或 ~/.config/cxsign)" }, async (t) => {
    const r = await withSession(["auth", "status", "--check"])
    if (skipIfUnavailable(t, r)) return
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
  })
  it("session: courses list + activities available", { skip: !hasSession() && "未找到已登录状态" }, async (t) => {
    const c = await withSession(["courses", "list"])
    if (skipIfUnavailable(t, c)) return
    assert.equal(c.exitCode, 0, c.stdout + c.stderr)
    assert.ok(Array.isArray(JSON.parse(c.stdout).data))
    const a = await withSession(["activities", "available"])
    if (skipIfUnavailable(t, a)) return
    assert.equal(a.exitCode, 0, a.stdout + a.stderr)
  })
  it("auth status without session is 3", async () => {
    fs.rmSync(HOME, { recursive: true, force: true })
    process.env.CXSIGN_HOME = HOME
    resetCache()
    const r = await run(["auth", "status", "--check", "--json"])
    assert.equal(r.exitCode, 3)
  })
  it("sign * never fires without --confirm", async () => {
    for (const cmd of [
      ["sign", "location", "--active", "1", "--class", "1", "--course", "1", "--lat", "0", "--lon", "0"],
      ["sign", "password", "--active", "1", "--class", "1", "--course", "1", "--code", "1234"],
      ["sign", "gesture", "--active", "1", "--class", "1", "--course", "1", "--code", "14789"],
      ["sign", "photo", "--active", "1", "--class", "1", "--course", "1"],
      ["sign", "qrcode", "--qr", "SIGNIN:aid=1&c=x&enc=abc"],
      ["rank", "upload"],
      ["cloud", "upload", "--file", "/etc/hosts"],
    ]) {
      const r = await run([...cmd, "--json"])
      assert.equal(r.exitCode, 10, cmd.join(" "))
    }
  })
})
