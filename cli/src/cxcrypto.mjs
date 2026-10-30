/**
 * 学习通协议用到的加解密,逐一移植自:
 *  - api/ChaoxingHttpClient.kt          encryptByAES(登录 uname/password)
 *  - api/ChaoxingIMHelper.kt            desDecrypt / resolveImPassword
 *  - api/ChaoxingDeviceInfoHelper.kt    buildEncryptedDeviceInfo / decryptClientId / randomizedDeviceCode
 *  - api/ChaoxingFaceHelper.kt          signToken
 */
import crypto from "node:crypto"
import { desEcbDecrypt } from "./des.mjs"

const LOGIN_AES_KEY = Buffer.from("u2oh6Vu^HWe4_AES", "utf8")
export const DEVICE_INFO_PUBLIC_KEY =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC79d8Ot0hCbxxSISC6x8SCwTBspFSzlLKHJUYqoFNu1TSRaw4hEYkOnvEaL1VyoxV6HXcDrzwYvaFZaZaPQPFnfCHZy5dQwxcmifgSHqS+oKXw40Ys4cVIqnU5d90S7EWSRdBglX489jlqVaNcQSkDx2TYmC+DbAq9FV/BU09ISQIDAQAB"
const IM_KEY = Buffer.from("SL2(M/eD", "utf8")

/** AES-128-CBC / PKCS5,key = iv = "u2oh6Vu^HWe4_AES",Base64 输出 */
export function encryptByAES(plain) {
  const c = crypto.createCipheriv("aes-128-cbc", LOGIN_AES_KEY, LOGIN_AES_KEY)
  return Buffer.concat([c.update(String(plain), "utf8"), c.final()]).toString("base64")
}
export function decryptByAES(b64) {
  const d = crypto.createDecipheriv("aes-128-cbc", LOGIN_AES_KEY, LOGIN_AES_KEY)
  return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8")
}

export function desDecryptHex(hex) {
  return desEcbDecrypt(Buffer.from(hex, "hex"), IM_KEY).toString("utf8")
}

/** ChaoxingIMHelper.resolveImPassword */
export function resolveImPassword(enc) {
  if (enc && enc.length >= 16) {
    try { return desDecryptHex(enc) } catch { return enc }
  }
  return enc
}

export const md5 = (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex")
export const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex")

const pubKey = () => crypto.createPublicKey({ key: Buffer.from(DEVICE_INFO_PUBLIC_KEY, "base64"), format: "der", type: "spki" })

/** RSA/ECB/PKCS1Padding,117 字节分块 */
export function encryptByRsa(plain) {
  const key = pubKey()
  const out = []
  for (let i = 0; i < plain.length; i += 117) {
    out.push(crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, plain.subarray(i, i + 117)))
  }
  return Buffer.concat(out).toString("base64")
}

function modPow(b, e, m) {
  let r = 1n; b %= m
  while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m }
  return r
}

/** decryptClientId:用公钥 modPow 后去掉 PKCS#1 type-1 填充,得到 {cid, sc, ...} */
export function decryptClientId(clientId) {
  try {
    const jwk = pubKey().export({ format: "jwk" })
    const n = BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex"))
    const e = BigInt("0x" + Buffer.from(jwk.e, "base64url").toString("hex"))
    const size = Buffer.from(jwk.n, "base64url").length
    const enc = Buffer.from(clientId, "base64")
    const parts = []
    for (let off = 0; off < enc.length; off += size) {
      const c = BigInt("0x" + enc.subarray(off, off + size).toString("hex"))
      let hex = modPow(c, e, n).toString(16)
      hex = hex.padStart(size * 2, "0")
      const blk = Buffer.from(hex, "hex")
      if (!(blk.length > 2 && blk[0] === 0 && blk[1] === 1)) return null
      const sep = blk.indexOf(0, 2)
      if (sep <= 2) return null
      parts.push(blk.subarray(sep + 1))
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"))
  } catch {
    return null
  }
}

/** randomizedDeviceCode:base64(sha256(uuid+uuid) 重复两次) */
export function randomizedDeviceCode() {
  const raw = crypto.createHash("sha256").update(crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")).digest()
  return Buffer.concat([raw, raw]).toString("base64")
}

/**
 * buildDeviceInfo 的 CLI 版本:没有真实 Android 设备,用每个账号持久化的随机 androidId,
 * 其余字段取 App 中的默认值(app_ver 6.7.5 / versionCode 10941 / 官方签名摘要)。
 */
export function buildEncryptedDeviceInfo(androidId, packageName = "com.chaoxing.mobile") {
  const uid = sha256Hex(`${packageName}:${androidId}:samsung/SM-N9006/8aba9e4.0`)
  const info = {
    deviceUniqueId: uid, cdid: uid, device_id: uid, android_id: androidId, mediaDrmId: "", oaid: "",
    platform: "android", os_name: "android", os_ver: "12", os_lang: "zh-CN", brand: "samsung", board: "SM-N9006",
    hardware: "qcom", model: "SM-N9006", cpu_ar: "arm64-v8a,armeabi-v7a,armeabi", app_name: packageName,
    app_ver: "6.7.5", versionCode: "10941", signatures: "1e27068798b6697821abbeb44a17da5483c4fb7fad7b9ce7890465ed04d0cbe0",
    resolution: "1080*2400", dpi: "2.75", time_stamp: Date.now(),
  }
  return encryptByRsa(Buffer.from(JSON.stringify(info), "utf8"))
}

/** ChaoxingFaceHelper.buildFaceResult(含 addSignToken) */
export function buildFaceResult(objectId, clientId, now = Date.now()) {
  const cxtime = String(now)
  const out = { currentFaceId: objectId, LiveDetectionStatus: 1, collectStatus: 1, cxtime }
  const info = clientId ? decryptClientId(clientId) : null
  if (info?.cid && info?.sc) {
    const fields = { currentFaceId: objectId, LiveDetectionStatus: "1", collectStatus: "1", cxtime, cxcid: String(info.cid) }
    // TreeMap 自然序(按 UTF-16 码点)
    const raw = Object.keys(fields).sort().map((k) => k + fields[k]).join("") + info.sc
    out.cxcid = String(info.cid)
    out.signToken = md5(raw)
  }
  return out
}
