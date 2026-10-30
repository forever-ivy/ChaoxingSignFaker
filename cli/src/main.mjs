/**
 * cxsign —— 随地大小签(ChaoxingSignFaker)的 agent 友好命令行。
 * 协议逻辑移植自 app/src/main/java/org/aquamarine5/brainspark/chaoxingsignfaker/。
 */
import fs from "node:fs"
import { COMMANDS } from "./commands.mjs"
import { EXIT_CODE_DOCS, EXIT_CODES, GLOBAL_FLAGS } from "./spec.mjs"
import { CxError, scrub, toErrorPayload } from "./errors.mjs"
import { flush, statePath } from "./store.mjs"
import { options as httpOptions, stats } from "./http.mjs"
import { applyClientPreferences } from "./client.mjs"

export const CLI_VERSION = "1.0.0"
export const APP_VERSION = "1.19.4-stable-261024"

export function parseArgv(argv) {
  const path = [], flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") { path.push(...argv.slice(i + 1)); break }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      const g = GLOBAL_FLAGS.find((f) => f.name === key)
      if (next !== undefined && !next.startsWith("--") && g?.type !== "boolean") { flags[key] = next; i++ }
      else flags[key] = true
    } else if (a === "-h") flags.help = true
    else path.push(a)
  }
  return { path, flags }
}

export function findCommand(path) {
  for (let len = Math.min(3, path.length); len >= 1; len--) {
    const name = path.slice(0, len).join(" ")
    const cmd = COMMANDS.find((c) => c.name === name)
    if (cmd) return { cmd, rest: path.slice(len) }
  }
  return { rest: path }
}

function coerce(spec, raw, source) {
  if (raw === undefined) return undefined
  switch (spec.type) {
    case "boolean":
      if (raw === true) return true
      if (/^(1|true|yes|on)$/i.test(String(raw))) return true
      if (/^(0|false|no|off|)$/i.test(String(raw))) return false
      throw new CxError("USAGE", `--${spec.name} 需要布尔值,收到 ${source}`)
    case "number": {
      const v = Number(raw)
      if (raw === true || !Number.isFinite(v)) throw new CxError("USAGE", `--${spec.name} 需要数字`)
      return v
    }
    case "json": {
      if (raw === true) throw new CxError("USAGE", `--${spec.name} 需要 JSON`)
      let text = String(raw)
      if (text.startsWith("@")) text = text === "@-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(text.slice(1), "utf8")
      try { return JSON.parse(text) } catch { throw new CxError("USAGE", `--${spec.name} 不是合法 JSON`) }
    }
    default:
      if (raw === true) throw new CxError("USAGE", `--${spec.name} 需要值`)
      if (spec.choices && !spec.choices.includes(String(raw))) throw new CxError("USAGE", `--${spec.name} 只能是 ${spec.choices.join(" | ")}`)
      return String(raw)
  }
}

export function resolveArgs(specs, flags, env = process.env) {
  const out = {}
  for (const spec of specs) {
    let raw = flags[spec.name], src = `--${spec.name}`
    if (raw === undefined && spec.env && env[spec.env] !== undefined && !spec.secret) { raw = env[spec.env]; src = spec.env }
    let v = coerce(spec, raw, src)
    if (v === undefined && spec.default !== undefined) v = spec.default
    if (v === undefined && spec.required && !(spec.secret && spec.env && env[spec.env])) {
      throw new CxError("USAGE", `缺少必填参数 --${spec.name}${spec.env ? `(或环境变量 ${spec.env})` : ""}`)
    }
    if (v !== undefined) out[spec.name] = v
  }
  return out
}

export function paginate(all, offset = 0, limit) {
  const total = all.length
  const items = all.slice(offset, limit !== undefined ? offset + limit : undefined)
  return { items, page: { offset, limit: limit ?? null, total, returned: items.length, hasMore: offset + items.length < total } }
}

