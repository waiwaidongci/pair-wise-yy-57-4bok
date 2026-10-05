<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTestStore, type DeviceEdit } from '../store'
import { clone } from '../topology'
import type { OfflineBatch, StationDevice, TopologyIssue } from '../types'

const store = useTestStore()
const canvas = ref<HTMLCanvasElement>()
const zoom = ref(1)
let resizeObserver: ResizeObserver | undefined

const selectedDeviceId = ref<string>('P-03')
const editX = ref(67)
const editY = ref(40)
const editPosition = ref<'定位' | '反位'>('定位')
const editReverseX = ref(67)
const editReverseY = ref(58)
const baseRevision = ref(1)
const author = ref('制图员-甲')

const selectedDevice = computed<StationDevice | undefined>(() => store.devices.find((device) => device.id === selectedDeviceId.value))
/** 当前停在待处理的修订及其节点问题 */
const pending = computed(() => store.pendingRevisions[0])
const issueNodeSet = computed(() => new Set((pending.value?.issues ?? []).flatMap((issue) => issue.nodeIds)))
const liveWarningNodeSet = computed(() => new Set(store.liveIssues.map((issue) => issue.nodeIds[0])))

function selectDevice(id: string) {
  selectedDeviceId.value = id
  const device = store.devices.find((item) => item.id === id)
  if (!device) return
  editX.value = device.x
  editY.value = device.y
  editPosition.value = device.position ?? '定位'
  editReverseX.value = device.reverseX ?? device.x
  editReverseY.value = device.reverseY ?? device.y
  baseRevision.value = store.revision
}

function currentEdits(): DeviceEdit[] {
  const device = selectedDevice.value
  if (!device) return []
  const edits: DeviceEdit[] = []
  if (editX.value !== device.x || editY.value !== device.y || editReverseX.value !== device.reverseX || editReverseY.value !== device.reverseY) {
    edits.push({ id: device.id, x: editX.value, y: editY.value, reverseX: editReverseX.value, reverseY: editReverseY.value })
  }
  if (device.kind === '道岔' && editPosition.value !== device.position) {
    edits.push({ id: device.id, position: editPosition.value })
  }
  return edits
}

function submit() {
  const edits = currentEdits()
  if (!edits.length) return
  store.submitDeviceRevision(author.value, baseRevision.value, edits)
  selectDevice(selectedDeviceId.value)
}

/** 模拟第二个制图员基于旧修订同时提交，验证先到生效、后到保留 */
function simulateConcurrent() {
  store.submitDeviceRevision('制图员-乙', store.revision, [
    { id: 'T-03', x: 82, y: 65 },
  ])
  store.submitDeviceRevision('制图员-乙', store.revision - 1, [
    { id: 'T-03', x: 70, y: 68 },
  ])
}

/** 提交一个会把设备挪出链路的坐标，触发断开停在待处理 */
function simulateBreak() {
  selectedDeviceId.value = 'T-03'
  store.submitDeviceRevision(author.value, store.revision, [{ id: 'T-03', x: 20, y: 90 }])
}

/** 让道岔定位/反位锚点重合，触发重复锚点 */
function simulateDuplicateAnchor() {
  store.submitDeviceRevision(author.value, store.revision, [{ id: 'P-03', reverseX: 67, reverseY: 40 }])
}

/** 离线回传：逐设备带修订号合并 */
function simulateOffline() {
  const t03 = store.devices.find((device) => device.id === 'T-03')
  const x01 = store.devices.find((device) => device.id === 'X-01')
  if (!t03 || !x01) return
  const batches: OfflineBatch[] = [
    { id: 'OFF-01', author: '外勤-丙', baseRevision: store.revision, deviceId: 'T-03', device: { ...clone(t03), x: 80, y: 65, anchorRevision: store.revision + 2 } },
    { id: 'OFF-02', author: '外勤-丙', baseRevision: store.revision, deviceId: 'X-01', device: { ...clone(x01), anchorRevision: 0 } },
  ]
  store.mergeOfflineBatches('外勤-丙', batches)
}

/** 旧版站场备份：道岔没有 position，恢复时升级为默认定位并标记待复核 */
function simulateLegacyRestore() {
  const backup = store.fullBackup()
  const legacyDevices = backup.devices.map((device) => {
    const { position: _position, reverseX: _rx, reverseY: _ry, ...rest } = device
    return rest
  })
  store.restoreCompleteStation({ ...backup, revision: store.revision, devices: legacyDevices }, '旧版备份-2609')
}

function armWriteFailure() { store.failNextWrite = true }

function resubmit() { if (pending.value) store.resubmitRetained(pending.value.revision, author.value) }
function discard() { if (pending.value) store.discardRevision(pending.value.revision) }

function issueTypeTag(issue: TopologyIssue) {
  return issue.severity === '阻断' ? 'error' : 'warning'
}

function zoomOut() { zoom.value = Math.max(.7, zoom.value - .1) }
function zoomIn() { zoom.value = Math.min(1.5, zoom.value + .1) }

