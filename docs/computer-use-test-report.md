# 电脑操控与双平台适配测试报告

报告日期：2026-10-21；版本 `0.6.0-beta.1`；分支 `codex/cross-platform-computer-use`。本报告区分实际桌面、浏览器、确定性模型、故障注入及真实模型，不把这些证据相互替代。原始范围见 [开发计划](windows-and-computer-use-development-plan.md)，操作方式见 [使用指南](computer-use-guide.md)。

**整体尚未通过完整验收。** 三个平台安装包已经生成；最终 Windows ARM64 包的实际宿主 12/12、安装恢复 5/5通过，Mac 最终包安装恢复 5/5通过。Mac 最近预检实测锁屏，新的 WKWebView 手动输入、完整 Mac 长稳、持有输入后崩溃恢复和反向独立目标仍被阻塞；真实视觉模型也缺少可用前提。Excel 专用加载项和 macOS 锁屏扩展尚未实现，不能称为“完全复刻 Codex”。

## 1. 版本、环境及证据口径

- 生产源码：`3c924d0`；编译产物及安装包回执：`3c6e865`。后续测试脚本、报告提交不改变这份生产包。精确文件哈希见 [delivery-manifest.json](../artifacts/delivery-manifest.json)，包校验值见 [SHA256SUMS](../artifacts/SHA256SUMS)。
- Mac：macOS 26.6.2 / Darwin 25.6.0，Apple Silicon；主执行 Node 24.17.0，实际安装的 Harness CLI 使用自己的运行时。
- Windows：PD 26.4.1 内 Windows 11 ARM64，真实登录用户交互桌面 **Session 1**，Node 22.23.3 ARM64；Session 0 命令成功不算 GUI 验证。
- Windows 原生程序为 .NET 8 自包含程序，构建 SDK 8.0.426，WebView2 SDK 1.0.3912.50。ARM64 helper SHA 为 `0eb1fb6ab29370c04a8b13feb78b6c2e3a5efd80a2b4cbefd1945d88b08f2030`；x64 为 `3b2dda6eb93d8e8491326ce166b963fc556ba289500f980d7d004ff037039e83`。
- Windows 测试运行时从公开 npm 精确 lock 重建；lock SHA `dd08239ab518fa1bd0254774b8209853122bffe0c87c1734deab145a82e70dea`，运行时档案 SHA `d73549cd1bd3421674e648c407ed7f4517c9ca2cf4ddbf467ea23a6d123e329a`。没有复制用户 profile 或账户凭据，详见 [运行时来源说明](windows-test-runtime.md)。
- 状态仅使用 `passed / failed / blocked / not-run`。同一行为在多个 runner 中重复出现，数量不相加成“全部通过”总数。历史失败不删除，不以最后一次绿色覆盖原记录。

## 2. 最终自动回归与真实功能结果