export function schema() {
  return {
    name: "cxsign",
    version: CLI_VERSION,
    appVersion: APP_VERSION,
    description: "随地大小签(ChaoxingSignFaker)的非交互命令行。覆盖学习通签到的全部功能。所有命令支持 --json。",
    envelope: {
      success: { ok: true, command: "string", data: "any", meta: { durationMs: "number", httpRequests: "number", retries: "number", page: "{offset,limit,total,returned,hasMore}?" } },
      failure: { ok: false, command: "string|null", error: { code: "string", message: "string", exitCode: "number", status: "number?", details: "any?", retryable: "boolean" } },
      dryRun: { ok: false, command: "string", dryRun: true, plan: "object", error: { code: "DRY_RUN", exitCode: 10 } },
    },
    exitCodes: EXIT_CODE_DOCS,
    globalFlags: GLOBAL_FLAGS,
    environment: {
      CXSIGN_PHONE: "手机号", CXSIGN_PASSWORD: "密码(仅 auth login / users add 读取)",
      CXSIGN_HOME: "状态目录", CXSIGN_JSON: "默认 JSON 输出", CXSIGN_TIMEOUT_MS: "请求超时",
      CXSIGN_RETRIES: "GET 重试次数", CXSIGN_VERBOSE: "HTTP 摘要日志", CXSIGN_AS: "默认执行账号",
      CXSIGN_ORT_MODEL: "验证码模型路径",
    },
    commands: [
      ...COMMANDS.map((c) => ({
        name: c.name, summary: c.summary, requiresLogin: !!c.auth, sideEffect: !!c.sideEffect, paged: !!c.paged,
        args: c.args ?? [], examples: c.examples ?? [],
      })),
      { name: "schema", summary: "输出本描述(机器可读)", requiresLogin: false, sideEffect: false, paged: false, args: [], examples: [] },
      { name: "version", summary: "版本信息", requiresLogin: false, sideEffect: false, paged: false, args: [], examples: [] },
    ],
  }
}

function fmtArg(a) {
  const t = a.type === "boolean" ? "" : ` <${a.choices ? a.choices.join("|") : a.type}>`
  const extra = [a.required ? "必填" : "", a.env ? `env ${a.env}` : "", a.default !== undefined ? `默认 ${JSON.stringify(a.default)}` : ""].filter(Boolean).join(", ")
  return `  --${a.name}${t}`.padEnd(36) + a.description + (extra ? ` (${extra})` : "")
}

export function helpText(prefix = []) {
  const found = findCommand(prefix)
  if (found.cmd && found.rest.length === 0) {
    const cmd = found.cmd
    return [
      `cxsign ${cmd.name} — ${cmd.summary}`,
      cmd.auth ? "需要登录" : "", cmd.sideEffect ? "有副作用:默认 dry-run,加 --confirm 执行" : "", cmd.paged ? "支持 --limit / --offset" : "",
      "", "参数:", ...(cmd.args?.length ? cmd.args.map(fmtArg) : ["  (无)"]),
      ...(cmd.examples?.length ? ["", "示例:", ...cmd.examples.map((x) => `  ${x}`)] : []),
      "", "全局参数见 `cxsign --help`。",
    ].filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n")
  }
  const groups = new Map()
  for (const c of COMMANDS) {
    const g = c.name.split(" ")[0]
    if (prefix.length && g !== prefix[0]) continue
    groups.set(g, [...(groups.get(g) ?? []), c])
  }
  const lines = ["cxsign — 随地大小签 CLI(面向 agent:非交互、--json、稳定退出码)", "", "用法: cxsign <命令> [子命令] [--参数 值] [--json]", ""]
  for (const [g, cs] of groups) {
    lines.push(`${g}:`)
    for (const c of cs) lines.push(`  ${c.name.padEnd(28)}${c.summary}${c.sideEffect ? " [写]" : ""}${c.auth ? "" : " [免登录]"}`)
  }
  lines.push("", "  schema                      输出全部命令与参数的 JSON 描述", "  version                     版本", "", "全局参数:", ...GLOBAL_FLAGS.map(fmtArg), "", "退出码:", ...Object.entries(EXIT_CODE_DOCS).map(([k, v]) => `  ${String(k).padEnd(4)}${v}`), "", `状态文件: ${statePath()}`)
  return lines.join("\n")
}

