# Windows Harness 流水线与失败清理验收记录

记录日期：2026-10-22。此文只记录 Windows 完整 Harness UI 链路及其隔离诊断，不能替代真实 DeepSeek、Mac 验收或最终可安装包交付。正式 ARM64 PE 为 `c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce`，x64 PE 为 `3d2206f3b12e3e26406e60c9b11b7400e89d7cd3373e3b569e3331e4f5f7ce58`；实测环境为 Parallels Windows 11 ARM，x64 在该系统兼容运行。

## 正式包已有失败，原始记录保留

`windows-final-native-ui-prepared-d2b86a66-0af7-4fdd-aa8d-1c417b3c97f6/runs/`：ARM64 的安装、升级、恢复、回滚、重装 5/5 通过，UI 为 10/12；x64 安装 5/5，UI 为 11/12。ARM64 case9 的外部状态读取先超时，随后真实工具记录了 `NATIVE_TIMEOUT`，case11 又与未退出的主 Agent 重叠。x64 case9 首次 observe 记录 `capture-timeout`。两者不能合并成同一根因，也不能仅延长 UI 等待将其覆盖。

`windows-public-reuse-cleanup-prepared-0324ccce-2537-454c-a5b4-311ebf872908/runs/arm64/`：前六项通过，case7 在寻找独立 Alpha 窗口的原生查询阶段遇到 `NATIVE_TIMEOUT`，未取得目标身份。保存的 target 投影当时只有主窗口；后置只读系统快照才看见 Alpha。旧代码未记录 native 内部最早调用时序，故不能断定是 targets 的哪个系统调用、observe、线程池或输出管道卡住。回退截图错误被捕获，不能将它当作首个异常。

该轮旧 finally 在 observer.dispose 抛出 `NATIVE_CLEANUP_FAILED` 后跳过浏览器和 Host 的清理及报告写入，后续正常退出检查失败。已分别核对本轮 runner/Host 的 PID、100ns 出生时间、路径、Session 和命令摘要，并用再次核验的进程句柄仅收尾仍存活的自有 runner；Host 在独立核验时已经退出，未对它发信号。native/esbuild/浏览器随后自然退出。`recovery-boundary.json` 明确记录 `originalRunPassed:false`、`forcedRecovery:true`；最终 `post-recovery-owned-input-assets.json` 为 remaining=[]、OS held=[]、lease 空闲、journal 缺席。失败及恢复均保留，恢复成功不改变该轮失败结论。

上述目录均在仓库 `artifacts/harness-e2e/` 下。曾有只读 PowerShell 结果尚在写入时提前读取失败，读取任务自然退出后再次读取同一结果成功；它是诊断收集时序问题，未改写产品结果。

## 同一完整改动的测试修复

1. 新建聊天通过实际空白会话身份、可编辑 composer 及稳定窗口确认交接，保留原 15 秒边界，不重复输入提示词。
2. 主 Agent 多轮电脑任务统一使用固定 90 秒总预算；进度不重置截止时间，native/tool/暂停失败立即返回。capture 每次 2500ms、最多两次、退役 1500ms、UIA 等待 6500ms 和 native RPC 20000ms 均保持不变。
3. 失败后只取消本轮 Alpha 主 Agent，并只停止其电脑任务；已启动必须证明 stopped，未启动必须证明任务不存在，同时要求 Agent idle、nextTurn/nextStep 均为空、系统无 held 输入、租约归还。原失败保留，清理失败不继续未知输入。
4. 先通过公开菜单复用同一 Alpha 原生窗口，再沿用原前台命中检查；防止前一个 Beta 拖动用例盖住 Alpha。仍严格核对原 HWND/PID/appId，不绕过前台限制。
5. Stop 验收要求后台 stopped 及设置中对应卡片已移除，其他控制仍要求一个可见且状态精确匹配的卡片。
6. observer、browser、Host 三个 finally 阶段独立执行；前一个阶段失败不能阻止后两个，有限清理错误必须进入最终 failed 报告。已无目标的前置失败也先绑定本轮 Alpha SID，使只读清理 oracle 能证明未创建任务，而不会被缺失 target 误拒；这不授予任何输入。

