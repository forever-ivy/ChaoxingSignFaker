import { CxError, usage } from "./errors.mjs"

const PI = Math.PI
const X_PI = (PI * 3000) / 180
const A = 6378245
const EE = 0.00669342162296594323

export const COORD_SYSTEMS = ["bd09", "gcj02", "wgs84"]
export const SIGN_COORD_SYSTEM = "bd09"

function isOutOfChina(lat, lon) { return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271 }
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  return r
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  return r
}
export function wgs84ToGcj02(lat, lon) {
  if (isOutOfChina(lat, lon)) return { lat, lon }
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35)
  const rad = (lat / 180) * PI
  let magic = Math.sin(rad); magic = 1 - EE * magic * magic
  const sq = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * PI)
  dLon = (dLon * 180) / ((A / sq) * Math.cos(rad) * PI)
  return { lat: lat + dLat, lon: lon + dLon }
}
export function gcj02ToWgs84(lat, lon) {
  if (isOutOfChina(lat, lon)) return { lat, lon }
  let w = { lat, lon }
  for (let i = 0; i < 10; i++) {
    const g = wgs84ToGcj02(w.lat, w.lon)
    const dLat = g.lat - lat, dLon = g.lon - lon
    w = { lat: w.lat - dLat, lon: w.lon - dLon }
    if (Math.abs(dLat) < 1e-9 && Math.abs(dLon) < 1e-9) break
  }
  return w
}
export function gcj02ToBd09(lat, lon) {
  const z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * X_PI)
  const t = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * X_PI)
  return { lat: z * Math.sin(t) + 0.006, lon: z * Math.cos(t) + 0.0065 }
}
export function bd09ToGcj02(lat, lon) {
  const x = lon - 0.0065, y = lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI)
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI)
  return { lat: z * Math.sin(t), lon: z * Math.cos(t) }
}
export function normalizeSystem(s) {
  const v = String(s ?? "").toLowerCase().replace(/[-_ ]/g, "").replace(/ll$/, "")
  if (v === "bd09" || v === "baidu") return "bd09"
  if (v === "gcj02" || v === "gcj" || v === "amap" || v === "mars") return "gcj02"
  if (v === "wgs84" || v === "wgs" || v === "gps") return "wgs84"
  throw usage(`未知坐标系: ${s}(可选 bd09 / gcj02 / wgs84)`)
}
export function convert(lat, lon, from, to) {
  from = normalizeSystem(from); to = normalizeSystem(to)
  lat = Number(lat); lon = Number(lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw usage("经纬度必须是数字")
  if (from === to) return { lat, lon }
  let g = from === "gcj02" ? { lat, lon } : from === "wgs84" ? wgs84ToGcj02(lat, lon) : bd09ToGcj02(lat, lon)
  if (to === "gcj02") return g
  if (to === "wgs84") return gcj02ToWgs84(g.lat, g.lon)
  return gcj02ToBd09(g.lat, g.lon)
}
export const round6 = (n) => Number(Number(n).toFixed(6))

export function distanceMeters(a, b) {
  const R = 6371008.8, r = (d) => (d * PI) / 180
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null }

function pointOf(p) {
  if (p === null || p === undefined) return null
  if (Array.isArray(p) && p.length >= 2) {
    const a = num(p[0]), b = num(p[1])
    if (a === null || b === null) return null
    return Math.abs(a) > 90 ? { lat: b, lon: a } : { lat: a, lon: b }
  }
  if (typeof p === "object") {
    const lat = num(p.lat ?? p.latitude ?? p.locationLatitude ?? p.y)
    const lon = num(p.lon ?? p.lng ?? p.longitude ?? p.locationLongitude ?? p.x)
    return lat === null || lon === null ? null : { lat, lon }
  }
  if (typeof p === "string") {
    const parts = p.split(/[,\s]+/).filter(Boolean)
    return parts.length >= 2 ? pointOf(parts) : null
  }
  return null
}

export function parsePointList(v) {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "string") {
    const t = v.trim()
    if (t.startsWith("[") || t.startsWith("{")) { try { return parsePointList(JSON.parse(t)) } catch { return null } }
    if (!/[;|]/.test(t)) return null
    const pts = t.split(/[;|]/).map((x) => pointOf(x.trim())).filter(Boolean)
    return pts.length >= 2 ? pts : null
  }
  if (Array.isArray(v)) {
    const pts = v.map(pointOf).filter(Boolean)
    return pts.length >= 2 ? pts : null
  }
  if (typeof v === "object") {
    const lo = pointOf(v.min ?? v.southWest ?? v.sw), hi = pointOf(v.max ?? v.northEast ?? v.ne)
    if (lo && hi) return [lo, hi]
    const minLat = num(v.minLat ?? v.latMin), maxLat = num(v.maxLat ?? v.latMax), minLon = num(v.minLon ?? v.minLng ?? v.lonMin ?? v.lngMin), maxLon = num(v.maxLon ?? v.maxLng ?? v.lonMax ?? v.lngMax)
    if ([minLat, maxLat, minLon, maxLon].every((x) => x !== null)) return [{ lat: minLat, lon: minLon }, { lat: maxLat, lon: maxLon }]
    if (Array.isArray(v.points)) return parsePointList(v.points)
  }
  return null
}

