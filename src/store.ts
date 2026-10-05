import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CompleteStation,
  ExecutionRecord,
  OfflineBatch,
  RevisionHistoryEntry,
  RouteNode,
  RouteRelation,
  StationDevice,
  TestCase,
  TestStep,
  TopologyChange,
  TopologyIssue,
  TopologySnapshot,
} from './types'
import { devices as seedDevices, routes as seedRoutes, seedCases, seedExecutions } from './mock'
import {
  affectedRouteIds,
  buildTopologySnapshot,
  clone,
  describeChange,
  hasBlockingIssue,
  nodesFromLegacy,
  recomputeAffectedRoutes,
  recomputeRoutePoints,
  upgradeLegacyDevice,
  validateTopology,
} from './topology'

const STORAGE_KEY = 'yy57-interlocking-topo-v3'
const LEGACY_STORAGE_KEY = 'yy57-interlocking-draft-v1'

export interface DeviceEdit {
  id: string
  x?: number
  y?: number
  position?: StationDevice['position']
  reverseX?: number
  reverseY?: number
  /** 离线合并时并集保留的进路归属 */
  routeIds?: string[]
}

interface PrepareInput {
  author: string
  source: '在线提交' | '离线回传'
  baseRevision: number
  edits: DeviceEdit[]
}

interface PersistedState {
  revision: number
  devices: StationDevice[]
  routes: RouteRelation[]
  cases: TestCase[]
  executions: ExecutionRecord[]
  history: RevisionHistoryEntry[]
  snapshot: TopologySnapshot | null
}

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function normalizeRoutes(routes: RouteRelation[], devices: StationDevice[]): RouteRelation[] {
  return routes.map((route) => {
    const next = clone(route)
    if (!next.nodes || next.nodes.length === 0) next.nodes = nodesFromLegacy(next, devices)
    next.points = recomputeRoutePoints(next, devices)
    next.devices = next.nodes.map((node: RouteNode) => node.deviceId).filter((id: string | undefined): id is string => Boolean(id))
    next.anchorRevision = next.anchorRevision ?? 1
    return next
  })
}

