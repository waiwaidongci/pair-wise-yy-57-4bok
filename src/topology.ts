import type {
  IssueSeverity,
  RevisionHistoryEntry,
  RouteNode,
  RouteRelation,
  StationDevice,
  StagedTopology,
  SwitchPosition,
  TestCase,
  TopologyChange,
  TopologyIssue,
  TopologySnapshot,
} from './types'
import { devices as seedDevices, routes as seedRoutes } from './mock'

export const CURRENT_REVISION_KEY = 'yy57-topology-revision'

/** 道岔反位锚点相对岔心的默认偏移（旧数据升级时使用，标记待复核） */
export const DEFAULT_REVERSE_OFFSET: [number, number] = [0, 14]

export function clone<T>(value: T): T {
  // 拓扑数据全是可序列化纯对象；JSON 拷贝可安全处理 Vue 响应式 Proxy（structuredClone 遇到 Proxy 会抛 DataCloneError）
  return JSON.parse(JSON.stringify(value)) as T
}

export function isSwitch(device: StationDevice) {
  return device.kind === '道岔'
}

/** 设备在指定道岔位置下的锚点坐标；非道岔设备恒取自身坐标 */
export function deviceAnchor(device: StationDevice, position?: SwitchPosition): [number, number] {
  if (isSwitch(device) && position === '反位' && device.reverseX !== undefined && device.reverseY !== undefined) {
    return [device.reverseX, device.reverseY]
  }
  return [device.x, device.y]
}

/** 旧数据没有道岔位置：升级为默认定位并标记待复核，补全反位锚点 */
export function upgradeLegacyDevice(device: StationDevice): StationDevice {
  if (!isSwitch(device) || device.position) return device
  const upgraded = clone(device)
  upgraded.position = '定位'
  upgraded.needsReview = true
  if (upgraded.reverseX === undefined || upgraded.reverseY === undefined) {
    upgraded.reverseX = upgraded.x + DEFAULT_REVERSE_OFFSET[0]
    upgraded.reverseY = upgraded.y + DEFAULT_REVERSE_OFFSET[1]
  }
  return upgraded
}

/** 节点锚点：设备节点取设备在道岔位置下的坐标，折点节点取自身 anchor */
export function nodeAnchor(node: RouteNode, devices: StationDevice[]): [number, number] | undefined {
  if (node.anchor) return node.anchor
  const device = node.deviceId ? devices.find((entry) => entry.id === node.deviceId) : undefined
  return device ? deviceAnchor(device, node.requiredPosition) : undefined
}

/** 由节点链与设备锚点重算单条进路几何点，只依赖相关设备 */
export function recomputeRoutePoints(route: RouteRelation, devices: StationDevice[]): [number, number][] {
  const points: [number, number][] = []
  for (const node of route.nodes) {
    const anchor = nodeAnchor(node, devices)
    if (anchor) points.push(anchor)
  }
  return points
}

/** 只重算受变更设备影响的进路，返回受影响进路 id */
export function affectedRouteIds(deviceIds: string[], routes: RouteRelation[]): string[] {
  const changed = new Set(deviceIds)
  return routes.filter((route) => route.nodes.some((node) => node.deviceId && changed.has(node.deviceId))).map((route) => route.id)
}

/** 重算相关进路锚点并标记修订号 */
export function recomputeAffectedRoutes(devices: StationDevice[], routes: RouteRelation[], deviceIds: string[], revision: number) {
  const ids = new Set(affectedRouteIds(deviceIds, routes))
  for (const route of routes) {
    if (!ids.has(route.id)) continue
    route.points = recomputeRoutePoints(route, devices)
    route.devices = route.nodes.map((node) => node.deviceId).filter((id): id is string => Boolean(id))
    route.anchorRevision = revision
  }
  return [...ids]
}

