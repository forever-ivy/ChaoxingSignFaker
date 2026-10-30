/**
 * CLI 持久化:单个 JSON 文件,结构对应 app/src/main/proto/datastore.proto 的 ChaoxingSignFakerDataStore。
 * 目录 0700、文件 0600、原子写入。含会话 cookie、AES 加密后的密码,永远不会被打印。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

export function stateDir() {
  return process.env.CXSIGN_HOME || path.join(os.homedir(), ".config", "cxsign")
}
export function statePath() {
  return path.join(stateDir(), "state.json")
}
export function faceDir() {
  return path.join(stateDir(), "face_images")
}

export function emptyState() {
  return {
    version: 1,
    loginSession: null, // {phoneNumber,password(AES),cookies[],configuredFid,puid,uid,name,deviceCode,isNotRandomizedDeviceCode,isDeviceCodeDuplicatedSignBefore,user{...}}
    otherUsers: [], // 同上 + tags[] + isObsoleteSession
    tagsLibrary: [], // {id,name,color}
    locations: [], // {address,label,latitude,longitude}
    classRememberedLocation: {}, // classId -> location
    classSelectedLocation: {},
    faceRecognitionConfigures: {}, // phone -> {images:[{objectId,useCount,isFailureBefore}]}
    analysis: { locationSign: 0, qrcodeSign: 0, photoSign: 0, clickSign: 0, gestureSign: 0, otherUserSign: 0, passwordSign: 0 },
    analysisUUID: "",
    analysisRankName: "",
    disableAnalysisRank: false,
    hideAnalysisRankSchoolName: false,
    selectedAnalysisRankSchoolName: "",
    lastUploadAnalysisDate: 0,
    bypassBlockedChecking: false,
    preferClassId: [],
    preferGroupId: [],
    classSchedule: { lessons: [], lastFetchTimestamp: 0, firstWeekDate: 0, contentMd5: "" },
    preferences: { customizedUserAgent: "", customizedPackageName: "", clientIdentity: "", alwaysForceSign: false, isIgnoreAllConsistentDeviceCodeComponents: false },
    pending: {}, // 跨进程的人工步骤(滑块验证码)
  }
}

let cache = null
let dirty = false

export function load() {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"))
    cache = { ...emptyState(), ...raw }
    for (const k of ["preferences", "analysis", "classSchedule"]) cache[k] = { ...emptyState()[k], ...(raw[k] ?? {}) }
  } catch {
    cache = emptyState()
  }
  return cache
}

export function markDirty() { dirty = true }

/** 修改并标脏 */
export function update(fn) {
  const st = load()
  const r = fn(st)
  dirty = true
  return r
}

export function flush() {
  if (!dirty || !cache) return
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* ignore */ }
  const tmp = path.join(dir, `.state.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
  fs.renameSync(tmp, statePath())
  fs.chmodSync(statePath(), 0o600)
  dirty = false
}

/** 仅测试用 */
export function resetCache() { cache = null; dirty = false }

/** 写一个 0600 的文件(用于分享链接等敏感输出) */
export function writeSecretFile(file, content) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, content, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}
