// 从历史位置签到记录学习常用签到点(bd09)。纯函数,便于测试。
import { distanceMeters as dm, round6 } from "./geo.mjs"

const distanceMeters = (a, b) => dm({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude })

export const LEARN_CLUSTER_METERS = 80

// points: [{ latitude, longitude, address, locationText, activeId, startTime }]
export function clusterPoints(points, radiusM = LEARN_CLUSTER_METERS) {
  const clusters = []
  const sorted = [...points].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
  for (const p of sorted) {
    let best = null, bestD = Infinity
    for (const c of clusters) {
      const d = distanceMeters({ latitude: c.latitude, longitude: c.longitude }, p)
      if (d <= radiusM && d < bestD) { best = c; bestD = d }
    }
    if (!best) { best = { members: [], latitude: p.latitude, longitude: p.longitude }; clusters.push(best) }
    best.members.push(p)
    const n = best.members.length
    best.latitude = best.members.reduce((s, m) => s + m.latitude, 0) / n
    best.longitude = best.members.reduce((s, m) => s + m.longitude, 0) / n
  }
  const total = points.length
  return clusters.map((c) => {
    const spread = Math.max(0, ...c.members.map((m) => distanceMeters({ latitude: c.latitude, longitude: c.longitude }, m)))
    return {
      latitude: round6(c.latitude), longitude: round6(c.longitude),
      count: c.members.length, share: total ? Number((c.members.length / total).toFixed(2)) : 0,
      spreadMeters: Math.round(spread),
      address: mostCommon(c.members.map((m) => m.address).filter(Boolean)) ?? "",
      locationTexts: [...new Set(c.members.map((m) => m.locationText).filter(Boolean))],
      lastUsed: Math.max(0, ...c.members.map((m) => Number(m.startTime) || 0)) || null,
      activeIds: c.members.map((m) => m.activeId),
    }
  }).sort((a, b) => b.count - a.count || (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
}

function mostCommon(arr) {
  const m = new Map(); for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1)
  let best = null, n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v }
  return best
}

// 已学到的位置: st.learnedLocations[classId] = { courseId, courseName, clusters: [...], at }
// 优先选 locationText 与活动一致的簇,再退到该班级最常用的簇。
export function pickLearnedTarget(learned, { classId, locationText } = {}) {
  const entries = Object.entries(learned ?? {})
  const own = learned?.[String(classId)]
  if (locationText) {
    const byText = (e) => e?.clusters?.find((c) => c.locationTexts?.includes(locationText))
    const hit = byText(own)
    if (hit) return { cluster: hit, classId: String(classId), match: "class+locationText" }
    for (const [cid, e] of entries) { const h = byText(e); if (h) return { cluster: h, classId: cid, match: "locationText" } }
  }
  if (own?.clusters?.length) return { cluster: own.clusters[0], classId: String(classId), match: "class" }
  return null
}
