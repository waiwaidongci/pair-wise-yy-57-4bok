import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ExecutionRecord, PendingProposal, StationDevice, SwitchPosition, TestCase, TestStep, TopologyIssue, TopologySnapshot, TopologyState } from './types'
import { seedCases, seedExecutions, devices as seedDevices, routes as seedRoutes } from './mock'
import { diffDevices, migrateDevice, recomputeAffected, validateTopology } from './topology'

const DRAFT_KEY = 'yy57-interlocking-draft-v1'
const COMPLETE_KEY = 'yy57-interlocking-complete-v1'

/** 深拷贝：Vue 响应式 Proxy 无法用 structuredClone，数据均为可序列化的站场数据 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function seedTopology() {
  return {
    rev: 1,
    devices: clone(seedDevices),
    routes: clone(seedRoutes),
    status: '有效' as const,
    issues: [] as TopologyIssue[],
    needsReview: [] as string[],
  }
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref<TestCase[]>(clone(seedCases))
  const executions = ref<ExecutionRecord[]>(clone(seedExecutions))
  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const baselineLocked = ref(false)
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')

  // 拓扑修订：StationDevice / RouteRelation / TestCase 共用同一份修订
  const topology = ref<TopologyState>(seedTopology())
  const pendingProposals = ref<PendingProposal[]>([])
  const topologyMessage = ref('')
  const writeFailArmed = ref(false)
  const lastAffectedRouteIds = ref<string[]>([])
  const lockedTopology = ref<TopologySnapshot | null>(null)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })
  const changedDevices = ['P-02 转辙机更换', 'T-03 绝缘节调整']
  // 受影响用例由拓扑修订自动推导：进路关联的设备发生变化 → 该进路上的用例受影响
  const affectedCases = computed(() =>
    cases.value.filter((item) => item.routeIds.some((routeId) => lastAffectedRouteIds.value.includes(routeId))),
  )

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
    writeDraft()
  }

  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({ id: `EX-${Date.now().toString().slice(-6)}`, caseId: item.id, operator: '当前用户', startedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), snapshot: 'v26.10 / CS-LEU-09', result: '执行中', evidence: [] })
    writeDraft()
  }

  function updateLiveProgress(value: number) {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`
    if (value >= 100) {
      const active = executions.value.find((item) => item.result === '执行中')
      if (active) { active.result = '失败'; active.finishedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) }
    }
  }

  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }
  function lockBaseline() {
    baselineLocked.value = true
    lockedTopology.value = topologySnapshot.value
  }

  // ── 拓扑持久化与恢复 ──────────────────────────────────────────────

  function writeDraft() {
    const payload = JSON.stringify({ topology: topology.value, cases: cases.value, executions: executions.value })
    localStorage.setItem(DRAFT_KEY, payload)
    // 完整站场快照：仅在拓扑有效时更新，写入失败时从这里恢复
    if (topology.value.status === '有效') localStorage.setItem(COMPLETE_KEY, payload)
  }

  function persistTopology() {
    try {
      if (writeFailArmed.value) throw new Error('模拟写入失败')
      writeDraft()
    } catch {
      restoreCompleteStation()
      topologyMessage.value = '写入失败，已从完整站场快照恢复'
      writeFailArmed.value = false
    }
  }

  /** 写入失败后从完整站场恢复 */
  function restoreCompleteStation() {
    const raw = localStorage.getItem(COMPLETE_KEY)
    if (raw) {
      const complete = JSON.parse(raw)
      topology.value = complete.topology
      cases.value = complete.cases
      executions.value = complete.executions
    } else {
      topology.value = seedTopology()
    }
    revalidate()
    // 恢复后同步草稿，避免下次载入又回到失败前的状态
    const payload = JSON.stringify({ topology: topology.value, cases: cases.value, executions: executions.value })
    localStorage.setItem(DRAFT_KEY, payload)
  }

  function revalidate() {
    const issues = validateTopology(topology.value.devices, topology.value.routes)
    topology.value.issues = issues
    topology.value.status = issues.length ? '待处理' : '有效'
    topology.value.needsReview = topology.value.devices.filter((d) => d.needsReview).map((d) => d.id)
  }

  /** 旧数据迁移：道岔位置缺失 → 升级默认定位 + 待复核 */
  function migrateLegacyDevices() {
    topology.value.devices = topology.value.devices.map((d) => migrateDevice(d).device)
  }

  function initTopology() {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) {
      const draft = JSON.parse(raw)
      if (draft.topology) {
        topology.value = draft.topology
        cases.value = draft.cases ?? cases.value
        executions.value = draft.executions ?? executions.value
      }
    }
    migrateLegacyDevices()
    seedAffected()
    revalidate()
    if (!localStorage.getItem(COMPLETE_KEY)) writeDraft()
  }

  /** 从进路的 affectedBy 文本中提取本轮变更涉及的设备，推导受影响进路 */
  function seedAffected() {
    const mentioned = new Set<string>()
    for (const route of topology.value.routes) {
      for (const text of route.affectedBy) {
        for (const d of topology.value.devices) {
          if (text.includes(d.id)) mentioned.add(d.id)
        }
      }
    }
    markAffected([...mentioned])
  }

  function markAffected(deviceIds: string[]) {
    const set = new Set(deviceIds)
    lastAffectedRouteIds.value = topology.value.routes
      .filter((r) => r.devices.some((id) => set.has(id)))
      .map((r) => r.id)
  }

  /** 设备坐标变化后，只重算相关进路的锚点顶点 */
  function recomputeRoutesFor(beforeDevices: StationDevice[], changedIds: Set<string>) {
    const { routes: newRoutes } = recomputeAffected(beforeDevices, topology.value.devices, topology.value.routes, changedIds)
    topology.value.routes = newRoutes
  }

  // ── 拓扑变更：只重算相关进路和设备锚点 ─────────────────────────────

  function applyTopologyChange(changedIds: Set<string>, mutate: () => void) {
    const beforeDevices = clone(topology.value.devices)
    mutate()
    topology.value.rev += 1
    const { routes: newRoutes, recomputedRoutes } = recomputeAffected(
      beforeDevices, topology.value.devices, topology.value.routes, changedIds,
    )
    topology.value.routes = newRoutes
    markAffected([...changedIds].filter((id) => topology.value.devices.some((d) => d.id === id)))
    revalidate()
    persistTopology()
    return { recomputedRoutes }
  }

  /** 施工队改设备坐标 */
  function moveDevice(id: string, x: number, y: number) {
    applyTopologyChange(new Set([id]), () => {
      const d = topology.value.devices.find((e) => e.id === id)
      if (d) { d.x = x; d.y = y; d.rev += 1 }
    })
  }

  /** 施工队改道岔方向 */
  function toggleSwitch(id: string) {
    const d = topology.value.devices.find((e) => e.id === id)
    if (!d || d.kind !== '道岔') return
    applyTopologyChange(new Set([id]), () => {
      d.switchPosition = d.switchPosition === '反位' ? '定位' : '反位'
      d.rev += 1
    })
  }

  // ── 演示：制造拓扑问题（待处理并指出节点） ─────────────────────────

  function demoDuplicateAnchor() {
    const target = topology.value.devices.find((d) => d.id === 'P-02')
    if (target) moveDevice('T-01', target.x, target.y)
  }

  function demoDisconnect() {
    applyTopologyChange(new Set(['T-01']), () => {
      topology.value.devices = topology.value.devices.filter((d) => d.id !== 'T-01')
    })
  }

  function demoLoop() {
    applyTopologyChange(new Set(['R-01']), () => {
      const r = topology.value.routes.find((route) => route.id === 'R-01')
      if (r && !r.devices.includes('X-01')) r.devices = [...r.devices, 'X-01']
    })
  }

  // ── 旧数据升级演示 ────────────────────────────────────────────────

  function loadLegacyData() {
    topology.value.devices = clone(seedDevices).map((d) => ({ ...d, switchPosition: undefined, needsReview: false }))
    topology.value.routes = clone(seedRoutes)
    topology.value.rev = 1
    migrateLegacyDevices()
    seedAffected()
    revalidate()
    persistTopology()
    topologyMessage.value = '已载入旧版数据：道岔位置缺失，升级为默认定位并标记待复核'
  }

  // ── 离线回传：按修订号逐设备合并 ───────────────────────────────────

  function mergeOffline(remoteDevices: StationDevice[]) {
    const merged: string[] = []
    const beforeDevices = clone(topology.value.devices)
    topology.value.devices = topology.value.devices.map((local) => {
      const remote = remoteDevices.find((r) => r.id === local.id)
      if (remote && remote.rev > local.rev) { merged.push(local.id); return { ...remote } }
      return local
    })
    for (const remote of remoteDevices) {
      if (!topology.value.devices.some((d) => d.id === remote.id)) {
        topology.value.devices.push(remote)
        merged.push(remote.id)
      }
    }
    topology.value.rev += 1
    const changedIds = new Set(merged)
    recomputeRoutesFor(beforeDevices, changedIds)
    markAffected(merged)
    revalidate()
    persistTopology()
    topologyMessage.value = `离线回传完成，逐设备合并 ${merged.length} 项：${merged.join('、') || '无'}`
  }

  function demoOfflineBackhaul() {
    const p01 = topology.value.devices.find((d) => d.id === 'P-01')!
    const s01 = topology.value.devices.find((d) => d.id === 'S-01')!
    mergeOffline([
      { ...p01, x: p01.x + 3, rev: p01.rev + 1 },
      { ...s01, switchPosition: '反位', rev: s01.rev + 1 },
    ])
  }

  // ── 制图员并发提交：先到版本生效，后到内容保留现场坐标和差异 ────────

  function submitProposal(
    from: string,
    changes: { id: string; x?: number; y?: number; switchPosition?: SwitchPosition }[],
    baseRev: number = topology.value.rev,
  ) {
    const proposalDevices = topology.value.devices.map((d) => ({ ...d }))
    for (const change of changes) {
      const d = proposalDevices.find((e) => e.id === change.id)
      if (!d) continue
      if (change.x !== undefined) d.x = change.x
      if (change.y !== undefined) d.y = change.y
      if (change.switchPosition) d.switchPosition = change.switchPosition
      d.rev += 1
    }
    const proposal: PendingProposal = {
      id: `PP-${Date.now()}`,
      from,
      baseRev,
      rev: baseRev + 1,
      devices: proposalDevices,
      routes: topology.value.routes.map((r) => ({ ...r })),
      diff: diffDevices(topology.value.devices, proposalDevices),
      receivedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    }

    if (proposal.rev <= topology.value.rev) {
      // 后到版本：保留现场坐标和差异，不覆盖生效版本
      pendingProposals.value.unshift(proposal)
      topologyMessage.value = `${from} 提交晚到（修订号 ${proposal.rev} ≤ 当前 ${topology.value.rev}），现场坐标与差异已保留`
    } else {
      // 先到版本生效：重算相关进路锚点
      const beforeDevices = clone(topology.value.devices)
      topology.value.devices = proposalDevices
      topology.value.rev = proposal.rev
      const changedIds = new Set(changes.map((c) => c.id))
      recomputeRoutesFor(beforeDevices, changedIds)
      markAffected([...changedIds])
      revalidate()
      persistTopology()
      topologyMessage.value = `${from} 提交先生效（修订号 ${proposal.rev}）`
    }
  }

  function demoDraftsmans() {
    const baseRev = topology.value.rev
    const p02 = topology.value.devices.find((d) => d.id === 'P-02')!
    const t03 = topology.value.devices.find((d) => d.id === 'T-03')!
    submitProposal('制图员 A', [{ id: 'P-02', x: p02.x, y: p02.y + 4 }], baseRev)
    submitProposal('制图员 B', [{ id: 'T-03', x: t03.x - 3, y: t03.y }], baseRev)
  }

  /** 采纳后到版本中与生效版本无冲突的设备差异（按设备修订号） */
  function adoptProposal(id: string) {
    const proposal = pendingProposals.value.find((p) => p.id === id)
    if (!proposal) return
    const adopted: string[] = []
    const beforeDevices = clone(topology.value.devices)
    topology.value.devices = topology.value.devices.map((local) => {
      const remote = proposal.devices.find((d) => d.id === local.id)
      if (remote && remote.rev > local.rev) { adopted.push(local.id); return { ...remote } }
      return local
    })
    topology.value.rev += 1
    pendingProposals.value = pendingProposals.value.filter((p) => p.id !== id)
    const changedIds = new Set(adopted)
    recomputeRoutesFor(beforeDevices, changedIds)
    markAffected(adopted)
    revalidate()
    persistTopology()
    topologyMessage.value = `已采纳 ${proposal.from} 的无冲突设备差异：${adopted.join('、') || '无'}`
  }

  const topologySnapshot = computed((): TopologySnapshot => ({
    rev: topology.value.rev,
    devices: clone(topology.value.devices),
    routes: clone(topology.value.routes),
    status: topology.value.status,
    issues: topology.value.issues.map((i) => ({ ...i, nodes: [...i.nodes] })),
    needsReview: [...topology.value.needsReview],
    capturedAt: new Date().toISOString(),
  }))

  watch(cases, () => { try { writeDraft() } catch { /* 写入失败时忽略，由拓扑写入路径恢复 */ } }, { deep: true })
  initTopology()

  return {
    cases, executions, selectedCaseId, selectedRouteIds, selectedCase, progress,
    baselineLocked, connection, pendingRetry, liveMessage, changedDevices, affectedCases,
    selectCase, setStepResult, startExecution, updateLiveProgress, simulateDisconnect, retry, lockBaseline,
    // 拓扑修订
    topology, topologyMessage, pendingProposals, writeFailArmed, lastAffectedRouteIds, lockedTopology, topologySnapshot,
    moveDevice, toggleSwitch, demoDuplicateAnchor, demoDisconnect, demoLoop,
    loadLegacyData, demoOfflineBackhaul, mergeOffline, submitProposal, demoDraftsmans, adoptProposal,
    restoreCompleteStation, revalidate,
  }
})
