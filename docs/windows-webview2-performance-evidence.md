# Windows 当前 PE 的 WebView2 性能验收

本页只整理 2026-10-22 的原生预览性能、恢复和清理证据。当前 ARM64 `c8be` PE 的 30 分钟、5 次恢复已经实际通过；x64 `3d22` 在保留两轮原始失败后，新冻结载体的 1 分钟、1 次恢复烟测已实际通过，x64 的 30 分钟结果仍须独立取得。不能由 ARM64、旧 PE 或其他功能通过推导为通过。本页不代替逐功能 Harness、真实 DeepSeek、桌面输入或暂停延迟验收。

## 实际版本与测量范围

| 项目 | 本轮绑定 |
| --- | --- |
| 运行环境 | PD 中的 Windows 11 ARM 已登录交互桌面；ARM64 Node 22.23.3。x64 烟测使用 x64 Node／PE 在同一 ARM Windows 兼容运行，不代表物理 x64 机器 |
| ARM64 原生 PE SHA-256 | `c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce` |
| x64 原生 PE SHA-256 | `3d2206f3b12e3e26406e60c9b11b7400e89d7cd3373e3b569e3331e4f5f7ce58` |
| 生产 Host 测试 bundle SHA-256 | `e2b495d708f8153c932d19d0bc757a671face59ee82009aafbaa51ec5f6bf47d` |
| 实际 renderer | 正式 `qiuya-windows.exe` 的 WinForms WebView2；测试专用 loopback CDP 只观察该原生窗口，没有另开 Edge 替代 renderer |
| 源／捕获 JPEG／canvas backing | 1280 × 720。实际浮窗为 600 × 420，画面可能缩放，不能称为物理 720p 视口 |
| 输入负载 | 动画源持续捕获、传输、绘制；无滚动／拖动输入负载，不证明持键／拖动时的停止延迟 |
| 调试范围 | 仅本次可丢弃测试进程及其 UUID WebView2 数据目录启用调试；不修改生产启动参数、注册表、用户浏览器 profile 或防火墙 |

帧数来自独立解码生产 canvas 在完成 draw 后的 32 位源 epoch-ms 时钟。重复时钟不计为新帧；超过 10 秒的旧／未来时间戳算 invalid。完整壁钟 FPS 保留故障恢复停顿，没有把恢复时间从分母扣掉。`invalid = 0` 不等于没有丢帧。

本轮沿用完整壁钟及唯一帧 FPS ≥ 10、P95 源到 renderer 延迟 ≤ 500 ms、Node RSS ≤ 512 MiB、完整自有树 RSS ≤ 1.5 GiB、最多 1 个直接 native worker／4 个 native 树进程等既定门槛，没有因本轮结果修改阈值。

## ARM64：30 分钟／5 次恢复通过

实际目录：[/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-arm64-long-29556578-b6e5-4832-a47e-14adb3c50028](/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-arm64-long-29556578-b6e5-4832-a47e-14adb3c50028)。以下数字直接取该目录 `report.json`；runner、delivery、外层退出均有独立回执。

| 指标 | 实际结果 |
| --- | --- |
| 测量壁钟 | 1,800,038 ms |
| 有效新帧 | 24,656 |
| 完整壁钟 FPS | 13.6974886086 |
| 唯一帧 FPS | 13.6974733426 |
| 延迟 P95 | 44 ms |
| invalid 时间戳／错误尺寸 | 0／0 |
| 最大帧间隔 | 12,171 ms，包含恢复停顿；P95 不能代替此项 |
| 排除的热身帧 | 6；热身帧不计新帧，恢复停顿仍留在测量壁钟 |
| 故障恢复 | 5 次，产生 6 代 renderer；5 次旧代均确认退役，输入状态均为 `paused` |
| 资源样本 | 61 个；`resourcesBounded: true` |
| Node RSS 采样最高 | 91,631,616 B，约 87.39 MiB，低于 536,870,912 B 上限 |
| 完整自有树 RSS 采样最高 | 1,490,374,656 B，约 1.388 GiB，低于 1,610,612,736 B 上限 |
| 直接 native worker／native 树进程最高 | 1／3，低于或等于既定 1／4 上限 |
| 附件写入观测 | 0；这是 Host attachment service spy，不是实际 SDK 数据库写计数 |

