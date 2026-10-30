import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { CxError, maskPhone, scrub, usage, notFound, unsupported } from "./errors.mjs"
import { EXIT_CODES } from "./spec.mjs"
import { CLIENT_INFOS } from "./http.mjs"
import { encryptByAES, randomizedDeviceCode } from "./cxcrypto.mjs"
import { load, markDirty, stateDir, faceDir, writeSecretFile } from "./store.mjs"
import { Client, selfClient, otherClient, resolveClient, ensureUser, applyClientPreferences, checkPassword, URL_LOGIN, buildLoginForm } from "./client.mjs"
import { CookieSession, checkResponse, request } from "./http.mjs"
import * as api from "./api.mjs"
import { captchaModelStatus, predictSliderXOffset, decodeQRCodeImage } from "./image.mjs"
import { createRequire } from "node:module"
const _req = createRequire(import.meta.url)
const hasDep = (n) => { try { _req.resolve(n); return true } catch { return false } }

const s = (name, description, extra = {}) => ({ name, type: "string", description, ...extra })
const n = (name, description, extra = {}) => ({ name, type: "number", description, ...extra })
const b = (name, description, extra = {}) => ({ name, type: "boolean", description, ...extra })

async function clientOf(ctx) {
  applyClientPreferences()
  return ensureUser(resolveClient(ctx.args.as ?? ctx.global?.as))
}

async function withRelogin(ctx, fn) {
  const c = await clientOf(ctx)
  try { return await fn(c) } catch (e) {
    if (ctx.global?.["no-relogin"]) throw e
    if (e?.code === "AUTH_SESSION_EXPIRED" || e?.code === "AUTH_REQUIRED") {
      await c.relogin()
      return fn(c)
    }
    throw e
  }
}

function locFromArgs(args) {
  if (args.lat === undefined && args.lon === undefined && !args.address && !args.location) return null
  if (args.location) {
    const [a, b, ...rest] = String(args.location).split(",")
    const lat = Number(a), lon = Number(b)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw usage("--location 格式: lat,lon[,address]")
    return new api.SignLocation(lat, lon, rest.join(",") || args.address || "")
  }
  if (args.lat === undefined || args.lon === undefined) throw usage("位置签到需要 --lat 与 --lon(或 --location)")
  return new api.SignLocation(args.lat, args.lon, args.address ?? "")
}

function findLocation(st, label) {
  const l = st.locations.find((x) => x.label === label)
  if (!l) throw notFound(`找不到收藏位置: ${label}`, { next: "cxsign locations list" })
  return new api.SignLocation(l.latitude, l.longitude, l.address)
}

async function resolveFaceObjectId(client, args) {
  if (args["face-object"]) return String(args["face-object"])
  if (args["face-file"]) {
    const buf = fs.readFileSync(args["face-file"])
    return api.uploadImage(client, buf, path.basename(args["face-file"]))
  }
  if (args["face-index"] !== undefined) {
    const cfg = load().faceRecognitionConfigures[client.phone]?.images ?? []
    const img = cfg[Number(args["face-index"])]
    if (!img) throw notFound(`用户没有第 ${args["face-index"]} 张人脸照片`, { next: "cxsign face list" })
    return img.objectId
  }
  return null
}

async function solveCaptcha(signer, args) {
  if (args.validate) return args.validate
  if (args["captcha-x"] !== undefined) {
    const data = await signer.getCaptchaImage()
    const v = await signer.checkCaptchaResult(args["captcha-x"], data)
    if (!v) throw new CxError("CAPTCHA_REQUIRED", "验证码校验失败,请换一个 --captcha-x 重试")
    return v
  }
  if (args["captcha-auto"]) {
    const data = await signer.getCaptchaImage()
    const res = await request(null, { url: data.shadeImageUrl })
    checkResponse(res)
    const pred = await predictSliderXOffset(res.buf)
    if (!pred) throw new CxError("CAPTCHA_REQUIRED", "模型未检测到缺口", { next: "cxsign captcha fetch --active <id> --class <id> --course <id> 后手动传 --captcha-x" })
    const v = await signer.checkCaptchaResult(pred.x, data)
    if (!v) throw new CxError("CAPTCHA_REQUIRED", `自动识别的 x=${pred.x} 未通过校验`, { predicted: pred })
    return v
  }
  return null
}

async function doSign(signer, once, args) {
  let need = await once(null)
  if (need === true) {
    const validate = await solveCaptcha(signer, args)
    if (!validate) throw new CxError("CAPTCHA_REQUIRED", "签到需要滑块验证码", {
      next: "cxsign captcha fetch --active ... 获取图片,再用 --captcha-x <像素> 或 --captcha-auto 重试本命令",
      enc2Present: !!signer.signEnc2,
    })
    need = await once(validate)
    if (need === true) throw new CxError("CAPTCHA_REQUIRED", "验证码通过后仍要求验证码,请重试")
  }
  return { ok: true }
}

function bumpAnalysis(kind) {
  const a = load().analysis
  a[kind] = (a[kind] ?? 0) + 1
  markDirty()
}

async function readStdin() {
  if (process.stdin.isTTY) return ""
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")
}

