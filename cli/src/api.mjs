import crypto from "node:crypto"
import { CxError, scrubString } from "./errors.mjs"
import { checkResponse, request, unwrapJsonp } from "./http.mjs"
import { buildFaceResult, md5, resolveImPassword } from "./cxcrypto.mjs"


export const URL_COURSE_LIST = "https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1"
export const URL_CLASS_NAME = "https://mooc1-api.chaoxing.com/gas/clazz?fields=name&view=json"
export const DEFAULT_COURSE_IMAGE = "https://p.ananas.chaoxing.com/star3/270_160c/669ca80d6a0c5f74835bb936a41aabca.jpg"

function sessionExpired(client, data) {
  return new CxError("AUTH_SESSION_EXPIRED", "登录状态已过期", { account: client.label, ...(data ? { snippet: scrubString(String(data).slice(0, 120)) } : {}) })
}

export async function courseListJson(client) {
  const res = await client.req({ url: URL_COURSE_LIST })
  if (res.status === 403) throw sessionExpired(client)
  checkResponse(res)
  let j
  try { j = JSON.parse(res.text) } catch { throw sessionExpired(client, res.text) }
  if (j.result === 0 || !Array.isArray(j.channelList)) throw sessionExpired(client, res.text)
  return j
}

export function parseCourseList(channelList) {
  const out = []
  for (const c of channelList) {
    const content = c?.content
    if (!content || !("course" in content) || !("cataName" in c)) continue
    const d = content.course?.data?.[0]
    if (!d) continue
    out.push({
      courseName: d.name,
      teacher: d.teacherfactor,
      courseId: Number(d.id),
      classId: Number(content.id),
      imageUrl: d.imageurl ?? DEFAULT_COURSE_IMAGE,
      schools: d.schools ?? null,
      chatId: content.chatid ? String(content.chatid) : null,
      isEnded: content.state === 1,
      isFiled: content.isFiled === 1,
    })
  }
  return out
}

export async function getAllCourses(client) {
  return parseCourseList((await courseListJson(client)).channelList)
}

export async function checkClassValid(client, classId) {
  try {
    const j = await courseListJson(client)
    return j.channelList.some((c) => Number(c?.content?.id) === Number(classId))
  } catch (e) {
    if (e.code === "AUTH_SESSION_EXPIRED") return null
    throw e
  }
}

export async function getCourseIdFromClassId(client, classId) {
  const courses = await getAllCourses(client)
  return courses.find((c) => c.classId === Number(classId))?.courseId ?? null
}

export async function queryClassName(client, classId) {
  const res = await client.req({ url: URL_CLASS_NAME, query: { id: classId } })
  checkResponse(res)
  return res.json()?.data?.[0]?.name ?? null
}


export const URL_ACTIVITY_LOAD = "https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist?fid=0&showNotStartedActive=0"
export const NO_SIGN_OFF_EVENT = 4999
export const AVAILABLE_INTERVAL = 20 * 60 * 1000

export const SIGN_TYPES = { "0": "photo", "2": "qrcode", "3": "gesture", "4": "location", "5": "password" }
export const SIGN_TYPE_NAMES = { photo: "拍照/普通签到", qrcode: "二维码签到", gesture: "手势签到", location: "位置签到", password: "签到码签到" }
export const ATYPE_NAME_TO_TYPE = { 密码签到: "password", 签到码签到: "password", 位置签到: "location", 二维码签到: "qrcode", 拍照签到: "photo", 手势签到: "gesture" }

async function activityListJson(client, classId, courseId) {
  const res = await client.req({ url: URL_ACTIVITY_LOAD, query: { courseId, classId } })
  if (res.status === 403) throw sessionExpired(client)
  checkResponse(res)
  let full
  try { full = JSON.parse(res.text) } catch { throw sessionExpired(client, res.text) }
  return full
}

export function parseActivityList(full, course) {
  const data = full?.data
  if (!data) throw new CxError("BACKEND_BUSINESS_ERROR", full?.errorMsg ?? "解析课程数据失败")
  if (!Array.isArray(data.activeList)) throw new CxError("BACKEND_BUSINESS_ERROR", full?.errorMsg ?? "解析课程数据失败")
  const ext = data.ext !== undefined ? JSON.stringify(data.ext) : ""
  const now = Date.now()
  const activities = data.activeList
    .filter((a) => a.type === 2 || a.type === 74)
    .map((a) => ({
      activeId: Number(a.id),
      name: a.nameOne,
      signType: SIGN_TYPES[String(a.otherId)] ?? "unknown",
      otherId: a.otherId === undefined || a.otherId === null ? null : String(a.otherId),
      type: a.type,
      activeType: a.activeType,
      status: a.status,
      isAvailable: a.status === 1,
      isRecent: a.status === 1 && Number(a.startTime) + AVAILABLE_INTERVAL > now,
      userStatus: a.userStatus,
      isLook: a.isLook === 1,
      startTime: a.startTime ?? null,
      endTime: a.endTime ?? null,
      nameFour: a.nameFour ?? "",
      classId: course.classId,
      courseId: course.courseId,
      courseName: course.courseName ?? null,
    }))
  return { ext, activities }
}

export async function getActivities(client, course) {
  return parseActivityList(await activityListJson(client, course.classId, course.courseId), course)
}