五次故障在测试相对时刻 309,254／609,231／913,535／1,212,839／1,508,827 ms 注入。类型均为：对精确自有 native parent 注入终止，确认旧预览销毁和旧代退役，显式重新打开新预览并重新连接 CDP。六次启动的 native SHA 均为上述 `c8be`。这里的故障注入终止与结束清理是两种动作；通过要求没有借助结束时的强制兜底来清退残留。

资源归属依据同一快照中的 PID＋birth、后代出生顺序、精确 UUID helper 路径及 UUID WebView2 数据目录；保留旧代 PID＋birth，使已失去父进程的自有 worker 仍计入范围。采样 PowerShell／conhost 也保留在归属内，没有为降低数字删去。采样之间的瞬时峰值未测量，30 分钟通过不能解释为无限运行无泄漏。

## 退出、精确清退与环境恢复

本轮 `delivery-verdict.json` 为 `status: passed`、`runnerStatus: passed`、`exitCode: 0`、`naturalCleanupPassed: true`；`launcher-completed.json` 记录重定向输出复制完成及 launcher 退出 0。

- `cleanup-verification.json`：跟踪 289 个进程身份，旧代 retirement 验证通过，`naturallyRemaining`／`remaining` 均为空。另有 1 个当前 runner 自有的直接系统 console 基础设施，明确推迟到 runner 退出后核验。
- `post-run-cleanup-verification.json`：runner 退出后检查 290 个身份，`remaining: []`、`passed: true`。
- `task-natural-exit.json`：计划任务正常进入 `Ready`，结果 0，action 与交互主体匹配。冻结载体先核对精确 task action／principal，再等 `Ready`，随后注销并检查该 task 已不存在；不发送 `Stop-ScheduledTask`。
- `outer-cleanup-verdict.json`：`naturallyClean: true`、`forcedRequired: false`、`errors: []`、`remaining: []`，没有强制清理分支结果。
- `end-audit.json`：外层 orchestrator 退出 0、`signal: null`、原 `pause-idle` 已恢复。实际开始记录为 UTC 12:29:36，性能报告结束 UTC 12:59:45，外层清退与 idle 恢复结束 UTC 13:00:18。

因此本轮同时具备业务性能报告、runner／launcher 退出、独立进程清退、计划任务自然退出及外层环境恢复，不能只凭 `report.cleanup.passed` 或 launcher 返回就代替这些证据。

## x64：保留失败，不计为长稳通过

实际失败目录：[/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-smoke-6215e949-5492-4598-9581-7c2385e39c29](/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-smoke-6215e949-5492-4598-9581-7c2385e39c29)。这份证据是 `3d22` 的 1 分钟／1 次恢复烟测，不是 30 分钟验收。

该轮取得 692 帧／60,027 ms，完整壁钟 11.5281 FPS、P95 39 ms、invalid／错误尺寸均为 0，1 次恢复旧代退役成功；但 `resourcesBounded: false`，完整自有树 RSS 采样最高 **1,656,238,080 B > 1,610,612,736 B**。所以 `report.status`、`delivery.status` 为 `failed`，外层 orchestrator 退出 1。

该轮自然清退、Task `Ready`／结果 0、无强制兜底、idle 恢复均有通过回执。这些清理通过不会将性能失败变绿。资源超限的具体原因仍需独立诊断；这里不把它直接归因为内存泄漏，也不假定是采样误归属。修复后必须按新冻结输入另跑 smoke，再取得独立长稳证据，不能覆盖这份原始失败记录。

## 证据索引与复核

ARM64 冻结准备目录是 [`artifacts/computer-use/windows-webview2-c8be-prepared-v2`](../artifacts/computer-use/windows-webview2-c8be-prepared-v2)，`prepared.json` 记录 source closure、静态 import 检查、native 与 runtime 字节；实际环境与各次 native SHA 另存于外部 `environment.json`／`report.json`，不以准备成功代替实跑。

