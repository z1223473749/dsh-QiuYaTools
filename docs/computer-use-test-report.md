# 电脑操控与双平台适配测试报告

报告日期：2026-10-21。开发版本：`0.6.0-beta.1`。本文件是最终候选冻结前的证据草稿，Windows 最终宿主/安装结果和最终候选 SHA 待主执行者补充。范围与门槛见 [开发计划](windows-and-computer-use-development-plan.md)，阶段进度见 [实施记录](implementation-progress.md)。

当前结论：已取得桌面输入、双平台实际宿主、浏览器、独立电脑与安装的分项通过证据，Mac 完整自动回归 477/477 通过；整体验收尚未通过。Mac 完整长稳失败，Windows 排除虚拟机暂停后仍遇到截图超时，正在修复并重跑；Mac 当前锁屏，真实视觉模型缺少可用证据。新锁定 Windows 测试运行时首轮为 9/10，动作失败原因仍在诊断。未运行与被阻塞的检查不计通过。

## 1. 状态与证据类型

| 状态 | 含义 |
| --- | --- |
| passed | 明列范围内的检查实际完成并满足断言 |
| failed | 已执行但未达到门槛，保留失败报告 |
| blocked | 依赖解锁、可用模型或稳定交互环境，不能完成对应验收 |
| not-run | 尚未执行，或该阶段尚未实现 |

确定性 driver、故障注入、合成浏览器事件、真实桌面与真实模型分别记录，不互相替代。各 runner 数量不相加成一个“全部通过”总数：同一行为可能在不同 runner 中重复出现。

## 2. 环境与支持边界

| 环境 | 实际证据 | 边界 |
| --- | --- | --- |
| Mac Apple Silicon | `darwin/arm64`；预检为 Darwin `25.6.0`、Node `24.17.0`；Harness 使用隔离 profile | 最新观测为 `screenLocked=1`、前台 `loginwindow`；先前权限通过不代表当前可输入 |
| PD Windows | Windows 11 ARM64；原生 runner、Edge 位于登录用户交互桌面 Session 1；远端代理记录 Node `22.23.3` | Session 0 启动不算 GUI 运行证明；PD 暂停会影响采集、计时和窗口状态 |
| Mac Intel | 通用二进制含 `x86_64`，构建通过 | Intel 实机运行未验证 |
| Windows x64 | x64 自包含资产构建通过 | ARM 来宾中的 x64 仿真不等于原生 x64 硬件，本报告不宣称后者通过 |
| 最低/旧系统 | Mac 构建目标 macOS 13+；Windows 首轮为 Windows 11 | macOS 13 实机、Windows 10 等旧系统未验证 |

[Mac 预检报告](../artifacts/computer-use/preflight/report.json)只证明只读就绪检查；它不授予 OS 权限，也不替代真实输入验收。

## 3. 已取得的通过证据