export async function run(argv, env = process.env) {
  const started = Date.now()
  const { path, flags } = parseArgv(argv)
  let g = {}, json = false, pretty = false, commandName = null
  const emit = (obj, human, exitCode, toErr = false) => {
    const out = json ? JSON.stringify(obj, null, pretty ? 2 : undefined) + "\n" : (human.endsWith("\n") ? human : human + "\n")
    return { exitCode, stdout: toErr && !json ? "" : out, stderr: toErr && !json ? out : "" }
  }
  try {
    g = resolveArgs(GLOBAL_FLAGS, flags, env)
    pretty = !!g.pretty; json = !!g.json || pretty
    if (g.home) process.env.CXSIGN_HOME = g.home
    httpOptions.retries = Math.max(0, Math.floor(g.retries ?? 2))
    if (g.timeout !== undefined) httpOptions.timeoutMs = g.timeout
    httpOptions.verbose = !!g.verbose
    applyClientPreferences()

    if (path.length === 0 || path[0] === "help") {
      const p = path[0] === "help" ? path.slice(1) : []
      return emit({ ok: true, command: "help", data: { text: helpText(p) } }, helpText(p), 0)
    }
    if (path[0] === "schema") return emit({ ok: true, command: "schema", data: schema() }, JSON.stringify(schema(), null, 2), 0)
    if (path[0] === "version") {
      const v = { cli: CLI_VERSION, app: APP_VERSION, node: process.version }
      return emit({ ok: true, command: "version", data: v }, `cxsign ${v.cli} (app ${v.app}, node ${v.node})`, 0)
    }

    const { cmd, rest } = findCommand(path)
    if (g.help) return emit({ ok: true, command: "help", data: { text: helpText(path) } }, helpText(path), 0)
    if (!cmd) {
      const near = COMMANDS.filter((c) => c.name.startsWith(path[0] ?? "")).map((c) => c.name)
      throw new CxError("USAGE", `未知命令: ${path.join(" ")}`, { suggestions: near.length ? near : undefined, hint: "cxsign --help 或 cxsign schema" })
    }
    commandName = cmd.name
    if (rest.length) throw new CxError("USAGE", `多余的位置参数: ${rest.join(" ")}(所有参数都用 --name value 传入)`)
    const known = new Set([...(cmd.args ?? []).map((a) => a.name), ...GLOBAL_FLAGS.map((a) => a.name)])
    const unknown = Object.keys(flags).filter((k) => !known.has(k))
    if (unknown.length) throw new CxError("USAGE", `未知参数: ${unknown.map((k) => "--" + k).join(" ")}`, { allowed: [...(cmd.args ?? []).map((a) => a.name)] })
    const args = resolveArgs(cmd.args ?? [], flags, env)
    const ctx = { args, global: g, flags }

    if (cmd.sideEffect && (!g.confirm || g["dry-run"])) {
      const plan = { command: cmd.name, ...(cmd.plan ? cmd.plan(ctx) : {}), args: scrub(args) }
      const payload = { ok: false, command: cmd.name, dryRun: true, plan, error: { code: "DRY_RUN", message: "有副作用的命令默认 dry-run;确认无误后加 --confirm 执行", exitCode: EXIT_CODES.DRY_RUN, retryable: false } }
      return emit(payload, `[dry-run] ${JSON.stringify(plan, null, 2)}\n加 --confirm 才会真正执行。`, EXIT_CODES.DRY_RUN)
    }

    if (cmd.auth) {
      // 懒加载:真正需要时再检查会话(命令内部会抛 AUTH_REQUIRED)
      try { await import("./client.mjs").then((m) => m.selfClient()) } catch (e) { throw e }
    }

    let data = await cmd.run(ctx)
    const meta = { durationMs: Date.now() - started, httpRequests: stats.requests, retries: stats.retries }
    if (Array.isArray(data) && (cmd.paged || g.limit !== undefined || g.offset)) {
      const r = paginate(data, g.offset, g.limit)
      data = r.items; meta.page = r.page
    } else if (data && typeof data === "object" && Array.isArray(data.lessons) && (g.limit !== undefined || g.offset)) {
      // schedule list 特殊处理
      const r = paginate(data.lessons, g.offset, g.limit)
      data = { ...data, lessons: r.items }; meta.page = r.page
    }
    data = scrub(data)
    return emit({ ok: true, command: cmd.name, data, meta }, JSON.stringify(data, null, 2), 0)
  } catch (e) {
    const err = toErrorPayload(e)
    return emit({ ok: false, command: commandName, error: err }, `错误 [${err.code}] ${err.message}${err.details ? "\n" + JSON.stringify(err.details, null, 2) : ""}`, err.exitCode, true)
  } finally {
    try { flush() } catch { /* ignore */ }
  }
}

export async function main(argv = process.argv.slice(2)) {
  stats.requests = 0; stats.retries = 0
  const r = await run(argv)
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exitCode = r.exitCode
}
