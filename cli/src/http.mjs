import { CxError, scrubString } from "./errors.mjs"

export const DEFAULT_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 12; SM-N9006 Build/8aba9e4.0) (schild:2d97f7b9439f21333c946878fc4d6ccb) (device:SM-N9006) Language/zh_CN com.chaoxing.mobile/ChaoXingStudy_3_6.7.5_android_phone_10941_314 (@Kalimdor)_68f184fd763546c1a04ab3a09b3deebb"

export const CLIENT_INFOS = {
  "@@default": { name: "学习通", userAgent: DEFAULT_USER_AGENT, packageName: "com.chaoxing.mobile" },
  "@@xuezaixidian": {
    name: "学在西电",
    userAgent: "Mozilla/5.0 (Linux; Android 16; 23113RKC6C Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/147.0.7727.137 Mobile Safari/537.36 (schild:be536573b69ec1ae359e359d11f7f3e3) (device:23113RKC6C) Language/zh_CN com.chaoxing.mobile.xuezaixidian/ChaoXingStudy_1000149_6.3.7_android_phone_6005_249 (@Kalimdor)_f8777230ca1e45b2831ec7e36a9da1ea",
    packageName: "com.chaoxing.mobile.xuezaixidian",
  },
}

export const options = { timeoutMs: 15000, retries: 2, verbose: false, userAgent: DEFAULT_USER_AGENT }
export const stats = { requests: 0, retries: 0 }

export const transport = { fetch: (...a) => globalThis.fetch(...a) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function redactUrl(u) {
  try {
    const x = new URL(u)
    for (const k of [...x.searchParams.keys()]) {
      if (/pass|pwd|token|uname|enc|validate|code|key|iv|faceResult|location|deviceCode|ext/i.test(k)) x.searchParams.set(k, "***")
    }
    return x.toString()
  } catch {
    return "<url>"
  }
}

function parseSetCookie(sc, url) {
  const [pair, ...attrs] = sc.split(";")
  const eq = pair.indexOf("=")
  if (eq <= 0) return null
  const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), host: new URL(url).hostname }
  for (const a of attrs) {
    const [k, v] = a.split("=")
    if (k.trim().toLowerCase() === "domain" && v) c.host = v.trim().replace(/^\./, "")
  }
  return c
}

const isChaoxing = (host) => host === "chaoxing.com" || host.endsWith(".chaoxing.com")

export class CookieSession {
  constructor(cookies = []) {
    this.chaoxing = cookies.map((c) => ({ ...c }))
    this.others = new Map()
  }
  header(url) {
    const host = new URL(url).hostname
    const list = isChaoxing(host) ? this.chaoxing : this.others.get(host) ?? []
    return list.map((c) => `${c.name}=${c.value}`).join("; ")
  }
  save(url, setCookies) {
    if (!setCookies.length) return
    const u = new URL(url)
    const parsed = setCookies.map((s) => parseSetCookie(s, url)).filter(Boolean)
    if (isChaoxing(u.hostname) && u.pathname === "/fanyalogin") {
      this.chaoxing = parsed
    } else if (isChaoxing(u.hostname) && u.pathname === "/apis/login/userLogin4Uname.do") {
      const names = new Set(parsed.map((c) => c.name))
      this.chaoxing = [...this.chaoxing.filter((c) => !names.has(c.name)), ...parsed]
    } else if (!isChaoxing(u.hostname)) {
      this.others.set(u.hostname, parsed)
    }
  }
  setFid(fid) {
    for (const c of this.chaoxing) if (c.name === "fid") c.value = String(fid)
  }
  get(name) { return this.chaoxing.find((c) => c.name === name)?.value }
  toJSON() { return this.chaoxing }
}

function buildUrl(url, query) {
  if (!query) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    u.searchParams.append(k, String(v))
  }
  return u.toString()
}

