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
    loginSession: null,
    otherUsers: [],
    tagsLibrary: [],
    locations: [],
    classRememberedLocation: {},
    classSelectedLocation: {},
    faceRecognitionConfigures: {},
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
    imMutedGroups: [],
    imPinnedGroups: [],
    learnedLocations: {},
    classSchedule: { lessons: [], lastFetchTimestamp: 0, firstWeekDate: 0, contentMd5: "" },
    preferences: { customizedUserAgent: "", customizedPackageName: "", clientIdentity: "", alwaysForceSign: false, isIgnoreAllConsistentDeviceCodeComponents: false },
    pending: {},
  }
}

let cache = null
let isDirty = false

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

export function markDirty() { isDirty = true }

export function update(fn) {
  const st = load()
  const r = fn(st)
  isDirty = true
  return r
}

export function flush() {
  if (!isDirty || !cache) return
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  const tmp = path.join(dir, `.state.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
  fs.renameSync(tmp, statePath())
  fs.chmodSync(statePath(), 0o600)
  isDirty = false
}

export function resetCache() { cache = null; isDirty = false }

export function writeSecretFile(file, content) {
  const target = path.resolve(file)
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  const isWritten = (() => { try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, content); return true } finally { fs.closeSync(fd) } })()
  if (isWritten) fs.renameSync(tmp, target)
}