最终相关纯回归 49/49 通过、零跳过，包括独立 finally 的 native 拒绝仍执行 browser/Host、owner-only 的 SID 读取、未创建任务与已停止任务判定、固定预算、Stop 卡片语义、trace 隔离、Node Worker 自然退出、真实文件读取负例、归档/计划/绘制证据和新会话身份交接。纯回归不替代下述实机报告。

## 隔离诊断 a2f：12/12 通过，未复现正式失败

载体 `windows-observer-diagnostic-prepared-a2fbdcb2-a969-4c9e-80b7-81e7587da689` 使用单独的 Windows 源码副本与诊断包，PE SHA 为 `0dc66fe09fbb5d6488f3f5a16f738232f79cbac77ed0a8b128dd941378f4fab1`，包 SHA 为 `6fed377d6f04b0f3ec4a1d83399bca169c1d4628409d93e1f178b5e9505ccc69`。正式 c8/3d 的源文件、二进制及超时参数未改。

第一次启动在任何 Windows 测试进程或输入前遇到 VM paused，原始前置失败保留为 `runs/arm64-preflight-paused/`。正常恢复同一 VM 后，使用 fresh `runs/arm64/` 运行：十页设置、阈值/主题、新会话、提示词、长文本附件、会话菜单、独立窗口复用、浏览器拖出、主 Agent 图片/动作流水线、批量归档、计划批注和真实文件上传下载，共 12/12 通过；没有前端错误。主 Agent 流水线在 4902ms 内完成 8 次模型适配器请求，包含实际 JPEG 和真实原生动作；完整 case9 含预览、接管中文输入、继续/暂停/停止等控制，为 66092ms。该 provider 是确定性传输验收，不能称为真实 DeepSeek 推理。

独立 finally 已在这一实际运行中验证：`ownedCleanup.passed:true/errors:[]`，所有自有进程自然退出，remaining=[]、OS held=[]、lease lockFree=true/journal=null；wrapper 任务 Ready 后自然注销，forced=false；后置读取任务自然退出且无 signal，VM pause-idle:on 恢复。机器可供下一项验收使用。

### 首个请求的有限时序

每个 native 进程最多保存 4096 条记录，专门保留前两组 status/targets/非 preview observe，其余使用尾部环。每个 marker 只更新内存，由独立后台线程每 250ms 落盘；不改变调度或等待参数。Node 侧只记录请求号、操作名、长度和心跳送达时间，最多保留 stdout 头部 128 字符用于提取数字 requestId，不保存原始内容。trace 不含屏幕、输入文本、路径、密钥或任意工具参数。

| 原生角色 | 第一/二次 targets 枚举 | outer 排队 | 首次 observe | 首次 capture | 首次 UIA 等待 |
| --- | --- | --- | --- | --- | --- |
| 外部 observer，PID 5900 | 38.691 / 10.986ms | 0.679 / 0.087ms | 2047.743ms | 772.250ms | 1269.913ms |
| Host 内置 native，PID 5560 | 10.300 / 8.634ms | 0.067 / 0.042ms | 353.240ms | 25.585ms | 326.891ms |

首 targets 的 UI 派发均小于 1ms，pending=0；候选标题、进程出生、MainModule 路径读取均有成对标记，未见持续卡住。外部第一轮路径读取最高 17.297ms。Host 第二次非 preview observe 为 934.970ms，其中 UIA 排队 812.296ms；实际线程数由 5 增至 6、最多 pending=1，仍未触及原 6500ms/20000ms。不能仅凭 available workers 数值很大断定没有排队，也不能凭这些成功时序推断正式失败的内部原因。

运行中 Host 心跳曾出现 5691ms 峰值，另一 Node 为 1501ms；尾环会淘汰早期峰值，因此同时保留即时只读快照，不能仅从最终快照声称整轮没有延迟。此轮在有这些延迟的情况下仍通过，尚无与正式 `NATIVE_TIMEOUT` 的因果证据，不据此调整生产线程数或超时。

完整有限数据见 `runs/arm64/evidence/pipeline-timing-projection.json`，早期即时副本为 `live-readonly-1792666583814/`、`live-readonly-1792666618006/` 和 `live-readonly-1792666664361/`；结论与严格边界见 `runs/arm64/diagnostic-verdict.json`，其中 `formalPackageAcceptance:false`。