export async function request(jar, req) {
  const method = (req.method ?? "GET").toUpperCase()
  let url = buildUrl(req.url, req.query)
  const isIdempotent = method === "GET" && !req.noRetry
  const maxAttempts = isIdempotent ? Math.max(0, options.retries) + 1 : 1
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    try {
      let curUrl = url
      let curMethod = method
      let body = req.form !== undefined ? String(req.form) : req.body
      for (let hop = 0; hop < 10; hop++) {
        const headers = new Headers()
        headers.set("user-agent", req.ua ?? options.userAgent)
        for (const [k, v] of Object.entries(req.headers ?? {})) headers.set(k, v)
        if (req.form !== undefined && curMethod !== "GET") headers.set("content-type", req.contentType ?? "application/x-www-form-urlencoded")
        else if (req.contentType && curMethod !== "GET") headers.set("content-type", req.contentType)
        const cookie = jar?.header(curUrl)
        if (cookie) headers.set("cookie", cookie)
        stats.requests++
        const resp = await transport.fetch(curUrl, {
          method: curMethod,
          headers,
          body: curMethod === "GET" ? undefined : body,
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        })
        const setCookies = resp.headers.getSetCookie?.() ?? []
        jar?.save(curUrl, setCookies)
        if (options.verbose) process.stderr.write(`[http] ${curMethod} ${redactUrl(curUrl)} -> ${resp.status} ${Date.now() - started}ms\n`)
        const loc = resp.headers.get("location")
        if (req.followRedirects !== false && [301, 302, 303, 307, 308].includes(resp.status) && loc) {
          await resp.arrayBuffer().catch(() => {})
          curUrl = new URL(loc, curUrl).toString()
          if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && curMethod === "POST")) { curMethod = "GET"; body = undefined }
          continue
        }
        const buf = Buffer.from(await resp.arrayBuffer())
        if (isIdempotent && resp.status >= 502 && resp.status <= 504 && attempt < maxAttempts) {
          stats.retries++
          await sleep(400 * 2 ** (attempt - 1))
          throw Object.assign(new Error("retry"), { __retry: true })
        }
        return {
          status: resp.status,
          ok: resp.status >= 200 && resp.status < 300,
          url: curUrl,
          headers: resp.headers,
          buf,
          text: buf.toString("utf8"),
          json() {
            try { return JSON.parse(this.text) } catch { throw new CxError("BACKEND_PROTOCOL_ERROR", "响应不是合法 JSON", { status: this.status, url: redactUrl(curUrl), snippet: scrubString(this.text.slice(0, 200)) }) }
          },
        }
      }
      throw new CxError("BACKEND_PROTOCOL_ERROR", "重定向次数过多", { url: redactUrl(url) })
    } catch (e) {
      if (e?.__retry) continue
      if (e instanceof CxError) throw e
      lastErr = e
      if (options.verbose) process.stderr.write(`[http] ${method} ${redactUrl(url)} failed (${e?.name}) attempt ${attempt}/${maxAttempts}\n`)
      if (attempt < maxAttempts) {
        stats.retries++
        await sleep(400 * 2 ** (attempt - 1))
      }
    }
  }
  if (lastErr?.name === "TimeoutError" || lastErr?.name === "AbortError") {
    throw new CxError("TIMEOUT", `请求超时(${options.timeoutMs}ms): ${redactUrl(url)}`)
  }
  throw new CxError("NETWORK_ERROR", `网络连接异常: ${lastErr?.cause?.code ?? lastErr?.message ?? lastErr} (${redactUrl(url)})`)
}

export function checkResponse(resp) {
  if (resp.ok) return resp
  if (resp.status === 429) throw new CxError("RATE_LIMITED", "请求过于频繁(HTTP 429)", { status: 429 }, 429)
  const msg = { 403: "网络异常，访问被拒绝", 404: "网络异常，资源未找到", 500: "网络异常，服务器内部错误" }[resp.status] ?? `网络异常，错误码：${resp.status}`
  throw new CxError(resp.status === 404 ? "DATA_NOT_FOUND" : "BACKEND_BUSINESS_ERROR", msg, { status: resp.status, url: redactUrl(resp.url), snippet: scrubString(resp.text.slice(0, 200)) }, resp.status)
}

export function unwrapJsonp(text) {
  return JSON.parse(text.replace("cx_captcha_function(", "").replace(/\)\s*$/, ""))
}