export function polygonCentroid(pts) {
  const ring = pts.length > 2 && pts[0].lat === pts.at(-1).lat && pts[0].lon === pts.at(-1).lon ? pts.slice(0, -1) : pts
  if (ring.length === 2) return { lat: (ring[0].lat + ring[1].lat) / 2, lon: (ring[0].lon + ring[1].lon) / 2 }
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    const f = p.lon * q.lat - q.lon * p.lat
    a += f; cx += (p.lon + q.lon) * f; cy += (p.lat + q.lat) * f
  }
  if (Math.abs(a) < 1e-12) return { lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length }
  a /= 2
  return { lat: cy / (6 * a), lon: cx / (6 * a) }
}

const RANGE_FIELDS = ["locationRange", "locationArea", "locationPoints", "locationList", "locationPolygon", "polygon", "range", "area", "points"]

export function resolveSignTarget(info) {
  if (!info || typeof info !== "object") return null
  const address = info.locationText ?? info.address ?? info.locationAddress ?? ""
  for (const f of RANGE_FIELDS) {
    const pts = parsePointList(info[f])
    if (pts) {
      const c = polygonCentroid(pts)
      const kind = pts.length === 2 ? "midpoint" : "centroid"
      return {
        latitude: round6(c.lat), longitude: round6(c.lon), radius: null, address, coordSystem: SIGN_COORD_SYSTEM,
        source: f, method: kind, points: pts.map((p) => ({ latitude: p.lat, longitude: p.lon })),
        reason: kind === "midpoint" ? `${f} 给出两点/最小最大范围,取中点` : `${f} 给出 ${pts.length} 个顶点的多边形,取几何质心`,
      }
    }
  }
  const lat = num(info.locationLatitude ?? info.latitude), lon = num(info.locationLongitude ?? info.longitude)
  if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) {
    const radius = num(info.locationRange)
    return {
      latitude: lat, longitude: lon, radius, address, coordSystem: SIGN_COORD_SYSTEM, source: "locationLatitude/locationLongitude", method: "center",
      reason: radius !== null ? `教师设置了中心点(bd09)和半径 ${radius} 米,取中心点` : "教师设置了中心点(bd09),直接使用",
    }
  }
  const gLat = num(info.locationLatitude_gd), gLon = num(info.locationLongitude_gd)
  if (gLat !== null && gLon !== null && !(gLat === 0 && gLon === 0)) {
    const radius = num(info.locationRange)
    const p = convert(gLat, gLon, "gcj02", SIGN_COORD_SYSTEM)
    return {
      latitude: round6(p.lat), longitude: round6(p.lon), radius, address, coordSystem: SIGN_COORD_SYSTEM, source: "locationLatitude_gd/locationLongitude_gd", method: "center",
      reason: `只有高德(gcj02)中心点,已转为 bd09${radius !== null ? `,半径 ${radius} 米` : ""}`,
    }
  }
  return null
}

export function isInsideRadius(target, lat, lon) {
  if (!target?.radius) return null
  return distanceMeters({ lat: target.latitude, lon: target.longitude }, { lat, lon }) <= target.radius
}

const UA = "cxsign/1.0 (+https://github.com/aquamarine5/ChaoxingSignFaker)"