成功截图在项目外：`/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-arm64-pipeline-diagnostic-a2fbdcb2-a969-4c9e-80b7-81e7587da689/`。已肉眼查看聊天悬停预览，确认固定铺满矩形、边界/阴影及悬停控件；它使用诊断包，不充当正式包像素验收。

## 正式复验状态

载体为 `windows-public-reuse-cleanup-prepared-1160cfaf-a043-40cd-9376-b6f170e691e7`，entry SHA `cdec185cd13e142f1870e74f70d34c238b8dc822338ffee356d7db3f1213f154`，绑定 e2e 源码 `fae0d0d3cf869ece7dd75e78bbe52062f8a31639a1e9696e1918809764038f90`。包为 ARM64 `8b5dca9fa3017414ac8ad88f99afa86cfb056b3887b3b330c98334c147b5c6e3`、x64 `3542d877955c57bf381e89c8ad856929bd87b90f198a52416cdf2734582c090c`，没有附加 trace、preload 或诊断 PE。

| 正式复验 | ARM64 | x64 |
| --- | --- | --- |
| 全部 Harness UI（旧版证据口径，四项待下述补强） | 12/12 通过 | 12/12 通过 |
| 安装、升级、坏包保护、回滚、重装 | 5/5 通过 | 5/5 通过 |
| 独立 finally | passed、errors=[] | passed、errors=[] |
| 进程/输入/租约回收 | remaining=[]、OS held=[]、lease 空闲、journal 缺席 | 同样通过 |
| wrapper/只读审计任务 | 自然注销、无 forced/无 signal | 同样通过 |
| VM idle 恢复 | on，顶层 exit0 | on，顶层 exit0 |

ARM64 当前正式包十页设置截图已经逐张肉眼查看：电脑操控位于首位，其他设置页沿用统一卡片、间距、文字和开关样式，无裁切或布局重叠。成功截图在项目外 `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-arm64-public-reuse-formal-1160cfaf-a043-40cd-9376-b6f170e691e7/`。实际逐项结果及独立审计在载体的 `runs/arm64/`。

两架构完整运行均结束并严格自然退净。复查后发现以下四项的成功判定仍有证据缺口，原始 pass/截图保留，不能扩大解释；下述同包 fresh 专项已补足。

## 四项结果证据补强

- 长文本：旧图仍显示“上传中”，只证明已被官方 composer 接收。新测试等待真实 `/api/session/uploadFileBinary` 返回 HTTP200，使用精确绑定的隔离 profile、HTTP 捕获的随机文件名及本轮 nonce/SHA，独立打开实际存储文件的只读句柄，逐字节计算实际 SHA256 和长度，核对原始 UTF8/换行。上传前先证明该 nonce 的 SHA 桶缺席。官方 composer 完成 ready 状态，界面不再显示上传中或失败，才保存新的成功图；不直接读取 receiptId 或响应正文，不替换或重复上传。
- 批量归档：通过自有 workspaceRegistry 的实际 archive 全集，要求增量恰为 Beta/Gamma，Alpha 保持 member 且未归档，原 accounting 集合不变。不能仅凭两个 sidebar 行消失通过。
- 计划修订：由 `sessionQuery.readSurface` 读取自有 plan SID 的真实普通 `user/message`；要求 seq 大于点击前切点、完整 revision 文本/原文引用/批注完全一致且恰好出现一次。评论卡、工具错误、assistant 文本或队列正文均不算送达。
- inline 预览：必须等 iframe canvas 真正绘制后发出的未来 `qiuya-preview-frame` 事件，frameId 有效、宽高均大于1且匹配 canvas，再等两次渲染机会。初始1×1、文字标签和 rAF 本身不能通过。

严格专项明确标为8项 feature-evidence subset、`fullUIAcceptance:false`，与1160使用同一 ARM/x64 包。只重跑四项及其必要前置，不重复安装、提示词、会话菜单、拖出和文件交换。最终成功索引须引用下述最终7da专项的 TXT/计划图与出处，不能将1160的上传中/未完成计划画面当最终成功图。首轮 b889 及中间失败保持原始结果，不能与最终通过轮混合计算。

### b889 ARM 首轮严格专项：7/8，采集失败保留