export const COMMANDS = [

  {
    name: "auth login", summary: "用手机号 + 密码登录学习通", auth: false,
    args: [
      s("phone", "手机号", { required: true, env: "CXSIGN_PHONE" }),
      b("password-stdin", "从 stdin 读密码(推荐)"),
      s("password", "密码(不推荐明文)", { secret: true, env: "CXSIGN_PASSWORD" }),
      b("remember", "记住加密后的密码,以便会话过期时自动重登(默认 true)", { default: true }),
      b("no-remember", "不保存密码"),
    ],
    examples: ['printf %s "$CXSIGN_PASSWORD" | cxsign auth login --phone 13800138000 --password-stdin --json'],
    async run(ctx) {
      const phone = String(ctx.args.phone)
      let password = ctx.args.password
      if (ctx.args["password-stdin"]) password = (await readStdin()) || password
      if (!password && process.env.CXSIGN_PASSWORD) password = process.env.CXSIGN_PASSWORD
      if (!password) throw usage("缺少密码:用 --password-stdin 或环境变量 CXSIGN_PASSWORD")
      checkPassword(password)
      applyClientPreferences()
      const st = load()
      const isRemember = !ctx.args["no-remember"] && ctx.args.remember !== false
      const rec = {
        phoneNumber: phone, password: null, cookies: [], configuredFid: null, puid: null, name: "",
        deviceCode: randomizedDeviceCode(), isNotRandomizedDeviceCode: false, isDeviceCodeDuplicatedSignBefore: false,
        androidId: crypto.randomBytes(8).toString("hex"), user: null,
      }
      const c = new Client(rec, { isSelf: true })
      const enc = encryptByAES(password)
      await c.login(enc)
      await c.getInfo()
      if (!isRemember) rec.password = null
      st.loginSession = rec; markDirty()
      return { phone: maskPhone(phone), name: c.name, puid: c.puid, uid: c.uid, fid: c.configuredFid, schools: c.user.fidList, remembered: isRemember }
    },
  },
  {
    name: "auth status", summary: "查看当前登录状态", auth: false,
    args: [b("check", "向服务器校验会话是否仍有效")],
    async run(ctx) {
      applyClientPreferences()
      const st = load()
      if (!st.loginSession?.phoneNumber) throw new CxError("AUTH_REQUIRED", "尚未登录", { next: "cxsign auth login --phone <手机号> --password-stdin" })
      const c = selfClient()
      const base = { phone: maskPhone(c.phone), name: c.name || null, puid: c.puid ?? null, uid: c.uid ?? null, fid: c.configuredFid, hasPassword: !!c.record.password, cookieCount: (c.record.cookies ?? []).length }
      if (!ctx.args.check) return { ...base, checked: false }
      try {
        await c.getInfo()
        return { ...base, name: c.name, puid: c.puid, uid: c.uid, fid: c.configuredFid, schools: c.user.fidList, checked: true, valid: true }
      } catch (e) {
        if (e.code === "AUTH_SESSION_EXPIRED" || e.code === "AUTH_REQUIRED") return { ...base, checked: true, valid: false, error: e.message }
        throw e
      }
    },
  },
  {
    name: "auth logout", summary: "登出(清除主账号会话;代签用户与签到统计默认保留)", auth: false, sideEffect: true,
    args: [b("forget", "同时清除代签用户 / 人脸 / 位置 / 统计")],
    plan: (ctx) => ({ forget: !!ctx.args.forget }),
    async run(ctx) {
      const st = load()
      st.loginSession = null
      if (ctx.args.forget) {
        st.otherUsers = []; st.faceRecognitionConfigures = {}; st.locations = []
        st.classRememberedLocation = {}; st.classSelectedLocation = {}
        st.analysis = { locationSign: 0, qrcodeSign: 0, photoSign: 0, clickSign: 0, gestureSign: 0, otherUserSign: 0, passwordSign: 0 }
        st.classSchedule = { lessons: [], lastFetchTimestamp: 0, firstWeekDate: 0, contentMd5: "" }
      }
      markDirty()
      return { loggedOut: true, forgotten: !!ctx.args.forget }
    },
  },
  {
    name: "auth relogin", summary: "用已保存的加密密码重新登录", auth: true,
    async run(ctx) {
      const c = await withRelogin(ctx, async (c) => { await c.relogin(); return c })
      return { phone: maskPhone(c.phone), name: c.name, puid: c.puid, fid: c.configuredFid }
    },
  },
  {
    name: "auth schools", summary: "列出当前账号绑定的学校单位(fid)", auth: true,
    async run(ctx) {
      return withRelogin(ctx, async (c) => ({ configuredFid: c.configuredFid, schools: c.user.fidList }))
    },
  },
  {
    name: "auth set-fid", summary: "切换当前学校单位(改 fid cookie)", auth: true, sideEffect: true,
    args: [n("fid", "学校单位 ID", { required: true })],
    plan: (ctx) => ({ fid: ctx.args.fid }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        if (!c.user.fidList.some((f) => f.fid === Number(ctx.args.fid))) throw notFound(`当前账号没有 fid=${ctx.args.fid}`, { schools: c.user.fidList })
        c.setFid(Number(ctx.args.fid))
        return { configuredFid: c.configuredFid }
      })
    },
  },

  {
    name: "user info", summary: "当前账号的详细资料(不含密码 / cookie)", auth: true,
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const u = c.user
        return { phone: maskPhone(c.phone), name: u.name, uid: u.uid, puid: u.puid, uname: u.uname, pic: u.pic, fid: c.configuredFid, schools: u.fidList, hasClientId: !!u.clientId, hasImPassword: !!u.imEncryptedPassword, deviceCodeLength: (c.deviceCode ?? "").length }
      })
    },
  },

  {
    name: "courses list", summary: "列出全部课程", auth: true, paged: true,
    async run(ctx) {
      return withRelogin(ctx, (c) => api.getAllCourses(c))
    },
  },
  {
    name: "activities list", summary: "列出一门课的签到活动", auth: true, paged: true,
    args: [n("class", "班级 ID", { required: true }), n("course", "课程 ID", { required: true }), s("course-name", "课程名(可选,写入返回值)")],
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const course = { classId: Number(ctx.args.class), courseId: Number(ctx.args.course), courseName: ctx.args["course-name"] ?? null }
        const { activities, ext } = await api.getActivities(c, course)
        return activities.map((a) => ({ ...a, extLength: ext.length }))
      })
    },
  },
  {
    name: "activities available", summary: "扫描全部课程,列出近期可签到的活动", auth: true, paged: true,
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const courses = await api.getAllCourses(c)
        const out = []
        for (const course of courses) {
          try {
            const { activities } = await api.getActivities(c, course)
            for (const a of activities) if (a.isRecent) out.push({ ...a, courseName: course.courseName, teacher: course.teacher })
          } catch (e) {
            if (e.code === "AUTH_SESSION_EXPIRED") throw e
          }
        }
        return out.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
      })
    },
  },
  {
    name: "activity info", summary: "查看签到活动详情(getPPTActiveInfo)", auth: true,
    args: [n("active", "活动 ID", { required: true })],
    async run(ctx) {
      return withRelogin(ctx, async (c) => api.describeSignInfo(await api.getSignInfo(c, ctx.args.active)))
    },
  },
  {
    name: "activity presign", summary: "执行 preSign + analysis,返回签到状态(不真正签到)", auth: true,
    args: [n("active", "活动 ID", { required: true }), n("class", "班级 ID", { required: true }), n("course", "课程 ID", { required: true }), s("ext", "活动列表返回的 ext JSON(可选)")],
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const signer = new api.Signer(c, { activeId: ctx.args.active, classId: ctx.args.class, courseId: ctx.args.course, ext: ctx.args.ext ?? "" })
        const status = await signer.preSign()
        const info = api.describeSignInfo(await signer.getSignInfo())
        return { status, info }
      })
    },
  },

  {
    name: "sign location", summary: "位置签到", auth: true, sideEffect: true,
    args: [
      n("active", "活动 ID", { required: true }), n("class", "班级 ID", { required: true }), n("course", "课程 ID", { required: true }),
      s("ext", "ext JSON"), n("lat", "纬度"), n("lon", "经度"), s("address", "地址描述"), s("location", "lat,lon[,address]"),
      s("favorite", "使用收藏位置的 label"), s("face-object", "人脸照片 objectId"), s("face-file", "上传本地人脸照片"), n("face-index", "使用已保存的第 N 张人脸"),
      b("captcha-auto", "自动识别滑块"), n("captcha-x", "手动提供缺口像素位置"), s("validate", "已有的 validate 字符串"),
    ],
    plan: (ctx) => ({ active: ctx.args.active, class: ctx.args.class, course: ctx.args.course, location: ctx.args.location ?? (ctx.args.lat !== undefined ? `${ctx.args.lat},${ctx.args.lon}` : ctx.args.favorite), face: ctx.args["face-object"] ?? ctx.args["face-file"] ?? ctx.args["face-index"] }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        let pos = locFromArgs(ctx.args)
        if (!pos && ctx.args.favorite) pos = findLocation(load(), ctx.args.favorite)
        if (!pos) {
          const rem = load().classSelectedLocation[String(ctx.args.class)] ?? load().classRememberedLocation[String(ctx.args.class)]
          if (rem) pos = new api.SignLocation(rem.latitude, rem.longitude, rem.address)
        }
        if (!pos) throw usage("位置签到需要 --lat/--lon 或 --location 或 --favorite")
        const face = await resolveFaceObjectId(c, ctx.args)
        const signer = new api.Signer(c, { activeId: ctx.args.active, classId: ctx.args.class, courseId: ctx.args.course, ext: ctx.args.ext ?? "" })
        await signer.checkSignStatus()
        await doSign(signer, (v) => signer.signLocation(pos, { validate: v, faceObjectId: face }), ctx.args)
        bumpAnalysis("locationSign")
        if (!c.isSelf) bumpAnalysis("otherUserSign")
        return { signed: true, type: "location", activeId: Number(ctx.args.active), latitude: pos.randomizedLatitude, longitude: pos.randomizedLongitude, address: pos.address }
      })
    },
  },
  {
    name: "sign password", summary: "签到码签到", auth: true, sideEffect: true,
    args: [
      n("active", "活动 ID", { required: true }), n("class", "班级 ID", { required: true }), n("course", "课程 ID", { required: true }),
      s("code", "签到码", { required: true }), s("ext", "ext JSON"), n("lat", "纬度"), n("lon", "经度"), s("address", "地址"), s("location", "lat,lon[,address]"),
      b("captcha-auto", "自动识别滑块"), n("captcha-x", "缺口像素"), s("validate", "validate 字符串"), b("skip-check", "跳过 checkSignCode"),
    ],
    plan: (ctx) => ({ active: ctx.args.active, code: "***" }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const signer = new api.Signer(c, { activeId: ctx.args.active, classId: ctx.args.class, courseId: ctx.args.course, ext: ctx.args.ext ?? "" })
        await signer.checkSignStatus()
        if (!ctx.args["skip-check"] && !(await api.checkSignCode(c, ctx.args.active, ctx.args.code))) throw new CxError("SIGN_CODE_INCORRECT", "签到码错误")
        const pos = locFromArgs(ctx.args)
        await doSign(signer, (v) => signer.signCode(ctx.args.code, pos, { validate: v }), ctx.args)
        bumpAnalysis("passwordSign"); if (!c.isSelf) bumpAnalysis("otherUserSign")
        return { signed: true, type: "password", activeId: Number(ctx.args.active) }
      })
    },
  },
  {
    name: "sign gesture", summary: "手势签到(手势序列等同签到码)", auth: true, sideEffect: true,
    args: [
      n("active", "活动 ID", { required: true }), n("class", "班级 ID", { required: true }), n("course", "课程 ID", { required: true }),
      s("code", "手势序列(如 14789)", { required: true }), s("ext", "ext JSON"), n("lat", "纬度"), n("lon", "经度"), s("address", "地址"), s("location", "lat,lon[,address]"),
      b("captcha-auto", "自动识别滑块"), n("captcha-x", "缺口像素"), s("validate", "validate 字符串"), b("skip-check", "跳过校验"),
    ],
    plan: (ctx) => ({ active: ctx.args.active, code: "***" }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const signer = new api.Signer(c, { activeId: ctx.args.active, classId: ctx.args.class, courseId: ctx.args.course, ext: ctx.args.ext ?? "" })
        await signer.checkSignStatus()
        if (!ctx.args["skip-check"] && !(await api.checkSignCode(c, ctx.args.active, ctx.args.code))) throw new CxError("SIGN_CODE_INCORRECT", "手势不正确")
        const pos = locFromArgs(ctx.args)
        await doSign(signer, (v) => signer.signCode(ctx.args.code, pos, { validate: v }), ctx.args)
        bumpAnalysis("gestureSign"); if (!c.isSelf) bumpAnalysis("otherUserSign")
        return { signed: true, type: "gesture", activeId: Number(ctx.args.active) }
      })
    },
  },
  {
    name: "sign photo", summary: "拍照 / 普通(点击)签到", auth: true, sideEffect: true,
    args: [
      n("active", "活动 ID", { required: true }), n("class", "班级 ID", { required: true }), n("course", "课程 ID", { required: true }),
      s("ext", "ext JSON"), s("image", "本地照片路径(需要拍照时必填)"), s("object-id", "已上传的云盘 objectId"),
      b("captcha-auto", "自动识别滑块"), n("captcha-x", "缺口像素"), s("validate", "validate 字符串"),
    ],
    plan: (ctx) => ({ active: ctx.args.active, image: ctx.args.image ?? ctx.args["object-id"] ?? null }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const signer = new api.Signer(c, { activeId: ctx.args.active, classId: ctx.args.class, courseId: ctx.args.course, ext: ctx.args.ext ?? "" })
        await signer.checkSignStatus()
        const info = await signer.getSignInfo()
        let objectId = ctx.args["object-id"] ?? null
        if (info.ifphoto === 1 && !objectId) {
          if (!ctx.args.image) throw usage("该活动需要拍照,请用 --image <路径>")
          objectId = await api.uploadImage(c, fs.readFileSync(ctx.args.image), path.basename(ctx.args.image))
        } else if (ctx.args.image && !objectId) {
          objectId = await api.uploadImage(c, fs.readFileSync(ctx.args.image), path.basename(ctx.args.image))
        }
        await doSign(signer, (v) => signer.signPhoto(objectId, { validate: v }), ctx.args)
        bumpAnalysis(objectId ? "photoSign" : "clickSign"); if (!c.isSelf) bumpAnalysis("otherUserSign")
        return { signed: true, type: objectId ? "photo" : "click", activeId: Number(ctx.args.active), objectId }
      })
    },
  },
  {
    name: "sign qrcode", summary: "二维码签到", auth: true, sideEffect: true,
    args: [
      s("qr", "二维码原文(SIGNIN:... 或 https://...)", { required: true }),
      n("class", "班级 ID(可省略,会从活动详情获取)"), n("course", "课程 ID(可省略)"), s("ext", "ext JSON"),
      n("lat", "纬度"), n("lon", "经度"), s("address", "地址"), s("location", "lat,lon[,address]"), s("favorite", "收藏位置 label"),
      s("face-object", "人脸 objectId"), s("face-file", "本地人脸文件"), n("face-index", "已保存人脸下标"),
      b("captcha-auto", "自动识别滑块"), n("captcha-x", "缺口像素"), s("validate", "validate 字符串"),
      b("skip-expire-check", "跳过二维码过期检查"),
    ],
    plan: (ctx) => ({ qr: scrub(String(ctx.args.qr)).slice(0, 40) + "…" }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const parsed = api.parseQRCode(ctx.args.qr)
        if (parsed.aid === null) throw usage("二维码中未包含签到活动 ID")
        let classId = ctx.args.class, courseId = ctx.args.course
        if (classId === undefined || courseId === undefined) {
          const info = await api.getSignInfo(c, parsed.aid)
          classId = classId ?? info.clazzid
          courseId = courseId ?? info.courseId
          if (!courseId) courseId = await api.getCourseIdFromClassId(c, classId) ?? 0
        }
        const signer = new api.Signer(c, { activeId: parsed.aid, classId, courseId, ext: ctx.args.ext ?? "" })
        if (!ctx.args["skip-expire-check"]) {
          const exp = await signer.isQRCodeExpired(parsed)
          if (exp === true) throw new CxError("SIGN_QRCODE_EXPIRED", "二维码已过期")
        }
        await signer.checkSignStatus()
        let pos = locFromArgs(ctx.args)
        if (!pos && ctx.args.favorite) pos = findLocation(load(), ctx.args.favorite)
        const face = await resolveFaceObjectId(c, ctx.args)
        await doSign(signer, (v) => signer.signQRCode(parsed, pos, { validate: v, faceObjectId: face }), ctx.args)
        bumpAnalysis("qrcodeSign"); if (!c.isSelf) bumpAnalysis("otherUserSign")
        return { signed: true, type: "qrcode", activeId: parsed.aid, classId, courseId }
      })
    },
  },
  {
    name: "sign-code check", summary: "校验签到码 / 手势是否正确", auth: true,
    args: [n("active", "活动 ID", { required: true }), s("code", "签到码或手势序列", { required: true })],
    async run(ctx) {
      return withRelogin(ctx, async (c) => ({ valid: await api.checkSignCode(c, ctx.args.active, ctx.args.code) }))
    },
  },

  {
    name: "qrcode parse", summary: "解析二维码原文(离线)", auth: false,
    args: [s("text", "二维码原文", { required: true })],
    async run(ctx) { return api.parseQRCode(ctx.args.text) },
  },
  {
    name: "qrcode from-image", summary: "从图片识别二维码原文", auth: false,
    args: [s("file", "图片路径(JPEG/PNG)", { required: true })],
    async run(ctx) {
      const text = decodeQRCodeImage(fs.readFileSync(ctx.args.file))
      let parsed = null
      try { parsed = api.parseQRCode(text) } catch {}
      return { text, parsed }
    },
  },
  {
    name: "qrcode check-expired", summary: "检查二维码是否已过期", auth: true,
    args: [s("text", "二维码原文", { required: true }), n("active", "活动 ID(可省略)")],
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const parsed = api.parseQRCode(ctx.args.text)
        const expired = await api.isQRCodeExpired(c, parsed, ctx.args.active ?? parsed.aid)
        return { ...parsed, expired }
      })
    },
  },

  {
    name: "captcha conf", summary: "获取滑块验证码 conf(公开,免登录)", auth: false,
    async run() { return { t: await api.getCaptchaConf(null), captchaId: api.CAPTCHA_ID } },
  },
  {
    name: "captcha fetch", summary: "获取滑块验证码图片(写入文件;不打印 URL 中的 token)", auth: false,
    args: [
      n("active", "活动 ID(用于 Referer)"), n("class", "班级 ID"), n("course", "课程 ID"),
      s("shade-out", "背景图输出路径", { default: "shade.jpg" }), s("cutout-out", "缺口图输出路径", { default: "cutout.png" }),
      b("predict", "用模型预测缺口位置"),
    ],
    async run(ctx) {
      applyClientPreferences()
      let jar = null, referer = "https://mobilelearn.chaoxing.com/"
      if (ctx.args.active !== undefined && ctx.args.class !== undefined && ctx.args.course !== undefined) {
        const c = await clientOf(ctx)
        const signer = new api.Signer(c, { activeId: ctx.args.active, classId: ctx.args.class, courseId: ctx.args.course })
        jar = c.jar; referer = signer.preSignUrl()
      }
      const data = await api.getCaptchaImage(jar, referer)
      const shade = await request(null, { url: data.shadeImageUrl }); checkResponse(shade)
      const cut = await request(null, { url: data.cutoutImageUrl }); checkResponse(cut)
      fs.writeFileSync(ctx.args["shade-out"], shade.buf)
      fs.writeFileSync(ctx.args["cutout-out"], cut.buf)
      let predicted = null
      if (ctx.args.predict) {
        try { predicted = await predictSliderXOffset(shade.buf) } catch (e) { predicted = { error: e.message } }
      }
      load().pending.captcha = { captchaId: data.captchaId, type: data.type, version: data.version, token: data.token, captchaKey: data.captchaKey, iv: data.iv, referer, fetchedAt: Date.now() }
      markDirty()
      return { shadeOut: path.resolve(ctx.args["shade-out"]), cutoutOut: path.resolve(ctx.args["cutout-out"]), predicted, pending: true }
    },
  },
  {
    name: "captcha check", summary: "校验缺口位置,返回 validate(下次签到用 --validate)", auth: false,
    args: [n("x", "缺口像素位置", { required: true })],
    async run(ctx) {
      const data = load().pending.captcha
      if (!data) throw usage("请先运行 cxsign captcha fetch")
      const jar = load().loginSession?.cookies ? new CookieSession(load().loginSession.cookies) : null
      const v = await api.checkCaptchaResult(jar, ctx.args.x, data, data.referer)
      if (!v) return { ok: false, validate: null }
      return { ok: true, validate: v }
    },
  },
  {
    name: "captcha model", summary: "查看验证码模型是否可用", auth: false,
    async run() { return captchaModelStatus() },
  },

  {
    name: "cloud upload", summary: "上传图片到学习通云盘,返回 objectId", auth: true, sideEffect: true,
    args: [s("file", "本地图片路径", { required: true })],
    plan: (ctx) => ({ file: ctx.args.file }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const objectId = await api.uploadImage(c, fs.readFileSync(ctx.args.file), path.basename(ctx.args.file))
        return { objectId, url: api.URL_SHARED_IMAGE(objectId) }
      })
    },
  },

  {
    name: "face profile", summary: "获取账号已设置的人脸识别照片", auth: true,
    async run(ctx) {
      return withRelogin(ctx, (c) => api.getProfileFace(c))
    },
  },
  {
    name: "face list", summary: "列出本地保存的人脸照片", auth: true, paged: true,
    async run(ctx) {
      const c = await clientOf(ctx)
      return (load().faceRecognitionConfigures[c.phone]?.images ?? []).map((img, i) => ({ index: i, objectId: img.objectId, useCount: img.useCount, isFailureBefore: img.isFailureBefore, localFile: path.join(faceDir(), `${img.objectId}.jpg`) }))
    },
  },
  {
    name: "face add", summary: "添加人脸照片(上传并下载到本地,最多 5 张)", auth: true, sideEffect: true,
    args: [s("file", "本地图片"), s("object-id", "已有 objectId"), b("from-profile", "使用账号已设置的人脸")],
    plan: (ctx) => ({ file: ctx.args.file, objectId: ctx.args["object-id"], fromProfile: !!ctx.args["from-profile"] }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        let objectId = ctx.args["object-id"]
        if (ctx.args["from-profile"]) objectId = (await api.getProfileFace(c)).objectId
        else if (ctx.args.file) objectId = await api.uploadImage(c, fs.readFileSync(ctx.args.file), path.basename(ctx.args.file))
        if (!objectId) throw usage("需要 --file / --object-id / --from-profile")
        const st = load()
        const cfg = st.faceRecognitionConfigures[c.phone] ??= { images: [] }
        if (cfg.images.some((i) => i.objectId === objectId)) return { objectId, already: true, count: cfg.images.length }
        if (cfg.images.length >= api.MAX_FACE_IMAGES) throw unsupported(`每人最多 ${api.MAX_FACE_IMAGES} 张人脸照片`)
        const buf = await api.downloadSharedImage(objectId)
        fs.mkdirSync(faceDir(), { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(faceDir(), `${objectId}.jpg`), buf, { mode: 0o600 })
        cfg.images.push({ objectId, useCount: 0, isFailureBefore: false })
        markDirty()
        return { objectId, count: cfg.images.length }
      })
    },
  },
  {
    name: "face remove", summary: "删除本地保存的人脸照片", auth: true, sideEffect: true,
    args: [s("object-id", "objectId"), n("index", "下标")],
    plan: (ctx) => ({ objectId: ctx.args["object-id"], index: ctx.args.index }),
    async run(ctx) {
      const c = await clientOf(ctx)
      const cfg = load().faceRecognitionConfigures[c.phone]
      if (!cfg?.images?.length) throw notFound("没有人脸照片")
      let idx = ctx.args.index
      if (ctx.args["object-id"]) idx = cfg.images.findIndex((i) => i.objectId === ctx.args["object-id"])
      if (idx === undefined || idx < 0 || idx >= cfg.images.length) throw notFound("找不到该人脸照片")
      const [rm] = cfg.images.splice(idx, 1)
      try { fs.unlinkSync(path.join(faceDir(), `${rm.objectId}.jpg`)) } catch {}
      markDirty()
      return { removed: rm.objectId, remaining: cfg.images.length }
    },
  },

  {
    name: "schedule refresh", summary: "从学习通刷新课表并缓存", auth: true,
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const r = await api.fetchLessons(c)
        const st = load()
        st.classSchedule = { lessons: r.lessons, lastFetchTimestamp: Date.now(), firstWeekDate: r.firstWeekDate, contentMd5: r.contentMd5 }
        markDirty()
        return { count: r.lessons.length, firstWeekDate: r.firstWeekDate, contentMd5: r.contentMd5 }
      })
    },
  },
  {
    name: "schedule list", summary: "列出缓存的课表", auth: false, paged: true,
    async run() {
      const s = load().classSchedule
      return { firstWeekDate: s.firstWeekDate, lastFetchTimestamp: s.lastFetchTimestamp, currentWeek: api.currentWeekOfSemester(s.firstWeekDate), lessons: s.lessons }
    },
  },
  {
    name: "schedule current", summary: "当前时段正在上 / 即将上的课(默认 ±30 分钟)", auth: false,
    args: [n("before", "提前分钟", { default: 30 }), n("after", "延后分钟", { default: 30 })],
    async run(ctx) {
      return api.currentLessons(load().classSchedule, { before: ctx.args.before ?? 30, after: ctx.args.after ?? 30 })
    },
  },
  {
    name: "schedule recommend", summary: "根据当前课表推荐可能的签到活动", auth: true, paged: true,
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const courses = await api.getAllCourses(c)
        const lessons = api.currentLessons(load().classSchedule)
        const out = []
        for (const lesson of lessons) {
          const matched = lesson.classId > 0
            ? courses.filter((x) => x.classId === lesson.classId)
            : courses.filter((x) => api.isCourseNameMatched(lesson.courseName, x.courseName))
          for (const course of matched) {
            try {
              const { activities } = await api.getActivities(c, course)
              for (const a of activities) if (a.isRecent) out.push({ ...a, courseName: course.courseName, lesson: lesson.courseName })
            } catch {}
          }
        }
        const seen = new Set()
        return out.filter((a) => { const k = `${a.classId}:${a.activeId}`; if (seen.has(k)) return false; seen.add(k); return true })
      })
    },
  },

  {
    name: "im groups", summary: "列出环信课程群聊", auth: true, paged: true,
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const im = await api.getEasemobConfig(c)
        return api.getEasemobGroups(im)
      })
    },
  },
  {
    name: "im signs", summary: "从群聊历史消息里发现签到活动", auth: true, paged: true,
    args: [s("group", "只扫某个群 ID(默认扫全部)"), n("max-groups", "最多扫几个群", { default: 50 })],
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const im = await api.getEasemobConfig(c)
        let groups = await api.getEasemobGroups(im)
        if (ctx.args.group) groups = groups.filter((g) => g.groupId === ctx.args.group)
        else groups = groups.slice(0, ctx.args["max-groups"] ?? 50)
        const all = []
        for (const g of groups) {
          try { all.push(...await api.fetchGroupSignActivities(im, g)) } catch {}
        }
        const by = new Map()
        for (const a of all) if (!by.has(a.activeId)) by.set(a.activeId, a)
        return api.sortIMActivities([...by.values()])
      })
    },
  },

  {
    name: "users list", summary: "列出代签用户", auth: false, paged: true,
    async run() {
      const tags = Object.fromEntries(load().tagsLibrary.map((t) => [t.id, t]))
      return load().otherUsers.map((u) => ({
        phone: maskPhone(u.phoneNumber), phoneHash: crypto.createHash("sha256").update(u.phoneNumber).digest("hex").slice(0, 8),
        name: u.name, puid: u.puid ?? null, fid: u.configuredFid ?? null, obsolete: !!u.isObsoleteSession,
        tags: (u.tags ?? []).map((id) => tags[id]?.name ?? id), hasPassword: !!u.password, cookieCount: (u.cookies ?? []).length,
        faceCount: (load().faceRecognitionConfigures[u.phoneNumber]?.images ?? []).length,
      }))
    },
  },
  {
    name: "users add", summary: "用手机号 + 密码添加代签用户", auth: false, sideEffect: true,
    args: [
      s("phone", "手机号", { required: true }), b("password-stdin", "从 stdin 读密码"), s("password", "密码", { secret: true }),
      b("encrypted", "密码已经是 AES 密文(分享链接里的 pwd)"),
    ],
    plan: (ctx) => ({ phone: maskPhone(ctx.args.phone) }),
    async run(ctx) {
      applyClientPreferences()
      let password = ctx.args.password
      if (ctx.args["password-stdin"]) password = (await readStdin()) || password
      if (!password && process.env.CXSIGN_PASSWORD) password = process.env.CXSIGN_PASSWORD
      if (!password) throw usage("缺少密码:用 --password-stdin 或环境变量 CXSIGN_PASSWORD")
      if (!ctx.args.encrypted) checkPassword(password)
      const enc = ctx.args.encrypted ? password : encryptByAES(password)
      if (load().otherUsers.some((u) => u.phoneNumber === ctx.args.phone)) throw usage("该手机号已在代签列表中")
      if (load().loginSession?.phoneNumber === ctx.args.phone) throw usage("不能把主账号添加为代签用户")
      const rec = {
        phoneNumber: String(ctx.args.phone), password: enc, cookies: [], configuredFid: null, puid: null, name: "",
        deviceCode: randomizedDeviceCode(), isNotRandomizedDeviceCode: false, isDeviceCodeDuplicatedSignBefore: false,
        androidId: crypto.randomBytes(8).toString("hex"), user: null, tags: [], isObsoleteSession: false,
      }
      const c = new Client(rec, { isSelf: false })
      await c.login(enc)
      await c.getInfo()
      load().otherUsers.push(rec); markDirty()
      return { phone: maskPhone(rec.phoneNumber), name: rec.name, puid: rec.puid }
    },
  },
  {
    name: "users import", summary: "从分享链接导入代签用户(链接含加密密码,从 stdin 读)", auth: false, sideEffect: true,
    args: [b("url-stdin", "从 stdin 读分享 URL", { default: true })],
    plan: () => ({ from: "stdin" }),
    async run() {
      applyClientPreferences()
      const raw = (await readStdin()).trim()
      if (!raw) throw usage("请把分享链接通过 stdin 传入")
      let u
      try { u = new URL(raw) } catch { throw usage("不是合法 URL") }
      const phone = u.searchParams.get("phone")
      const pwd = u.searchParams.get("pwd")
      const name = u.searchParams.get("name") ?? ""
      const faces = (u.searchParams.get("face") ?? "").split(",").filter(Boolean)
      const dc = u.searchParams.get("dc")
      if (!phone || !pwd) throw usage("链接缺少 phone / pwd")
      if (load().otherUsers.some((x) => x.phoneNumber === phone)) throw usage("该手机号已在代签列表中")
      const rec = {
        phoneNumber: phone, password: pwd, cookies: [], configuredFid: null, puid: null, name,
        deviceCode: dc || randomizedDeviceCode(), isNotRandomizedDeviceCode: !!dc, isDeviceCodeDuplicatedSignBefore: false,
        androidId: crypto.randomBytes(8).toString("hex"), user: null, tags: [], isObsoleteSession: false,
      }
      const c = new Client(rec, { isSelf: false })
      await c.login(pwd)
      await c.getInfo()
      load().otherUsers.push(rec)
      if (faces.length) {
        const cfg = load().faceRecognitionConfigures[phone] ??= { images: [] }
        for (const oid of faces.slice(0, api.MAX_FACE_IMAGES)) {
          if (cfg.images.some((i) => i.objectId === oid)) continue
          try {
            const buf = await api.downloadSharedImage(oid)
            fs.mkdirSync(faceDir(), { recursive: true, mode: 0o700 })
            fs.writeFileSync(path.join(faceDir(), `${oid}.jpg`), buf, { mode: 0o600 })
            cfg.images.push({ objectId: oid, useCount: 0, isFailureBefore: false })
          } catch {}
        }
      }
      markDirty()
      return { phone: maskPhone(phone), name: rec.name, puid: rec.puid, facesImported: (load().faceRecognitionConfigures[phone]?.images ?? []).length }
    },
  },
  {
    name: "users share", summary: "生成主账号或代签用户的分享链接(写到 0600 文件,永不打印)", auth: true, sideEffect: false,
    args: [
      s("phone", "代签用户手机号(默认主账号)"), s("out", "输出文件路径", { required: true }),
      s("faces", "逗号分隔的 objectId(默认全部)"),
    ],
    async run(ctx) {
      applyClientPreferences()
      let rec
      if (ctx.args.phone) {
        rec = load().otherUsers.find((u) => u.phoneNumber === ctx.args.phone)
        if (!rec) throw notFound("找不到代签用户")
      } else {
        const c = selfClient()
        if (!c.record.password) throw new CxError("AUTH_REQUIRED", "主账号没有保存密码,无法生成分享链接", { next: "重新 auth login 并默认 --remember" })
        rec = c.record
      }
      if (!rec.password) throw new CxError("AUTH_REQUIRED", "该账号没有保存密码")
      const avail = (load().faceRecognitionConfigures[rec.phoneNumber]?.images ?? []).map((i) => i.objectId)
      const faces = ctx.args.faces ? ctx.args.faces.split(",").filter((x) => avail.includes(x)) : avail
      const url = `http://cdn.aquamarine5.fun/?phone=${encodeURIComponent(rec.phoneNumber)}&pwd=${encodeURIComponent(rec.password)}&name=${encodeURIComponent(rec.name || "")}&face=${faces.join(",")}&dc=${encodeURIComponent(rec.deviceCode || "")}`
      writeSecretFile(ctx.args.out, url + "\n")
      return { out: path.resolve(ctx.args.out), mode: "0600", phone: maskPhone(rec.phoneNumber), faceCount: faces.length }
    },
  },
  {
    name: "users remove", summary: "删除代签用户", auth: false, sideEffect: true,
    args: [s("phone", "手机号", { required: true })],
    plan: (ctx) => ({ phone: maskPhone(ctx.args.phone) }),
    async run(ctx) {
      const st = load()
      const i = st.otherUsers.findIndex((u) => u.phoneNumber === ctx.args.phone)
      if (i < 0) throw notFound("找不到代签用户")
      st.otherUsers.splice(i, 1); markDirty()
      return { removed: maskPhone(ctx.args.phone) }
    },
  },
  {
    name: "users relogin", summary: "重新登录代签用户", auth: false, sideEffect: true,
    args: [s("phone", "手机号", { required: true }), b("password-stdin", "用新密码(从 stdin)"), s("password", "新密码", { secret: true })],
    plan: (ctx) => ({ phone: maskPhone(ctx.args.phone) }),
    async run(ctx) {
      applyClientPreferences()
      const c = otherClient(ctx.args.phone)
      let password = ctx.args.password
      if (ctx.args["password-stdin"]) password = (await readStdin()) || password
      if (password) { checkPassword(password); c.record.password = encryptByAES(password); markDirty() }
      await c.relogin()
      return { phone: maskPhone(c.phone), name: c.name, puid: c.puid }
    },
  },
  {
    name: "users tag", summary: "给代签用户打 / 改标签", auth: false, sideEffect: true,
    args: [s("phone", "手机号", { required: true }), s("add", "添加标签名(逗号分隔)"), s("remove", "移除标签名"), s("set", "覆盖为这些标签")],
    plan: (ctx) => ({ phone: maskPhone(ctx.args.phone), add: ctx.args.add, remove: ctx.args.remove, set: ctx.args.set }),
    async run(ctx) {
      const st = load()
      const u = st.otherUsers.find((x) => x.phoneNumber === ctx.args.phone)
      if (!u) throw notFound("找不到代签用户")
      const ensure = (name) => {
        let t = st.tagsLibrary.find((x) => x.name === name)
        if (!t) { t = { id: (st.tagsLibrary.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1, name, color: 0xff2196f3 }; st.tagsLibrary.push(t) }
        return t.id
      }
      let tags = [...(u.tags ?? [])]
      if (ctx.args.set !== undefined) tags = String(ctx.args.set).split(",").filter(Boolean).map(ensure)
      if (ctx.args.add) for (const n of String(ctx.args.add).split(",").filter(Boolean)) { const id = ensure(n); if (!tags.includes(id)) tags.push(id) }
      if (ctx.args.remove) {
        const rm = new Set(String(ctx.args.remove).split(","))
        tags = tags.filter((id) => !rm.has(st.tagsLibrary.find((t) => t.id === id)?.name))
      }
      u.tags = tags; markDirty()
      return { phone: maskPhone(u.phoneNumber), tags: tags.map((id) => st.tagsLibrary.find((t) => t.id === id)?.name) }
    },
  },

  {
    name: "locations list", summary: "列出收藏的签到位置", auth: false, paged: true,
    async run() { return load().locations },
  },
  {
    name: "locations add", summary: "添加收藏位置", auth: false, sideEffect: true,
    args: [s("label", "名称", { required: true }), n("lat", "纬度", { required: true }), n("lon", "经度", { required: true }), s("address", "地址描述", { default: "" })],
    plan: (ctx) => ({ label: ctx.args.label, lat: ctx.args.lat, lon: ctx.args.lon }),
    async run(ctx) {
      const st = load()
      if (st.locations.some((l) => l.label === ctx.args.label)) throw usage("已存在同名位置")
      const loc = { label: ctx.args.label, latitude: Number(ctx.args.lat), longitude: Number(ctx.args.lon), address: ctx.args.address ?? "" }
      st.locations.push(loc); markDirty()
      return loc
    },
  },
  {
    name: "locations remove", summary: "删除收藏位置", auth: false, sideEffect: true,
    args: [s("label", "名称", { required: true })],
    plan: (ctx) => ({ label: ctx.args.label }),
    async run(ctx) {
      const st = load(); const i = st.locations.findIndex((l) => l.label === ctx.args.label)
      if (i < 0) throw notFound("找不到该位置")
      const [rm] = st.locations.splice(i, 1); markDirty()
      return { removed: rm.label }
    },
  },
  {
    name: "locations remember", summary: "记住某个班级的默认签到位置", auth: false, sideEffect: true,
    args: [n("class", "班级 ID", { required: true }), n("lat", "纬度", { required: true }), n("lon", "经度", { required: true }), s("address", "地址", { default: "" }), b("selected", "同时设为选中位置")],
    plan: (ctx) => ({ class: ctx.args.class, lat: ctx.args.lat, lon: ctx.args.lon }),
    async run(ctx) {
      const st = load()
      const loc = { latitude: Number(ctx.args.lat), longitude: Number(ctx.args.lon), address: ctx.args.address ?? "", label: "" }
      st.classRememberedLocation[String(ctx.args.class)] = loc
      if (ctx.args.selected) st.classSelectedLocation[String(ctx.args.class)] = loc
      markDirty()
      return { classId: Number(ctx.args.class), location: loc }
    },
  },

  {
    name: "device-code show", summary: "查看当前设备码长度(不打印明文)", auth: false,
    async run(ctx) {
      const c = resolveClient(ctx.args.as ?? ctx.global?.as)
      return { account: c.isSelf ? "self" : maskPhone(c.phone), length: (c.deviceCode ?? "").length, isRandomized: !c.record.isNotRandomizedDeviceCode, duplicatedBefore: !!c.record.isDeviceCodeDuplicatedSignBefore }
    },
  },
  {
    name: "device-code reset", summary: "重新生成设备码(解决「同一设备不允许重复签到」)", auth: false, sideEffect: true,
    plan: (ctx) => ({ as: ctx.args.as ?? "self" }),
    async run(ctx) {
      const c = resolveClient(ctx.args.as ?? ctx.global?.as)
      c.record.deviceCode = randomizedDeviceCode()
      c.record.isNotRandomizedDeviceCode = false
      c.record.isDeviceCodeDuplicatedSignBefore = true
      markDirty()
      return { account: c.isSelf ? "self" : maskPhone(c.phone), length: c.deviceCode.length, reset: true }
    },
  },

  {
    name: "rank summary", summary: "公开排行榜总人数 / 总签到次数(免登录)", auth: false,
    async run() { return api.rankSummary() },
  },
  {
    name: "rank top", summary: "公开排行榜 Top N(免登录)", auth: false, paged: true,
    args: [n("count", "条数", { default: 10 })],
    async run(ctx) {
      return (await api.rankTop(ctx.args.count ?? 10)).map((r) => ({
        name: r.name, schoolName: r.schoolName, totalSignCount: r.totalSignCount, latestDate: r.latestDate,
        locationSign: r.locationSign, qrcodeSign: r.qrcodeSign, photoSign: r.photoSign, clickSign: r.clickSign,
        gestureSign: r.gestureSign, passwordSign: r.passwordSign, otherSign: r.otherSign, versionName: r.versionName,
      }))
    },
  },
  {
    name: "rank me", summary: "本机在公开排行榜的名次", auth: false,
    async run() {
      const uuid = load().analysisUUID
      if (!uuid) throw notFound("本机尚未上传过排行榜数据", { next: "cxsign rank upload --confirm" })
      return { uuidPrefix: uuid.slice(0, 8), rank: await api.rankOf(uuid) }
    },
  },
  {
    name: "rank upload", summary: "上传本机签到统计到公开排行榜", auth: true, sideEffect: true,
    args: [s("name", "排行榜显示名"), s("school", "学校名(必须是当前账号学校之一)"), b("hide-school", "学校名后加 HIDE")],
    plan: (ctx) => ({ name: ctx.args.name, school: ctx.args.school }),
    async run(ctx) {
      return withRelogin(ctx, async (c) => {
        const st = load()
        if (st.disableAnalysisRank) throw unsupported("已关闭排行榜上传(preferences)")
        if (!st.analysisUUID) { st.analysisUUID = crypto.randomUUID(); markDirty() }
        const a = st.analysis
        const total = (a.photoSign ?? 0) + (a.gestureSign ?? 0) + (a.locationSign ?? 0) + (a.qrcodeSign ?? 0) + (a.clickSign ?? 0) + (a.passwordSign ?? 0)
        const name = ctx.args.name || st.analysisRankName || `****${c.phone.slice(-2)} 用户`
        const school = api.pickRankSchoolName(c.user.fidList, ctx.args.school || st.selectedAnalysisRankSchoolName, ctx.args["hide-school"] || st.hideAnalysisRankSchoolName)
        const today = new Date(); const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`
        const form = {
          otherSign: String(a.otherUserSign ?? 0), photoSign: String(a.photoSign ?? 0), gestureSign: String(a.gestureSign ?? 0),
          locationSign: String(a.locationSign ?? 0), qrcodeSign: String(a.qrcodeSign ?? 0), clickSign: String(a.clickSign ?? 0), passwordSign: String(a.passwordSign ?? 0),
          latestDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
          schoolName: school, uuid: st.analysisUUID, totalSignCount: String(total), isPublic: "true", name, versionName: api.APP_VERSION_NAME,
        }
        await api.rankUpload(form)
        st.lastUploadAnalysisDate = Number(ymd); st.analysisRankName = name; markDirty()
        return { uploaded: true, totalSignCount: total, name, schoolName: school }
      })
    },
  },

  {
    name: "banlist", summary: "获取被封禁的学校 fid 列表(公开)", auth: false,
    async run() {
      try { return { banfids: await api.getBanlist() } }
      catch (e) { throw new CxError(e.code ?? "BACKEND_BUSINESS_ERROR", `封禁名单获取失败: ${e.message}`) }
    },
  },
  {
    name: "sponsors", summary: "获取捐赠名单(公开)", auth: false,
    async run() {
      try { return await api.getSponsors() }
      catch (e) { throw new CxError(e.code ?? "BACKEND_BUSINESS_ERROR", `捐赠名单获取失败: ${e.message}`) }
    },
  },

  {
    name: "config get", summary: "查看本地配置", auth: false,
    async run() {
      const st = load()
      return {
        home: stateDir(),
        preferences: { ...st.preferences },
        client: CLIENT_INFOS[st.preferences.clientIdentity] ? { identity: st.preferences.clientIdentity, name: CLIENT_INFOS[st.preferences.clientIdentity].name } : { identity: st.preferences.clientIdentity || "@@default", name: "学习通" },
        analysisRank: { name: st.analysisRankName, disable: st.disableAnalysisRank, hideSchool: st.hideAnalysisRankSchoolName, selectedSchool: st.selectedAnalysisRankSchoolName, uuidPrefix: st.analysisUUID ? st.analysisUUID.slice(0, 8) : null },
        bypassBlockedChecking: st.bypassBlockedChecking,
      }
    },
  },
  {
    name: "config set", summary: "修改本地配置", auth: false, sideEffect: true,
    args: [
      s("client", "客户端: default | xuezaixidian | custom"), s("user-agent", "自定义 UA(配合 --client custom)"), s("package-name", "自定义包名"),
      b("always-force-sign", "总是强制签到"), b("bypass-blocked", "绕过学校封禁检查"), b("disable-rank", "关闭排行榜上传"),
      s("rank-name", "排行榜显示名"), s("rank-school", "排行榜学校名"), b("hide-rank-school", "学校名加 HIDE"),
    ],
    plan: (ctx) => scrub(ctx.args),
    async run(ctx) {
      const st = load(); const p = st.preferences
      if (ctx.args.client) {
        const id = ctx.args.client === "default" ? "@@default" : ctx.args.client === "xuezaixidian" ? "@@xuezaixidian" : ctx.args.client === "custom" ? "@@custom" : null
        if (!id) throw usage("--client 只能是 default | xuezaixidian | custom")
        p.clientIdentity = id
      }
      if (ctx.args["user-agent"] !== undefined) {
        if (![...ctx.args["user-agent"]].every((ch) => { const c = ch.codePointAt(0); return c >= 0x20 && c <= 0x7e })) throw usage("UserAgent只能包含可打印ASCII字符")
        p.customizedUserAgent = ctx.args["user-agent"]; p.clientIdentity = "@@custom"
      }
      if (ctx.args["package-name"] !== undefined) p.customizedPackageName = ctx.args["package-name"]
      if (ctx.args["always-force-sign"] !== undefined) p.alwaysForceSign = !!ctx.args["always-force-sign"]
      if (ctx.args["bypass-blocked"] !== undefined) st.bypassBlockedChecking = !!ctx.args["bypass-blocked"]
      if (ctx.args["disable-rank"] !== undefined) st.disableAnalysisRank = !!ctx.args["disable-rank"]
      if (ctx.args["rank-name"] !== undefined) st.analysisRankName = ctx.args["rank-name"]
      if (ctx.args["rank-school"] !== undefined) st.selectedAnalysisRankSchoolName = ctx.args["rank-school"]
      if (ctx.args["hide-rank-school"] !== undefined) st.hideAnalysisRankSchoolName = !!ctx.args["hide-rank-school"]
      markDirty(); applyClientPreferences()
      return { preferences: p, bypassBlockedChecking: st.bypassBlockedChecking, analysisRankName: st.analysisRankName }
    },
  },
  {
    name: "stats", summary: "本机签到统计", auth: false,
    async run() {
      const a = load().analysis
      const total = (a.photoSign ?? 0) + (a.gestureSign ?? 0) + (a.locationSign ?? 0) + (a.qrcodeSign ?? 0) + (a.clickSign ?? 0) + (a.passwordSign ?? 0)
      return { ...a, totalSignCount: total }
    },
  },

  {
    name: "capabilities", summary: "列出已实现的能力与可选依赖状态", auth: false,
    async run() {
      return {
        signTypes: Object.values(api.SIGN_TYPES),
        captchaModel: captchaModelStatus(),
        optionalDeps: captchaModelStatus().runtime
          ? { "onnxruntime-node": true, jsqr: hasDep("jsqr"), "jpeg-js": hasDep("jpeg-js"), pngjs: hasDep("pngjs") }
          : { "onnxruntime-node": false, jsqr: hasDep("jsqr"), "jpeg-js": hasDep("jpeg-js"), pngjs: hasDep("pngjs") },
        stateDir: stateDir(),
      }
    },
  },
]
