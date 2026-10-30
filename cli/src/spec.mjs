
export const EXIT_CODES = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  USAGE: 2,
  AUTH_REQUIRED: 3,
  AUTH_ACTION_REQUIRED: 4,
  NETWORK: 5,
  BACKEND: 6,
  NOT_SUPPORTED: 7,
  NOT_FOUND: 8,
  RATE_LIMITED: 9,
  DRY_RUN: 10,
})

export const EXIT_CODE_DOCS = {
  0: "成功",
  1: "未知错误 / 状态保存失败",
  2: "用法错误(未知命令 / 缺参数 / 参数类型不对)",
  3: "需要登录或会话已过期且无法自动重登(AUTH_REQUIRED / AUTH_SESSION_EXPIRED / AUTH_INVALID_CREDENTIAL)",
  4: "需要人工步骤:滑块验证码未能自动通过(CAPTCHA_REQUIRED),error.details.next 给出下一条命令",
  5: "网络错误或超时(NETWORK_ERROR / TIMEOUT),可重试",
  6: "学习通业务错误(BACKEND_BUSINESS_ERROR / BACKEND_PROTOCOL_ERROR / SIGN_*),details.reason 给出具体原因",
  7: "不支持(FEATURE_NOT_SUPPORTED:签到类型不支持、可选依赖未安装、学校被封禁等)",
  8: "数据不存在(DATA_NOT_FOUND:课程/活动/用户/位置不存在)",
  9: "被限流(RATE_LIMITED)",
  10: "dry-run:有副作用的命令未加 --confirm,只返回将要执行的操作",
}

export const CODE_EXIT = {
  USAGE: 2,
  AUTH_REQUIRED: 3,
  AUTH_SESSION_EXPIRED: 3,
  AUTH_INVALID_CREDENTIAL: 3,
  CAPTCHA_REQUIRED: 4,
  NETWORK_ERROR: 5,
  TIMEOUT: 5,
  BACKEND_BUSINESS_ERROR: 6,
  BACKEND_PROTOCOL_ERROR: 6,
  BACKEND_UNAVAILABLE: 6,
  SIGN_ALREADY_SIGNED: 6,
  SIGN_EXPIRED: 6,
  SIGN_ENDED: 6,
  SIGN_NO_PERMISSION: 6,
  SIGN_WRONG_POSITION: 6,
  SIGN_QRCODE_EXPIRED: 6,
  SIGN_CODE_INCORRECT: 6,
  SIGN_FACE_ERROR: 6,
  SIGN_DEVICE_DUPLICATED: 6,
  FEATURE_NOT_SUPPORTED: 7,
  DATA_NOT_FOUND: 8,
  RATE_LIMITED: 9,
  DRY_RUN: 10,
  STATE_WRITE_FAILED: 1,
  UNKNOWN: 1,
}

export const RETRYABLE = new Set(["NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "BACKEND_UNAVAILABLE"])

export const GLOBAL_FLAGS = [
  { name: "json", type: "boolean", env: "CXSIGN_JSON", description: "输出单行 JSON 信封 {ok,command,data,meta} / {ok:false,error}" },
  { name: "pretty", type: "boolean", description: "JSON 缩进输出(隐含 --json)" },
  { name: "timeout", type: "number", env: "CXSIGN_TIMEOUT_MS", default: 15000, description: "单个 HTTP 请求超时(毫秒)" },
  { name: "retries", type: "number", env: "CXSIGN_RETRIES", default: 2, description: "网络错误 / 502-504 时 GET 请求的重试次数(指数退避);POST 与签到请求从不重试" },
  { name: "limit", type: "number", description: "列表结果最多返回条数(客户端分页)" },
  { name: "offset", type: "number", default: 0, description: "列表结果起始偏移(客户端分页)" },
  { name: "confirm", type: "boolean", description: "真正执行有副作用的命令(签到 / 上传 / 排行榜上传),否则为 dry-run" },
  { name: "dry-run", type: "boolean", description: "强制 dry-run(优先于 --confirm)" },
  { name: "no-relogin", type: "boolean", description: "会话过期时不使用已保存的(加密)密码自动重登" },
  { name: "as", type: "string", env: "CXSIGN_AS", description: "以哪个账号执行:self(默认,主账号)或代签用户的手机号" },
  { name: "trace", type: "boolean", env: "CXSIGN_TRACE", description: "在 meta.trace 里输出耗时分解(启动、各阶段、每个 HTTP 请求的主机/路径/状态/耗时;不含参数与 cookie)" },
  { name: "hedge-ms", type: "number", env: "CXSIGN_HEDGE_MS", default: 2500, description: "只读 GET 超过这么多毫秒没响应就并发补发一次,取先返回的(0 关闭;签到/POST 从不补发)" },
  { name: "verbose", type: "boolean", env: "CXSIGN_VERBOSE", description: "把 HTTP 摘要日志写到 stderr(敏感参数已打码,不含 cookie / 请求体)" },
  { name: "home", type: "string", env: "CXSIGN_HOME", description: "状态目录,默认 ~/.config/cxsign(目录 0700,state.json 0600)" },
  { name: "help", type: "boolean", description: "显示帮助" },
]

export const ENVIRONMENT = {
  CXSIGN_PHONE: "手机号(auth login / users add 的 --phone 默认值)",
  CXSIGN_PASSWORD: "密码(仅 auth login / users add 读取;推荐改用 --password-stdin)",
  CXSIGN_HOME: "状态目录",
  CXSIGN_JSON: "默认 JSON 输出",
  CXSIGN_TIMEOUT_MS: "请求超时",
  CXSIGN_RETRIES: "GET 重试次数",
  CXSIGN_VERBOSE: "HTTP 摘要日志",
  CXSIGN_AS: "默认执行账号",
  CXSIGN_ORT_MODEL: "验证码模型路径(默认 app/src/main/assets/captcha.ort)",
}