| 检查 | 结果及证据类型 | 原始证据 |
| --- | --- | --- |
| Mac 完整回归 | `QIUYA_TOOLS_UNIVERSAL=1 npm run check`：477/477，零失败、零跳过，包含浏览器释放失败与跨平台 fixture 回归 | [完整日志](../artifacts/computer-use/final-regression-cursor.log) |
| Windows 完整 Node 回归 | 真实 Windows ARM64 Node 22.23.3：477 总数、472 passed、0 failed、5 skipped；4 项依赖 Mac 编译工具，1 项缺可选旧包 fixture | [报告](../artifacts/computer-use/windows-unit-final/report.json)、[日志](../artifacts/computer-use/windows-unit-final/unit.log) |
| Windows 补充归档回归 | 提供缺少的旧包 fixture 后，归档文件单独重跑 9/9，零跳过；不改写前一份完整日志 | [报告](../artifacts/computer-use/windows-archive-extra/report.json) |
| Mac 原生自测 | Swift 自测通过；通用原生构建通过 | [原生自测日志](../artifacts/computer-use/macos-native-selftest-final.log) |
| Mac 实际 Harness | 10/10：设置/主题、会话、建议、TXT 附件、菜单、原生分窗与复用、Agent 图片运输、归档、批注 | [宿主报告](../artifacts/harness-e2e/macos/report.json) |
| Mac 原生功能 | ARM64，11 项：SCK、AX、真实点击、Unicode、快捷键、滚动、WKWebView、预览重叠、拖动中接管与释放、旧动作零输入 | [原生报告](../artifacts/computer-use/macos-native/report.json)、[同范围重跑](../artifacts/computer-use/macos-native-fast/report.json) |
| Windows 原生 | 截图隔离进程版本在 Windows 11 ARM64 的 47 项编排检查通过；包括真实桌面输入、UIA、窗口/WebView2、互斥、按住后崩溃恢复、旧 owner 隔离与实时光标 | [Windows 原生报告](../artifacts/computer-use/windows-native-broker-final/report.json) |
| Windows 隐藏启动回归 | 同版真实 Node `windowsHide:true` 启动后原生窗口必须可见，5/5；确认修复原先隐藏会话窗问题 | [报告](../artifacts/computer-use/windows-node-hidden-broker/report.json) |
| Windows 截图隔离与恢复 | 集成 8/8，含 14 项真实子进程故障注入和 20/20 张不同动画截图；卡死、崩溃、坏协议、未确认退出、Dispose 与孤儿清理分别验证 | [报告](../artifacts/computer-use/windows-capture-broker-final/report.json) |
| Windows 实际 Harness | 旧测试运行时、ARM64 候选 `1de2f104…`：10/10，含真实会话窗与主 Agent 图片运输、四个原生悬浮窗按钮回执 | [宿主报告](../artifacts/harness-e2e/windows/report.json) |
| Windows 微软拼音 | 5/5：PD 虚拟硬件扫描码进入已安装微软拼音，Space 提交“你好”；Enter/Tab/Escape/Ctrl+Enter 不误接受建议或发送 | [报告](../artifacts/computer-use/windows-ime-final/report.json)、[硬件事件](../artifacts/computer-use/windows-ime-final/hardware-events.json) |
| Mac Chrome | 10 项实际浏览器检查；含截图/AX、Unicode、登录态、坐标、许可、CDP、注册 Agent 的导航/选择器/新建/关闭 | [Chrome 报告](../artifacts/computer-use/browser-cleanup-final/summary.json) |
| Windows Edge | 10 项实际 Edge 检查，ARM64 交互 runner | [报告](../artifacts/computer-use/windows-edge-final/summary.json) |
| Mac → Windows | 15 项：配对、错误 token/协议/Origin、目标/截图、真实点击/Unicode、互斥、释放/继续、预览、断连与心跳撤销 | [跨电脑报告](../artifacts/computer-use/windows-remote-final/report.json) |
| Mac 官方安装管理器 | 5/5：旧版干净安装、升级保留配置、坏包恢复、回滚、重装；对应最终 Mac 包 `8ae78904…` | [安装与恢复报告](../artifacts/install-e2e/macos-delivery-final/report.json) |
| Windows 官方安装管理器 | 相同 5 项全部通过；对应 Windows ARM64 包 `1de2f104…`，后续原生修复包须重新绑定 | [报告](../artifacts/install-e2e/windows/report.json) |

Windows 原生报告中的 `WIN-REJECTED-RELEASE-STATE-01` 内含 4 项注入写入器的故障测试，原报告明确 `actualOsInput:false`；不能把原生检查全部称为物理 HID 测试。“拖动中物理 HID 点击自己的预览”仍未验证，UIA InvokePattern、`SetCursorPos` 或 `SendInput` 不替代该证据。

微软拼音证明真实 trusted `compositionstart/update/input` 与实际中文提交；已安装 Harness 会将 `compositionend` 替换成非 trusted 事件，不能声称捕获了 trusted end。AltGr、死键及其他输入法仍未验证。