function draw() {
  const element = canvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  element.width = rect.width * ratio
  element.height = rect.height * ratio
  const context = element.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  context.clearRect(0, 0, rect.width, rect.height)
  context.fillStyle = '#f8fafc'; context.fillRect(0, 0, rect.width, rect.height)
  const unitX = rect.width / 100; const unitY = rect.height / 100
  context.save(); context.translate(rect.width * (1 - zoom.value) / 2, rect.height * (1 - zoom.value) / 2); context.scale(zoom.value, zoom.value)
  context.strokeStyle = '#e2e8f0'; context.lineWidth = 1
  for (let i=0;i<=100;i+=5) { context.beginPath(); context.moveTo(i*unitX,0); context.lineTo(i*unitX,rect.height); context.stroke(); context.beginPath(); context.moveTo(0,i*unitY); context.lineTo(rect.width,i*unitY); context.stroke() }
  context.lineCap = 'round'; context.lineJoin = 'round'

  store.routes.forEach((route) => {
    const selected = store.selectedRouteIds.includes(route.id)
    context.beginPath(); route.points.forEach((point,index)=>{ const x=point[0]*unitX, y=point[1]*unitY; if(index===0)context.moveTo(x,y); else context.lineTo(x,y) })
    context.strokeStyle = selected ? route.color : '#94a3b8'; context.lineWidth = selected ? 7 : 3; context.globalAlpha = selected ? 1 : .42; context.stroke(); context.globalAlpha = 1
  })

  store.devices.forEach((device) => {
    const active = store.selectedCase?.routeIds.some((routeId) => device.routeIds.includes(routeId))
    const hasIssue = issueNodeSet.value.has(device.id) || liveWarningNodeSet.value.has(device.id)
    const px = device.x*unitX, py = device.y*unitY
    context.beginPath(); context.arc(px, py, hasIssue ? 13 : active ? 12 : 8, 0, Math.PI*2)
    context.fillStyle = hasIssue ? '#dc2626' : device.kind === '道岔' ? (active ? '#d97706' : '#94a3b8') : device.kind === '信号机' ? (active ? '#16a34a' : '#64748b') : (active ? '#2563eb' : '#cbd5e1'); context.fill(); context.strokeStyle='#fff'; context.lineWidth=3; context.stroke()
    // 道岔画出定位/反位双锚点
    if (device.kind === '道岔' && device.reverseX !== undefined && device.reverseY !== undefined) {
      context.beginPath(); context.arc(device.reverseX*unitX, device.reverseY*unitY, issueNodeSet.value.has(device.id) ? 7 : 5, 0, Math.PI*2)
      context.strokeStyle = device.position === '反位' ? '#d97706' : '#94a3b8'; context.lineWidth = 2; context.stroke()
      context.beginPath(); context.moveTo(px, py); context.lineTo(device.reverseX*unitX, device.reverseY*unitY)
      context.strokeStyle = '#cbd5e1'; context.lineWidth = 1; context.setLineDash([4,3]); context.stroke(); context.setLineDash([])
    }
    context.fillStyle = '#0f172a'; context.font = '600 12px sans-serif'; context.fillText(device.id + (device.needsReview ? '（待复核）' : ''), px+13, py-10)
  })
  context.restore()
}
function hitTest(event: MouseEvent) {
  const rect = canvas.value!.getBoundingClientRect()
  const unitX = rect.width / 100, unitY = rect.height / 100
  let closest: StationDevice | undefined; let distance = Infinity
  store.devices.forEach((device)=>{ const d=Math.hypot(device.x*unitX-event.offsetX, device.y*unitY-event.offsetY); if(d<distance){distance=d;closest=device} })
  if (closest && distance < 20) {
    selectDevice(closest.id)
    store.selectedRouteIds = closest.routeIds.slice(0,1)
  }
}
onMounted(async()=>{ await nextTick(); selectDevice('P-03'); draw(); resizeObserver=new ResizeObserver(draw); resizeObserver.observe(canvas.value!) })
onBeforeUnmount(()=>resizeObserver?.disconnect())
watch(()=>store.selectedCaseId, draw)
watch(()=>store.selectedRouteIds, draw, { deep:true })
watch(() => [store.revision, store.pendingRevisions.length, store.devices, store.routes], draw, { deep:true })
watch(zoom, draw)
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">站场与进路 · 共用拓扑修订 {{store.revision}}</p><h1>Canvas 站场示意</h1><p>设备坐标或道岔位置变更后只重算相关进路和锚点；断开、环路、重复锚点会停在待处理并标出节点。</p></div><n-space><n-button @click="zoomOut">缩小</n-button><span>{{Math.round(zoom*100)}}%</span><n-button @click="zoomIn">放大</n-button></n-space></section>
  <n-alert :type="store.hasBlockingPending ? 'error' : store.hasReviewWarnings ? 'warning' : 'success'" :title="store.topologyNotice" class="topo-alert" />
  <div class="station-grid"><article class="card canvas-card"><div class="canvas-head"><span>海州站 · 计算机联锁平面示意（修订 {{store.revision}}）</span><span>红圈：待处理 / 待复核节点 · 虚线：道岔反位锚点</span></div><canvas ref="canvas" class="station-canvas" @click="hitTest" /></article>
    <aside class="card">
      <div class="panel-head"><div><h2>拓扑修订提交</h2><p>基于修订 {{baseRevision}} · {{author}}</p></div><n-tag type="info">现行 {{store.revision}}</n-tag></div>
      <n-form label-placement="left" :show-feedback="false" size="small">
        <n-form-item label="制图员"><n-input v-model:value="author" /></n-form-item>
        <n-form-item label="基线修订"><n-input-number v-model:value="baseRevision" :min="1" style="width:100%" /></n-form-item>
        <n-form-item label="设备"><n-select :value="selectedDeviceId" :options="store.devices.map((device)=>({label:`${device.id} ${device.name}${device.needsReview?'（待复核）':''}`,value:device.id}))" @update:value="selectDevice" /></n-form-item>
        <n-form-item label="坐标 X/Y"><n-input-number v-model:value="editX" :min="0" :max="100" /><n-input-number v-model:value="editY" :min="0" :max="100" style="margin-left:8px" /></n-form-item>
        <template v-if="selectedDevice?.kind === '道岔'">
          <n-form-item label="道岔位置"><n-radio-group v-model:value="editPosition"><n-radio value="定位">定位</n-radio><n-radio value="反位">反位</n-radio></n-radio-group></n-form-item>
          <n-form-item label="反位锚点"><n-input-number v-model:value="editReverseX" :min="0" :max="100" /><n-input-number v-model:value="editReverseY" :min="0" :max="100" style="margin-left:8px" /></n-form-item>
        </template>
      </n-form>
      <n-button type="primary" block @click="submit">提交拓扑修订（只重算相关进路）</n-button>

      <n-divider>场景模拟</n-divider>
      <div class="sim-row"><n-button size="small" @click="simulateConcurrent">两个制图员同时提交</n-button><n-button size="small" @click="simulateBreak">提交断开坐标</n-button></div>
      <div class="sim-row"><n-button size="small" @click="simulateDuplicateAnchor">重复锚点提交</n-button><n-button size="small" @click="simulateOffline">离线回传逐设备合并</n-button></div>
      <div class="sim-row"><n-button size="small" @click="simulateLegacyRestore">恢复旧版站场备份</n-button><n-button size="small" type="warning" @click="armWriteFailure">下次写入失败</n-button></div>

      <n-divider>进路关系</n-divider>
      <button v-for="route in store.routes" :key="route.id" class="route-row" :class="{active:store.selectedRouteIds.includes(route.id)}" @click="store.selectedRouteIds=[route.id]"><i :style="{background:route.color}"></i><div><b>{{route.id}} · {{route.name}}</b><small>{{route.devices.join(' → ')}}</small><small>锚点修订 {{route.anchorRevision}}</small></div></button>
    </aside></div>

  <div class="grid-2" style="margin-top:16px">
    <article class="card">
      <div class="panel-head"><div><h2>待处理修订</h2><p>校验未通过的提交停在这里，现场仍用旧修订，节点已指出</p></div><n-tag :type="pending ? 'error' : 'success'">{{pending ? '待处理' : '无阻断'}}</n-tag></div>
      <n-empty v-if="!pending" description="当前没有断开、环路或重复锚点" />
      <div v-else class="pending-box">
        <p><b>修订 {{pending.revision}}</b> · {{pending.author}} · {{pending.at}}</p>
        <p>{{pending.message}}</p>
        <n-alert v-for="(issue,index) in pending.issues" :key="index" :type="issueTypeTag(issue)" class="issue">
          <b>{{issue.type}} · 节点 {{issue.nodeIds.join('、')}}</b>
          <div>{{issue.message}}</div>
        </n-alert>
        <n-space style="margin-top:10px"><n-button size="small" type="primary" @click="resubmit">装回保留的现场坐标并重提</n-button><n-button size="small" @click="discard">放弃该修订</n-button></n-space>
      </div>
    </article>
    <article class="card">
      <div class="panel-head"><div><h2>修订历史与并发裁决</h2><p>先到版本生效，后到内容保留现场坐标与差异</p></div></div>
      <n-timeline>
        <n-timeline-item v-for="entry in store.history.slice(0,6)" :key="entry.revision + entry.author + entry.at" :type="entry.status==='已生效'?'success':entry.status==='待处理'?'error':'warning'" :title="`修订 ${entry.revision} · ${entry.status} · ${entry.source}`" :content="`${entry.author} ${entry.at}\n${entry.message}${entry.changes.length ? '\n差异：' + entry.changes.map(c=>`${c.label} ${c.from}→${c.to}`).join('；') : ''}`" />
      </n-timeline>
      <n-divider />
      <h3>写入恢复记录</h3>
      <n-empty v-if="!store.recoveries.length" description="暂无写入失败" />
      <n-alert v-for="(item,index) in store.recoveries" :key="index" type="warning" class="issue" :title="item" />
    </article>
  </div>
</template>
