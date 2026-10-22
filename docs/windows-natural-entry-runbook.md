# Windows 自然入口测试模式（仅测试工具）

本模式补验“自然语言请求 → 模型发现应用 → 模型申请控制 → 独立测试驱动模拟 owner 允许一次 → 模型观察与点击”。它复用当前 Harness 的真实账户、默认模型、SDK 根 Agent 和原 live owner browserPeer。生产电脑工具、权限协调器、owner 鉴权和原生程序均不因该模式改变。

准备器默认保持旧四工具、三任务流程。必须同时显式提供 `--test-only-auto-run --test-only-natural-entry --test-only-once` 才开启本模式；只打开其中部分、与 `--test-only-probe-only` 混用，或 manifest/config 不一致，都拒绝。运行仍受 fresh runId、20 分钟私有一次性能力、官方 CLI/HMR ACTIVE 回执以及既有配对与源码冻结约束。

三任务协议保持不变。仅任务 1 发布生产 `discover`、`request_control`、`status`、`observe`、`act`、`pause` 六工具，模型请求、steps 与总时限仍分别不超过 12、12、180 秒。任务 2/3 继续原四工具和固定目标流程，不能声称它们也覆盖了自然授权入口。

任务 1 先为精确自有 SID 连接固定 fixture 远端环境，不执行 owner `start`。自然 prompt 只包含实际安全应用名与业务目标，不提供 candidateId、targetId、nonce、坐标或工具调用顺序。SDK 必须确认该 Agent 是 `agents.get(id)` 的同一对象且属于 `roots()`；仅对其自身 session 读取 approval override/default，按生产规则只有明确 `never` 禁止新申请。缺省记录为 `absent-default`，不改全局或任何 session policy；读取抛错或身份变化则失败。

生产 discover 必须返回唯一、未授权、未过期候选。生产 request_control 生成同 SID 的真实 pending 请求。独立测试驱动只能读取本轮 SID/appId/requestId/version，先核验 guest 的 observe/preview/lease/act 调用均为零及原 C# 桌面审计通过，再经同一原 owner 的生产 `decide` RPC 提交一次 `once`。模型没有 decide 工具；测试驱动不能发 `always`、写 allowlist、对任务1发 `start/resume`，也不能对未知应用授权。授权发出前即消耗该次机会，异常或未知结果不重发。

授权 ACK、allowedApps 未变化及精确 target 通过后，才将真实 request_control 结果交还模型。之后使用原生产 observe/act、最新 frameId、随机视觉 nonce 和独立业务 oracle。预授权审计失败、用户拒绝、候选过期、默认 policy 明确 never、未知 RPC 结果或预算耗尽均保持失败，按已有精确自有身份清理，不能补发 prompt 或重放输入。

报告明确记录 `ownerOnceDriver="独立测试驱动模拟owner允许一次"`、`humanClickProven=false`、`naturalEntryTaskIds=[1]`。这项 RPC 测试不证明真实人工点击、卡片像素或锁屏下 UI 可用；相应视觉验收应待合法 renderer/解锁界面可用时另做。

准备器将 guard/core/owner adapter 的静态依赖、新纯测试和本说明放入 source snapshot；Windows guest 的新计数与预授权审计代码由既有 carrier 静态闭包冻结。原生 PE、fixture PE 和 C# audit 只读核哈希，不因该模式重编。保持原三任务 natural cleanup、release ACK、严格进程/计划任务身份、held/lease/journal 审计、官方单次卸载与 Fiber DISPOSED 证据。

当前验证为 Node 纯回归：新增自然入口及原 host-autorun/terminal 联合24项通过；所有 `computer-live-vision-*` 与新增自然入口联合110项通过，零失败、零跳过。独立审查发现未授权收尾仍可能截图，已改为明确批准前 capture/write 零调用并增加实际helper spy负例；原退出审计断言限定在retire阶段，预授权只读审计不能误作退出后审计。`node --check`通过。测试使用离线模型/owner 替身，并直接加载实际 runner 的 JavaScript 函数验证调度；没有构建、安装、Host 激活、PD、真实模型请求或输入。实际 bundle/import smoke、完整回归及真实三任务须由主任务取得独占槽后串行执行，使用全新冻结目录和能力。

本次还为新诊断快照补入公开 `STALE_OBSERVATION` 错误码，纯回归保证原 Error 继续抛出且敏感 message 不进入投影。旧 c8-4 原始报告及其 `unclassified` 记录不改写。

自然入口 `natural-c8-2` 的实际启动失败记录保留：官方 CLI add 退出 0，但 Host 回执为 `host-activation-failed=VISION_AUTORUN_MANIFEST`、`consumed=false`，模型请求、fixture 和输入均为 0。已核实原因是 test-only `visionBundlePatch` 显式字段白名单未包含 `testOnlyNaturalEntry/testOnlyOwnerOnce`，使 `plugin-config.json` 中的两个 true 未进入实际包内 `cordis.patch.yml`，Host 正确拒绝不一致配置。这不是模型或业务动作失败，也不是自然入口通过。载体已按零任务正常取消路径收尾；原临时包的精确核验与官方卸载由主任务处理，不因本次源码修复推定已经卸载。

本次修复只扩大测试序列化白名单中的这两个已定义字段，并拒绝 unknown field、缺失 autorun 元数据、单边 natural/once 或与 probe 冲突的配置。Windows 准备器对将写入包内的精确 JSON 做往返解析，并逐层严格比较完整 config，仅忽略对象键顺序；漏字段、多字段、类型改变或 JSON 丢失 undefined 都在归档前失败。新增纯回归实际调用 `visionBundlePatch`，再模拟上述真实漏字段，覆盖自然模式、legacy、probe 与 future unknown field；不能用手写 patch 掩盖序列化缺口。旧 outside 失败回执不改写，新包须使用全新冻结目录与 runId。

序列化修复后的自然入口、host-autorun 与 terminal 纯 Node 联合回归为 27 项通过、零失败、零跳过；日志保存于 `/private/tmp/qiuya-natural-entry-serializer-pure-tests.txt`。本次修复未重新构建、安装、启动 Host/PD、发送模型请求或输入；新包激活和业务结果仍待后续独立回执。

序列化修复后，所有 `computer-live-vision-*` 与自然入口联合113项回归通过，零失败／取消／跳过；这是新修复快照，旧110项与失败轮原结果仍保留。

后续实际c8-3已完成：任务1自然六工具通过，任务3通过，但任务2因两次STALE及重复完整点击耗尽12请求，整轮failed，业务成功不能覆盖预算失败。当前生产帧指导已构建打包，完整976项回归通过；新包后c8-4官方add退出0但未取得Host激活回执，模型／fixture／输入均零，载体正常取消及临时包磁盘移除完成，运行时退休未确认。个人正常退出被自动审批拒绝，尚未重启；详情及新包指纹见[增量验收](computer-frame-guidance-acceptance.md)。本说明前述未运行状态仅指各历史快照，不能覆盖后续实际结果。

用户确认无运行任务并授权正常重开后，自然c8-5已完成真实DeepSeek三任务，SDK请求携带新metadata，23次请求尝试／5次成功act且无工具错误或重复动作；官方安装／移除、Host patch退休及Windows自然清理与原设置／连接恢复通过。任务1自然发现／申请与独立测试驱动模拟owner允许一次，任务2／3固定目标；真人授权UI未计为已验，默认模型未修改。详见[新候选视觉与模型验收](current-candidate-visual-and-model-acceptance.md)。旧失败与本说明各阶段的未运行状态保留原时点。