export const URL_PRESIGN = "https://mobilelearn.chaoxing.com/newsign/preSign"
export const URL_SIGN_INFO = "https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo"
export const URL_ANALYSIS = "https://mobilelearn.chaoxing.com/pptSign/analysis?vs=1&DB_STRATEGY=RANDOM"
export const URL_ANALYSIS2 = "https://mobilelearn.chaoxing.com/pptSign/analysis2?DB_STRATEGY=RANDOM"
export const URL_CAPTCHA_CONF = "https://captcha.chaoxing.com/captcha/get/conf?callback=cx_captcha_function"
export const URL_CAPTCHA_RESULT = "https://captcha.chaoxing.com/captcha/check/verification/result?callback=cx_captcha_function"
export const URL_CAPTCHA_IMAGE = "https://captcha.chaoxing.com/captcha/get/verification/image"
export const URL_SIGN_DETAIL = "https://mobilelearn.chaoxing.com/newsign/signDetail"
export const URL_SIGN = "https://mobilelearn.chaoxing.com/pptSign/stuSignajax"
export const URL_CHECK_SIGN_CODE = "https://mobilelearn.chaoxing.com/widget/sign/pcStuSignController/checkSignCode"
export const CAPTCHA_ID = "Qt9FIw9o4pwRjOyqM6yizZBh682qN2TU"
const SIGNED_STATUSES = new Set([1, 2, 3, 9])
const PRIMARY_ATTEND_STATUS_PATTERN = /"primaryAttend"\s*:\s*\{[^{}]*?"status"\s*:\s*(\d+)/
const SIGN_STATUS_PATTERN = /signstatus\s*=\s*(\d+)/

export function checkAlreadySign(body) {
  const m = PRIMARY_ATTEND_STATUS_PATTERN.exec(body) ?? SIGN_STATUS_PATTERN.exec(body)
  if (m) return SIGNED_STATUSES.has(Number(m[1]))
  return false
}
export const checkExpiredSign = (body) => body.includes("下次早点哦")

export async function getSignInfo(client, activeId) {
  const res = await client.req({ url: URL_SIGN_INFO, query: { activeId } })
  checkResponse(res)
  const j = res.json()
  if (!j?.data) throw new CxError("DATA_NOT_FOUND", "获取签到活动信息失败,请确认活动 ID 是否正确", { activeId, result: j?.result, msg: j?.msg ?? j?.errorMsg })
  return j.data
}

export function describeSignInfo(d) {
  const endTime = d.endTime ?? d.endtime ?? null
  const signOutTs = d.signOutPublishTimeStamp
  return {
    activeId: Number(d.id ?? d.activeId ?? 0) || null,
    name: d.name ?? d.activeName ?? null,
    signType: SIGN_TYPES[String(d.otherId)] ?? "unknown",
    otherId: d.otherId ?? null,
    classId: d.clazzid ?? null,
    courseId: d.courseId ?? null,
    startTime: d.starttime ?? null,
    endTime,
    isLate: endTime ? Date.now() > Number(endTime) : false,
    requirements: {
      captcha: d.ifNeedVCode === 1,
      face: d.openCheckFaceFlag === 1,
      position: d.ifopenAddress === 1,
      photo: d.ifphoto === 1,
      refreshingQRCode: d.ifrefreshewm === 1,
    },
    numberCount: d.numberCount ?? null,
    location: d.locationLatitude !== undefined && d.locationLatitude !== null && d.locationLatitude !== ""
      ? { latitude: Number(d.locationLatitude), longitude: Number(d.locationLongitude), range: d.locationRange ?? null }
      : null,
    signOut: {
      signInId: d.signInId ?? null,
      signOutId: d.signOutId ?? null,
      signOutPublishTimeStamp: signOutTs === NO_SIGN_OFF_EVENT ? null : signOutTs ?? null,
    },
  }
}

export class SignLocation {
  constructor(latitude, longitude, address) {
    this.latitude = Number(latitude); this.longitude = Number(longitude); this.address = address ?? ""
    this.tightened = false
  }
  get range() { return this.tightened ? 0.00001 : 0.00005 }
  rnd() { return (Math.random() * 2 - 1) * this.range }
  get randomizedLatitude() { return this.latitude + this.rnd() }
  get randomizedLongitude() { return this.longitude + this.rnd() }
  disableRandomizedLocation() { this.tightened = true }
}

const f6 = (n) => Number(n.toFixed(6))

export class Signer {
  constructor(client, { activeId, classId, courseId, ext = "" }) {
    this.client = client
    this.activeId = Number(activeId)
    this.classId = Number(classId)
    this.courseId = Number(courseId)
    this.ext = ext
    this.signEnc2 = null
    this.info = null
  }

  preSignUrl() {
    const u = new URL(URL_PRESIGN)
    for (const [k, v] of Object.entries({ courseId: this.courseId, classId: this.classId, activePrimaryId: this.activeId, general: 1, sys: 1, ls: 1, appType: 15, uid: this.client.puid, isTeacherViewOpen: 0 })) u.searchParams.append(k, String(v))
    return u.toString()
  }

  async getSignInfo() {
    if (!this.info) this.info = await getSignInfo(this.client, this.activeId)
    return this.info
  }

  async preSign() {
    const send = () => this.client.req({ method: "POST", url: this.preSignUrl(), form: `ext=${this.ext}` })
    let res = await send()
    if (res.status === 403) {
      await this.client.relogin().catch((e) => { throw e.code ? e : sessionExpired(this.client) })
      res = await send()
      if (res.status === 403) throw sessionExpired(this.client)
    }
    checkResponse(res)
    const body = res.text
    if (res.status === 302 || body.includes("校验失败，未查询到活动数据")) throw new CxError("SIGN_NO_PERMISSION", "此用户不在班级")
    await this.postAnalysis()
    if (checkExpiredSign(body)) return "EXPIRED"
    if (checkAlreadySign(body)) return "ALREADY_SIGNED"
    return "READY_TO_SIGN"
  }

  async postAnalysis() {
    const res = await this.client.req({ url: URL_ANALYSIS, query: { aid: this.activeId } })
    checkResponse(res)
    const m = /code='\+'([a-f0-9]+)'/.exec(res.text)
    if (!m) throw new CxError("BACKEND_PROTOCOL_ERROR", "Cannot find code")
    await this.client.req({ url: URL_ANALYSIS2, query: { code: m[1] } })
  }

  async checkSignStatus() {
    const st = await this.preSign()
    if (st === "EXPIRED") throw new CxError("SIGN_EXPIRED", "签到已截止")
    if (st === "ALREADY_SIGNED") throw new CxError("SIGN_ALREADY_SIGNED", "重复签到", { predicted: true })
    if ((await checkClassValid(this.client, this.classId)) === false) throw new CxError("SIGN_NO_PERMISSION", "此用户不在班级")
    return st
  }

  async getCaptchaImage() {
    return getCaptchaImage(this.client.jar, this.preSignUrl())
  }
  async checkCaptchaResult(x, data) {
    return checkCaptchaResult(this.client.jar, x, data, this.preSignUrl())
  }

  async faceParams(objectId, courseAlreadyAdded) {
    if (!objectId) return {}
    const p = { currentFaceId: objectId, ifCFP: "0" }
    if (!courseAlreadyAdded) p.courseId = this.courseId
    p.faceEnc = await checkFaceResultAndGetEnc(this.client, objectId, this.activeId)
    p.faceCode = ""
    p.faceEncAid = ""
    return p
  }

  locationJson(pos, mock) {
    if (!pos) return undefined
    const o = { result: 1, latitude: f6(pos.randomizedLatitude), longitude: f6(pos.randomizedLongitude), address: pos.address }
    if (mock) o.mockData = '{"strategy":0,"probability":-1}'
    return JSON.stringify(o)
  }

  async sendSign(pairs, pos) {
    const u = new URL(URL_SIGN)
    for (const [k, v] of pairs) if (v !== undefined && v !== null) u.searchParams.append(k, String(v))
    const res = await this.client.req({ url: u.toString(), noRetry: true })
    checkResponse(res)
    return this.checkSignResult(res.text, pos)
  }

  checkSignResult(result, pos) {
    if (result.startsWith("[face]")) throw new CxError("SIGN_FACE_ERROR", result.slice(6) || "人脸识别失败")
    if (result === "success2") throw new CxError("SIGN_ENDED", "迟到或签到已结束")
    if (result === "签到失败，请重新扫描。") throw new CxError("SIGN_QRCODE_EXPIRED", "二维码已过期")
    if (result.startsWith("checkFace_")) {
      this.signEnc2 = result.slice("checkFace_".length) || null
      throw new CxError("SIGN_FACE_ERROR", "需要人脸识别(checkFace),请用 --face-* 参数提供人脸照片", { reason: "checkFace" })
    }
    if (result.startsWith("errorLocation")) {
      const already = pos?.tightened === true
      pos?.disableRandomizedLocation()
      const dist = Number(result.split("_")[1])
      throw new CxError("SIGN_WRONG_POSITION", `位置不在设置范围内${Number.isFinite(dist) ? `，距离签到点${dist}米` : ""}`, { distance: Number.isFinite(dist) ? dist : null, alreadyTightened: already })
    }
    if (result === "您已签到过了") throw new CxError("SIGN_ALREADY_SIGNED", "已经签到过了")
    if (result.includes("同一设备不允许重复签到")) throw new CxError("SIGN_DEVICE_DUPLICATED", "同一设备不允许重复签到", { next: "cxsign device-code reset --confirm 后重试" })
    if (result.startsWith("validate")) {
      this.signEnc2 = result.startsWith("validate_") ? result.slice("validate_".length) || null : null
      return true
    }
    if (result !== "success") throw new CxError("BACKEND_BUSINESS_ERROR", scrubString(result.slice(0, 200)) || "签到失败", { reason: "unknown_result" })
    return false
  }

  async signLocation(pos, { validate, faceObjectId } = {}) {
    const c = this.client
    const pairs = [
      ["name", c.name], ["address", pos.address], ["activeId", this.activeId], ["courseId", this.courseId], ["uid", c.puid], ["clientip", ""],
      ["latitude", pos.randomizedLatitude], ["longitude", pos.randomizedLongitude], ["fid", c.configuredFid], ["appType", "15"], ["ifTiJiao", "1"],
      ["validate", validate], ["deviceCode", c.deviceCode], ["vpProbability", "-1"], ["vpStrategy", ""], ["enc2", this.signEnc2 ?? undefined],
      ["locationResult", this.locationJson(pos, true)],
      ...Object.entries(await this.faceParams(faceObjectId, true)),
    ]
    return this.sendSign(pairs, pos)
  }

  async signCode(signCode, pos, { validate } = {}) {
    const c = this.client
    const pairs = [
      ["activeId", this.activeId], ["courseId", this.courseId], ["uid", c.puid], ["clientip", ""],
      ["latitude", pos ? pos.randomizedLatitude.toFixed(6) : "-1"], ["longitude", pos ? pos.randomizedLongitude.toFixed(6) : "-1"],
      ["appType", "15"], ["fid", c.configuredFid], ["name", c.name], ["signCode", signCode], ["deviceCode", c.deviceCode],
      ["location", this.locationJson(pos, false)], ["locationResult", this.locationJson(pos, true)], ["enc2", this.signEnc2 ?? undefined], ["validate", validate],
    ]
    return this.sendSign(pairs, pos)
  }

  async signPhoto(objectId, { validate } = {}) {
    const c = this.client
    const pairs = [
      ["activeId", this.activeId], ["courseId", this.courseId], ["uid", c.puid], ["clientip", ""], ["useragent", ""], ["latitude", "-1"], ["longitude", "-1"],
      ["appType", "15"], ["fid", c.configuredFid], ["objectId", objectId ?? undefined], ["name", c.name], ["validate", validate], ["deviceCode", c.deviceCode], ["enc2", this.signEnc2 ?? undefined],
    ]
    return this.sendSign(pairs)
  }

  async signQRCode(parsed, pos, { validate, faceObjectId } = {}) {
    const c = this.client
    const pairs = [
      ["enc", parsed.enc], ["name", c.name], ["activeId", parsed.aid ?? this.activeId], ["uid", c.puid], ["clientip", ""],
      ["location", this.locationJson(pos, false)], ["latitude", "-1"], ["longitude", "-1"], ["fid", c.configuredFid], ["appType", "15"], ["deviceCode", c.deviceCode],
      ["vpProbability", "-1"], ["vpStrategy", ""], ["courseId", this.courseId], ["enc2", this.signEnc2 ?? undefined], ["validate", validate],
      ["locationResult", this.locationJson(pos, true)],
      ...Object.entries(await this.faceParams(faceObjectId, true)),
    ]
    return this.sendSign(pairs, pos)
  }

  async isQRCodeExpired(parsed) {
    return isQRCodeExpired(this.client, parsed, this.activeId)
  }
}

export async function checkSignCode(client, activeId, signCode) {
  const res = await client.req({ url: URL_CHECK_SIGN_CODE, query: { activeId, signCode } })
  checkResponse(res)
  return res.json()?.result === 1
}


export function parseQRCode(raw) {
  const rawValue = String(raw ?? "").trim()
  const fail = () => new CxError("USAGE", "二维码解析失败", { reason: "qrcode_parse" })
  if (!rawValue) throw fail()
  if (rawValue.startsWith("SIGNIN:")) {
    const content = rawValue.slice(7).split("-")[0]
    const encIdx = content.indexOf("&enc=")
    const enc = encIdx >= 0 ? content.slice(encIdx + 5).split("&")[0] : ""
    if (!enc.trim()) throw fail()
    const detail = encIdx >= 0 ? content.slice(0, encIdx) : content
    const first = detail.split("&")[0]
    const aidStr = first.includes("=") ? first.slice(first.indexOf("=") + 1) : ""
    const lastEq = detail.lastIndexOf("=")
    const code = lastEq >= 0 ? detail.slice(lastEq + 1) : ""
    return { aid: /^-?\d+$/.test(aidStr) ? Number(aidStr) : null, code: code.trim() ? code : null, enc }
  }
  let u
  try { u = new URL(rawValue) } catch { throw fail() }
  if (!/^https?:$/.test(u.protocol)) throw fail()
  const enc = u.searchParams.get("enc")
  if (!enc || !enc.trim()) throw fail()
  const id = u.searchParams.get("id"), aid = u.searchParams.get("aid")
  const num = (s) => (s && /^-?\d+$/.test(s) ? Number(s) : null)
  const c = u.searchParams.get("c")
  return { aid: num(id) ?? num(aid), code: c && c.trim() ? c : null, enc }
}

export async function isQRCodeExpired(client, parsed, fallbackActiveId) {
  if (!parsed.code) return null
  try {
    const res = await client.req({ url: URL_SIGN_DETAIL, query: { activePrimaryId: parsed.aid ?? fallbackActiveId, type: 1, msg: parsed.code } })
    checkResponse(res)
    const j = res.json()
    return Number(j.isOver) === 1 || j.signCode !== parsed.code
  } catch {
    return null
  }
}


export async function getCaptchaConf(jar) {
  const res = await request(jar, { url: URL_CAPTCHA_CONF, query: { captchaId: CAPTCHA_ID, _: Date.now() } })
  checkResponse(res)
  return Number(unwrapJsonp(res.text).t)
}

export async function getCaptchaImage(jar, referer) {
  const t = await getCaptchaConf(jar)
  const type = "slide"
  const captchaKey = md5(`${t}${crypto.randomUUID()}`)
  const iv = md5(`${CAPTCHA_ID}${type}${Date.now()}${crypto.randomUUID()}`)
  const token = md5(`${t}${CAPTCHA_ID}${type}${captchaKey}`) + `:${t + 300000}`
  const res = await request(jar, {
    url: URL_CAPTCHA_IMAGE,
    query: { callback: "cx_captcha_function", captchaId: CAPTCHA_ID, type, version: "1.1.20", captchaKey, token, referer, iv, _: Date.now() },
  })
  checkResponse(res)
  const j = unwrapJsonp(res.text)
  const vo = j.imageVerificationVo
  if (!vo?.shadeImage || !vo?.cutoutImage) throw new CxError("BACKEND_PROTOCOL_ERROR", "验证码获取失败")
  return { captchaId: CAPTCHA_ID, type, version: "1.1.20", token: j.token, captchaKey, iv, shadeImageUrl: vo.shadeImage, cutoutImageUrl: vo.cutoutImage }
}

export async function checkCaptchaResult(jar, x, data, referer) {
  const res = await request(jar, {
    url: URL_CAPTCHA_RESULT,
    query: { captchaId: data.captchaId, type: data.type, token: data.token, textClickArr: `[{"x":${Math.trunc(x)}}]`, coordinate: "[]", runEnv: "10", version: data.version, t: "a", iv: data.iv, _: Date.now() },
    headers: { Referer: referer },
    noRetry: true,
  })
  checkResponse(res)
  const j = unwrapJsonp(res.text)
  if (Number(j.error) === 1) throw new CxError("BACKEND_BUSINESS_ERROR", `${j.msg}, 验证码校验失败`, { reason: "captcha_check" })
  if (j.result === true || j.result === "true") {
    const extra = typeof j.extraData === "string" ? JSON.parse(j.extraData.replace(/\\"/g, '"')) : j.extraData
    return extra?.validate ?? null
  }
  return null
}


export const URL_SHARED_IMAGE = (objectId) => `https://p.cldisk.com/star4/${objectId}/origin.jpg`
export const URL_GET_PROFILE_FACE_IMAGE = "https://mobilelearn.chaoxing.com/v2/apis/sign/collectionfilephotoEnc?DB_STRATEGY=DEFAULT"
export const URL_CHECK_FACE_RESULT = "https://mobilelearn.chaoxing.com/pptSign/check-face-result?DB_STRATEGY=PRIMARY_KEY&STRATEGY_PARA=activeId"
export const MAX_FACE_IMAGES = 5

export async function checkFaceResultAndGetEnc(client, objectId, activeId) {
  const res = await client.req({ url: URL_CHECK_FACE_RESULT, query: { activeId, faceResult: JSON.stringify(buildFaceResult(objectId, client.user?.clientId)) } })
  checkResponse(res)
  const j = res.json()
  if (!j?.enc) throw new CxError("SIGN_FACE_ERROR", "获取faceEnc失败")
  return j.enc
}

export async function getProfileFace(client) {
  const res = await client.req({ url: URL_GET_PROFILE_FACE_IMAGE })
  checkResponse(res)
  const id = res.json()?.data?.oldObjectId
  if (!id) throw new CxError("DATA_NOT_FOUND", "获取人脸照片ID失败，可能用户没有设置过人脸识别照片")
  return { objectId: id, url: URL_SHARED_IMAGE(id) }
}

export async function downloadSharedImage(objectId) {
  const res = await request(null, { url: URL_SHARED_IMAGE(objectId) })
  checkResponse(res)
  if (!res.buf.length) throw new CxError("BACKEND_BUSINESS_ERROR", "下载的人脸照片为空")
  return res.buf
}


export const URL_CLOUD_TOKEN = "https://pan-yz.chaoxing.com/api/token/uservalid"
export const URL_CLOUD_UPLOAD = "https://pan-yz.chaoxing.com/upload?_from=mobilelearn&_token="

export async function getCloudToken(client) {
  const res = await client.req({ url: URL_CLOUD_TOKEN })
  checkResponse(res)
  const t = res.json()?._token
  if (!t) throw new CxError("AUTH_SESSION_EXPIRED", "获取云盘 token 失败")
  return t
}

export async function uploadImage(client, buffer, filename = `${crypto.randomUUID()}.jpg`) {
  const token = await getCloudToken(client)
  const fd = new FormData()
  fd.append("puid", String(client.puid))
  fd.append("file", new Blob([buffer], { type: "image/jpeg" }), filename)
  const res = await client.req({ method: "POST", url: URL_CLOUD_UPLOAD + token, body: fd })
  checkResponse(res)
  const id = res.json()?.objectId
  if (!id) throw new CxError("BACKEND_BUSINESS_ERROR", "上传失败,未返回 objectId")
  return id
}


export const URL_MY_LESSONS = "https://kb.chaoxing.com/pc/curriculum/getMyLessons"

function sectionMinute(s, start) {
  const t = start ? s.split("-")[0] : s.includes("-") ? s.slice(s.indexOf("-") + 1) : ""
  const p = t.split(":")
  if (p.length !== 2) return null
  const h = parseInt(p[0].trim(), 10), m = parseInt(p[1].trim(), 10)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}

export function parseLessons(lessonArray, sectionTimes) {
  const out = []
  for (const it of lessonArray ?? []) {
    if (!it?.name) continue
    const dayOfWeek = Number(it.dayOfWeek) || 0, begin = Number(it.beginNumber) || 0
    if (dayOfWeek <= 0 || begin <= 0) continue
    const length = Number(it.length) > 0 ? Number(it.length) : 1
    const st = sectionTimes[begin - 1] !== undefined ? sectionMinute(String(sectionTimes[begin - 1]), true) : null
    const en = sectionTimes[begin + length - 2] !== undefined ? sectionMinute(String(sectionTimes[begin + length - 2]), false) : null
    if (st === null || en === null) continue
    out.push({ courseId: Number(it.courseId) || 0, classId: Number(it.classId) || 0, courseName: it.name, teacherName: it.teacherName ?? "", location: it.location ?? "", dayOfWeek, startMinuteOfDay: st, endMinuteOfDay: en, weeks: it.weeks ?? "" })
  }
  return out
}

export async function fetchLessons(client) {
  const res = await client.req({ url: URL_MY_LESSONS, query: { curTime: Date.now() } })
  checkResponse(res)
  let j
  try { j = JSON.parse(res.text) } catch { throw new CxError("BACKEND_PROTOCOL_ERROR", "课表数据解析失败") }
  const data = j?.data
  if (!data) throw new CxError(j?.result === 0 ? "AUTH_SESSION_EXPIRED" : "BACKEND_PROTOCOL_ERROR", "课表数据解析失败")
  const cur = data.curriculum
  if (!cur) throw new CxError("BACKEND_PROTOCOL_ERROR", "课表配置解析失败")
  const sectionTimes = (cur.lessonTimeConfigArray ?? null)
  if (!sectionTimes) throw new CxError("BACKEND_PROTOCOL_ERROR", "课表节次时间解析失败")
  if (!data.lessonArray) throw new CxError("BACKEND_PROTOCOL_ERROR", "课表课程列表解析失败")
  const canonical = { ...data }; delete canonical.sysTime
  return { lessons: parseLessons(data.lessonArray, sectionTimes.map(String)), firstWeekDate: Number(cur.firstWeekDate) || 0, contentMd5: md5(JSON.stringify(canonical)), sectionTimes }
}

export function currentWeekOfSemester(firstWeekDate, now = new Date()) {
  if (!firstWeekDate || firstWeekDate <= 0) return 1
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const f = new Date(firstWeekDate); const b = new Date(f.getFullYear(), f.getMonth(), f.getDate())
  return Math.floor(Math.round((a - b) / 86400000) / 7) + 1
}

export function currentLessons(schedule, { before = 30, after = 30, now = new Date() } = {}) {
  const dow = now.getDay() === 0 ? 7 : now.getDay()
  const minute = now.getHours() * 60 + now.getMinutes()
  const week = String(currentWeekOfSemester(schedule.firstWeekDate, now))
  return (schedule.lessons ?? []).filter((l) => l.dayOfWeek === dow && l.weeks.split(",").map((s) => s.trim()).includes(week) && l.startMinuteOfDay - before <= minute && minute <= l.endMinuteOfDay + after)
}

const STRIP_CHARS = new Set("[()（）\\[\\]【】《》<>《》·．._\\-—~、，,]")
export function normalizeCourseName(name) {
  const s = [...name].map((c) => { const code = c.codePointAt(0); return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : c }).join("").toLowerCase()
  const filtered = [...s].filter((c) => !/\s/.test(c) && !STRIP_CHARS.has(c)).join("")
  return filtered.replace(/(一|二|三|四|五|六|七|八|九|十|\d+|i{1,3}|iv|v)+$/, "")
}
export function bigramSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return 0
  const A = new Set(), B = new Set()
  for (let i = 0; i < a.length - 1; i++) A.add(a.slice(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) B.add(b.slice(i, i + 2))
  let inter = 0; for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}
export function isCourseNameMatched(lessonName, courseName) {
  const l = normalizeCourseName(lessonName), c = normalizeCourseName(courseName)
  if (!l || !c) return false
  if (c.includes(l) || l.includes(c)) return true
  return bigramSimilarity(l, c) >= 0.5
}


export const URL_EASEMOB_IM_TOKEN = "https://a1-vip6.easemob.com/cx-dev/cxstudy/token"
export const URL_EASEMOB_IM_JOINED_GROUPS = (u) => `https://a1-vip6.easemob.com/cx-dev/cxstudy/users/${u}/joined_chatgroups?detail=true&version=v3&pagenum=1&pagesize=200`
export const URL_MESSAGE_ROAMING = (u) => `https://a1-vip6.easecdn.com/cx-dev/cxstudy/users/${u}/messageroaming`
export const USER_AGENT_EASEMOB = "Easemob-SDK(Android) 4.9.0.1"

export async function getEasemobConfig(client) {
  const user = client.user
  if (!user?.imEncryptedPassword) throw new CxError("BACKEND_PROTOCOL_ERROR", "IM配置解析异常: imAccount 获取失败")
  const res = await request(null, {
    method: "POST", url: URL_EASEMOB_IM_TOKEN, ua: USER_AGENT_EASEMOB, contentType: "application/x-www-form-urlencoded",
    body: JSON.stringify({ grant_type: "password", password: resolveImPassword(user.imEncryptedPassword), username: user.uid }),
  })
  checkResponse(res)
  const j = res.json()
  if (!j.access_token) throw new CxError("BACKEND_PROTOCOL_ERROR", "IM token 获取失败")
  return { accessToken: j.access_token, uuid: j.user?.uuid, username: j.user?.username }
}

export async function getEasemobGroups(im) {
  const res = await request(null, { url: URL_EASEMOB_IM_JOINED_GROUPS(im.username), ua: USER_AGENT_EASEMOB, headers: { Authorization: `Bearer ${im.accessToken}` } })
  checkResponse(res)
  const out = []
  for (const g of res.json()?.data ?? []) {
    try {
      const desc = JSON.parse(g.description)
      const name = g.name && String(g.name).trim() ? g.name : desc.courseInfo.coursename
      out.push({ groupId: g.id, name, imageUrl: desc.courseInfo?.imageUrl ?? null })
    } catch {}
  }
  return out
}

export function pbFields(buf) {
  const out = []
  let i = 0
  const varint = () => { let r = 0n, s = 0n; for (;;) { const b = buf[i++]; if (b === undefined) throw new Error("pb eof"); r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n } return r }
  while (i < buf.length) {
    const key = Number(varint()); const no = key >> 3, wt = key & 7
    if (wt === 0) out.push({ no, v: varint() })
    else if (wt === 2) { const len = Number(varint()); out.push({ no, b: buf.subarray(i, i + len) }); i += len }
    else if (wt === 1) { out.push({ no, b: buf.subarray(i, i + 8) }); i += 8 }
    else if (wt === 5) { out.push({ no, b: buf.subarray(i, i + 4) }); i += 4 }
    else throw new Error(`pb wiretype ${wt}`)
  }
  return out
}

export function decodeIMMessage(b64) {
  const meta = pbFields(Buffer.from(b64, "base64"))
  const ts = meta.find((f) => f.no === 4)?.v ?? 0n
  const body = meta.find((f) => f.no === 6)?.b
  const ext = []
  if (body) for (const f of pbFields(body)) {
    if (f.no !== 5) continue
    const kv = pbFields(f.b)
    ext.push({ key: kv.find((x) => x.no === 1)?.b?.toString("utf8") ?? "", stringValue: kv.find((x) => x.no === 6)?.b?.toString("utf8") ?? "" })
  }
  return { timestamp: Number(ts), ext }
}

export function parseIMSignActivityInfo(att) {
  if (att?.attachmentType !== 15) return null
  const s = att.att_chat_course
  if (!s) return null
  const aid = Number(s.aid ?? 0)
  if (!aid) return null
  if (s.atype !== 2 && s.atype !== 74) return null
  const ci = s.courseInfo
  return {
    activeId: aid, title: s.title ?? "", classId: Number(ci?.classid ?? 0), courseId: Number(ci?.courseid ?? 0), courseName: ci?.coursename ?? "",
    startTimeTitle: s.subTitle ?? "", activeTypeName: s.atypeName ?? "", signType: ATYPE_NAME_TO_TYPE[s.atypeName] ?? "redirect", isUnsupportedLegacySign: !ci,
  }
}

export async function fetchGroupMessages(im, group, { since = 0 } = {}) {
  const res = await request(null, {
    method: "POST", url: URL_MESSAGE_ROAMING(im.username), ua: USER_AGENT_EASEMOB, contentType: "text/plain;charset=UTF-8",
    headers: { Authorization: `Bearer ${im.accessToken}` },
    body: JSON.stringify({ end: "-1", queue: `${group.groupId}@conference.easemob.com`, start: "-1" }),
  })
  checkResponse(res)
  return parseRoamingMessages(res.json()?.data?.msgs ?? [], group, { since })
}

export function parseRoamingMessages(msgs, group, { since = 0 } = {}) {
  const out = new Map()
  let lastMessageTs = 0, newCount = 0
  for (const m of msgs) {
    try {
      const d = decodeIMMessage(m.msg)
      if (d.timestamp > lastMessageTs) lastMessageTs = d.timestamp
      if (since && d.timestamp && d.timestamp <= since) continue
      newCount++
      const att = d.ext.find((e) => e.key === "attachment")
      if (!att) continue
      const info = parseIMSignActivityInfo(JSON.parse(att.stringValue))
      if (info && !out.has(info.activeId)) out.set(info.activeId, { ...info, groupId: group.groupId, groupName: group.name, messageTimestamp: d.timestamp })
    } catch {}
  }
  const signs = [...out.values()]
  const lastSignTs = signs.reduce((a, x) => Math.max(a, x.messageTimestamp || 0), 0)
  return { signs, messageCount: msgs.length, newCount, lastMessageTs, lastSignTs }
}

export async function fetchGroupSignActivities(im, group) {
  return (await fetchGroupMessages(im, group)).signs
}

export const DEFAULT_ACTIVE_DAYS = 30

export function classifyGroups(groups, { activity = {}, courses = {}, activeDays = DEFAULT_ACTIVE_DAYS, isAll = false, forced = [], muted = [], pinned = [], now = Date.now() } = {}) {
  const forcedSet = new Set(forced.map(String)), mutedSet = new Set(muted.map(String)), pinnedSet = new Set(pinned.map(String))
  const cutoff = now - activeDays * 86400000
  return groups.map((g) => {
    const id = String(g.groupId)
    const a = activity[id]
    const lastActivityTs = a ? Math.max(a.lastMessageTs || 0, a.lastSignTs || 0) || null : null
    const course = courses[id] ?? null
    let isWatched, reason
    if (forcedSet.size) { isWatched = forcedSet.has(id); reason = isWatched ? "forced" : "not-selected" }
    else if (mutedSet.has(id)) { isWatched = false; reason = "muted" }
    else if (pinnedSet.has(id)) { isWatched = true; reason = "pinned" }
    else if (isAll) { isWatched = true; reason = "all" }
    else if (course?.isEnded || course?.isFiled) { isWatched = false; reason = "course-ended" }
    else if (!a) { isWatched = true; reason = "scan-failed" }
    else if (!lastActivityTs) { isWatched = false; reason = "no-recent-messages" }
    else if (lastActivityTs >= cutoff) { isWatched = true; reason = "active" }
    else { isWatched = false; reason = "inactive" }
    return { ...g, lastActivityTs, lastActivity: lastActivityTs ? new Date(lastActivityTs).toISOString() : null, isCourseEnded: !!(course?.isEnded || course?.isFiled), isWatched, reason }
  })
}

const START_TIME_TITLE_PATTERN = /(?:(\d{2,4})-)?(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})/
export function startTimeTitleSortKey(t) {
  const m = START_TIME_TITLE_PATTERN.exec(t)
  if (!m) return null
  return [m[1] ? Number(m[1]) : -Infinity, ...m.slice(2).map(Number)]
}
export function sortIMActivities(list) {
  return [...list].sort((a, b) => {
    const ka = startTimeTitleSortKey(a.startTimeTitle), kb = startTimeTitleSortKey(b.startTimeTitle)
    if (!ka !== !kb) return ka ? -1 : 1
    if (ka && kb) for (let i = 0; i < 5; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    return a.startTimeTitle < b.startTimeTitle ? -1 : a.startTimeTitle > b.startTimeTitle ? 1 : 0
  })
}


export const SUPABASE_ENDPOINT = "https://zpkavhhjdtghljleztpb.supabase.co/rest/v1"
export const SUPABASE_API_KEY = "sb_publishable_dFuI4bOoYPlDozMXOGKgPg_cCQ0o22B"
export const APP_VERSION_NAME = "1.19.4-stable-261024"

export async function rankSummary() {
  const res = await request(null, { url: `${SUPABASE_ENDPOINT}/total_sign_view?select=userCount,totalRecordSignCount&limit=1`, headers: { apikey: SUPABASE_API_KEY } })
  checkResponse(res)
  const j = res.json()?.[0]
  if (!j) throw new CxError("DATA_NOT_FOUND", "排行榜统计为空")
  return { userCount: j.userCount, totalRecordSignCount: j.totalRecordSignCount }
}
export async function rankOf(uuid) {
  const res = await request(null, { url: `${SUPABASE_ENDPOINT}/user_sign_rank?select=rank&limit=1&uuid=eq.${encodeURIComponent(uuid)}`, headers: { apikey: SUPABASE_API_KEY } })
  checkResponse(res)
  const j = res.json()?.[0]
  if (!j) throw new CxError("DATA_NOT_FOUND", "排行榜中没有本机记录(尚未上传过)", { next: "cxsign rank upload --confirm" })
  return j.rank
}
export async function rankTop(n) {
  const c = Math.min(100, Math.max(1, Math.trunc(n)))
  const res = await request(null, { url: `${SUPABASE_ENDPOINT}/AnalyserData?order=totalSignCount.desc&limit=${c}&isPublic=eq.TRUE`, headers: { apikey: SUPABASE_API_KEY } })
  checkResponse(res)
  return res.json()
}
export function pickRankSchoolName(fidList, selected, hide) {
  const raw = [...new Set((fidList ?? []).map((f) => f.name))]
  let s
  if (selected && raw.includes(selected)) s = selected
  else {
    const l = raw.filter((x) => !/^\d/.test(x) && !x.endsWith("图书馆"))
    s = l.length ? l.sort((a, b) => a.length - b.length)[0] : raw[0] ?? ""
  }
  return hide ? s + "HIDE" : s
}
export async function rankUpload(form) {
  const res = await request(null, { method: "POST", url: `${SUPABASE_ENDPOINT}/AnalyserData`, headers: { apikey: SUPABASE_API_KEY, Prefer: "resolution=merge-duplicates" }, form: new URLSearchParams(form).toString() })
  checkResponse(res)
  return { status: res.status }
}


export const URL_BANLIST = "http://cdn.aquamarine5.fun/chaoxingsignfaker_banlist.json"
export const URL_SPONSOR = "http://cdn.aquamarine5.fun/chaoxingsignfaker_sponsor.json"

export async function getBanlist() {
  const res = await request(null, { url: URL_BANLIST })
  checkResponse(res)
  return (res.json()?.banfids ?? []).map(Number)
}
export async function getSponsors() {
  const res = await request(null, { url: URL_SPONSOR })
  checkResponse(res)
  const j = res.json()
  return { updateTime: j.updateTime ?? null, sponsors: (j.sponsorList ?? []).filter((x) => Array.isArray(x) && x.length === 2).map(([name, amount]) => ({ name: String(name), amount: String(amount) })) }
}