| 检查 | 实际结果与边界 | 原始证据 |
| --- | --- | --- |
| Mac 完整检查 | passed：`QIUYA_TOOLS_UNIVERSAL=1 npm run check`，**517/517**，0失败、0跳过；含类型检查、通用构建、逻辑与集成回归，不等同全部桌面 E2E | [日志](../artifacts/computer-use/final-canvas-epoch-check.log) |
| Windows 完整 Node 检查 | passed：真实 Windows Node 22.23.3，**517总数、513 passed、0 failed、4 skipped**；仅跳过依赖 Swift/lipo 的 Mac 检查，旧归档 fixture 已纳入 | [报告](../artifacts/computer-use/windows-unit-canvas-final/report.json)、[日志](../artifacts/computer-use/windows-unit-canvas-final/unit.log) |
| 真实 Chromium 预览 | passed：**17/17**，确定性 driver；覆盖坐标、光标、接管、文字、继续/停止、位图释放、坏 JPEG、迟到解码、旧手势、迟到自动暂停 | [报告](../artifacts/computer-use/preview-web/report.json) |
| Windows ARM64 原生 | passed：最终 helper **52/52**，真实桌面输入、UIA、WebView2、租约、崩溃与 guardian、持续可见预览；个别注入 writer 故障检查不使用真实 OS 输入 | [报告](../artifacts/computer-use/windows-native-hook-final/report.json) |
| Windows Node 隐藏启动 | passed：真实 Node `windowsHide:true` 启动最终 helper，窗口可见和回执 **5/5** | [报告](../artifacts/computer-use/windows-node-hidden-hook-final/report.json) |
| Windows 在途拖动释放 | passed：30次实际按住后释放，独立 C# 线程观测 OS mouse-up，P95 **21.7592ms**，最大 **24.1073ms**；旧epoch全部拒绝，ACK后光标稳定100ms | [报告](../artifacts/computer-use/windows-pause-latency-hook-final/report.json) |
| Windows 最终实际 Harness | passed：包 `ab9d9b12…`，真实 Host/UI **12/12**，含原功能、原生窗、可信浏览器拖出、主 Agent 收图、原生预览人工操作、8MiB 文件交换 | [报告](../artifacts/harness-e2e/windows-canvas-final/report.json)、[验证边界](../artifacts/harness-e2e/windows-canvas-final/validation-notes.json) |
| Windows 最终安装恢复 | passed：同一 `ab9d9b12…` 包，官方管理器安装、升级保留配置、坏包恢复、回滚、重装 **5/5** | [报告](../artifacts/install-e2e/windows-canvas-final/report.json) |
| Mac 最终安装恢复 | passed：包 `e528ed96…`，相同官方管理器流程 **5/5**；不需要解锁后的桌面输入 | [报告](../artifacts/install-e2e/macos-canvas-final/report.json) |
| Mac 历史实际 Harness | passed：解锁时原功能、主 Agent 图像、原生分窗等 **10/10**；这是该次源码/候选的证据，新 canvas 在 Mac WKWebView 的手动输入没有被这份旧报告覆盖 | [报告](../artifacts/harness-e2e/macos/report.json) |
| Mac 原生功能 | passed（历史明列范围）：**11项**实际输入与窗口检查；通用原生构建、自测通过。后续 guard 真正持有输入后的崩溃恢复另列阻塞 | [原生报告](../artifacts/computer-use/macos-native/report.json)、[同范围重跑](../artifacts/computer-use/macos-native-fast/report.json) |
| Mac Chrome / Windows Edge | passed：各 **10项**真实浏览器通道检查；登录 profile、截图/元素、Unicode、坐标、站点许可、CDP、注册 Agent 的导航与标签页动作 | [Chrome](../artifacts/computer-use/browser-cleanup-final/summary.json)、[Edge](../artifacts/computer-use/windows-edge-final/summary.json) |
| Mac→Windows 独立目标 | passed：最终 helper **15/15**；配对/撤权、错误凭据、协议/Origin、真实输入、互斥、释放/继续、断连与心跳 | [报告](../artifacts/computer-use/windows-remote-hook-final/report.json) |
| Windows 微软拼音 | passed：**5/5**，PD 硬件扫描码进入已安装微软拼音，实际提交“你好”，Enter/Tab/Escape/Ctrl+Enter不误发送/接受建议 | [报告](../artifacts/computer-use/windows-ime-final/report.json) |
| x64 在 ARM Windows 仿真 | passed（转译范围）：最终 x64 **原生52/52、Node隐藏启动5/5、截图8/8**；真实WebView2握手/窗口/预览及PD硬件Escape通过。Node自身ARM64，启动的helper为x64；未覆盖原生x64硬件 | [原生](../artifacts/computer-use/windows-x64-emulation-native-final/report.json)、[隐藏启动及架构说明](../artifacts/computer-use/windows-node-hidden-x64-emulation-final/coverage.json)、[截图](../artifacts/computer-use/windows-x64-emulation-capture-final/report.json) |

实际悬浮窗口中的鼠标点击采用 **Win32 SendInput OS 合成事件**，不冒充 PD 物理鼠标。原生测试另有 PD 硬件 Escape 中断拖动，但“物理鼠标在按住拖动中点击自己的预览”仍未测。可信拖出为客户端浏览器内真实 trusted drag/drop，不能扩展为 OS 桌面硬件拖出。

微软拼音证明确实收到 trusted compositionstart/update/input 和中文提交；当前 Harness 会替换 compositionend，因此不声称捕获了 trusted end。AltGr、死键及其他输入法未完整验证。

## 3. 已有功能与文件交换的验收范围

