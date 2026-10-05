export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'

export type SwitchPosition = '定位' | '反位'

export interface StationDevice {
  id: string
  name: string
  kind: '道岔' | '信号机' | '轨道区段'
  x: number
  y: number
  routeIds: string[]
  /** 设备级修订号：离线回传按修订号逐设备合并的依据 */
  rev: number
  /** 道岔位置；旧数据中可能缺失，载入时升级为默认定位 */
  switchPosition?: SwitchPosition
  /** 旧数据升级后标记，等待人工复核 */
  needsReview?: boolean
}

export interface RouteRelation {
  id: string
  name: string
  color: string
  points: [number, number][]
  devices: string[]
  affectedBy: string[]
  /** 进路级修订号：随拓扑修订递增 */
  rev: number
}

export type TopologyIssueType = '断开' | '环路' | '重复锚点'

export interface TopologyIssue {
  type: TopologyIssueType
  message: string
  /** 指出的节点（设备 id / 进路 id） */
  nodes: string[]
  routeId?: string
}

export interface TopologyState {
  /** 拓扑修订号：StationDevice / RouteRelation / TestCase 共用 */
  rev: number
  devices: StationDevice[]
  routes: RouteRelation[]
  status: '有效' | '待处理'
  issues: TopologyIssue[]
  needsReview: string[]
}

export interface TopologySnapshot {
  rev: number
  devices: StationDevice[]
  routes: RouteRelation[]
  status: '有效' | '待处理'
  issues: TopologyIssue[]
  needsReview: string[]
  capturedAt: string
}

export interface ProposalDiff {
  movedDevices: { id: string; from: [number, number]; to: [number, number] }[]
  switchChanges: { id: string; from?: SwitchPosition; to: SwitchPosition }[]
  addedDevices: string[]
  removedDevices: string[]
  addedRoutes: string[]
  removedRoutes: string[]
}

export interface PendingProposal {
  id: string
  from: string
  baseRev: number
  rev: number
  devices: StationDevice[]
  routes: RouteRelation[]
  diff: ProposalDiff
  receivedAt: string
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
}
