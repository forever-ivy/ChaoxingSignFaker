/**
 * 离线单元测试:加解密、参数解析、二维码、打码、课表、错误码。
 * 不触网、不登录。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encryptByAES, decryptByAES, desDecryptHex, resolveImPassword, md5, randomizedDeviceCode, buildFaceResult, encryptByRsa, decryptClientId, buildEncryptedDeviceInfo } from "../src/cxcrypto.mjs"
import { desEcbEncrypt } from "../src/des.mjs"
import { parseArgv, findCommand, resolveArgs, run, schema, paginate } from "../src/main.mjs"
import { GLOBAL_FLAGS, EXIT_CODES } from "../src/spec.mjs"
import { scrub, toErrorPayload, CxError } from "../src/errors.mjs"
import { parseQRCode, parseCourseList, parseActivityList, parseLessons, currentWeekOfSemester, currentLessons, normalizeCourseName, isCourseNameMatched, bigramSimilarity, checkAlreadySign, checkExpiredSign, parseIMSignActivityInfo, decodeIMMessage, pbFields, startTimeTitleSortKey, SignLocation, describeSignInfo, pickRankSchoolName } from "../src/api.mjs"
import { COMMANDS } from "../src/commands.mjs"
import { resetCache } from "../src/store.mjs"
import { preprocess, nms, postprocess } from "../src/image.mjs"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cxsign-test-"))
process.env.CXSIGN_HOME = HOME

describe("cxcrypto", () => {
  it("AES login encrypt/decrypt roundtrip", () => {
    const c = encryptByAES("13800138000")
    assert.equal(decryptByAES(c), "13800138000")
    // + 在 Base64 里会出现,登录时要替换成 %2B
    assert.match(encryptByAES("abcdefgh"), /[A-Za-z0-9+/=]+/)
  })
  it("DES ECB matches OpenSSL for IM password", () => {
    const plain = Buffer.from("hello123456")
    const key = Buffer.from("SL2(M/eD")
    const enc = desEcbEncrypt(plain, key)
    assert.equal(enc.toString("hex"), "4a0976b4bd6a6706292eac81d1756d08")
    assert.equal(desDecryptHex(enc.toString("hex")), "hello123456")
  })
  it("resolveImPassword: short plaintext passthrough, long hex decrypt", () => {
    assert.equal(resolveImPassword("short"), "short")
    const hex = desEcbEncrypt(Buffer.from("im-secret"), Buffer.from("SL2(M/eD")).toString("hex")
    assert.equal(resolveImPassword(hex), "im-secret")
  })
  it("randomizedDeviceCode is base64 of 64 bytes", () => {
    const a = randomizedDeviceCode(), b = randomizedDeviceCode()
    assert.notEqual(a, b)
    assert.equal(Buffer.from(a, "base64").length, 64)
  })
  it("buildEncryptedDeviceInfo is RSA-encrypted base64", () => {
    const s = buildEncryptedDeviceInfo("abc123")
    assert.ok(s.length > 100)
    assert.doesNotThrow(() => Buffer.from(s, "base64"))
  })
  it("buildFaceResult without clientId omits signToken", () => {
    const r = buildFaceResult("obj1", null, 1700000000000)
    assert.equal(r.currentFaceId, "obj1")
    assert.equal(r.LiveDetectionStatus, 1)
    assert.equal(r.cxtime, "1700000000000")
    assert.equal(r.signToken, undefined)
  })
  it("md5 matches known vector", () => {
    assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e")
  })
})

describe("argv / schema", () => {
  it("parseArgv handles --flag=value and booleans", () => {
    const p = parseArgv(["auth", "login", "--phone", "1", "--json", "--timeout=5000", "--confirm"])
    assert.deepEqual(p.path, ["auth", "login"])
    assert.equal(p.flags.phone, "1")
    assert.equal(p.flags.json, true)
    assert.equal(p.flags.timeout, "5000")
    assert.equal(p.flags.confirm, true)
  })
  it("findCommand matches longest path", () => {
    assert.equal(findCommand(["sign", "location"]).cmd.name, "sign location")
    assert.equal(findCommand(["sign-code", "check"]).cmd.name, "sign-code check")
    assert.equal(findCommand(["nope"]).cmd, undefined)
  })
  it("schema lists every command", () => {
    const s = schema()
    assert.equal(s.name, "cxsign")
    assert.ok(s.commands.length >= COMMANDS.length)
    for (const c of COMMANDS) assert.ok(s.commands.some((x) => x.name === c.name), c.name)
  })
  it("paginate", () => {
    const r = paginate([1, 2, 3, 4, 5], 1, 2)
    assert.deepEqual(r.items, [2, 3])
    assert.deepEqual(r.page, { offset: 1, limit: 2, total: 5, returned: 2, hasMore: true })
  })
})

describe("scrub", () => {
  it("redacts secret keys and embedded tokens", () => {
    const o = scrub({ password: "secret", cookie: "a=b", nested: { token: "t", ok: 1 }, url: "https://x/?pwd=abc&enc=zzz&keep=1", auth: "Bearer eyJhbGciOi" })
    assert.equal(o.password, "***")
    assert.equal(o.cookie, "***")
    assert.equal(o.nested.token, "***")
    assert.equal(o.nested.ok, 1)
    assert.match(o.url, /pwd=\*\*\*/)
    assert.match(o.url, /enc=\*\*\*/)
    assert.match(o.url, /keep=1/)
    assert.match(o.auth, /Bearer \*\*\*/)
  })
  it("toErrorPayload maps codes", () => {
    const e = toErrorPayload(new CxError("AUTH_REQUIRED", "尚未登录", { next: "x" }))
    assert.equal(e.exitCode, EXIT_CODES.AUTH_REQUIRED)
    assert.equal(e.retryable, false)
    assert.equal(e.details.next, "x")
  })
})