| ARM64 外部证据文件 | SHA-256 |
| --- | --- |
| `report.json` | `f67726e9b2a6838d5a92736dbba395c7a2710a35f9c5b85c58be9b9bfa911ddc` |
| `delivery-verdict.json` | `2f59065d5f0db333551939e5ce56463b1d2628ec1a38eb14ac80e8c0644ffe15` |
| `environment.json` | `dbc02a4c39bbad1e21578099f0bfae627c3b499aad882a5dcf25c87b2be7069f` |
| `outer-cleanup-verdict.json` | `196c9f4c19a0b8f762ec42ab08e5964d53130920a529d2850bb0654bc9c44524` |
| `post-run-cleanup-verification.json` | `ff877a939a8402d387399e25f74c25ebb642f0fdb1a5749d63f2f5fa4fd6b372` |
| `end-audit.json` | `efd690c1b01a86256a5c45a84484cd1a6cc02b22af6ff07f6a3bd9c85385f6b2` |

逐帧时钟保存在 `frame-clock.json`，故障过程保存在 `fault-trace.json`；完整资源与进程身份仍留在外部原始 JSON，本页只列有限汇总，不复制大数组进入 Git。`source-initial.jpg` 和 `native-webview2-page.png` 也保留在项目外原目录。

旧 `42889` PE 的 30 分钟／5 次恢复与旧输入暂停延迟报告仅是各自历史版本的证据，不继承给当前 `c8be`／`3d22`。本页新增的是当前 `c8be` 的独立 30 分钟结果；当前 x64 的此份失败仍保留，真实 Harness 集成和真实模型结论继续由各自专项报告负责。

## x64 原失败的有限归因与新采集器准备

对原失败的三个资源样本按 PID 分组复核，没有发现重复 PID、旧 native 代或旧 WebView2 代被重复相加。峰值 1,656,238,080 B 比原 1,610,612,736 B 门槛高 45,625,344 B，约 43.51 MiB；同一峰值样本的角色 RSS 为：

| 原样本角色 | 进程数 | 实际 RSS |
| --- | ---: | ---: |
| WebView2 | 6 | 715,816,960 B |
| native helper 树 | 3 | 489,816,064 B |
| PowerShell（fixture＋采集器） | 2 | 283,303,936 B |
| console | 6 | 58,347,520 B |
| Node | 1 | 108,953,600 B |

其中本次短命 PowerShell 采集器本身为 136,237,056 B。它原本就在完整自有树内，不能从旧样本减掉以重判通过；private bytes 也不能替换 RSS 门槛。三个样本、约一分钟的结果不足以推断长期泄漏。

新测试载体仅将每次新开的 PowerShell 进程采集器替换为短命 C# 只读程序。它仍查询相同的 `Win32_Process` 字段，先固定 `Process.SafeHandle`，再用完整 100 ns `StartTime` 与 CIM 微秒 `CreationDate` 相互核验；仍然存活但无法核验的行保留为 `unavailable`，自有进程若无法确认身份必须失败。命令行只用于匹配本轮 UUID，输出不含命令行正文。Node 每次运行前核验程序 SHA，要求真实子进程退出 0、无 signal／强制终止，并要求快照内包含采集器自身同 PID／parent／路径的完整身份；该行与 console、PowerShell、native、WebView2 仍共同计入完整自有树。原 20 秒／8 MiB 采集边界、1.5 GiB 完整树门槛、帧与恢复负载及正式 `3d22` PE 均未改变。

冻结准备目录为 `artifacts/computer-use/windows-webview2-3d22-csharp-collector-prepared-1`，`prepared.json` SHA 为 `c6f5d5861fa4e37238cd62039550151af9c794322580d97979920ffde8b108d5`。该目录包含完整静态 import 闭包、采集器 C# 源和模块哈希；Windows Framework 编译发生在 guest 测量开始前，编译结果由 `collector-build.json` 另行记录。每次调用的正常退出与自身计入证据写入 `collector-audit.json`；有限 `gateEvidence` 只解释原有门槛，不改变原 `status` 表达式。

本地针对性检查共 **19／19 通过**，包括 C#5 核心实际编译运行的 13 条纯检查（含 PID 0 哨兵与非零 PID 缺出生时间的失败边界）、Node 对 schema／身份／SHA 篡改／非正常退出／实际超时的负例、原所有权与像素时钟回归，以及 fresh x64 prepare 的静态闭包和运行前篡改拒绝。这里的 C# 核心使用 Mac 上的 .NET 8，仅证明核心纯逻辑；它没有执行 WMI，不能替代 Windows Framework 实编译及新的 smoke／长稳实测。新的准备成功不会修改或覆盖上述旧 x64 失败结论。