export const useTestStore = defineStore('interlocking', () => {
  const devices = ref<StationDevice[]>([])
  const routes = ref<RouteRelation[]>([])
  const cases = ref<TestCase[]>([])
  const executions = ref<ExecutionRecord[]>([])
  const revision = ref(1)
  const history = ref<RevisionHistoryEntry[]>([])
  const topologySnapshot = ref<TopologySnapshot | null>(null)
  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const baselineLocked = ref(false)
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')
  const topologyNotice = ref('当前为修订 1：站场、进路与用例共用同一拓扑坐标')
  const recoveries = ref<string[]>([])
  /** 演示用：下一次写入强制失败，随后从完整站场备份恢复 */
  const failNextWrite = ref(false)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / Math.max(steps.length, 1) * 100)
  })

  /** 现行拓扑自身的问题（如旧版升级后待复核的道岔） */
  const liveIssues = computed<TopologyIssue[]>(() => validateTopology(devices.value, routes.value))
  const pendingRevisions = computed(() => history.value.filter((entry) => entry.status === '待处理'))
  const hasBlockingPending = computed(() => pendingRevisions.value.length > 0)
  const hasReviewWarnings = computed(() => liveIssues.value.some((issue) => issue.severity === '待复核'))

  /** 已生效修订带来的设备变更；无修订记录时回落到种子变更说明 */
  const changedDevices = computed<string[]>(() => {
    const labels = history.value
      .filter((entry) => entry.status === '已生效')
      .flatMap((entry) => entry.changes.map((change) => change.label))
    return labels.length ? [...new Set(labels)] : ['P-02 转辙机更换', 'T-03 绝缘节调整']
  })

  /** 受影响用例：沿“设备 → 进路 → 用例”由拓扑修订推导 */
  const affectedCases = computed<TestCase[]>(() => {
    const effective = history.value.filter((entry) => entry.status === '已生效')
    const changedDeviceIds = new Set(effective.flatMap((entry) => entry.changes.map((change) => change.deviceId)))
    if (changedDeviceIds.size === 0) {
      return cases.value.filter((item) => item.routeIds.some((routeId) => ['R-02', 'R-04'].includes(routeId)))
    }
    const changedRoutes = new Set(affectedRouteIds([...changedDeviceIds], routes.value))
    return cases.value.filter((item) => item.routeIds.some((routeId) => changedRoutes.has(routeId)))
  })

  function fullBackup(): CompleteStation {
    return { revision: revision.value, devices: clone(devices.value), routes: clone(routes.value), cases: clone(cases.value), executions: clone(executions.value) }
  }

  function persist() {
    const state: PersistedState = {
      revision: revision.value,
      devices: devices.value,
      routes: routes.value,
      cases: cases.value,
      executions: executions.value,
      history: history.value,
      snapshot: topologySnapshot.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  function safePersist(backup: CompleteStation, onRollback?: () => void): boolean {
    try {
      if (failNextWrite.value) {
        failNextWrite.value = false
        throw new Error('存储介质写入失败（模拟）')
      }
      persist()
      return true
    } catch (error) {
      // 写入失败后从完整站场恢复，现场不留半成品
      devices.value = backup.devices
      routes.value = normalizeRoutes(backup.routes, backup.devices)
      cases.value = backup.cases
      executions.value = backup.executions
      revision.value = backup.revision
      onRollback?.()
      const message = `${nowLabel()} 写入失败（${(error as Error).message}），已从完整站场备份恢复至修订 ${backup.revision}`
      recoveries.value.unshift(message)
      topologyNotice.value = message
      return false
    }
  }

  function buildDraft(edits: DeviceEdit[]): { devices: StationDevice[]; changes: TopologyChange[]; changedIds: string[] } {
    const nextDevices = clone(devices.value)
    const changes: TopologyChange[] = []
    const changedIds: string[] = []
    for (const edit of edits) {
      const index = nextDevices.findIndex((device) => device.id === edit.id)
      if (index === -1) continue
      const before = nextDevices[index]!
      const after = clone(before)
      if (edit.x !== undefined) after.x = edit.x
      if (edit.y !== undefined) after.y = edit.y
      if (edit.position !== undefined) after.position = edit.position
      if (edit.reverseX !== undefined) after.reverseX = edit.reverseX
      if (edit.reverseY !== undefined) after.reverseY = edit.reverseY
      if (edit.routeIds) after.routeIds = [...new Set([...before.routeIds, ...edit.routeIds])]
      if (after.x !== before.x || after.y !== before.y || after.position !== before.position || after.reverseX !== before.reverseX || after.reverseY !== before.reverseY || (edit.routeIds && after.routeIds.join() !== before.routeIds.join())) {
        after.anchorRevision = revision.value + 1
        changes.push(describeChange(before, after))
        changedIds.push(after.id)
        nextDevices[index] = after
      }
    }
    return { devices: nextDevices, changes, changedIds }
  }

  /**
   * 核心：提交一次拓扑修订。
   * 设备坐标/道岔位置变化 → 只重算相关进路与设备锚点；
   * 校验出断开/环路/重复锚点 → 停在待处理并指出节点，现场坐标原样保留；
   * baseRevision 落后 → 先到版本生效，后到内容保留现场坐标与差异。
   */
  function prepareRevision(input: PrepareInput): RevisionHistoryEntry {
    const backup = fullBackup()
    const targetRevision = revision.value + 1
    const built = buildDraft(input.edits)
    const workingDevices = built.devices
    const changes = built.changes
    const changedIds = built.changedIds

    // 并发：两个制图员同时提交同一站场，先到版本生效
    if (input.baseRevision !== revision.value) {
      const entry: RevisionHistoryEntry = {
        revision: targetRevision,
        author: input.author,
        source: input.source,
        reason: '并发冲突',
        message: `基线修订 ${input.baseRevision} 已过期，修订 ${revision.value} 先生效；本次内容未覆盖，现场坐标与差异已保留`,
        at: nowLabel(),
        routes: [],
        changes,
        status: '已拒绝',
        retainedDraft: { baseRevision: input.baseRevision, author: input.author, devices: workingDevices, changes, at: nowLabel() },
        issues: [],
      }
      history.value.unshift(entry)
      topologyNotice.value = entry.message
      safePersist(backup, () => { history.value = history.value.filter((item) => item !== entry) })
      return entry
    }

    // 只重算受影响进路
    const workingRoutes = clone(routes.value)
    const touchedRoutes = recomputeAffectedRoutes(workingDevices, workingRoutes, changedIds, targetRevision)
    const issues = validateTopology(workingDevices, workingRoutes)
    const blocking = hasBlockingIssue(issues)

    if (blocking) {
      const entry: RevisionHistoryEntry = {
        revision: targetRevision,
        author: input.author,
        source: input.source,
        reason: '拓扑校验',
        message: `修订 ${targetRevision} 校验未通过，停在待处理：图上存在断开 / 环路 / 重复锚点，已指出节点`,
        at: nowLabel(),
        routes: touchedRoutes,
        changes,
        status: '待处理',
        retainedDraft: { baseRevision: revision.value, author: input.author, devices: workingDevices, changes, at: nowLabel() },
        issues,
      }
      history.value.unshift(entry)
      topologyNotice.value = entry.message
      safePersist(backup, () => { history.value = history.value.filter((item) => item !== entry) })
      return entry
    }

    // 生效：设备锚点、相关进路、关联用例统一落到新修订号
    devices.value = workingDevices
    routes.value = workingRoutes
    revision.value = targetRevision
    const touchedSet = new Set(touchedRoutes)
    for (const item of cases.value) {
      if (item.routeIds.some((routeId) => touchedSet.has(routeId))) item.topologyRevision = targetRevision
    }
    const entry: RevisionHistoryEntry = {
      revision: targetRevision,
      author: input.author,
      source: input.source,
      reason: issues.length ? '旧版升级' : undefined,
      message: issues.length
        ? `修订 ${targetRevision} 已生效，含 ${issues.length} 项待复核项（道岔位置按默认定位升级）`
        : `修订 ${targetRevision} 已生效，重算进路 ${touchedRoutes.join('、') || '无'}`,
      at: nowLabel(),
      routes: touchedRoutes,
      changes,
      status: '已生效',
      issues,
    }
    history.value.unshift(entry)
    topologyNotice.value = entry.message
    safePersist(backup, () => { history.value = history.value.filter((item) => item !== entry) })
    return entry
  }

  /** 制图员在线提交设备坐标/道岔位置 */
  function submitDeviceRevision(author: string, baseRevision: number, edits: DeviceEdit[]) {
    return prepareRevision({ author, baseRevision, edits, source: '在线提交' })
  }

  /** 把被挡下/待处理修订保留的现场坐标装回编辑区，修正后重新提交 */
  function retainedEdits(entryRevision: number): DeviceEdit[] {
    const entry = history.value.find((item) => item.revision === entryRevision && item.retainedDraft)
    if (!entry?.retainedDraft) return []
    return entry.retainedDraft.devices
      .filter((draftDevice) => {
        const current = devices.value.find((item) => item.id === draftDevice.id)
        return current && (current.x !== draftDevice.x || current.y !== draftDevice.y || current.position !== draftDevice.position || current.reverseX !== draftDevice.reverseX || current.reverseY !== draftDevice.reverseY)
      })
      .map((draftDevice) => ({ id: draftDevice.id, x: draftDevice.x, y: draftDevice.y, position: draftDevice.position, reverseX: draftDevice.reverseX, reverseY: draftDevice.reverseY }))
  }

  function resubmitRetained(entryRevision: number, author: string) {
    const entry = history.value.find((item) => item.revision === entryRevision)
    if (!entry?.retainedDraft) return
    const edits = retainedEdits(entryRevision)
    if (!edits.length) {
      topologyNotice.value = `修订 ${entryRevision} 保留的现场坐标与现行版本一致，无需重提`
      entry.status = '已拒绝'
      persist()
      return
    }
    entry.status = '已拒绝'
    submitDeviceRevision(author || entry.author, revision.value, edits)
  }

  function discardRevision(entryRevision: number) {
    const backup = fullBackup()
    const entry = history.value.find((item) => item.revision === entryRevision)
    if (entry && entry.status !== '已生效') {
      entry.status = '已拒绝'
      topologyNotice.value = `修订 ${entryRevision} 已放弃，现场仍使用修订 ${revision.value}`
    }
    safePersist(backup)
  }

  /** 离线回传：按修订号逐设备合并，再走统一校验 */
  function mergeOfflineBatches(author: string, batches: OfflineBatch[]) {
    const backup = fullBackup()
    const edits: DeviceEdit[] = []
    const mergedLabels: string[] = []
    for (const batch of batches) {
      const current = devices.value.find((device) => device.id === batch.deviceId)
      if (!current) continue
      // 同一设备以离线端修订号大者为准
      if ((batch.device.anchorRevision ?? 0) <= (current.anchorRevision ?? 0)) continue
      edits.push({
        id: batch.device.id,
        x: batch.device.x,
        y: batch.device.y,
        position: batch.device.position,
        reverseX: batch.device.reverseX,
        reverseY: batch.device.reverseY,
        routeIds: batch.device.routeIds,
      })
      mergedLabels.push(`${batch.device.id}@修订${batch.device.anchorRevision}`)
    }
    if (!edits.length) {
      topologyNotice.value = '离线回传的设备修订号均不新于现行版本，未合并'
      return
    }
    const entry = prepareRevision({ author, source: '离线回传', baseRevision: revision.value, edits })
    entry.reason = '离线合并'
    entry.message = `离线回传按修订号逐设备合并（${mergedLabels.join('、')}）；${entry.status === '已生效' ? `已生成修订 ${entry.revision}` : '校验未通过，停在待处理，节点已指出'}`
    topologyNotice.value = entry.message
    safePersist(backup, () => { history.value = history.value.filter((item) => item !== entry) })
  }

  /** 从完整站场备份恢复；旧数据没有道岔位置时升级为默认定位并标记待复核 */
  function restoreCompleteStation(station: CompleteStation, source = '导入') {
    const backup = fullBackup()
    const upgradedDevices = station.devices.map(upgradeLegacyDevice)
    const upgradedRoutes = normalizeRoutes(station.routes, upgradedDevices)
    devices.value = upgradedDevices
    routes.value = upgradedRoutes
    cases.value = station.cases
    executions.value = station.executions
    revision.value = station.revision
    const reviewCount = upgradedDevices.filter((device) => device.needsReview).length
    const issues = validateTopology(upgradedDevices, upgradedRoutes)
    const entry: RevisionHistoryEntry = {
      revision: station.revision,
      author: source,
      source: '在线提交',
      reason: '旧版升级',
      message: reviewCount ? `从完整站场恢复，${reviewCount} 台道岔缺少位置记录，已升级为默认定位并标记待复核` : '已从完整站场备份恢复',
      at: nowLabel(),
      routes: upgradedRoutes.map((route) => route.id),
      changes: [],
      status: '已生效',
      issues,
    }
    history.value.unshift(entry)
    topologyNotice.value = entry.message
    safePersist(backup, () => { history.value = history.value.filter((item) => item !== entry) })
  }

  function selectCase(id: string) {
    selectedCaseId.value = id
    selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? []
  }
  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string) {
    if (baselineLocked.value) return
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    if (step.dependency && item.steps.find((entry) => entry.id === step.dependency)?.result !== '通过') {
      liveMessage.value = `前置步骤 ${step.dependency} 未通过，禁止跳过`
      return
    }
    step.result = result
    step.actual = actual ?? step.actual
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败' : item.steps.every((entry) => entry.result === '通过') ? '通过' : '执行中'
    persist()
  }
  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({ id:`EX-${Date.now().toString().slice(-6)}`, caseId:item.id, operator:'当前用户', startedAt:nowLabel(), snapshot:`v26.10 / CS-LEU-09 / 拓扑修订 ${revision.value}`, topologyRevision:revision.value, result:'执行中', evidence:[] })
    persist()
  }
  function updateLiveProgress(value: number) {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`
    if (value >= 100) {
      const active = executions.value.find((item) => item.result === '执行中')
      if (active) { active.result = '失败'; active.finishedAt = nowLabel() }
    }
  }
  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }
  function lockBaseline() {
    if (hasBlockingPending.value) return
    baselineLocked.value = true
    topologySnapshot.value = buildTopologySnapshot(devices.value, routes.value, revision.value)
    persist()
  }

  /** 修订暂存的内部载体 */

  function init() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as PersistedState
      revision.value = saved.revision ?? 1
      devices.value = (saved.devices ?? []).map(upgradeLegacyDevice)
      routes.value = normalizeRoutes(saved.routes ?? [], devices.value)
      cases.value = saved.cases ?? []
      executions.value = saved.executions ?? []
      history.value = saved.history ?? []
      topologySnapshot.value = saved.snapshot ?? null
      return
    }
    devices.value = clone(seedDevices)
    routes.value = normalizeRoutes(clone(seedRoutes), devices.value)
    cases.value = clone(seedCases)
    executions.value = clone(seedExecutions)
    // 兼容旧草稿：旧版本只持久化用例与执行记录
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacy) {
      try {
        const draft = JSON.parse(legacy) as { cases?: TestCase[]; executions?: ExecutionRecord[] }
        if (draft.cases) cases.value = draft.cases
        if (draft.executions) executions.value = draft.executions
      } catch { /* 旧草稿损坏时回落种子数据 */ }
    }
    persist()
  }

  init()

  return {
    devices, routes, cases, executions, revision, history, topologySnapshot,
    selectedCaseId, selectedRouteIds, selectedCase, progress,
    baselineLocked, connection, pendingRetry, liveMessage, topologyNotice, recoveries, failNextWrite,
    liveIssues, pendingRevisions, hasBlockingPending, hasReviewWarnings,
    changedDevices, affectedCases,
    selectCase, setStepResult, startExecution, updateLiveProgress, simulateDisconnect, retry, lockBaseline,
    submitDeviceRevision, mergeOfflineBatches, restoreCompleteStation, retainedEdits, resubmitRetained, discardRevision,
    fullBackup, persist,
  }
})