Mac 新 guard 的只读不启动 guardian、双 helper 互斥、正常转移与旧 release 隔离、空租约崩溃恢复共 4 项，在最新诊断运行中通过。但包含真实按住拖动的整个 runner 仍失败，不能扩大为按住输入后崩溃恢复已通过。

控制边界回归覆盖了最新授权意图、撤权立即停止、真实租约 epoch、动作去重、取消/接管、预览帧不污染模型观察、窗口身份/几何变化、失败远端释放、旧 heartbeat、卸载后迟到连接、失败退役重试和 CDP 释放未确认。入口见 [会话测试](../tests/computer-session.test.mjs)、[远端生命周期](../tests/computer-remote-lifecycle.test.mjs)、[router](../tests/computer-router.test.mjs)、[浏览器](../tests/computer-browser.test.mjs)。这些故障回归已包含在 477 项完整检查中，不另加为独立总数。

## 4. 主 Agent 图片运输与真实模型

Mac 与 Windows 实际 Harness 报告均证明公开工具在主 Agent 中执行，截图经过附件和 adapter 投影；Mac 报告捕获到 3 次带图请求、4 个图片块。使用本地确定性 adapter，不使用真实账户凭据。这证明真实主 Agent 的工具和图片运输，不能证明视觉推理。

真实视觉模型固定任务为 **blocked**。当前用户配置包含 `deepseek-flash`，尚无证据证明该配置在本次链路中具备可用图片输入；另一本机 `49506/v1/models` 返回 503，不构成模型可用证据。定位、填写以及接管后继续的真实模型任务未执行，不根据本地 adapter 或模型名称推断通过。

脚本化 Agent 工具经过服务控制层操作真实 Chrome/Edge 已通过；它证明动作接口与页面效果，不证明模型会自主理解截图并选择动作。

## 5. 原有功能的双平台验收范围

| 功能 | Mac 实际宿主 | Windows 当前证据 | 仍需独立验收 |
| --- | --- | --- | --- |
| 长文本附件 | passed：浏览器 `ClipboardEvent` 进入官方 TXT 上传 | passed：实际宿主相同链路 | OS 实际剪贴板；拼音测试针对建议/发送，不扩大为全部粘贴与输入法组合 |
| 会话独立窗口 | passed：原生窗出现、身份与复用 | passed：实际宿主原生窗出现、身份与复用 | 真实拖出/取消及完整窗口行为矩阵 |
| 批量归档 | passed：真实测试会话归档 | passed：早期宿主报告 | 全部选择快捷键组合及跨窗口边界 |
| 计划批注 | passed：评论、提交与草稿保留 | passed：早期宿主报告 | 真实输入法、复杂 Unicode 与跨窗存储矩阵 |
| 会话菜单 | passed：置顶、未读、复制调用 | passed：早期宿主报告 | 复制使用浏览器局部 spy；Explorer 实际目标与全部路径形式 |
| 提示词建议 | passed：确定性会话、Tab/Escape | passed：实际宿主及真实微软拼音 5 项 | AltGr、死键和其他输入法 |
| Q 主题 | passed：设置持久化与截图 | passed：早期宿主主题与设置 | 全部 Windows DPI、字体与滚动条矩阵 |
| 关于、设置、更新 | passed：功能页/配置；官方管理器替换与恢复 5/5 | passed：设置/功能页；官方管理器升级/恢复/回滚 5/5 | 完整下载中断/占用 exe 矩阵、最终修复包重绑与签名 |

早期 Windows 宿主 8/10 的失败已确认为 `windowsHide:true` 导致会话窗不可见，已修复并取得上述 10/10，旧证据保留在 `artifacts/harness-e2e/windows-hidden-regression-failure/`。此后从公开 npm lock 新建的测试运行时首轮 9/10：主 Agent move 失败，其余 9 项通过；该轮没有运行到悬浮画面手动输入分支。此失败仍在诊断，不能用旧 runtime 的 10/10 直接覆盖。最终修复包将重新执行宿主和安装验证，并单独记录实际鼠标事件来源。

