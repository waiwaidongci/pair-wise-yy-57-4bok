import type { ProposalDiff, RouteRelation, StationDevice, TopologyIssue } from './types'

/** 锚点重合容差（站场坐标为 0-100 的示意图单位） */
export const EPS = 1

type Point = [number, number]

export function dist(a: Point | { x: number; y: number }, b: Point | { x: number; y: number }): number {
  const ax = Array.isArray(a) ? a[0] : a.x
  const ay = Array.isArray(a) ? a[1] : a.y
  const bx = Array.isArray(b) ? b[0] : b.x
  const by = Array.isArray(b) ? b[1] : b.y
  return Math.hypot(ax - bx, ay - by)
}

/**
 * 拓扑校验：找出断开、环路、重复锚点三类问题并指出节点。
 * - 断开：进路引用了不存在的设备、设备未挂接任何进路、设备图存在多个连通分量
 * - 环路：同一条进路重复经过同一设备（进路成环）
 * - 重复锚点：两台设备的锚点重合
 */
export function validateTopology(devices: StationDevice[], routes: RouteRelation[]): TopologyIssue[] {
  const issues: TopologyIssue[] = []
  const byId = new Map(devices.map((d) => [d.id, d]))

  // 断开：引用了不存在的设备
  for (const route of routes) {
    for (const devId of route.devices) {
      if (!byId.has(devId)) {
        issues.push({ type: '断开', routeId: route.id, nodes: [devId], message: `进路 ${route.id} 引用了不存在的设备 ${devId}` })
      }
    }
  }

  // 断开：设备未挂接任何进路（孤立节点）
  const referenced = new Set(routes.flatMap((r) => r.devices))
  for (const d of devices) {
    if (!referenced.has(d.id)) {
      issues.push({ type: '断开', nodes: [d.id], message: `设备 ${d.id} 未挂接任何进路` })
    }
  }

  // 断开：按进路相邻关系建图，连通分量 > 1 即存在断点
  const adj = new Map<string, Set<string>>()
  for (const d of devices) adj.set(d.id, new Set())
  for (const route of routes) {
    const ids = route.devices.filter((id) => byId.has(id))
    for (let i = 0; i < ids.length - 1; i++) {
      const a = ids[i]
      const b = ids[i + 1]
      if (a === b) continue
      adj.get(a)?.add(b)
      adj.get(b)?.add(a)
    }
  }
  const visited = new Set<string>()
  const components: string[][] = []
  for (const d of devices) {
    if (visited.has(d.id)) continue
    const comp: string[] = []
    const stack = [d.id]
    while (stack.length) {
      const id = stack.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      comp.push(id)
      for (const n of adj.get(id) ?? []) {
        if (!visited.has(n)) stack.push(n)
      }
    }
    components.push(comp)
  }
  if (components.length > 1) {
    const main = components.reduce((a, b) => (a.length >= b.length ? a : b))
    for (const comp of components) {
      if (comp === main) continue
      issues.push({ type: '断开', nodes: comp, message: `设备 ${comp.join('、')} 与主站场断开` })
    }
  }

  // 环路：同一条进路重复经过同一设备
  for (const route of routes) {
    const seen = new Set<string>()
    for (const devId of route.devices) {
      if (seen.has(devId)) {
        issues.push({ type: '环路', routeId: route.id, nodes: [route.id, devId], message: `进路 ${route.id} 重复经过设备 ${devId}` })
      }
      seen.add(devId)
    }
  }

  // 重复锚点：两台设备锚点重合
  for (let i = 0; i < devices.length; i++) {
    for (let j = i + 1; j < devices.length; j++) {
      if (dist(devices[i], devices[j]) <= EPS) {
        issues.push({ type: '重复锚点', nodes: [devices[i].id, devices[j].id], message: `设备 ${devices[i].id} 与 ${devices[j].id} 锚点重叠` })
      }
    }
  }

  return issues
}

/**
 * 旧数据升级：道岔缺少位置时升级为默认定位，并标记待复核。
 */
export function migrateDevice(d: StationDevice): { device: StationDevice; migrated: boolean } {
  if (d.kind === '道岔' && d.switchPosition == null) {
    return { device: { ...d, switchPosition: '定位', needsReview: true }, migrated: true }
  }
  return { device: d, migrated: false }
}

/**
 * 增量重算：设备坐标或道岔位置变化后，只重算相关进路和设备锚点。
 * 进路中锚定在变化设备旧坐标上的顶点随设备移动，其余进路保持不变。
 */
export function recomputeAffected(
  before: StationDevice[],
  after: StationDevice[],
  routes: RouteRelation[],
  changedIds: Set<string>,
): { routes: RouteRelation[]; recomputedRoutes: string[]; recomputedAnchors: string[] } {
  const beforeMap = new Map(before.map((d) => [d.id, d]))
  const afterMap = new Map(after.map((d) => [d.id, d]))
  const recomputedRoutes: string[] = []
  const recomputedAnchors: string[] = []

  const newRoutes = routes.map((route) => {
    const deviceChanged = route.devices.some((id) => changedIds.has(id))
    const routeChanged = changedIds.has(route.id)
    if (!deviceChanged && !routeChanged) return route

    const points = route.points.map(([px, py]) => {
      for (const id of route.devices) {
        if (!changedIds.has(id)) continue
        const oldD = beforeMap.get(id)
        const newD = afterMap.get(id)
        if (!oldD || !newD) continue
        if (Math.hypot(px - oldD.x, py - oldD.y) <= EPS) {
          if (!recomputedAnchors.includes(id)) recomputedAnchors.push(id)
          return [newD.x, newD.y] as Point
        }
      }
      return [px, py] as Point
    })

    if (!recomputedRoutes.includes(route.id)) recomputedRoutes.push(route.id)
    return { ...route, points, rev: route.rev + 1 }
  })

  return { routes: newRoutes, recomputedRoutes, recomputedAnchors }
}

/**
 * 差异比较：以后到版本的现场坐标为准，给出与当前生效版本的差异。
 */
export function diffDevices(base: StationDevice[], incoming: StationDevice[]): ProposalDiff {
  const movedDevices: ProposalDiff['movedDevices'] = []
  const switchChanges: ProposalDiff['switchChanges'] = []
  const baseMap = new Map(base.map((d) => [d.id, d]))
  for (const inc of incoming) {
    const b = baseMap.get(inc.id)
    if (!b) continue
    if (b.x !== inc.x || b.y !== inc.y) {
      movedDevices.push({ id: inc.id, from: [b.x, b.y], to: [inc.x, inc.y] })
    }
    if (b.switchPosition !== inc.switchPosition && inc.switchPosition) {
      switchChanges.push({ id: inc.id, from: b.switchPosition, to: inc.switchPosition })
    }
  }
  return { movedDevices, switchChanges, addedDevices: [], removedDevices: [], addedRoutes: [], removedRoutes: [] }
}
