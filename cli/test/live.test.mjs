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

describe("live read-only", () => {
  it("locations search 燕山大学", async () => {
    const r = await live(["locations", "search", "--keyword", "燕山大学", "--city", "秦皇岛"])
    if (r.exitCode === 5 || r.exitCode === 6) return
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const d = JSON.parse(r.stdout).data
    assert.ok(d.length > 0)
    assert.equal(d[0].coordSystem, "bd09")
    assert.ok(Math.abs(d[0].latitude - 39.91) < 0.1 && Math.abs(d[0].longitude - 119.54) < 0.1)
  })
  it("rank summary", async () => {
    const r = await live(["rank", "summary"])
    if (r.exitCode === 5) return
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