## 6. 失败与环境阻塞

### Mac 30 分钟采集长稳：failed

[失败报告](../artifacts/computer-use/macos-soak-fixed/report.json)确实记录了约 30 分钟的完整运行：

| 指标 | 实际值 |
| --- | --- |
| 实际耗时 | 1,800,796 ms |
| 有效唯一帧 | 19,691 |
| 旧脚本记录的 uniqueFps | 11.3805 |
| 延迟 P95 | 104 ms |
| 无效/过旧时间戳 | 892，门槛为 0，整体失败 |
| helper 受控终止并显式重启 | 5 次 |
| 空闲暂停 ACK | 0–2 ms；没有输入在途，不证明输入停稳 P95 |
| 连续预览附件写入 | 0 |

旧脚本的 `uniqueFps` 取有效帧区间，不能掩盖末尾冻结。即使部分 FPS/P95 达标，这次仍为 failed，不能删去尾部异常后当作 30 分钟通过。

冻结源时间戳 `1517991079` 还原为 **2026-10-20 18:02:33.511 UTC**。`pmset -g log` 明确记录 **2026-10-21 02:02:33 +0800，即 18:02:33 UTC** 显示器熄灭，发生在同一秒；显示器闲置配置为 10 分钟。这支持睡屏为此次冻结的重要原因，不等于修复后已经通过。系统证据见 `artifacts/computer-use/environment-interruption/` 下的 `power-settings-read-only.txt`、`power-assertions.txt`、`display-off.txt`。

原 fixture 的 `.userInitiatedAllowingIdleSystemSleep + .latencyCritical` 没有阻止显示器休眠。现 [SoakFixture.swift](../src/native/macos/fixtures/SoakFixture.swift)仅在其生命周期持有 `.userInitiated + .idleDisplaySleepDisabled + .latencyCritical`，并记录实际 draw 时间戳、次数、`display()` 返回及遮挡状态；Swift 编译通过。没有修改全局电源设置或生产截图逻辑。修复后的完整长稳尚未通过。

### Mac 短测与按住输入后崩溃：failed / blocked

- [半分钟短测](../artifacts/computer-use/macos-soak-awake-smoke/report.json)：30,282 ms，只有 12 个有效唯一帧、279 个无效时间戳，完整时段帧率约 0.396，结果 failed。
- [拖动诊断](../artifacts/computer-use/macos-lease-crash-diagnostic/report.json)：前 4 项租约检查 passed，真实拖动返回 `FOCUS_CHANGED`，没有观察到按住状态，整个 runner failed。
- 系统实际观测到 `screenLocked=1`、前台 `loginwindow`，见 `artifacts/computer-use/environment-interruption/macos-session.json`。已向用户请求解锁，不能写成已解锁。runner 将主动识别锁屏，避免将环境前提混成未证实的产品缺陷。
- 新 guard 的真实按住拖动 → SIGKILL → 恢复、Windows → Mac 真实前台任务需在解锁后重跑，对应验收 blocked；已有失败报告保留。

### Windows 长稳：failed，截图隔离修复中

PD 自动暂停两次打断运行，没有有效的完整 30 分钟验收。[中断进度](../artifacts/computer-use/windows-capture-interrupted/interrupted-progress.json)记录了 1,080.1 秒、11,341 次采集及约 30.58 ms 平均采集往返时间；这是采集往返，不是源画面到 renderer 的端到端 P95。

