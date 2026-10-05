<script setup lang="ts">
import { computed } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const casesReady = computed(() => store.cases.every((item) => item.status === '通过'))
const ready = computed(() => casesReady.value && !store.hasBlockingPending)
function exportPackage() {
  const report = {
    station:'海州站 CS',
    version:'v26.10',
    topologyRevision: store.revision,
    locked:store.baselineLocked,
    // 发布报告保留拓扑快照：基线锁定时冻结的设备锚点与进路节点
    topologySnapshot: store.topologySnapshot,
    cases:store.cases.map((item)=>({id:item.id,name:item.name,status:item.status,topologyRevision:item.topologyRevision,steps:item.steps.length,failureReason:item.failureReason})),
    executions:store.executions.map((item)=>({...item})),
    generatedAt:new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(report,null,2)],{type:'application/json'})
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download=`联锁测试报告-v26.10-修订${store.revision}.json`; link.click(); URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">发布门禁与历史基线 · 拓扑修订 {{store.revision}}</p><h1>基线锁定与测试报告</h1><p>全部未通过、阻塞和证据缺失项闭环后才能锁定；发布报告保留锁定时的完整拓扑快照。</p></div><n-space><n-button @click="exportPackage">导出测试报告（含拓扑快照）</n-button><n-button type="primary" :disabled="!ready || store.baselineLocked" @click="store.lockBaseline">锁定发布基线</n-button></n-space></section>
  <n-alert v-if="store.hasBlockingPending" type="error" title="存在待处理拓扑修订，禁止发布" :description="store.topologyNotice" style="margin-bottom:16px" />
  <n-alert :type="ready ? 'success' : 'error'" :title="ready ? '全部用例已通过，可锁定' : '发布门禁未通过'" :description="ready ? '设备锚点、进路节点、执行证据和失败闭环均完整。' : '存在失败、阻塞、未执行步骤或待处理拓扑修订，任何人员不得无痕跳过。'" style="margin-bottom:16px" />
  <div class="grid-2"><article class="card"><div class="panel-head"><div><h2>发布门禁清单</h2><p>自动判断，不允许人工绕过</p></div><n-tag :type="ready?'success':'error'">{{ready?'可发布':'阻断'}}</n-tag></div><div v-for="item in store.cases" :key="item.id" class="gate"><div><b>{{item.id}} · {{item.name}}</b><small>{{item.failureReason || '执行记录完整'}} · 修订{{item.topologyRevision}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':'warning'">{{item.status}}</n-tag></div></article>
    <article class="card"><div class="panel-head"><div><h2>差异与影响范围</h2><p>v26.09 → v26.10 · 修订 {{store.revision}}</p></div><n-tag>{{store.changedDevices.length}} 项设备变更</n-tag></div>
      <div v-if="!store.changedDevices.length" class="diff"><b>暂无已生效拓扑修订</b><p>设备坐标或道岔位置提交并通过校验后，这里会列出修订差异。</p></div>
      <div v-for="change in store.changedDevices" :key="change" class="diff"><b>{{change}}</b><p>沿“设备 → 进路 → 用例”影响 {{store.affectedCases.length}} 条用例，相关进路锚点已按修订重算。</p></div>
      <n-divider /><h3>基线拓扑快照</h3>
      <n-result :status="store.baselineLocked ? 'success' : 'info'" :title="store.baselineLocked ? `修订 ${store.topologySnapshot?.revision} 已锁定` : '等待全部用例通过且无待处理修订'" :description="store.baselineLocked ? `快照冻结于 ${store.topologySnapshot?.fixedAt}，含 ${store.topologySnapshot?.devices.length} 台设备、${store.topologySnapshot?.routes.length} 条进路节点链，随报告导出不可再改。` : '锁定后生成只读拓扑快照，发布报告与现场各看同一版坐标。'" />
    </article></div>
</template>