静态边界复核另外确认：原 PowerShell 和首版 C# 都会跳过空 `CreationDate`；当前 C# 仅允许 PID 0 系统 Idle 哨兵跳过，任何非零 PID 缺 CIM birth 立即让整个采样失败，避免未知存活 owner 从 RSS 消失。此项是测试证据的保守收口，正式 native PE／资源门槛不变。新冻结目录为 `artifacts/computer-use/windows-webview2-3d22-csharp-collector-prepared-2`，旧 prepared-1 及其所有实际报告保留。

## x64 新冻结版本：一分钟／一次恢复烟测实际通过

实际目录：[/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-smoke-ce274de1-13be-4c81-b0a8-cf12aed461e4](/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-smoke-ce274de1-13be-4c81-b0a8-cf12aed461e4)。这里是 x64 Node 与正式 `3d22` PE 在 PD Windows 11 ARM 兼容环境中的真实 WinForms WebView2；同样不是物理 x64 机器，也不是另开 Edge 替代原生预览。

本轮冻结目录为 `windows-webview2-3d22-csharp-collector-prepared-2`，manifest SHA 为 `d1555c6a6376b4cfcce12616fe112653aa07d314746791514150d98dfccaa0ca`，entry SHA 为 `5bd4cfb744aa7caeda469be99e35a2b1baf2808badc89b0b0ce199ba7dc59735`。正式 native PE 仍为 `3d2206f3b12e3e26406e60c9b11b7400e89d7cd3373e3b569e3331e4f5f7ce58`，生产 Host bundle 仍为 `e2b495d708f8153c932d19d0bc757a671face59ee82009aafbaa51ec5f6bf47d`。

Windows Framework 在测量前实际编译采集器成功：C# 源 SHA `13f0e5da40fa8201c887e308bdfd03b8d8cc96b9809608230b3b92b09579ad41`，生成 9,216 B EXE，SHA `19937a6d81ec4210e40e0b38f70a4ce03b88df64c1de815a259f7e61024a2209`。19 次真实 CIM／固定 native 身份采集均退出 0、无 signal／强制终止，并确认自身身份与自身计入，单次耗时 462–980 ms。这层证据与前述 Mac .NET 纯检查分别记录，不能相互替代。

| 烟测指标 | 实际结果 |
| --- | --- |
| `report.status`／有限失败门 | `passed`／`failedGates: []` |
| 测量壁钟／有效新帧 | 60,079 ms／726 |
| 完整壁钟 FPS／唯一帧 FPS | 12.0840892824／12.0772946860 |
| 源到 renderer 延迟 P95 | 42 ms |
| invalid／错误尺寸 | 0／0 |
| 最大断帧 | 9,122 ms，恢复停顿完整计入壁钟 |
| 热身排除／旧代通知排除 | 6／10 |
| 故障恢复 | 1 次，旧代已退役，两代分别取得 464／262 帧，恢复后的输入状态为 `paused` |
| Node RSS 最高 | 111,947,776 B < 536,870,912 B |
| 完整自有树 RSS 最高 | 1,567,047,680 B < 1,610,612,736 B，`resourcesBounded: true` |
| 直接 native worker／native 树进程最高 | 1／3，原上限仍为 1／4 |
| 附件写入观测 | 0，仍是 Host service spy 的测试口径 |

完整自有树峰值的 1,567,047,680 B 由 Node 107,417,600、native 485,335,040、WebView2 728,829,952、C# 采集器自身 42,012,672、PowerShell 145,285,120、console 58,167,296 B 共同组成，没有删除采集器或系统 console 来压低结果。上表单独的 Node RSS 最高来自 Node 自身测量，不要求与 CIM 峰值样本的 Node RSS 相同。