| 功能 | 已有双平台证据 | 尚未覆盖的完整矩阵 |
| --- | --- | --- |
| 长文本转 TXT | 实际 Host 的 ClipboardEvent→官方附件上传，阈值/纯空白/文件等逻辑回归 | OS 真剪贴板全部粘贴入口与输入法组合 |
| 会话分窗与拖出 | 双平台原生窗、身份/复用；Windows最终包 trusted拖出→native prepare/open | 全部任务栏、贴靠、拖出取消、重启/屏幕外恢复 |
| 批量归档、计划批注 | 双平台实际测试会话归档、评论提交与草稿保留 | 所有选择快捷键、复杂长计划/输入法及跨窗矩阵 |
| 会话/工作区菜单 | 置顶、未读、复制调用与持久化 | 剪贴板使用局部 spy；Explorer 真实目录及全部盘符/UNC/长路径组合 |
| 提示词、Q主题、设置/关于 | 实际宿主页面、持久化、Tab/Escape；真实微软拼音5项 | 全部DPI、字体、死键/AltGr、外链与跨窗矩阵 |
| 安装与更新 | 双端官方管理器5项，严格平台/架构/协议/版本/hash/包大小与坏包拒绝 | 占用exe、所有下载中断/并发更新、正式签名/发布 |

文件交换已实现为**手动、默认关闭的专用目录能力**：8MiB/文件、128KiB分块、最多2个未完成事务/16MiB、120秒过期、SHA256、原子不覆盖、目录进程独占、遗留临时文件预算与回收。发布后不回滚、不覆盖；响应未知必须刷新确认，不自动重播。聊天模型没有文件交换工具，也不会收到本机绝对路径。

- 文件系统/Host/React/真实HTTP **35项**已纳入双端完整回归；目录锁竞争、listen失败释放、配对轮换、迟到begin、未知commit、面板卸载均覆盖。
- [Mac→Windows真实NTFS 10/10](../artifacts/computer-use/windows-exchange-final/report.json)：400,033字节中文文件名，Mac SHA、独立Windows Get-FileHash、下载回读一致，路径与同名拒绝、残片清理通过；原生输入/租约调用均为0。
- Windows最终UI12包含 **8MiB** Unicode文件的真实Host/React上传、独立FS字节比较、浏览器下载字节比较、修改内容同名拒绝；该分支 observe/lease/release/act/preview计数全部0。它证明文件链，不能当作独立原生输入证明。

## 4. 主 Agent 图像与真实模型

Mac与Windows实际Harness均证明主Agent公开工具执行，观察截图通过附件和adapter投影。Mac报告实际捕获3次带图请求、4个图片块；Windows最终报告同样验证带图请求和后续真实native move。测试使用本地确定性provider，没有复制真实账户凭据。这证明工具和图片运输，不证明视觉推理。

真实视觉模型固定任务为 **blocked**。当前 `deepseek-flash` 配置没有本次可用图像推理证据，另一本机 `/v1/models` 返回503。不能根据模型名字、本地adapter或浏览器脚本推断完成了视觉模型定位、填写与接管后继续。

## 5. 性能、资源与修复证据

### 最终 Windows 30分钟源画面→renderer

**尚未收尾，不计为通过。** 当前完整运行见 [进度](../artifacts/computer-use/windows-renderer-canvas-final/progress.json)；完成后在此写实际结果。

链路为同一Windows来宾内：640×360、33ms带时间戳动画→最终native CaptureBroker→生产Host→生产预览页面canvas→实际Edge解码绘制。生产源码 `3c924d0`、helper `0eb1fb6a…`；运行时由相同源码独立bundle，并非直接启动tgz内整个插件。真正tgz/SDK/WebView2闭环由上一节UI12及安装5单独验证。

门槛未放宽：≥10完整时段唯一帧/秒，源时钟到完成绘制P95≤500ms，0坏/过旧时间戳，5次受控helper终止后显式重启，0逐帧附件写入；Node RSS≤512MiB，整个自有进程树 WorkingSet sum≤**1,610,612,736字节**，直接native≤1、native树≤4。进程统计包含采样PowerShell/conhost，按同快照PID+创建时间排除PID复用；精确测试helper路径保留孤儿。PrivatePageCount只是原始观察，不另设阈值，WS被trim不能证明私有提交回收。

这不是原生WebView2 renderer长稳，也没有覆盖720p、全部DPI或在途滚动/拖动负载。0无效时间戳不等于零丢源帧，最大间隔包含计划中的helper故障。空闲pause ACK与真正按住后的mouse-up P95分开计。

### 首轮完整renderer：failed，保留原记录

[旧报告](../artifacts/computer-use/windows-renderer-final/report.json)：1,801,317ms、22,441帧、完整时段12.4581FPS、P95 32ms、0无效时间戳、5恢复，但资源failed。最大统计WS为4,790,779,904字节。旧PPID递归误纳入wininit/services/MsMpEng；没有系统误归属的第30秒，自有进程也已1,797,849,088字节，不能把失败全部归于统计。