describe("qrcode parse", () => {
  it("SIGNIN: form", () => {
    const r = parseQRCode("SIGNIN:aid=123456&c=ABC&enc=deadbeef-extra")
    assert.equal(r.aid, 123456)
    assert.equal(r.code, "ABC")
    assert.equal(r.enc, "deadbeef")
  })
  it("URL form", () => {
    const r = parseQRCode("https://mobilelearn.chaoxing.com/widget/sign/e?id=99&c=ZZ&enc=abcdef")
    assert.equal(r.aid, 99)
    assert.equal(r.code, "ZZ")
    assert.equal(r.enc, "abcdef")
  })
  it("rejects garbage", () => {
    assert.throws(() => parseQRCode("not-a-qr"), (e) => e.code === "USAGE")
  })
})

describe("course / activity parsing", () => {
  it("parseCourseList filters and maps", () => {
    const list = parseCourseList([
      { cataName: "x", content: { id: 1, course: { data: [{ id: 10, name: "A", teacherfactor: "T", imageurl: "u", schools: "S" }] } } },
      { content: { id: 2, course: { data: [{ id: 20, name: "B" }] } } }, // no cataName
      { cataName: "y", content: { id: 3 } }, // no course
    ])
    assert.equal(list.length, 1)
    assert.deepEqual(list[0], { courseName: "A", teacher: "T", courseId: 10, classId: 1, imageUrl: "u", schools: "S" })
  })
  it("parseActivityList keeps type 2/74", () => {
    const now = Date.now()
    const { activities } = parseActivityList({
      data: {
        ext: { a: 1 },
        activeList: [
          { id: 1, type: 2, otherId: "4", status: 1, startTime: now, nameOne: "位置", userStatus: 1, isLook: 1, activeType: 2, endTime: now + 1e6, nameFour: "" },
          { id: 2, type: 1, otherId: "0", status: 1, startTime: now, nameOne: "非签到" },
          { id: 3, type: 74, otherId: "5", status: 2, startTime: now - 1e9, nameOne: "旧码", userStatus: 1, isLook: 0, activeType: 74, endTime: null, nameFour: "" },
        ],
      },
    }, { classId: 9, courseId: 8, courseName: "C" })
    assert.equal(activities.length, 2)
    assert.equal(activities[0].signType, "location")
    assert.equal(activities[0].isAvailable, true)
    assert.equal(activities[0].isRecent, true)
    assert.equal(activities[1].isAvailable, false)
  })
  it("checkAlreadySign / checkExpiredSign", () => {
    assert.equal(checkAlreadySign('"primaryAttend":{"status":1}'), true)
    assert.equal(checkAlreadySign("signstatus=2"), true)
    assert.equal(checkAlreadySign("signstatus=0"), false)
    assert.equal(checkExpiredSign("下次早点哦"), true)
    assert.equal(checkExpiredSign("ok"), false)
  })
})

