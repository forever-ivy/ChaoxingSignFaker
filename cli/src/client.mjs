import crypto from "node:crypto"
import { CxError, maskPhone } from "./errors.mjs"
import { CookieSession, checkResponse, request, CLIENT_INFOS, options } from "./http.mjs"
import { buildEncryptedDeviceInfo, encryptByAES, randomizedDeviceCode } from "./cxcrypto.mjs"
import { load, markDirty } from "./store.mjs"

export const URL_LOGIN = "https://passport2.chaoxing.com/fanyalogin"
export const URL_USER_INFO = "https://sso.chaoxing.com/apis/login/userLogin4Uname.do"

export function checkPassword(password) {
  if (!password) throw new CxError("USAGE", "密码不能为空")
  if (password.length < 8 || password.length > 16) throw new CxError("USAGE", "密码位数应该在8-16位")
}

export function buildLoginForm(phone, encryptedPassword) {
  const uname = encryptByAES(phone).replace(/\+/g, "%2B")
  const pwd = encryptedPassword.replace(/\+/g, "%2B").replace(/%20/g, "%2B").replace(/ /g, "%2B")
  return [
    "fid=-1", `uname=${uname}`, `password=${pwd}`, "refer=https%3A%2F%2Fi.chaoxing.com", "t=true",
    "forbidotherlogin=0", "validate=", "doubleFactorLogin=0", "independentId=0", "independentNameId=0",
  ].join("&")
}

export function parseUserInfo(json) {
  const m = json?.msg
  if (!m || typeof m !== "object" || m.uid === undefined) return null
  const schools = new Map()
  schools.set(Number(m.fid), m.schoolname && String(m.schoolname).trim() ? m.schoolname : "未知学校")
  for (const c of m.unitConfigInfos ?? []) {
    if (c?.fid === undefined || c?.fid === null) continue
    const fid = Number(c.fid)
    const name = c.schoolname && String(c.schoolname).trim() ? c.schoolname : null
    if (!schools.has(fid) || (name && schools.get(fid) === "未知学校")) schools.set(fid, name ?? `fid=${fid}`)
  }
  return {
    uid: Number(m.uid),
    fid: Number(m.fid),
    name: m.name,
    uname: m.uname,
    pic: String(m.pic ?? "").replace("http://", "https://"),
    puid: Number(m.puid),
    imEncryptedPassword: m.accountInfo?.imAccount?.password ?? "",
    clientId: m.clientId || null,
    fidList: [...schools].map(([fid, name]) => ({ fid, name })),
  }
}

export class Client {
  constructor(record, { isSelf }) {
    this.record = record
    this.isSelf = isSelf
    this.jar = new CookieSession(record.cookies ?? [])
    if (!record.androidId) { record.androidId = crypto.randomBytes(8).toString("hex"); markDirty() }
    if (!record.deviceCode) { record.deviceCode = randomizedDeviceCode(); record.isNotRandomizedDeviceCode = false; markDirty() }
  }
  get phone() { return this.record.phoneNumber }
  get puid() { return this.record.puid ?? this.record.user?.puid }
  get uid() { return this.record.user?.uid }
  get name() { return this.record.name || this.record.user?.name || "" }
  get user() { return this.record.user }
  get configuredFid() {
    const fids = this.record.user?.fidList ?? []
    const c = this.record.configuredFid
    if (c !== undefined && c !== null && (fids.length === 0 || fids.some((f) => f.fid === c))) return c
    return fids[0]?.fid ?? this.record.user?.fid ?? 0
  }
  get deviceCode() { return this.record.deviceCode }
  get label() { return this.isSelf ? "self" : this.phone }
  get hasSession() { return (this.record.cookies ?? []).length > 0 && !!this.record.user }

  async req(r) {
    const res = await request(this.jar, { ...r })
    this.persistCookies()
    return res
  }
  persistCookies() {
    const next = this.jar.toJSON()
    if (JSON.stringify(next) !== JSON.stringify(this.record.cookies ?? [])) { this.record.cookies = next; markDirty() }
  }

  async login(encryptedPassword) {
    const res = await this.req({ method: "POST", url: URL_LOGIN, form: buildLoginForm(this.phone, encryptedPassword) })
    checkResponse(res)
    const j = res.json()
    if (!j.status) {
      const m = (j.msg2 && String(j.msg2)) || "登录错误"
      if (/验证码|滑块|安全验证/.test(m)) throw new CxError("CAPTCHA_REQUIRED", m, { next: "请先在官方学习通 App / 网页登录一次完成安全验证,然后重试" })
      throw new CxError("AUTH_INVALID_CREDENTIAL", m)
    }
    this.record.password = encryptedPassword
    markDirty()
    return true
  }

  async getInfo() {
    const pkg = load().preferences.customizedPackageName || "com.chaoxing.mobile"
    const res = await this.req({ method: "POST", url: URL_USER_INFO, form: new URLSearchParams({ data: buildEncryptedDeviceInfo(this.record.androidId, pkg) }).toString() })
    checkResponse(res)
    let user = null
    try { user = parseUserInfo(JSON.parse(res.text)) } catch {}
    if (!user) throw new CxError("AUTH_SESSION_EXPIRED", this.isSelf ? "获取用户信息失败,会话可能已过期" : "获取代签用户信息失败", { account: maskPhone(this.phone) })
    this.record.user = user
    this.record.name = user.name
    this.record.puid = user.puid
    if (this.record.configuredFid === undefined || this.record.configuredFid === null || !user.fidList.some((f) => f.fid === this.record.configuredFid)) {
      this.record.configuredFid = user.fidList[0]?.fid ?? user.fid
    }
    markDirty()
    return user
  }

  async relogin() {
    if (!this.record.password) throw new CxError("AUTH_SESSION_EXPIRED", "会话已过期且没有保存密码", { next: this.isSelf ? "cxsign auth login --phone <手机号> --password-stdin" : `cxsign users relogin --phone ${this.phone} --password-stdin` })
    await this.login(this.record.password)
    await this.getInfo()
    if (!this.isSelf) { this.record.isObsoleteSession = false; markDirty() }
    return true
  }

  setFid(fid) {
    this.record.configuredFid = fid
    this.jar.setFid(fid)
    this.persistCookies()
    markDirty()
  }
}

export function applyClientPreferences() {
  const p = load().preferences
  if (p.clientIdentity === "@@custom" && p.customizedUserAgent) options.userAgent = p.customizedUserAgent
  else options.userAgent = (CLIENT_INFOS[p.clientIdentity] ?? CLIENT_INFOS["@@default"]).userAgent
}

export function selfClient() {
  const st = load()
  if (!st.loginSession?.phoneNumber) throw new CxError("AUTH_REQUIRED", "尚未登录", { next: "cxsign auth login --phone <手机号> --password-stdin" })
  return new Client(st.loginSession, { isSelf: true })
}

export function otherClient(phone) {
  const st = load()
  const rec = st.otherUsers.find((u) => u.phoneNumber === String(phone))
  if (!rec) throw new CxError("DATA_NOT_FOUND", `没有代签用户 ${maskPhone(phone)}`, { next: "cxsign users list" })
  return new Client(rec, { isSelf: false })
}

export function resolveClient(as) {
  if (!as || as === "self" || as === load().loginSession?.phoneNumber) return selfClient()
  return otherClient(as)
}

export async function ensureUser(client) {
  if (!client.record.cookies?.length) {
    if (client.record.password) { await client.relogin(); return client }
    throw new CxError("AUTH_REQUIRED", "该账号没有会话", { account: maskPhone(client.phone) })
  }
  if (!client.user) await client.getInfo()
  return client
}
