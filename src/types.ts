export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'
export type DeviceKind = '道岔' | '信号机' | '轨道区段'
export type SwitchPosition = '定位' | '反位'

export interface StationDevice {
  id: string
  name: string
  kind: DeviceKind
  x: number
  y: number
  /** 道岔当前现场位置；信号机/轨道区段为 undefined */
  position?: SwitchPosition
  /** 道岔反位锚点（定位锚点即 x/y 岔心），旧数据升级时按岔心+默认偏移补全 */
  reverseX?: number
  reverseY?: number
  routeIds: string[]
  /** 该设备最近一次变更所处的拓扑修订号（离线回传按设备合并的依据） */
  anchorRevision: number
  /** 旧数据没有道岔位置，升级为默认定位后必须人工复核 */
  needsReview?: boolean
}

export interface RouteNode {
  /** 设备节点；纯几何折点留空并给出 anchor */
  deviceId?: string
  /** 纯几何折点坐标（站场股道弯折处） */
  anchor?: [number, number]
  /** 经过道岔时要求的位置 */
  requiredPosition?: SwitchPosition
}

export type IssueType = '断开' | '环路' | '重复锚点' | '位置冲突' | '缺失设备'
export type IssueSeverity = '阻断' | '待复核'

export interface TopologyIssue {
  type: IssueType
  severity: IssueSeverity
  nodeIds: string[]
  message: string
}

export type RevisionStatus = '已生效' | '待处理' | '已拒绝'

export interface TopologyChange {
  deviceId: string
  label: string
  from: string
  to: string
}

export interface RevisionHistoryEntry {
  revision: number
  author: string
  source: '在线提交' | '离线回传'
  reason?: '拓扑校验' | '并发冲突' | '离线合并' | '旧版升级'
  message: string
  at: string
  routes: string[]
  changes: TopologyChange[]
  status: RevisionStatus
  /** 被先到版本挡下或校验未过时，保留后到内容的现场坐标与差异 */
  retainedDraft?: StagedTopology
  issues: TopologyIssue[]
}

/** 写入/恢复使用的完整站场备份 */
export interface CompleteStation {
  revision: number
  devices: StationDevice[]
  routes: RouteRelation[]
  cases: TestCase[]
  executions: ExecutionRecord[]
}

/** 制图员暂存的拓扑修订（只含变化的设备） */
export interface StagedTopology {
  baseRevision: number
  author: string
  devices: StationDevice[]
  changes: TopologyChange[]
  at: string
}

export interface OfflineBatch {
  id: string
  author: string
  deviceId: string
  /** 离线端最后一次同步到的修订号 */
  baseRevision: number
  device: StationDevice
}

export interface RouteRelation {
  id: string
  name: string
  color: string
  /** 由 nodes 与设备锚点重算，不再手工维护（旧 points 已并入拓扑修订） */
  points: [number, number][]
  devices: string[]
  nodes: RouteNode[]
  affectedBy: string[]
  /** 最近一次锚点重算所处的拓扑修订号 */
  anchorRevision: number
}

export interface TestStep {
  id: string
  action: string
  expected: string
  dependency?: string
  result: '未执行' | '通过' | '失败'
  actual?: string
  evidence?: string
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  /** 用例编排所依据的拓扑修订号，发布报告保留同一快照 */
  topologyRevision: number
  status: TestStatus
  steps: TestStep[]
  failureReason?: string
}

export interface ExecutionRecord {
  id: string
  caseId: string
  operator: string
  startedAt: string
  finishedAt?: string
  snapshot: string
  result: TestStatus
  evidence: string[]
  topologyRevision?: number
}

/** 发布报告里冻结的拓扑快照 */
export interface TopologySnapshot {
  revision: number
  fixedAt: string
  devices: StationDevice[]
  routes: Array<Pick<RouteRelation, 'id' | 'name' | 'points' | 'nodes' | 'anchorRevision'>>
}
