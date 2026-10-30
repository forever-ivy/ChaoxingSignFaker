import { spawn } from "node:child_process"
import * as api from "./api.mjs"
import { scrub } from "./errors.mjs"

export function backoffMs(attempt, baseMs, maxMs = 300000) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
}

function runNotify(cmd, ev, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const json = JSON.stringify(ev)
    const child = spawn(cmd, { shell: true, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, CXSIGN_EVENT: json } })
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", () => { clearTimeout(t); resolve({ exitCode: null }) })
    child.on("close", (code) => { clearTimeout(t); resolve({ exitCode: code }) })
    child.stdin.on("error", () => {})
    child.stdin.end(json + "\n")
  })
}

const isAuthError = (e) => e?.status === 401 || e?.status === 403 || /\b401\b|unauthor/i.test(String(e?.message))

export async function scanGroups(im, groups, io, { concurrency = 6, isStopped = () => false } = {}) {
  const activity = {}
  let i = 0
  const worker = async () => {
    while (i < groups.length && !isStopped()) {
      const g = groups[i++]
      try { activity[String(g.groupId)] = await io.fetchMessages(im, g, {}) } catch (e) { if (isAuthError(e)) throw e }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker))
  return activity
}

export function courseIndex(courses) {
  const out = {}
  for (const c of courses ?? []) if (c.chatId) out[String(c.chatId)] = { isEnded: !!c.isEnded, isFiled: !!c.isFiled, courseName: c.courseName }
  return out
}

