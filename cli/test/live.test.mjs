/**
 * 公开只读接口的 live 测试。不登录、不写。
 * 网络失败时标记为 skip(不是 fail),避免 CI 因 CDN 抖动红。
 */
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
  // main.run already resets via stats object mutation in main(); nothing else needed
}

describe("live read-only", () => {
  it("rank summary", async () => {
    const r = await live(["rank", "summary"])
    if (r.exitCode === 5) return // network → soft skip
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const d = JSON.parse(r.stdout).data
    assert.ok(d.userCount > 0)
    assert.ok(d.totalRecordSignCount > 0)
  })
  it("rank top", async () => {
    const r = await live(["rank", "top", "--count", "3"])
    if (r.exitCode === 5) return
    assert.equal(r.exitCode, 0, r.stdout)
    const d = JSON.parse(r.stdout).data
    assert.ok(Array.isArray(d) && d.length >= 1)
    assert.ok(d[0].totalSignCount >= 0)
  })
  it("captcha conf", async () => {
    const r = await live(["captcha", "conf"])
    if (r.exitCode === 5) return
    assert.equal(r.exitCode, 0, r.stdout)
    const d = JSON.parse(r.stdout).data
    assert.ok(Number(d.t) > 0)
  })
  it("banlist (CDN may 5xx)", async () => {
    const r = await live(["banlist"])
    // CDN 有时 500,接受 0 或 6
    assert.ok([0, 5, 6].includes(r.exitCode), r.stdout + r.stderr)
  })
  it("sponsors (CDN may 5xx)", async () => {
    const r = await live(["sponsors"])
    assert.ok([0, 5, 6].includes(r.exitCode), r.stdout + r.stderr)
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