修正身份统计并复用时间戳解码探针后，[30秒图片版短测](../artifacts/computer-use/windows-renderer-resource-smoke/report.json)仍超限至1,777,467,392字节，证明还要处理图像资源。

### 图像资源对照与生产修复

纯合成浏览器诊断使用相同640×360 JPEG与频率，无native、无解码探针canvas、无强制GC。诊断的passed仅表示实验完成，不等同资源验收：

| 60秒绘制方式 | 实际完成帧 | renderer峰值（字节） | 结论 |
| --- | ---: | ---: | --- |
| 原data URL | 805 | 747,806,720 | 随唯一图片增加而增长 |
| Blob URL+revoke | 803 | 762,523,648 | 没有改善，未采用为修复 |
| ImageBitmap→复用canvas→close | 805 | 257,507,328 | renderer明显下降；整个browser仍峰839,647,232，仍需原生链长稳 |

[前两组](../artifacts/computer-use/windows-preview-image-memory/report.json)、[位图组](../artifacts/computer-use/windows-preview-bitmap-memory/report.json)。生产实现绘制完成后才公开frame，只保留小型metadata，成功创建的bitmap均在finally关闭。控制代次/pagehide阻止迟到解码重绘；坏图清除可操作帧；旧mousedown在暂停/接管/尺寸变化后丢弃。真实浏览器17项中23个bitmap创建、23个关闭、0重复关闭，真实坏JPEG已测试。

### 旧自动暂停误停新任务：已复现并修复

[基线](../artifacts/computer-use/preview-stale-pause-repro/stale-pause-race.json)：旧周期7的第5次画面错误挂住，先外部stop/start新周期9，再释放旧错误，旧自动pause将新任务改为paused/10。[修复后](../artifacts/computer-use/preview-web/stale-pause-race.json)：自动pause携带expectedEpoch7，新任务仍ready/9。Host同步检查与失效之间没有await；连接/恢复中只查询status，错误计数按周期隔离。手动pause与关闭预览仍无条件暂停。

初次canvas故障短测[失败记录](../artifacts/computer-use/windows-renderer-canvas-smoke/report.json)为21,954ms后“操作已暂停或停止”，原记录没有足够event判定其唯一原因，不能事后硬写成全部已证实。后续加入bounded事件时间线、保留原1.2s重启时序，短测通过；已确认的自动暂停竞态另有上述可控因果证明。

最新epoch短测[报告](../artifacts/computer-use/windows-renderer-canvas-epoch-smoke/report.json)：30,794ms、329帧、完整时段10.6842FPS、P95 44ms、0无效、1恢复、最大WS1,536,512,000字节，passed；不替代30分钟。

### 原生截图与释放的历史修复

- 原PrintWindow长稳约1,239秒超时，已隔离为无输入权的capture child；2.5秒超时后须1.5秒内确认退出，最多重试一次只读截图，不重放输入。集成8项、14个真实子进程故障断言、20个不同动画帧通过。
- [采集组件30分钟](../artifacts/computer-use/windows-native-endurance-final/report.json)：1,800.052秒、20,742唯一帧、11.523FPS、采样父/worker私有内存增长4,988,928字节。平均RPC23.2521ms，最大6,420.2101ms，长尾保留。绑定早期helper `86ca7106…`，CaptureBroker此后未改，但不冒充最终包全量长稳。
- Windows拖动期间曾因整窗避让隐藏控制栏，已改为实际指针/路径避让、无安全位置在mouse-down前拒绝；最终52项有持续可见性采样。
- 暂停释放曾两轮P95约1秒；QPC与独立OS观察定位至同线程hook阻塞SendInput，已改专用hook消息线程及有界清理线程，最终30次mouse-up P95 21.7592ms。两条历史失败保留，首个requestToBothReplies仍约1.7秒，不与真正OS释放时间混淆。

## 6. Mac失败、阻塞及未覆盖范围

[Mac完整30分钟旧报告](../artifacts/computer-use/macos-soak-fixed/report.json)是 **failed**：1,800,796ms、19,691有效唯一帧、892无效/过旧时间戳、5次受控终止、0附件写入；即使P95 104ms或旧uniqueFPS达标也不能改判通过。源时间戳冻结在2026-10-20 18:02:33.511 UTC，与pmset显示器熄灭同秒，证据在 `environment-interruption/`。fixture已增加仅生命周期内的防显示器闲置休眠断言与draw遥测；没有修改全局电源或登录设置。修复后短测仍失败，最新桌面锁屏，完整重验blocked。

