<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const canvas = ref<HTMLCanvasElement>()
const zoom = ref(1)
let ctx: CanvasRenderingContext2D | undefined
let resizeObserver: ResizeObserver | undefined

const issueNodes = computed(() => new Set(
  store.topology.issues.flatMap((i) => i.nodes).filter((n) => store.topology.devices.some((d) => d.id === n)),
))
const issueRoutes = computed(() => new Set(
  store.topology.issues.map((i) => i.routeId).filter((n): n is string => !!n),
))
const reviewNodes = computed(() => new Set(store.topology.devices.filter((d) => d.needsReview).map((d) => d.id)))

function draw() {
  const element = canvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  element.width = rect.width * ratio
  element.height = rect.height * ratio
  const context = element.getContext('2d')
  if (!context) return
  ctx = context
  context.scale(ratio, ratio)
  context.clearRect(0, 0, rect.width, rect.height)
  context.fillStyle = '#f8fafc'; context.fillRect(0, 0, rect.width, rect.height)
  const unitX = rect.width / 100; const unitY = rect.height / 100
  context.strokeStyle = '#e2e8f0'; context.lineWidth = 1
  for (let i = 0; i <= 100; i += 5) { context.beginPath(); context.moveTo(i * unitX, 0); context.lineTo(i * unitX, rect.height); context.stroke(); context.beginPath(); context.moveTo(0, i * unitY); context.lineTo(rect.width, i * unitY); context.stroke() }
  context.lineCap = 'round'; context.lineJoin = 'round'
  store.topology.routes.forEach((route) => {
    const selected = store.selectedRouteIds.includes(route.id)
    const broken = issueRoutes.value.has(route.id)
    context.beginPath(); route.points.forEach((point, index) => { const x = point[0] * unitX, y = point[1] * unitY; if (index === 0) context.moveTo(x, y); else context.lineTo(x, y) })
    context.strokeStyle = broken ? '#dc2626' : selected ? route.color : '#94a3b8'; context.lineWidth = selected ? 7 : 3; context.globalAlpha = selected ? 1 : .42; context.stroke(); context.globalAlpha = 1
  })
  store.topology.devices.forEach((device) => {
    const active = store.selectedCase?.routeIds.some((routeId) => device.routeIds.includes(routeId))
    const inIssue = issueNodes.value.has(device.id)
    const inReview = reviewNodes.value.has(device.id)
    context.beginPath(); context.arc(device.x * unitX, device.y * unitY, active ? 12 : 8, 0, Math.PI * 2)
    context.fillStyle = device.kind === '道岔' ? (active ? '#d97706' : '#94a3b8') : device.kind === '信号机' ? (active ? '#16a34a' : '#64748b') : (active ? '#2563eb' : '#cbd5e1'); context.fill(); context.strokeStyle = '#fff'; context.lineWidth = 3; context.stroke()
    if (inIssue) { context.beginPath(); context.arc(device.x * unitX, device.y * unitY, 16, 0, Math.PI * 2); context.strokeStyle = '#dc2626'; context.lineWidth = 2; context.setLineDash([4, 4]); context.stroke(); context.setLineDash([]) }
    if (inReview) { context.beginPath(); context.arc(device.x * unitX, device.y * unitY, 20, 0, Math.PI * 2); context.strokeStyle = '#d97706'; context.lineWidth = 1.5; context.setLineDash([2, 3]); context.stroke(); context.setLineDash([]) }
    context.fillStyle = '#0f172a'; context.font = '600 12px sans-serif'; context.fillText(device.id, device.x * unitX + 13, device.y * unitY - 10)
    if (inReview) { context.fillStyle = '#b45309'; context.font = '600 10px sans-serif'; context.fillText('待复核', device.x * unitX + 13, device.y * unitY + 4) }
  })
}

function hitTest(event: MouseEvent) {
  const rect = canvas.value!.getBoundingClientRect(); const x = event.offsetX, y = event.offsetY
  let closest = store.topology.routes[0]!; let distance = Infinity
  store.topology.routes.forEach((route) => { route.points.forEach((point) => { const d = Math.hypot(point[0] / 100 * rect.width - x, point[1] / 100 * rect.height - y); if (d < distance) { distance = d; closest = route } }) })
  if (distance < 45) store.selectedRouteIds = [closest.id]
}

function moveP02() {
  const d = store.topology.devices.find((e) => e.id === 'P-02')
  if (d) store.moveDevice(d.id, d.x, Math.min(92, d.y + 6))
}
function toggleP03() { store.toggleSwitch('P-03') }

onMounted(async () => { await nextTick(); draw(); resizeObserver = new ResizeObserver(draw); resizeObserver.observe(canvas.value!) })
onBeforeUnmount(() => resizeObserver?.disconnect())
watch(() => store.selectedCaseId, draw)
watch(() => store.selectedRouteIds, draw, { deep: true })
watch(() => store.topology, draw, { deep: true })
</script>