/** 图里出现断开、环路、重复锚点等时停在待处理并指出节点 */
export function validateTopology(devices: StationDevice[], routes: RouteRelation[]): TopologyIssue[] {
  const issues: TopologyIssue[] = []
  const deviceMap = new Map(devices.map((device) => [device.id, device]))
  for (const device of devices) {
    if (device.needsReview) {
      issues.push({ type: '位置冲突', severity: '待复核', nodeIds: [device.id], message: `${device.id} 由旧版数据升级为默认定位，缺少道岔位置记录，需现场复核` })
    }
  }

  // 重复锚点（全局）：不同设备锚点重合，或同一道岔定位/反位锚点重合
  const globalAnchors = new Map<string, string[]>()
  for (const device of devices) {
    const anchors: Array<{ label: string; point: [number, number] }> = [{ label: device.id, point: [device.x, device.y] }]
    if (isSwitch(device) && device.reverseX !== undefined && device.reverseY !== undefined) {
      anchors.push({ label: `${device.id}反位`, point: [device.reverseX, device.reverseY] })
    }
    for (const { label, point } of anchors) {
      const key = point.join(',')
      const labels = globalAnchors.get(key) ?? []
      if (labels.length) {
        issues.push({ type: '重复锚点', severity: '阻断', nodeIds: [...labels, label], message: `锚点 ${key} 同时被 ${labels.join('、')} 与 ${label} 占用，存在重复锚点` })
      }
      labels.push(label)
      globalAnchors.set(key, labels)
    }
  }

  for (const route of routes) {
    // 缺失设备 → 节点断开
    const missing = route.nodes.filter((node) => node.deviceId && !deviceMap.has(node.deviceId))
    if (missing.length) {
      issues.push({ type: '缺失设备', severity: '阻断', nodeIds: missing.map((node) => node.deviceId!), message: `进路 ${route.id} 引用的设备 ${missing.map((node) => node.deviceId).join('、')} 不存在，节点断开` })
    }

    const resolved = route.nodes
      .map((node) => ({ node, anchor: nodeAnchor(node, devices) }))
      .filter((entry): entry is { node: RouteNode; anchor: [number, number] } => Boolean(entry.anchor))

    // 重复锚点：同一进路上两个节点落到同一坐标（含道岔定位/反位锚点重合）
    const seen = new Map<string, string>()
    resolved.forEach(({ node, anchor }) => {
      const label = node.deviceId ?? `折点(${anchor.join(',')})`
      const key = anchor.join(',')
      const previous = seen.get(key)
      if (previous) {
        issues.push({ type: '重复锚点', severity: '阻断', nodeIds: [previous, label], message: `进路 ${route.id} 中 ${previous} 与 ${label} 锚点重合（${key}），存在重复锚点` })
      } else {
        seen.set(key, label)
      }
    })

    // 环路：节点链中同一设备的同一位置被反复经过
    const trail: string[] = []
    for (const node of route.nodes) {
      if (!node.deviceId) continue
      const token = `${node.deviceId}@${node.requiredPosition ?? '锚点'}`
      const previousIndex = trail.findIndex((entry) => entry === token)
      if (previousIndex !== -1) {
        const cycle = trail.slice(previousIndex).concat(token)
        issues.push({ type: '环路', severity: '阻断', nodeIds: cycle.map((entry) => entry.split('@')[0]), message: `进路 ${route.id} 在 ${[...new Set(cycle)].join(' → ')} 形成环路` })
      }
      trail.push(token)
    }

    // 断开：相邻节点跨度过大，视为几何断开
    resolved.forEach((entry, index) => {
      if (index === 0) return
      const prev = resolved[index - 1]!
      const gap = Math.hypot(entry.anchor[0] - prev.anchor[0], entry.anchor[1] - prev.anchor[1])
      if (gap > 30) {
        const a = prev.node.deviceId ?? `折点(${prev.anchor.join(',')})`
        const b = entry.node.deviceId ?? `折点(${entry.anchor.join(',')})`
        issues.push({ type: '断开', severity: '阻断', nodeIds: [a, b], message: `进路 ${route.id} 在 ${a} → ${b} 之间间距 ${gap.toFixed(1)} 格，链路断开` })
      }
    })

    // 位置冲突：进路要求道岔反位但设备没有反位锚点
    for (const node of route.nodes) {
      const device = node.deviceId ? deviceMap.get(node.deviceId) : undefined
      if (device && isSwitch(device) && node.requiredPosition === '反位' && (device.reverseX === undefined || device.reverseY === undefined)) {
        issues.push({ type: '位置冲突', severity: '阻断', nodeIds: [device.id], message: `进路 ${route.id} 要求 ${device.id} 反位，但该道岔没有反位锚点` })
      }
    }
  }
  // 同一问题（如同一断开跨多条进路）去重，只指出一次节点
  const deduped = new Map<string, TopologyIssue>()
  for (const issue of issues) {
    const key = `${issue.type}:${[...issue.nodeIds].sort().join(',')}`
    if (!deduped.has(key)) deduped.set(key, issue)
  }
  return [...deduped.values()]
}