最新[预检](../artifacts/computer-use/preflight-final-root/report.json)权限为true但session-unlocked为blocked，前台loginwindow。新guard只读/互斥/正常转移/空租约崩溃恢复4项通过，真正按住拖动返回FOCUS_CHANGED，没有观察到down，不能称持有输入后崩溃恢复通过。新canvas的Mac真实WKWebView接管也需解锁后重验；Mac安装5、Chrome17不替代它。

| 未完成验收 | 状态 | 前提/范围 |
| --- | --- | --- |
| Mac新WKWebView手动预览、30分钟、按住后崩溃 | blocked | 用户解锁真实交互桌面；不绕过登录界面 |
| Windows→Mac独立目标完整输入 | blocked | Mac解锁；[反向预检](../artifacts/computer-use/windows-to-macos-preflight-final/report.json)实际未发送输入 |
| 真实视觉模型3固定任务 | blocked | 可用图像模型/当前Harness连接；确定性adapter不覆盖 |
| Intel Mac、原生Windows x64硬件 | not-run | 通用构建/ARM来宾x64仿真分别记录，不能涂绿原生硬件 |
| macOS13、Windows10等旧系统 | not-run | 仅编译目标/兼容设计，不等于旧机运行已验证 |
| 物理多屏、拔插、所有DPI、AltGr/死键 | not-run | 纯几何或微软拼音不能代替完整实机矩阵 |
| Excel专用加载项 | not-run，未实现 | P10独立实现、Mac/Windows Office及加载项环境；普通鼠标点单元格不算 |
| macOS锁屏操控扩展 | not-run，未实现 | P10系统授权/安装/恢复及可恢复环境；未改本机登录机制 |
| 浏览器扩展接日常profile | not-run，未实现 | 当前为独立持久profile或显式回环CDP，没有随包扩展 |
| 正式签名、公证、推送及公开发布 | not-run | 本次只有本地未签名测试资产，没有push、Release或npm publish |

## 7. 可安装资产与证据复现

三个包均通过严格版本/协议/原生架构/hash、64MiB压缩/256MiB解压上限及隔离Host加载校验。Mac为arm64+x64通用资产；Windows按架构选择，PD来宾使用ARM64包。`dsh-qiuya-tools.tgz`是Mac通用包兼容别名，不用于Windows安装。

| 资产 | 字节数 | SHA256 |
| --- | ---: | --- |
| `dsh-qiuya-tools-darwin-universal.tgz` | 721,180 | `e528ed9663494d34fd133778ac4ec14442bb6528ba29a659dc6744f0b3d3c679` |
| `dsh-qiuya-tools-win32-arm64.tgz` | 62,725,509 | `ab9d9b12c2757b0ee717c2f091e75d11669724df1bd9bbd46de93f47287c3f20` |
| `dsh-qiuya-tools-win32-x64.tgz` | 66,978,296 | `54f25c87ed911ed91b293646c19da2b08dee518003dc514969c739308af176e7` |

这些是Harness插件tgz，不是独立OS安装器。Windows最终用户不需要.NET开发SDK，WebView2 Runtime前提及命令见 [安装指南](computer-use-guide.md)。[原生与依赖manifest](../artifacts/delivery-manifest.json)绑定精确资产，历史包另存 `artifacts/pre-memory-candidate/`。

核心复现入口：

```sh
QIUYA_TOOLS_UNIVERSAL=1 npm run check
node scripts/test-computer-preview.mjs
node scripts/computer-preflight.mjs --target local --output artifacts/computer-use/preflight-new
node scripts/e2e-harness.mjs --package /absolute/candidate.tgz
node scripts/test-harness-install.mjs --package /absolute/candidate.tgz --old-package /absolute/previous.tgz
```

Windows PD入口：[原生runner](../scripts/test-windows-native-pd.mjs)、[宿主与安装runner](../scripts/e2e-windows-harness-pd.mjs)、[长稳runner](../scripts/soak-windows-pd.mjs)、[跨电脑文件](../scripts/e2e-windows-exchange-pd.mjs)。长稳与GUI测试的短租约必须按已导出的guest测量起点协调，避免互相抢桌面。

最终真实窗口证据：

![Windows实际悬浮预览](../artifacts/harness-e2e/windows-canvas-final/manual-preview-window.jpg)

[目标实际收到中文并回复](../artifacts/harness-e2e/windows-canvas-final/manual-preview-target-result.jpg)。以上为实际测试窗口，不是设计稿；本地确定性模型回复不能称真实视觉推理。
