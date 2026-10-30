import { describe, it, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "../src/main.mjs"
import { resetCache, writeSecretFile } from "../src/store.mjs"
import { transport, options } from "../src/http.mjs"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-reg-"))
let home
const realFetch = transport.fetch
const offline = async () => { throw new Error("fetch failed") }

function seed(state) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(state))
  resetCache()
}
const readState = () => JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"))
const session = (phone) => ({ phoneNumber: phone, password: "ENC", cookies: [{ name: "UID", value: "1", domain: "chaoxing.com", path: "/" }], deviceCode: "x", androidId: "a", user: { puid: 1, uid: 1, name: "n", fidList: [] } })

describe("PR #1 review regressions", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(ROOT, "h-"))
    process.env.CXSIGN_HOME = home
    delete process.env.CXSIGN_PASSWORD
    options.retries = 0
    transport.fetch = offline
    resetCache()
  })
  after(() => { transport.fetch = realFetch; fs.rmSync(ROOT, { recursive: true, force: true }) })

  it("failed login keeps the previous session", async () => {
    seed({ loginSession: session("13800000001"), otherUsers: [] })
    const r = await run(["auth", "login", "--phone", "13900000002", "--password", "Abcd12345", "--retries", "0", "--json"])
    assert.notEqual(r.exitCode, 0)
    assert.equal(readState().loginSession.phoneNumber, "13800000001")
    assert.equal(readState().loginSession.password, "ENC")
  })

  it("state persistence failure is reported, not success", async () => {
    const file = path.join(ROOT, "not-a-dir")
    fs.writeFileSync(file, "x")
    process.env.CXSIGN_HOME = path.join(file, "home")
    resetCache()
    const r = await run(["locations", "add", "--label", "L", "--lat", "1", "--lon", "2", "--confirm", "--json"])
    assert.equal(r.exitCode, 1)
    const j = JSON.parse(r.stdout)
    assert.equal(j.ok, false)
    assert.equal(j.error.code, "STATE_WRITE_FAILED")
  })

  it("--as a secondary user works without a primary login", async () => {
    seed({ loginSession: null, otherUsers: [{ ...session("13700000003"), tags: [] }] })
    const noAs = await run(["courses", "list", "--json"])
    assert.equal(JSON.parse(noAs.stdout).error.code, "AUTH_REQUIRED")
    resetCache()
    const withAs = await run(["courses", "list", "--as", "13700000003", "--retries", "0", "--json"])
    assert.notEqual(JSON.parse(withAs.stdout).error?.code, "AUTH_REQUIRED")
  })

  it("--json is honored when another global flag is invalid", async () => {
    const r = await run(["courses", "list", "--json", "--timeout", "invalid"])
    assert.equal(r.exitCode, 2)
    assert.equal(r.stderr, "")
    const j = JSON.parse(r.stdout)
    assert.equal(j.ok, false)
    assert.equal(j.error.code, "USAGE")
  })

  it("writeSecretFile never leaves an existing file world-readable", () => {
    const f = path.join(home, "share.txt")
    fs.writeFileSync(f, "old", { mode: 0o644 })
    fs.chmodSync(f, 0o644)
    writeSecretFile(f, "secret")
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(f, "utf8"), "secret")
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith(".tmp")), [])
  })

  it("auth logout --forget clears remembered class locations", async () => {
    seed({ loginSession: session("13800000001"), otherUsers: [], classRememberedLocation: { 5: { latitude: 1 } }, classSelectedLocation: { 5: { latitude: 1 } } })
    const r = await run(["auth", "logout", "--forget", "--confirm", "--json"])
    assert.equal(r.exitCode, 0)
    assert.deepEqual(readState().classRememberedLocation, {})
    assert.deepEqual(readState().classSelectedLocation, {})
  })

  it("users add reads CXSIGN_PASSWORD", async () => {
    seed({ loginSession: null, otherUsers: [] })
    process.env.CXSIGN_PASSWORD = "Abcd12345"
    const r = await run(["users", "add", "--phone", "13600000004", "--retries", "0", "--confirm", "--json"])
    const j = JSON.parse(r.stdout)
    assert.notEqual(j.error.code, "USAGE")
    assert.equal(readState().otherUsers.length, 0)
  })
})