describe("schedule helpers", () => {
  it("parseLessons", () => {
    const lessons = parseLessons([
      { name: "高数", dayOfWeek: 1, beginNumber: 1, length: 2, courseId: 1, classId: 2, teacherName: "张", location: "A101", weeks: "1,2,3" },
    ], ["08:00-08:45", "08:55-09:40", "10:00-10:45"])
    assert.equal(lessons.length, 1)
    assert.equal(lessons[0].startMinuteOfDay, 8 * 60)
    assert.equal(lessons[0].endMinuteOfDay, 9 * 60 + 40)
  })
  it("currentWeekOfSemester", () => {
    assert.equal(currentWeekOfSemester(0), 1)
    const first = Date.UTC(2026, 0, 5) // Mon
    assert.equal(currentWeekOfSemester(first, new Date(Date.UTC(2026, 0, 5))), 1)
    assert.equal(currentWeekOfSemester(first, new Date(Date.UTC(2026, 0, 12))), 2)
  })
  it("course name matching", () => {
    assert.ok(isCourseNameMatched("高等数学（一）", "高等数学(一)"))
    assert.ok(bigramSimilarity(normalizeCourseName("线性代数"), normalizeCourseName("线性代数A")) >= 0.5)
  })
})

describe("location randomization", () => {
  it("stays within range and tightens", () => {
    const p = new SignLocation(30, 120, "x")
    for (let i = 0; i < 50; i++) {
      assert.ok(Math.abs(p.randomizedLatitude - 30) <= 0.00005 + 1e-12)
    }
    p.disableRandomizedLocation()
    for (let i = 0; i < 50; i++) {
      assert.ok(Math.abs(p.randomizedLongitude - 120) <= 0.00001 + 1e-12)
    }
  })
})

describe("IM protobuf / attachment", () => {
  it("pbFields roundtrips a KeyValue-like buffer", () => {
    // key=1:"attachment" (tag 0x0a) + stringValue=6:"{}" (tag 0x32)
    const buf = Buffer.concat([
      Buffer.from([0x0a, 10]), Buffer.from("attachment"),
      Buffer.from([0x32, 2]), Buffer.from("{}"),
    ])
    const f = pbFields(buf)
    assert.equal(f.find((x) => x.no === 1).b.toString(), "attachment")
    assert.equal(f.find((x) => x.no === 6).b.toString(), "{}")
  })
  it("parseIMSignActivityInfo", () => {
    const ok = parseIMSignActivityInfo({ attachmentType: 15, att_chat_course: { aid: 42, atype: 2, title: "t", subTitle: "2026-01-01 08:00", atypeName: "位置签到", courseInfo: { classid: 1, courseid: 2, coursename: "C" } } })
    assert.equal(ok.activeId, 42)
    assert.equal(ok.signType, "location")
    assert.equal(parseIMSignActivityInfo({ attachmentType: 1 }), null)
  })
  it("startTimeTitleSortKey", () => {
    assert.deepEqual(startTimeTitleSortKey("2026-10-30 08:00"), [2026, 10, 30, 8, 0])
    assert.equal(startTimeTitleSortKey("nope"), null)
  })
})