export function hasBlockingIssue(issues: TopologyIssue[]): boolean {
  return issues.some((issue) => issue.severity === '阻断')
}

export function issueSeverityCount(issues: TopologyIssue[], severity: IssueSeverity) {
  return issues.filter((issue) => issue.severity === severity).length
}

/** 离线回传：按修订号逐设备合并；同一设备以修订号大者为准 */
export function mergeOfflineDevice(current: StationDevice, incoming: StationDevice, baseRevision: number, revision: number): { device: StationDevice; merged: boolean } {
  if ((incoming.anchorRevision ?? 0) <= (current.anchorRevision ?? 0)) {
    return { device: current, merged: false }
  }
  const merged = clone(incoming)
  merged.anchorRevision = revision
  merged.routeIds = [...new Set([...current.routeIds, ...incoming.routeIds])]
  void baseRevision
  return { device: merged, merged: true }
}

/** 设备变更文案 */
export function describeChange(before: StationDevice | undefined, after: StationDevice): TopologyChange {
  const parts: TopologyChange[] = []
  if (!before) {
    return { deviceId: after.id, label: `${after.id} 新增设备`, from: '不存在', to: `(${after.x}, ${after.y})` }
  }
  if (before.x !== after.x || before.y !== after.y) {
    parts.push({ deviceId: after.id, label: `${after.id} 坐标移动`, from: `(${before.x}, ${before.y})`, to: `(${after.x}, ${after.y})` })
  }
  if (isSwitch(after) && before.position !== after.position) {
    parts.push({ deviceId: after.id, label: `${after.id} 道岔扳动`, from: before.position ?? '无记录', to: after.position ?? '无记录' })
  }
  return parts[0] ?? { deviceId: after.id, label: `${after.id} 锚点更新`, from: `修订 ${before.anchorRevision}`, to: `修订 ${after.anchorRevision}` }
}

/** 冻结发布报告拓扑快照 */
export function buildTopologySnapshot(devices: StationDevice[], routes: RouteRelation[], revision: number): TopologySnapshot {
  return {
    revision,
    fixedAt: new Date().toISOString(),
    devices: clone(devices),
    routes: routes.map((route) => ({ id: route.id, name: route.name, points: clone(route.points), nodes: clone(route.nodes), anchorRevision: route.anchorRevision })),
  }
}

/** 从旧版 points 推导节点链（兼容持久化数据） */
export function nodesFromLegacy(route: { devices?: string[]; points?: [number, number][] }, deviceList: StationDevice[]): RouteNode[] {
  const list = route.devices ?? []
  return list.map((id) => {
    const device = deviceList.find((entry) => entry.id === id)
    return { deviceId: id, requiredPosition: device && isSwitch(device) ? device.position : undefined }
  })
}

export function seedTopologyRevision(): number {
  const raw = localStorage.getItem(CURRENT_REVISION_KEY)
  return raw ? Number(raw) || 1 : 1
}