该轮归档独立集合回执 passed，计划修订 beforeSeq=27、afterSeq=36，新普通 user/message seq=33、完整文本唯一匹配，inline 收到未来真实paint事件 frameId=31ab90dd8cfb4a1bb25c256118e383b9、1000×800，三项通过。TXT已观察到HTTP响应，但读取response.json时专用上传Worker已正常退役，Playwright报Target closed；主页面仍在，随后独立窗口及其余业务正常。未得到TXT存储/readyUI证据前，本项及整轮均failed，未重放原请求。

严格后置审计通过：ownedCleanup errors=[]、remaining=[]、OS held=[]、lease空闲/journal缺席，wrapper未forced且自然注销、只读任务无signal、VM idle恢复on，顶层exit1与失败一致。原始记录在b889载体runs/arm64。新的采集方式避免读取已退役Worker正文，使用HTTP会话/文件名绑定、独立实际存储字节及官方ready UI；不直接读取receiptId，也不把预先计算的hash说成服务端响应结果。生产上传实现未改。

### 独立TXT读取边界及原始采集失败

后续3df/4dadd尝试的SDK上下文附件探针未能提供成功读回，均保留7/8 failed及自然退净报告，不能由通用400推定产品上传失败。只读自有profile元数据和失败截图已证明随机TXT实际存在、长度395B，官方UI已ready。最终移除该未提交探针，使用独立文件句柄读回，不注册新的上传实现、不拦截网络、不重复原请求。

TXT-only d80d只运行4项必要前置，独立oracle最初强制nlink=1，实际句柄证明同一395B只读对象有2条硬链接：PowerShell out和C# direct一致、GetFileInformation成功、Win32error0、struct52B，attrs33，未发输入。单硬链接不是业务要求；现允许合法nlink>=1，但前后linkCount、volume/fileIndex/size/最终路径保持，各级无reparse，当前nonce桶只含一个捕获到的文件名，实际内容hash必须一致。Node实文件负例同时证明错hash、越界名、额外叶、符号链接均拒绝，合法稳定硬链接可读。

对该同一已上传文件再次只读执行完整oracle通过，actualSHA为9c3d618bc294b93835881e555e1f09a8a07a55c3e36487082d04d9c386e49efb、395B、linkCount2；没有再次发送payload。d80d原失败报告未修改。首次有限Info的临时aggregate JSON路径曾被后一次完整oracle复用，准确tool输出另以transcript明确来源保存，后续诊断文件改为唯一名称；不将转录文件冒充原始JSON。

## 最终同包严格专项7da：ARM64与x64均8/8通过

载体 `windows-feature-evidence-prepared-7da13ea6-3146-4a71-83cb-c6158247d8d0`，entry SHA `13c21e5c153449baa66bddad506ae0b8fa9380196ce4d0b3eb1fa2d48f1b7311`。`prepare-data.json` 记录37个输入条目（35个 live 文件、2个 snapshot-only bootstrap），使用与1160完全相同的 ARM64/x64 包及 c8/3d PE。E2E live 源 SHA 为 `313b9e0fbc9edd4f3a2756ff839ac14488486e6f8b513cd2d7260c69c2acf766`，provider 为 `6beb56fcdb2b66cbe8d7e6daefff8501da48d243c22859f318334d5e46834bde`；固定流水线 helper 保持 `68c619c52e0ce40e937103c95196d402349bcd36993ef0c86149442c0d5cbf48`。snapshot-only 的 owner/profile/readiness 引导与转换理由逐项写入 manifest，不将其误称完全未转换的 live 源。

| 最终严格专项 | ARM64 | x64 |
| --- | --- | --- |
| 所选8项 UI/Host 功能 | 8/8 通过 | 8/8 通过 |
| TXT HTTP、上传前缺席、实际395B、SHA、官方ready UI | 全部通过 | 全部通过 |
| 归档实际全集恰增 Beta/Gamma、Alpha保留、accounting不变 | 全部通过 | 全部通过 |
| 计划完整修订普通 user/message，切点后唯一一次 | seq27→33，afterCut36 | seq27→33，afterCut33 |
| inline 未来真实paint、1000×800、两次渲染机会 | 通过 | 通过 |
| 独立 finally、前端错误 | passed/errors=[]，frontendErrors=[] | 同样通过 |
| 自有进程、OS输入、lease、journal | remaining=[]、held=[]、lockFree=true、journal=null | 同样通过 |
| wrapper及只读后置任务 | Ready后自然注销、forced=false、signalSent=false | 同样通过 |
| VM idle及顶层退出 | restored=true、exit0 | restored=true、exit0 |

