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

export async function watchIM(ctx, client, deps = {}) {
  const a = ctx.args
  const write = deps.write ?? ((line) => process.stdout.write(line))
  const io = {
    getConfig: deps.getConfig ?? ((c) => api.getEasemobConfig(c)),
    getGroups: deps.getGroups ?? ((im) => api.getEasemobGroups(im)),
    fetchSigns: deps.fetchSigns ?? ((im, g) => api.fetchGroupSignActivities(im, g)),
    sleep: deps.sleep ?? ((ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r() }, { once: true }) })),
    now: deps.now ?? (() => Date.now()),
    notify: deps.notify ?? runNotify,
  }
  const intervalMs = Math.max(1, Number(a.interval ?? 15)) * 1000
  const started = io.now()
  const deadline = a.timeout !== undefined ? started + Number(a.timeout) * 1000 : Infinity
  const ctrl = new AbortController()
  const onSig = () => ctrl.abort()
  if (!deps.noSignals) { process.once("SIGINT", onSig); process.once("SIGTERM", onSig) }
  const emit = (ev) => write(JSON.stringify(scrub({ ts: new Date(io.now()).toISOString(), ...ev })) + "\n")
  const seen = new Set()
  let im = null, groups = [], failures = 0, polls = 0, signEvents = 0, connects = 0, isPrimed = false
  const stats = () => ({ polls, signEvents, connects, groups: groups.length, durationMs: io.now() - started })
  const isDone = () => ctrl.signal.aborted || io.now() >= deadline || (a.once && signEvents > 0)
  try {
    while (!isDone()) {
      try {
        if (!im) {
          im = await io.getConfig(client)
          groups = await io.getGroups(im)
          if (a.group) groups = groups.filter((g) => String(g.groupId) === String(a.group))
          else groups = groups.slice(0, a["max-groups"] ?? 50)
          connects++
          emit({ type: connects === 1 ? "connected" : "reconnected", imUser: im.username ? "***" : null, groups: groups.map((g) => ({ groupId: g.groupId, name: g.name })) })
        }
        polls++
        const found = []
        for (const g of groups) {
          if (isDone()) break
          try { found.push(...await io.fetchSigns(im, g)) } catch (e) {
            if (e?.status === 401 || e?.status === 403 || /401|unauthor/i.test(String(e?.message))) throw e
            emit({ type: "group-error", groupId: g.groupId, message: e?.message ?? String(e) })
          }
        }
        for (const act of api.sortIMActivities(found)) {
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
        if (!isPrimed) { isPrimed = true; emit({ type: "ready", knownActivities: seen.size }) }
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