<template>
  <section class="page-head">
    <div>
      <p class="eyebrow">站场与进路关系</p>
      <h1>Canvas 站场示意</h1>
      <p>设备坐标或道岔位置变化时只重算相关进路与锚点；出现断开、环路或重复锚点时停在待处理并指出节点。</p>
    </div>
    <n-space>
      <n-tag :type="store.topology.status === '有效' ? 'success' : 'error'">拓扑修订 v{{ store.topology.rev }} · {{ store.topology.status }}</n-tag>
      <n-button @click="zoom=Math.max(.7,zoom-.1); draw()">缩小</n-button>
      <span>{{ Math.round(zoom * 100) }}%</span>
      <n-button @click="zoom=Math.min(1.5,zoom+.1); draw()">放大</n-button>
    </n-space>
  </section>

  <div class="station-toolbar card">
    <n-space wrap>
      <span class="tool-group"><b>施工变更</b>
        <n-button size="small" @click="moveP02">移动 P-02 坐标</n-button>
        <n-button size="small" @click="toggleP03">切换 P-03 道岔方向</n-button>
      </span>
      <span class="tool-group"><b>制造拓扑问题</b>
        <n-button size="small" type="warning" @click="store.demoDuplicateAnchor()">重复锚点</n-button>
        <n-button size="small" type="warning" @click="store.demoDisconnect()">断开</n-button>
        <n-button size="small" type="warning" @click="store.demoLoop()">环路</n-button>
      </span>
      <span class="tool-group"><b>协同</b>
        <n-button size="small" @click="store.demoDraftsmans()">两制图员同时提交</n-button>
        <n-button size="small" @click="store.demoOfflineBackhaul()">离线回传</n-button>
        <n-button size="small" @click="store.writeFailArmed = true">模拟写入失败</n-button>
      </span>
      <span class="tool-group"><b>数据</b>
        <n-button size="small" @click="store.loadLegacyData()">旧数据升级</n-button>
      </span>
    </n-space>
  </div>

  <n-alert v-if="store.topologyMessage" type="info" class="topo-msg" :title="store.topologyMessage" />

  <n-alert v-if="store.topology.status === '待处理'" type="error" class="topo-msg" title="拓扑待处理：已停止重算并指出问题节点">
    <ul class="issue-list">
      <li v-for="(issue, index) in store.topology.issues" :key="index">
        <n-tag :type="issue.type === '断开' ? 'error' : issue.type === '环路' ? 'warning' : 'default'">{{ issue.type }}</n-tag>
        <span>{{ issue.message }}</span>
        <em>节点：{{ issue.nodes.join('、') }}</em>
      </li>
    </ul>
  </n-alert>

  <n-alert v-if="store.pendingProposals.length" type="warning" class="topo-msg" title="后到版本：现场坐标与差异已保留，未覆盖生效版本">
    <div v-for="p in store.pendingProposals" :key="p.id" class="proposal">
      <div><b>{{ p.from }}</b> · 修订号 {{ p.rev }}（基于 v{{ p.baseRev }}）· {{ p.receivedAt }}</div>
      <div class="diff-line" v-for="(m, i) in p.diff.movedDevices" :key="'m'+i">设备 {{ m.id }}：({{ m.from[0] }},{{ m.from[1] }}) → ({{ m.to[0] }},{{ m.to[1] }})</div>
      <div class="diff-line" v-for="(s, i) in p.diff.switchChanges" :key="'s'+i">道岔 {{ s.id }}：{{ s.from ?? '无位置' }} → {{ s.to }}</div>
      <n-button size="small" type="primary" @click="store.adoptProposal(p.id)">采纳无冲突差异</n-button>
    </div>
  </n-alert>

  <div class="station-grid">
    <article class="card canvas-card">
      <div class="canvas-head"><span>海州站 · 计算机联锁平面示意</span><span>实线高亮：当前用例关联进路</span></div>
      <canvas ref="canvas" class="station-canvas" @click="hitTest" />
    </article>
    <aside class="card">
      <div class="panel-head"><div><h2>进路关系</h2><p>共用拓扑修订 v{{ store.topology.rev }}</p></div><n-tag>{{ store.selectedRouteIds.length }} 条</n-tag></div>
      <button v-for="route in store.topology.routes" :key="route.id" class="route-row" :class="{ active: store.selectedRouteIds.includes(route.id) }" @click="store.selectedRouteIds = [route.id]">
        <i :style="{ background: route.color }"></i>
        <div><b>{{ route.id }} · {{ route.name }}</b><small>{{ route.devices.join(' → ') }}</small></div>
        <n-tag size="small" :type="issueRoutes.has(route.id) ? 'error' : 'default'">v{{ route.rev }}</n-tag>
      </button>
      <n-divider />
      <h3>设备锚点</h3>
      <div v-for="device in store.topology.devices" :key="device.id" class="device-row">
        <b>{{ device.id }}</b><small>{{ device.name }} · {{ device.kind }} · v{{ device.rev }}<span v-if="device.switchPosition"> · {{ device.switchPosition }}</span></small>
        <n-tag v-if="device.needsReview" size="small" type="warning">待复核</n-tag>
      </div>
      <n-divider />
      <h3>设备变更影响</h3>
      <n-alert v-for="item in store.topology.routes.filter((route) => store.selectedRouteIds.includes(route.id)).flatMap((route) => route.affectedBy)" :key="item" type="warning" :title="item" class="issue" />
    </aside>
  </div>
</template>