另一次 `/private/tmp/qiuya-windows-native-endurance-30min/report.json` 为 `passed:false`、`Capture timed out`。排除 PD 暂停后的最新运行同样因截图超时失败：最后进度约 1,200.1 秒、14,377 次采集，随后超过 2.5 秒超时。原 fixture 为静态画面，采集次数不证明唯一画面帧率。这是一项需要修复的产品问题，不能归为全部环境中断或拼接成 30 分钟 passed。

当前修复将不可中断的 `PrintWindow` 调用放到不拥有输入权的独立子进程，超时后确认旧进程退出，只对只读截图重试一次；按键/鼠标动作不重放。已取得隔离截图 8/8、其中 14 项子进程故障注入和 20/20 张不同动画帧的通过证据。33ms 动画完整 30 分钟长稳正在运行，逐分钟记录父/子进程总资源、单 worker 与唯一帧率；尚未结束，不能提前算通过。

另外，Windows 原生动作避让逻辑对整个目标窗避让，在大窗口下可能将悬浮窗隐藏至拖动结束。这会令暂停按钮暂时不可见，正在窄修为只避开实际指针点/路径；没有安全位置就在 mouse down 前返回错误。修复后的持续可见性、停稳 P95 与最终宿主正在验收。当前 47 项不能覆盖这个新发现的缺陷。

## 7. 未验证及尚未实现的范围

| 范围 | 状态 | 所需证据/前提 |
| --- | --- | --- |
| 真实视觉模型固定任务 | blocked | 可用图像模型、实际请求与 fixture 业务值；依计划执行轮数/时间上限 |
| Mac 新 guard 按住输入后崩溃 | blocked | 解锁桌面的实际 down、强退与释放证据，空租约不能替代 |
| Windows → Mac 独立目标 | blocked | Mac 解锁、真实独立目标输入闭环；Mac → Windows 不覆盖反向 |
| Intel Mac 与原生 Windows x64 | not-run | 各自实际架构 runner，交叉构建/仿真不替代 |
| 最低/旧系统 | not-run | macOS 13、Windows 10 等环境与 Harness 版本核验 |
| 物理多屏、拔插与全部 DPI | not-run | 实际显示器、负坐标和缩放变化；几何单元测试只证明映射 |
| Windows AltGr/死键及其他输入法 | not-run | 微软拼音已 5/5；仍需其他键盘布局与输入法实际环境 |
| 独立环境文件交换 | not-run，未实现 | 主体计划 P6 的明确文件交换入口尚未交付，远端控制通过不覆盖此功能 |
| 浏览器扩展连接日常 profile | not-run，未实现 | 当前交付为独立持久 profile 或显式回环 CDP；没有随包提供浏览器扩展 |
| Excel 专用加载项 | not-run，未实现 | P10 独立实现及 Mac/Windows Office、加载项环境；鼠标点击不替代 |
| macOS 锁屏操控扩展 | not-run，未实现 | P10 独立实现与系统会话能力；当前 helper 不据此声称支持锁屏 |
| 正式签名、公证、公开发布 | not-run | 发布身份、资产及独立发布流程；候选验证不等于公开发布 |

## 8. 最终资产与复现入口

最终交付需补下表，将冻结源码、原生 manifest、包 SHA 与安装报告绑定。历史安装报告中的 SHA 只证明该次候选，不能直接用于后续重打包文件。

| 资产 | 最终源码提交 | 最终 SHA256 | 安装证据 |
| --- | --- | --- | --- |
| `dsh-qiuya-tools-darwin-universal.tgz` | 待填写 | 待重打包后填写 | 已有历史候选 5/5；最终包对应待补 |
| `dsh-qiuya-tools-win32-arm64.tgz` | 待填写 | 待重打包后填写 | 主执行者补最终 Windows 结果 |
| `dsh-qiuya-tools-win32-x64.tgz` | 待填写 | 待重打包后填写 | 原生 x64 实机未运行 |

桌面 runner 需在授权且解锁的交互会话运行。显式选择新的证据目录以保留历史失败报告。