describe("captcha image math", () => {
  it("preprocess produces CHW float32", () => {
    const data = Buffer.alloc(4 * 4 * 4, 128)
    const { tensor, padded } = preprocess({ width: 4, height: 4, data })
    assert.equal(padded, 4)
    assert.equal(tensor.length, 3 * 640 * 640)
    assert.ok(tensor[0] >= 0 && tensor[0] <= 1)
  })
  it("nms keeps highest score", () => {
    const kept = nms([{ x: 0, y: 0, w: 10, h: 10, score: 0.9 }, { x: 1, y: 1, w: 10, h: 10, score: 0.5 }, { x: 50, y: 50, w: 5, h: 5, score: 0.8 }])
    assert.equal(kept.length, 2)
    assert.equal(kept[0].score, 0.9)
  })
})

describe("rank school picker", () => {
  it("filters library and digit-prefixed names", () => {
    assert.equal(pickRankSchoolName([{ name: "1xx图书馆" }, { name: "北京大学" }, { name: "北图图书馆" }], null, false), "北京大学")
    assert.equal(pickRankSchoolName([{ name: "北京大学" }], null, true), "北京大学HIDE")
    assert.equal(pickRankSchoolName([{ name: "北京大学" }, { name: "清华大学" }], "清华大学", false), "清华大学")
  })
})

describe("CLI run (offline)", () => {
  it("version / schema / help exit 0", async () => {
    for (const a of [["version", "--json"], ["schema", "--json"], ["--help"]]) {
      resetCache()
      const r = await run(a)
      assert.equal(r.exitCode, 0, a.join(" "))
    }
  })
  it("auth status without login → 3", async () => {
    resetCache(); fs.rmSync(HOME, { recursive: true, force: true })
    process.env.CXSIGN_HOME = HOME
    const r = await run(["auth", "status", "--json"])
    assert.equal(r.exitCode, 3)
    assert.match(r.stdout, /AUTH_REQUIRED/)
  })
  it("sign location dry-run → 10", async () => {
    // seed a fake session so auth gate passes... actually sign is sideEffect so dry-run fires first
    resetCache()
    const r = await run(["sign", "location", "--active", "1", "--class", "2", "--course", "3", "--lat", "1", "--lon", "2", "--json"])
    assert.equal(r.exitCode, 10)
    const j = JSON.parse(r.stdout)
    assert.equal(j.dryRun, true)
    assert.equal(j.error.code, "DRY_RUN")
  })
  it("qrcode parse offline", async () => {
    const r = await run(["qrcode", "parse", "--text", "SIGNIN:aid=1&c=X&enc=abc", "--json"])
    assert.equal(r.exitCode, 0)
    assert.equal(JSON.parse(r.stdout).data.aid, 1)
  })
  it("unknown command → 2", async () => {
    const r = await run(["nope", "--json"])
    assert.equal(r.exitCode, 2)
  })
  it("locations add requires --confirm", async () => {
    const r = await run(["locations", "add", "--label", "家", "--lat", "1", "--lon", "2", "--json"])
    assert.equal(r.exitCode, 10)
  })
  it("locations add --confirm works", async () => {
    resetCache(); fs.rmSync(HOME, { recursive: true, force: true }); process.env.CXSIGN_HOME = HOME
    const r = await run(["locations", "add", "--label", "家", "--lat", "30.1", "--lon", "120.2", "--address", "A", "--confirm", "--json"])
    assert.equal(r.exitCode, 0)
    const list = await run(["locations", "list", "--json"])
    assert.equal(JSON.parse(list.stdout).data.length, 1)
  })
  it("device-code reset is dry-run by default", async () => {
    // need a session for resolveClient... seed loginSession
    resetCache()
    const stPath = path.join(HOME, "state.json")
    fs.mkdirSync(HOME, { recursive: true })
    fs.writeFileSync(stPath, JSON.stringify({ version: 1, loginSession: { phoneNumber: "13800000000", cookies: [], deviceCode: "x", password: null }, otherUsers: [], locations: [], preferences: {}, analysis: {}, faceRecognitionConfigures: {}, classSchedule: { lessons: [] }, tagsLibrary: [], pending: {} }))
    resetCache()
    const dry = await run(["device-code", "reset", "--json"])
    assert.equal(dry.exitCode, 10)
  })
})