退出与恢复也单独核对：`cleanup` 跟踪 57 个身份、旧代退役验证通过，`naturallyRemaining`／`remaining` 为空；当前 runner 的直接 console 基础设施保留到 runner 退出后检查，独立 `post-run-cleanup-verification.json` 共核对 58 个身份且无残留。`delivery-verdict.json` 与 launcher 均退出 0，输出复制完成；`outer-cleanup-verdict.json` 为正常清退、无强制兜底、`errors: []`、`remaining: []`；精确 Task action／principal 核对后，任务正常进入 `Ready`、结果 0，再自然注销。外层 orchestrator 退出 0、`signal: null`，原 `pause-idle` 已恢复。环境开始记录为 UTC 14:03:56，外层结束记录 UTC 14:05:37.974。

| 本轮外部证据 | SHA-256 |
| --- | --- |
| `report.json` | `29887cb3ddb6209a11fcff5af7f311605016b232f4abce19cd70f28353a9104e` |
| `collector-build.json` | `3d25217edbd2ecc5147024ac558e77766d0aa224c235d19820b511fd843bf84a` |
| `collector-audit.json` | `b0334310e603f256d96e64e22e08ce9d9a7c68d4b985ca0fda954d208cb0a1e2` |
| `delivery-verdict.json` | `935c38a9228d91477c420320ad86eccf1c56b0aba7c92110c6a5feb5671d2604` |
| `post-run-cleanup-verification.json` | `76ac9613bc1a62ed3f551534b3e1e4f9858220e6fea37411b6e2b49ffd35ac05` |
| `end-audit.json` | `2be6f48e6bdbf0c5a9fbfc88d99230a203cd39c64350c0613491d11829ccf273` |

## 原 x64 两轮失败与结论边界继续保留

原 `6215e949` 完整树 RSS 超门的失败仍按原始值保留。首版 C# 载体的后续实际目录 `Windows-WebView2-x64-smoke-752cfe26-8886-46f4-8b67-6e73bd0734de` 也仍为失败：资源已在原门以内，但 571 帧／60,042 ms 的完整壁钟 FPS 9.5100096599、唯一帧 FPS 9.5026924295 低于 10，P95 为 59 ms。最大断帧 16,509 ms，精确跨旧代末帧 35.540 s 至新代首帧 52.049 s；没有把恢复时间从分母扣去。

`752cfe26` 中 kill 标记到旧代全退役为 8.011 s，期间四次采集器合计 3.217 s；旧代退役到新预览重连为 11.950 s，其中只有一次采集器调用、耗时 0.687 s。该轮 17 次采集均自然结束，单次 573–1,352 ms，没有出现采集器超时或异常；这些记录不足以把 16.5 秒空档归因为采集器单次长阻塞，也不能证明恢复慢的原因已单独消除。

新 `ce274de1` 使用了 PID 0／缺 CIM birth 的代码边界修正与新的冻结源，保留了原两轮失败，不把重复运行挑出的绿色覆盖原记录。新烟测通过只证明这次一分钟、一次恢复的全部既定门槛通过；不能据此声明恢复时长永远小于 9.122 秒、x64 已完成 30 分钟长稳或发现并消除了某个唯一根因。x64 30 分钟、五次恢复仍需按同一冻结输入取得独立结果。


## x64 最终补充：30 分钟／五次恢复实际通过

本节追加的是前文烟测之后取得的独立长稳结果；前文“仍需取得 x64 30 分钟结果”保留为当时的历史状态。当前正式 `3d22` PE 已在 **PD Windows 11 ARM 兼容环境，x64 Node 22.23.3／x64 PE／真实 WinForms WebView2** 下通过本次 30 分钟、五次恢复。它不代表物理 x64 机器实测；原资源超限失败、首版 C# 低 FPS 失败和绿色烟测均保持原始结论。

实际目录：[/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-long-ae53268c-3948-4243-8f12-645569757362](/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-long-ae53268c-3948-4243-8f12-645569757362)。本轮沿用 `windows-webview2-3d22-csharp-collector-prepared-2`，manifest／entry SHA 仍分别为 `d1555c6a6376b4cfcce12616fe112653aa07d314746791514150d98dfccaa0ca`／`5bd4cfb744aa7caeda469be99e35a2b1baf2808badc89b0b0ce199ba7dc59735`。独立复核冻结目录 41 个文件与 manifest 一致，实跑环境记录的 runtime、runner、证据模块、采集器、fixture、native 哈希均与冻结输入相符；正式 native PE 仍为 `3d2206f3b12e3e26406e60c9b11b7400e89d7cd3373e3b569e3331e4f5f7ce58`，生产 Host bundle 仍为 `e2b495d708f8153c932d19d0bc757a671face59ee82009aafbaa51ec5f6bf47d`。