export async function watchIM(ctx, client, deps = {}) {
  const a = ctx.args
  const write = deps.write ?? ((line) => process.stdout.write(line))
  const io = {
    getConfig: deps.getConfig ?? ((c) => api.getEasemobConfig(c)),
    getGroups: deps.getGroups ?? ((im) => api.getEasemobGroups(im)),
    fetchMessages: deps.fetchMessages ?? ((im, g, o) => api.fetchGroupMessages(im, g, o)),
    getCourses: deps.getCourses ?? ((c) => api.getAllCourses(c)),
    sleep: deps.sleep ?? ((ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r() }, { once: true }) })),
    now: deps.now ?? (() => Date.now()),
    notify: deps.notify ?? runNotify,
  }
  const lists = deps.lists ?? { muted: [], pinned: [] }
  const intervalMs = Math.max(1, Number(a.interval ?? 15)) * 1000
  const rescanMs = Math.max(1, Number(a["rescan-minutes"] ?? 60)) * 60000
  const activeDays = Number(a["active-days"] ?? api.DEFAULT_ACTIVE_DAYS)
  const forced = a.group ? String(a.group).split(",").map((x) => x.trim()).filter(Boolean) : []
  const started = io.now()
  const deadline = a.timeout !== undefined ? started + Number(a.timeout) * 1000 : Infinity
  const ctrl = new AbortController()
  const onSig = () => ctrl.abort()
  if (!deps.noSignals) { process.once("SIGINT", onSig); process.once("SIGTERM", onSig) }
  const emit = (ev) => write(JSON.stringify(scrub({ ts: new Date(io.now()).toISOString(), ...ev })) + "\n")
  const seen = new Set()
  const cursor = {}
  let im = null, allGroups = [], watched = [], classified = [], courses = {}, activity = {}
  let failures = 0, polls = 0, scans = 0, signEvents = 0, connects = 0, isPrimed = false, nextScanAt = 0, lastPollMs = null
  const stats = () => ({ polls, scans, signEvents, connects, groups: allGroups.length, watched: watched.length, skipped: allGroups.length - watched.length, lastPollMs, durationMs: io.now() - started })
  const isDone = () => ctrl.signal.aborted || io.now() >= deadline || (a.once && signEvents > 0)

  const handleSigns = async (signs) => {
    for (const act of api.sortIMActivities(signs)) {
      if (seen.has(act.activeId)) continue
      seen.add(act.activeId)
      if (!isPrimed && !a["include-existing"]) continue
      signEvents++
      const ev = { type: "sign", ...act, existing: !isPrimed }
      emit(ev)
      if (a["notify-cmd"]) { const r = await io.notify(a["notify-cmd"], ev); if (r.exitCode !== 0) emit({ type: "notify-error", activeId: act.activeId, exitCode: r.exitCode }) }
      if (deps.autoSign) {
        let res
        try { res = await deps.autoSign(ev) } catch (e) { res = { ok: false, error: { code: e.code ?? "UNKNOWN", message: e.message } } }
        emit({ type: "auto-sign", activeId: act.activeId, result: res })
      }
      if (a.once) break
    }
  }

  const rescan = async () => {
    const t0 = io.now()
    const candidates = forced.length ? allGroups.filter((g) => forced.includes(String(g.groupId))) : allGroups.filter((g) => !lists.muted.includes(String(g.groupId)))
    if (!forced.length && !a.all) { try { courses = courseIndex(await io.getCourses(client)) } catch {} }
    const fresh = await scanGroups(im, candidates, io, { isStopped: isDone })
    activity = { ...activity, ...fresh }
    for (const [id, r] of Object.entries(fresh)) if (r.lastMessageTs) cursor[id] = Math.max(cursor[id] ?? 0, r.lastMessageTs)
    classified = api.classifyGroups(allGroups, { activity, courses, activeDays, isAll: !!a.all, forced, muted: lists.muted, pinned: lists.pinned, now: io.now() })
    const before = new Set(watched.map((g) => String(g.groupId)))
    watched = classified.filter((g) => g.isWatched)
    scans++
    nextScanAt = io.now() + rescanMs
    const reasons = {}
    for (const g of classified) if (!g.isWatched) reasons[g.reason] = (reasons[g.reason] ?? 0) + 1
    const summary = { watched: watched.length, skipped: classified.length - watched.length, total: classified.length, skippedByReason: reasons, activeDays, scanMs: io.now() - t0,
      watchedGroups: watched.map((g) => ({ groupId: g.groupId, name: g.name, lastActivity: g.lastActivity, reason: g.reason })) }
    if (scans > 1) {
      const added = watched.filter((g) => !before.has(String(g.groupId))).map((g) => g.groupId)
      emit({ type: "rescan", ...summary, added })
    }
    await handleSigns(Object.entries(fresh).filter(([id]) => watched.some((g) => String(g.groupId) === id)).flatMap(([, r]) => r.signs))
    return summary
  }

  try {
    while (!isDone()) {
      try {
        if (!im) {
          im = await io.getConfig(client)
          allGroups = await io.getGroups(im)
          connects++
          emit({ type: connects === 1 ? "connected" : "reconnected", groups: allGroups.length })
        }
        if (io.now() >= nextScanAt) {
          const summary = await rescan()
          if (!isPrimed) { isPrimed = true; emit({ type: "ready", knownActivities: seen.size, ...summary }) }
        } else {
          polls++
          const t0 = io.now()
          const found = []
          let authError = null
          await Promise.all(watched.map(async (g) => {
            if (isDone()) return
            const id = String(g.groupId)
            try {
              const r = await io.fetchMessages(im, g, { since: cursor[id] ?? 0 })
              if (r.lastMessageTs) cursor[id] = Math.max(cursor[id] ?? 0, r.lastMessageTs)
              activity[id] = { ...(activity[id] ?? {}), lastMessageTs: Math.max(activity[id]?.lastMessageTs ?? 0, r.lastMessageTs || 0), lastSignTs: Math.max(activity[id]?.lastSignTs ?? 0, r.lastSignTs || 0) }
              found.push(...r.signs)
            } catch (e) {
              if (isAuthError(e)) { authError = e; return }
              emit({ type: "group-error", groupId: g.groupId, message: e?.message ?? String(e) })
            }
          }))
          if (authError) throw authError
          lastPollMs = io.now() - t0
          await handleSigns(found)
        }
        failures = 0
        if (isDone()) break
        await io.sleep(Math.max(0, Math.min(intervalMs, deadline - io.now())), ctrl.signal)
      } catch (e) {
        failures++
        im = null
        const wait = Math.max(0, Math.min(backoffMs(failures, Math.min(intervalMs, 2000)), deadline - io.now()))
        emit({ type: "disconnected", attempt: failures, retryInMs: wait, code: e?.code ?? "UNKNOWN", message: e?.message ?? String(e) })
        if (isDone()) break
        await io.sleep(wait, ctrl.signal)
      }
    }
  } finally {
    if (!deps.noSignals) { process.off("SIGINT", onSig); process.off("SIGTERM", onSig) }
  }
  const reason = ctrl.signal.aborted ? "signal" : a.once && signEvents > 0 ? "once" : "timeout"
  emit({ type: "stopped", reason, ...stats() })
  return { stopped: reason, ...stats(), isConnected: connects > 0 }
}
