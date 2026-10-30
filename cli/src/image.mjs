import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { CxError } from "./errors.mjs"

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

function optional(name) {
  try { return require(name) } catch { return null }
}

export function decodeImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = optional("pngjs")
    if (!png) throw new CxError("FEATURE_NOT_SUPPORTED", "缺少依赖 pngjs,请在 cli/ 下 npm install")
    const img = png.PNG.sync.read(buf)
    return { width: img.width, height: img.height, data: img.data }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const jpeg = optional("jpeg-js")
    if (!jpeg) throw new CxError("FEATURE_NOT_SUPPORTED", "缺少依赖 jpeg-js,请在 cli/ 下 npm install")
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 })
    return { width: img.width, height: img.height, data: img.data }
  }
  throw new CxError("USAGE", "只支持 JPEG / PNG 图片")
}

export function decodeQRCodeImage(buf) {
  const jsqr = optional("jsqr")
  if (!jsqr) throw new CxError("FEATURE_NOT_SUPPORTED", "缺少依赖 jsqr,请在 cli/ 下 npm install")
  const img = decodeImage(buf)
  const fn = jsqr.default ?? jsqr
  const r = fn(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height, { inversionAttempts: "attemptBoth" })
  if (!r?.data) throw new CxError("DATA_NOT_FOUND", "图片中没有识别到二维码")
  return r.data
}


const MODEL_INPUT_SIZE = 640
const SCORE_THRESHOLD = 0.25
const NMS_IOU_THRESHOLD = 0.45
const EDGE_OFFSET = 4

export function modelPath() {
  if (process.env.CXSIGN_ORT_MODEL) return process.env.CXSIGN_ORT_MODEL
  return path.resolve(here, "..", "..", "app", "src", "main", "assets", "captcha.ort")
}

export function captchaModelStatus() {
  const ort = optional("onnxruntime-node")
  const p = modelPath()
  return { runtime: ort ? "onnxruntime-node" : null, modelPath: p, modelExists: fs.existsSync(p), available: !!ort && fs.existsSync(p) }
}

export function preprocess(img) {
  const padded = Math.max(img.width, img.height)
  const S = MODEL_INPUT_SIZE
  const out = new Float32Array(3 * S * S)
  const scale = padded / S
  const px = (x, y, c) => (x < img.width && y < img.height ? img.data[(y * img.width + x) * 4 + c] : 0)
  for (let oy = 0; oy < S; oy++) {
    const sy = Math.max(0, (oy + 0.5) * scale - 0.5)
    const y0 = Math.floor(sy), y1 = Math.min(padded - 1, y0 + 1), fy = sy - y0
    for (let ox = 0; ox < S; ox++) {
      const sx = Math.max(0, (ox + 0.5) * scale - 0.5)
      const x0 = Math.floor(sx), x1 = Math.min(padded - 1, x0 + 1), fx = sx - x0
      for (let c = 0; c < 3; c++) {
        const v = (px(x0, y0, c) * (1 - fx) + px(x1, y0, c) * fx) * (1 - fy) + (px(x0, y1, c) * (1 - fx) + px(x1, y1, c) * fx) * fy
        out[c * S * S + oy * S + ox] = v / 255
      }
    }
  }
  return { tensor: out, padded }
}

function iou(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  return inter / (a.w * a.h + b.w * b.h - inter)
}

export function nms(dets) {
  const sorted = [...dets].sort((a, b) => b.score - a.score)
  const kept = []
  while (sorted.length) {
    const cur = sorted.shift()
    kept.push(cur)
    for (let i = sorted.length - 1; i >= 0; i--) if (iou(cur, sorted[i]) > NMS_IOU_THRESHOLD) sorted.splice(i, 1)
  }
  return kept
}

export function postprocess(data, n, padded) {
  const dets = []
  for (let i = 0; i < n; i++) {
    const score = data[4 * n + i]
    if (score < SCORE_THRESHOLD) continue
    const w = data[2 * n + i], h = data[3 * n + i]
    dets.push({ x: data[i] - w / 2, y: data[n + i] - h / 2, w, h, score })
  }
  const best = nms(dets).sort((a, b) => b.score - a.score)[0]
  if (!best) return null
  return { x: Math.trunc((best.x * padded) / MODEL_INPUT_SIZE - EDGE_OFFSET + 0.5), score: best.score }
}

let sessionPromise = null
export async function predictSliderXOffset(buf) {
  const ort = optional("onnxruntime-node")
  if (!ort) throw new CxError("FEATURE_NOT_SUPPORTED", "未安装可选依赖 onnxruntime-node,无法自动识别滑块", { next: "cd cli && npm install onnxruntime-node;或用 --captcha-x 手动提供缺口位置" })
  const p = modelPath()
  if (!fs.existsSync(p)) throw new CxError("FEATURE_NOT_SUPPORTED", `找不到验证码模型 ${p}`, { next: "设置 CXSIGN_ORT_MODEL" })
  sessionPromise ??= ort.InferenceSession.create(fs.readFileSync(p))
  const session = await sessionPromise
  const img = decodeImage(buf)
  const { tensor, padded } = preprocess(img)
  const input = new ort.Tensor("float32", tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE])
  const out = await session.run({ [session.inputNames[0] ?? "images"]: input })
  const t = out[session.outputNames[0]]
  const n = t.dims[2]
  return postprocess(t.data, n, padded)
}