| 长稳指标 | 实际结果 |
| --- | --- |
| `report.status`／有限失败门 | `passed`／`failedGates: []` |
| 测量壁钟／有效新帧 | 1,800,094 ms／24,490 |
| 完整壁钟 FPS／唯一帧 FPS | 13.6048450803／13.6051133759 |
| 源到 renderer 延迟 P95 | 45 ms |
| invalid 时间戳／错误尺寸 | 0／0 |
| 最大帧间隔 | 14,155 ms，恢复停顿保留在完整壁钟 |
| 热身排除／旧代通知排除 | 6／9 |
| 故障恢复／renderer 代数 | 5／6；五次旧代退役均确认，恢复后的输入状态均为 `paused` |
| 六代有效帧 | 4,250／4,083／4,126／4,113／4,054／3,864 |
| 资源样本／资源门 | 61／`resourcesBounded: true` |
| Node RSS 采样最高 | 112,955,392 B < 536,870,912 B |
| 完整自有树 RSS 采样最高 | 1,567,682,560 B < 原门槛 1,610,612,736 B，余量 42,930,176 B |
| 直接 native worker／native 树进程最高 | 1／3，原上限仍为 1／4 |
| 附件写入观测 | 0，仍为 Host attachment service spy 口径 |

从 `frame-clock.json` 的 24,490 条记录独立重算了壁钟、唯一帧 FPS、P95、最大帧间隔与各代帧数，均与 `report.json` 一致；源时钟无重复，render 时间均位于测量区间。61 个资源样本逐样本按 PID 检查没有重复相加；峰值发生在相对 30,813 ms，由 Node 106,360,832、native 479,784,960、WebView2 740,876,288、C# 采集器自身 42,057,728、PowerShell 145,723,392、console 52,879,360 B 共同组成。单独列出的 Node RSS 最高来自 Node 自测，与同一峰值快照的 Node RSS 口径不同。所有这些仍是离散采样，不能推断瞬时峰值或无限运行无泄漏。

Windows Framework 在测量前实编译同一 C# 源，源 SHA 为 `13f0e5da40fa8201c887e308bdfd03b8d8cc96b9809608230b3b92b09579ad41`，本轮 9,216 B EXE SHA 为 `f429c2498e881c7628112306512d7a19e3564338ae28585c9a389b796caa48a1`。`collector-audit.json` 的 **107 次**真实采集全部退出 0、`signal: null`、`killed: false`、`naturalExit: true`、`selfIncluded: true`，且每次 SHA 一致；单次 446–1,684 ms，仍沿用 20 秒／8 MiB 边界。此处是本轮 Windows CIM／固定 native 身份的实跑证据，前文 19 条针对性检查和 13 条 Mac .NET 核心纯逻辑检查仍仅是各自历史验证，不将其改写为新增测试或物理 x64 证据。

五次故障均为精确自有 native parent 的受控终止、旧预览销毁、旧代全退役、显式重开新预览及 CDP 重连。`fault-trace.json` 的有意终止标记在相对 **301,471／601,193／901,474／1,201,122／1,502,402 ms**；恢复完成标记在 **311,967／611,490／911,235／1,211,583／1,518,095 ms**。后者对应 `report.faults[].at`，不能误称为注入时刻。六次实际启动的 PE SHA 均为上述 `3d22`。受控故障注入与下面的最终自然清退是两种动作，“结束无强制兜底”不表示本轮没有有意注入终止。

退出与恢复回执也分别核对：