async function getJson(fetchImpl, url) {
  let res
  try { res = await fetchImpl(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN" } }) } catch (e) { throw new CxError("NETWORK_ERROR", `地理编码服务连接失败: ${e.message}`, { retryable: true }) }
  if (!res.ok) throw new CxError("NETWORK_ERROR", `地理编码服务 HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429 })
  return res.json()
}

export function geocoderProvider(env = process.env, cfg = {}) {
  const ak = env.CXSIGN_BAIDU_AK || cfg.baiduAk
  return ak ? { name: "baidu", ak } : { name: "nominatim", base: env.CXSIGN_NOMINATIM_URL || cfg.nominatimUrl || "https://nominatim.openstreetmap.org" }
}

function outPoint(lat, lon, from, address, extra = {}) {
  const p = convert(lat, lon, from, SIGN_COORD_SYSTEM)
  return { latitude: round6(p.lat), longitude: round6(p.lon), coordSystem: SIGN_COORD_SYSTEM, address, ...extra }
}

export async function searchPlaces(keyword, { city, limit = 10, env = process.env, cfg = {}, fetchImpl = fetch } = {}) {
  if (!keyword) throw usage("需要关键词")
  const p = geocoderProvider(env, cfg)
  if (p.name === "baidu") {
    const u = new URL("https://api.map.baidu.com/place/v2/search")
    u.search = new URLSearchParams({ query: keyword, region: city || "全国", output: "json", ret_coordtype: "bd09ll", page_size: String(Math.min(limit, 20)), ak: p.ak }).toString()
    const j = await getJson(fetchImpl, u)
    if (j.status !== 0) throw new CxError("BACKEND_PROTOCOL_ERROR", `百度地点检索失败[${j.status}]: ${j.message ?? ""}`)
    return { provider: "baidu", results: (j.results ?? []).filter((r) => r.location).slice(0, limit).map((r) => outPoint(r.location.lat, r.location.lng, "bd09", r.address ?? "", { name: r.name, city: r.city ?? null })) }
  }
  const u = new URL(`${p.base}/search`)
  u.search = new URLSearchParams({ q: city ? `${keyword} ${city}` : keyword, format: "jsonv2", limit: String(limit), "accept-language": "zh-CN", countrycodes: "cn" }).toString()
  const j = await getJson(fetchImpl, u)
  return { provider: "nominatim", results: (Array.isArray(j) ? j : []).map((r) => outPoint(r.lat, r.lon, "wgs84", r.display_name ?? "", { name: r.name || String(r.display_name ?? "").split(",")[0], city: null })) }
}

export async function reverseGeocode(lat, lon, { from = SIGN_COORD_SYSTEM, env = process.env, cfg = {}, fetchImpl = fetch } = {}) {
  const p = geocoderProvider(env, cfg)
  const bd = convert(lat, lon, from, "bd09")
  if (p.name === "baidu") {
    const u = new URL("https://api.map.baidu.com/reverse_geocoding/v3/")
    u.search = new URLSearchParams({ location: `${bd.lat},${bd.lon}`, coordtype: "bd09ll", output: "json", ak: p.ak }).toString()
    const j = await getJson(fetchImpl, u)
    if (j.status !== 0) throw new CxError("BACKEND_PROTOCOL_ERROR", `百度逆地理编码失败[${j.status}]: ${j.message ?? ""}`)
    return { provider: "baidu", ...outPoint(bd.lat, bd.lon, "bd09", j.result?.formatted_address ?? "", { name: j.result?.sematic_description ?? null }) }
  }
  const w = convert(bd.lat, bd.lon, "bd09", "wgs84")
  const u = new URL(`${p.base}/reverse`)
  u.search = new URLSearchParams({ lat: String(w.lat), lon: String(w.lon), format: "jsonv2", "accept-language": "zh-CN" }).toString()
  const j = await getJson(fetchImpl, u)
  return { provider: "nominatim", ...outPoint(bd.lat, bd.lon, "bd09", j.display_name ?? "", { name: j.name ?? null }) }
}

export function addressVariants(text) {
  const out = []
  const add = (v) => { v = String(v ?? "").trim(); if (v && !out.includes(v)) out.push(v) }
  let t = String(text ?? "").trim()
  add(t)
  t = t.replace(/^中国/, ""); add(t)
  t = t.replace(/^[^省]{2,8}省/, "").replace(/^[^自治区]{2,8}自治区/, ""); add(t)
  const noTown = t.replace(/[^市区县]{1,8}?(镇|乡|街道)/, ""); add(noTown)
  const noSuffix = noTown.replace(/(辅路|附近|旁|对面|东侧|西侧|南侧|北侧)$/, ""); add(noSuffix)
  const m = /^(.+?市)(.+?[区县])?(.*)$/.exec(noSuffix)
  if (m && m[3]) add(`${m[3]} ${m[1]}`)
  return out
}

export async function geocodeAddress(text, opts = {}) {
  let last = null
  for (const q of addressVariants(text)) {
    const r = await searchPlaces(q, { ...opts, limit: 1 })
    last = r
    if (r.results[0]) return { provider: r.provider, query: q, ...r.results[0] }
  }
  return null
}
