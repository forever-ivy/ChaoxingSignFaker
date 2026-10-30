import { CODE_EXIT, RETRYABLE } from "./spec.mjs"

export class CxError extends Error {
  constructor(code, message, details, status) {
    super(message)
    this.name = "CxError"
    this.code = code
    if (details !== undefined) this.details = details
    if (status !== undefined) this.status = status
  }
}

const SECRET_KEYS = /^(password|passwd|pwd|encryptedpassword|impassword|imencryptedpassword|cookie|cookies|set-cookie|token|_token|access_token|accesstoken|cloudtoken|enc|enc2|faceenc|validate|clientid|shareurl|secret|signtoken|sc|authorization)$/i

const SECRET_RE = [
  /([?&](?:pwd|password|uname|enc|enc2|validate|token|_token|faceEnc|signCode|dc|captchaKey|iv)=)[^&\s"']+/gi,
  /\b((?:JSESSIONID|UID|_uid|_d|vc3|uf|cx_p_token|p_auth_token|xxtenc|fid|_dfp|DSSTASH_LOG|route|spaceFid|spaceRoleId|lv|_tid|sso_puid)=)[^;\s"']+/g,
  /(Bearer\s+)[A-Za-z0-9._-]+/g,
]

export function scrubString(s) {
  let out = String(s)
  for (const re of SECRET_RE) out = out.replace(re, "$1***")
  return out
}

export function scrub(v) {
  if (typeof v === "string") return scrubString(v)
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === "object") {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEYS.test(k) && x !== null && x !== undefined && x !== "") { o[k] = "***"; continue }
      o[k] = scrub(x)
    }
    return o
  }
  return v
}

export function mask(v) {
  if (!v) return ""
  const s = String(v)
  if (s.length <= 6) return "***"
  return `${s.slice(0, 3)}…${s.slice(-2)}`
}

export function maskPhone(p) {
  const s = String(p ?? "")
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s
}

export function toErrorPayload(e) {
  let code = typeof e?.code === "string" ? e.code : "UNKNOWN"
  const msg = String(e?.message ?? e)
  if (!(code in CODE_EXIT)) {
    if (e?.name === "TimeoutError" || /timeout/i.test(msg)) code = "TIMEOUT"
    else if (/fetch failed|network|ENOTFOUND|ECONNRE|EAI_AGAIN|socket/i.test(msg)) code = "NETWORK_ERROR"
    else code = "UNKNOWN"
  }
  return {
    code,
    message: scrubString(msg),
    exitCode: CODE_EXIT[code],
    ...(typeof e?.status === "number" ? { status: e.status } : {}),
    ...(e?.details !== undefined ? { details: scrub(e.details) } : {}),
    retryable: typeof e?.details?.retryable === "boolean" ? e.details.retryable : RETRYABLE.has(code),
  }
}

export const usage = (m, d) => new CxError("USAGE", m, d)
export const notFound = (m, d) => new CxError("DATA_NOT_FOUND", m, d)
export const backend = (m, d, status) => new CxError("BACKEND_BUSINESS_ERROR", m, d, status)
export const protocol = (m, d) => new CxError("BACKEND_PROTOCOL_ERROR", m, d)
export const unsupported = (m, d) => new CxError("FEATURE_NOT_SUPPORTED", m, d)