- `cleanup-verification.json` 跟踪 281 个身份，旧代 retirement 验证通过，`naturallyRemaining`／`remaining` 均为空。另 1 个当前 runner 直接系统 console 延后到 runner 退出后核验；`post-run-cleanup-verification.json` 共检查 282 个身份，`remaining: []`、`passed: true`。
- `delivery-verdict.json` 为 `status: passed`、`runnerStatus: passed`、`exitCode: 0`、`naturalCleanupPassed: true`；launcher 退出 0，stdout／stderr 复制均完成。
- `task-natural-exit.json` 为精确 task action／principal 匹配、`Ready`、结果 0。冻结 orchestrator 先等待自然进入 `Ready`，再注销并检查任务不存在；该路径不发送 `Stop-ScheduledTask`。
- `outer-cleanup-verdict.json` 为 `naturallyClean: true`、`forcedRequired: false`、`errors: []`、`remaining: []`；只读 `before.terminate: false`，`forced`／`after` 均为 `null`，没有执行最终强制兜底。
- 内层 `end-audit.json` 为 orchestrator 退出 0、`signal: null`、`pauseIdleRestored: true`，结束 UTC 14:51:19.860。独立外层环境恢复回执 [`Windows-WebView2-x64-long-resume-40acf498-5f56-4155-8d3a-63923ac09905.json`](/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-WebView2-x64-long-resume-40acf498-5f56-4155-8d3a-63923ac09905.json) 另记原 `pause-idle: on`、VM 原状态 `paused`、子进程退出 0／无 signal、`restored: true`；外层开始 UTC 14:20:23.293，恢复完成 UTC 14:51:20.008。内层 launch 所见临时 `pause-idle: off` 不应被误写为外层原设置。

本轮 `input: false`，只持续执行动画源捕获、传输和绘制；`captureOnlyInputReleased: true` 与恢复后 `paused` 只支持该捕获测试的状态断言。**没有滚动／拖动／持键负载，也没有持键停止延迟实测**。真实 Harness SDK／模型及逐功能桌面输入仍由专项证据负责，本次长稳通过不会补齐这些验收。

| 本轮长稳外部证据 | SHA-256 |
| --- | --- |
| `report.json` | `c56a950dfcc415716372b0236b00df4fd74ad8ce9858d7414e1805b80952c5f7` |
| `frame-clock.json` | `55a19e04348feeb26bff81a141662faf2527828e717b8b73f88d69d70f56617a` |
| `fault-trace.json` | `82d425acb4e0b84e76c2ce52d574a739478bf3302d9d74047e2a86394c90bf53` |
| `collector-build.json` | `bbb62f906a2c3e25a6ff1b32f5e372eee866df7f4f015613ae4a04c95c507b61` |
| `collector-audit.json` | `95760765afcd433623dd784e7dfb91d3f9136d87df2a3bdd1cfcf645f92675ec` |
| `environment.json` | `22dfbf98a582378ba802b06c7cbb91cc7365886680b552a861a518a03a73aa13` |
| `cleanup-verification.json` | `0e8ccfa4a89091b0fc274a4f4fed53a404f2199b11dcedd4db80bc6602c17d6a` |
| `delivery-verdict.json` | `935c38a9228d91477c420320ad86eccf1c56b0aba7c92110c6a5feb5671d2604` |
| `launcher-completed.json` | `cb89df7811bf1a3a5d95a42f1ad613e991bbc2c1ca6097bc3f160e2636c20861` |
| `post-run-cleanup-verification.json` | `b5be2335feb1c42019074a2ea98c67fefdc09209fad96ed1f12ebc2447cb3fc8` |
| `task-natural-exit.json` | `fcc5c1fd013f5a8ec767ffb28843a6b25f3c470a70fa1baede43a6e1a4c4dc3a` |
| `outer-cleanup-verdict.json` | `196c9f4c19a0b8f762ec42ab08e5964d53130920a529d2850bb0654bc9c44524` |
| `end-audit.json` | `5b31362e79ecb98b8e7181903e73ae0612bcc0f6d26906a8a0976026e5a70af9` |
| `Windows-WebView2-x64-long-resume-40acf498-5f56-4155-8d3a-63923ac09905.json` | `0f976338689cd3159a036d7df2de7764d611c97879382f9a694bfd511bca2787` |

原始逐帧、资源、进程身份和截图继续保存在上述项目外目录；本页只新增有限汇总与哈希，不把原始大数组或截图加入 Git。

提交前对当前采集器与预览耐久工具再次执行16项相关Node回归，零失败／跳过；其中包含实际.NET核心矩阵编译运行。日志与源码SHA回执为 `artifacts/computer-use/windows-webview2-collector-final/86dc6137-67fc-443e-9758-de641db497cd/report.json`。该回归不代替上述PD长测；正式产品PE没有因采样器调整而重编。