```sh
QIUYA_TOOLS_UNIVERSAL=1 npm run check
node scripts/computer-preflight.mjs --target local
node scripts/test-computer-preview.mjs
node scripts/test-computer-browser.mjs --browser chrome --artifacts artifacts/computer-use/browser-cleanup-final
node scripts/e2e-macos-computer.mjs --evidence-dir artifacts/computer-use/macos-native
node scripts/test-macos-computer-lease.mjs --action-crash --out artifacts/computer-use/macos-lease-crash-final
node scripts/e2e-harness.mjs --package /absolute/path/candidate.tgz
node scripts/soak-computer.mjs --minutes 30 --faults 5
```

Windows 入口见 [原生说明](../src/native/windows/README.md)、[PD 原生 runner](../scripts/test-windows-native-pd.mjs)、[跨电脑 runner](../scripts/e2e-windows-remote-pd.mjs)、[Windows 宿主 runner](../scripts/e2e-windows-harness-pd.mjs)。临时 Windows 证据需归档到 `artifacts/` 后再绑定最终交付。

当前剩余门槛为 Windows 最终宿主/安装、解锁后的 Mac guard 与反向独立任务、双平台完整长稳、真实视觉模型及最终候选资产对应关系。P10 尚未实现，本报告不宣称“完全复刻 Codex”或“全部完成”。

## 9. 与参考界面和用户目标的差异

用户提供的第一张截图能直接确认“任意应用”“Google Chrome（已安装浏览器扩展程序）”“Microsoft Excel 加载项”“锁屏操作”及“始终允许的应用”入口。截图没有展示采集帧率、预览交互、AI 指针实现或内部 IPC；这些按用户明确要求设计和独立验收，不据截图推断 Codex 的内部机制。

| 对齐项 | 本次实现 | 仍有的差异 |
| --- | --- | --- |
| 原生应用操控 | Swift/SCK/AX 与 C#/GDI/UIA/SendInput，应用授权、明确目标、输入租约 | 只在已登录的交互桌面工作；后台、系统保护与任意应用兼容不作全面承诺 |
| 始终允许与撤销 | 按 Harness profile 存储应用许可；远端绑定设备身份；撤销立即停止 | 不复制 Codex 的系统权限或私有授权数据库；系统权限仍由 OS 管理 |
| Chrome/Edge | 独立持久浏览器配置或用户提供的回环 CDP；站点许可与标签页动作 | 没有提供截图所示的浏览器扩展；日常 profile 不能通过“一键安装扩展”接入 |
| 悬浮实时画面与 AI 指针 | 双端原生壳、共享实时页面、目标坐标光标、暂停/接管/继续/停止 | 截图本身未证明 Codex 细节；本产品性能、物理接管和长稳按本报告实际证据声明 |
| 人工直接操作预览 | 同一 Host 会话通过预览发出点击、拖动、滚动、文字和快捷键 | Windows 完整手动输入链正在实测；物理 HID 与 UIA/SendInput 证据分开 |
| 独立电脑/虚拟机 | 已存在系统的配对代理与可撤销控制；PD 为实际测试目标 | 不自动创建系统镜像；文件交换入口未实现；反向 Mac 输入待解锁 |
| Excel 专用增强 | 可按普通原生应用控制的设计，专用结构化工作簿连接未实现 | 缺少 P10 加载项、活动工作簿读取/编辑/撤销与双平台 Office 实测；不能称已对齐 |
| Mac 锁屏操作 | 当前预检识别锁屏并阻止前台输入验收 | P10 系统授权扩展未实现，未安装或修改当前机器的登录/锁屏组件 |

实际 Windows 界面证据包括[独立会话窗](../artifacts/harness-e2e/windows/independent-window.jpg)和[原生悬浮预览](../artifacts/harness-e2e/windows/floating-computer-preview.jpg)。这些来自隔离测试会话，不是设计稿；截图对应当时的候选 SHA，后续修复的准确验证另见最终报告。