ARM64 TXT实际SHA为 `640750c4e8df0e3ed566f0a17b11acee6778475104a8ad4eb10a063c3c098095`；x64为 `6cac8002902f01c886b23b15930c60bba61b936b5aacf4934b33c360df55bb3f`，不同轮使用不同nonce，均395B。两个实际句柄的linkCount均为2，身份/最终路径前后稳定、无reparse且当前nonce文件唯一。HTTP精确会话/文件名、实际存储内容、官方ready UI为三层独立证据；`receiptIdReadDirectly:false`、`responseBodyRead:false`、`inputReplayed:false` 明确保留，不声称读取了官方receipt正文。

两个计划修订的完整文本SHA均为 `3a1a360aa31920251f59bfe2d457e4172fe191fc8028a231d4d13055df1042bb`，实际普通消息均seq33，source.kind=user，原文引用和批注完全匹配且只有一条。该判据证明批注修订送达以及原draft保留，不要求外部模型完成后续推理。ARM64 inline frameId为 `7c92683844e146b78b97280e453dfb08`，x64为 `10dec5c21ee94e2696d082c3a4d82e6f`；均来自drawImage后的未来事件，而非初始空canvas。

每架构的原始独立收据在 `runs/<arch>/evidence/`：`pasted-text-upload-evidence.json`、`archive-exact-collection-evidence.json`、`plan-revision-durable-evidence.json`、`inline-preview-painted-frame.json`。严格后置分别在 `post-run-owned-input-assets.json`、`wrapper-task-cleanup.json`、`postflight-assets-task-cleanup.json`；根目录 `vm-pause-restored-<arch>.json` 证明原idle恢复。8项只是明确子集，与1160的12项和安装5项按同包证据合并覆盖，不能说成7da再次完整重跑。

## 本单元最终构建、纯测与截图来源

本次49项纯回归全部通过、零失败/跳过/取消，原始日志为7da目录 `final-related-tests.log`。命令覆盖 `harness-feature-evidence`、`harness-pasted-text-evidence`、`harness-failed-computer-cleanup`、`harness-computer-pipeline`、`harness-workspace-prerequisite`、`harness-settings-acceptance`、`windows-pipeline-diagnostic` 七个test文件。

为保持已冻结Mac正式helper并避免与真实模型实测争用，执行 `scripts/build.mjs` 同源的 Host、Client和remote JS步骤，明确跳过两项Swift编译及macOS manifest重写，转换副本/执行日志/前后hash保留在7da目录 `same-source-js-only-build.mjs`、`final-js-build.log`、`final-js-build-evidence.json`。三个当前JS产物与两份已实测Windows tgz中的对应产物逐字节SHA一致（6/6）；Mac正式computer helper保持 `66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502`，Session helper和manifest也前后不变。本单元未修改生产Windowsnative或重编native，不将本次JS构建称为新一轮完整native构建。

最终专项成功图在项目外：

- `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-arm64-strict-feature-evidence-7da13ea6-3146-4a71-83cb-c6158247d8d0/`
- `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-x64-strict-feature-evidence-7da13ea6-3146-4a71-83cb-c6158247d8d0/`

已肉眼查看两架构最终TXT图，均显示395B且无上传spinner；x64悬停预览为铺满的固定矩形、轻边框/阴影和浮层控件。最终计划展示优先使用ARM64 `plan-comments.png`（真实修订用户气泡、draft和已完成本地响应可见）；x64 `plan-comments.png` 采集时后续响应仍在“深度探索中”，只可作为已投递状态的原始记录，不进入“模型已完成”成功画廊。x64 `plan-comment-saved.png` 可明确标注保存批注，真正投递由上述独立消息收据证明。1160的旧TXT/未完成计划图、所有失败图与诊断包图保留原始字节和路径，不覆盖、不冒充最终成功图。

此单元完成Windows正式包的Harness功能及证据工具复验；真实DeepSeek、Mac当前包视觉验收、长稳测试和最终交付由各自独立报告证明，不能由确定性provider或本记录代替。
