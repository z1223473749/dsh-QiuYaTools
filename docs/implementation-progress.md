# 双平台适配与电脑操控实施记录

本文件为 2026-10-21 的证据快照。分支 `codex/cross-platform-computer-use`，版本 `0.6.0-beta.1`。已完成步骤分别使用中文 Git 提交；没有 push、Release 或 npm publish。当前共享前端包含批量归档修复 `0b5396e`，重新构建与资产回执绑定 `38b929dee91861a29f7e1e74ff16d743377267c0`；Windows正式PE及嵌入元数据绑定 `4dcb3af5881fc1d827f86bf027b632f0207abb35`，无诊断代码。旧 `3c924d0 / 3c6e865` 的测试只保留其原代次结论。

详细结果见 [测试报告](computer-use-test-report.md)，范围与原始门槛见 [开发计划](windows-and-computer-use-development-plan.md)。`passed` 只覆盖该行列明环境；`failed`、`blocked`、`not-run` 均不计为完成。基础交互已有实际可安装包，整体尚未通过“全部功能跨平台、完全复刻”的验收。

## 阶段进度

| 阶段 | 状态 | 已取得证据与剩余门槛 |
| --- | --- | --- |
| P0 基线与环境 | passed（各次列明环境） | 初始基线393项；当前Mac完整check **533/533**、0失败/跳过，日志final-lifecycle-webview-check.log；528/528保留为console清理修复前历史快照。Windows当前源码3a4dcd2的533项中529 passed、4个Mac-only skipped、0 failed；含最新批量菜单和生命周期回归 |
| P1 原有功能Windows适配 | blocked（完整矩阵） | 平台资产、PE/架构/协议、原生分窗已实现。历史ARM64包ab9d9b12…真实Harness12/12，Mac历史解锁时10/10，微软拼音硬件输入5/5。上一代置顶包0d341525…第二轮电脑case9通过、批量归档case10失败；独立菜单刷新缺陷已修，当前ARM64 5609bc04…及x64 95f0c9b9…新包各Host12/12和安装5/5通过；x64为ARM来宾转译。全部DPI、窗口恢复、OS剪贴板、盘符/UNC、AltGr/死键等未完整验收 |
| P2 会话与输入控制核心 | passed（列明回归） | 类型化协议、授权、会话隔离、互斥、epoch、去重、取消/暂停/接管/继续、几何校验、失败撤权/释放/迟到连接等回归纳入当前Mac533项；过期自动pause不能停止新任务。Windows同快照529 passed/4 skipped/0 failed |
| P3 主Agent与图像 | blocked（真实模型） | 双端历史实际SDK工具、附件与adapter运输通过；Mac实际3次带图请求/4图片块，当前Windows ARM64 5609bc04…Host12/12亦有带图与native动作，上一代0d341525…电脑case9通过。确定性provider不证明视觉推理。当前官方flash目录声明text+image，真实owner RPC401、桌面锁屏未取得合法renderer连接，实际账号服务及固定视觉任务仍未验 |
| P4A Mac原生执行器 | blocked | ARM64历史原生11项、通用构建/自测通过；新guard只读/互斥/转移/空租约崩溃恢复4项通过。真实按住后崩溃恢复未完成，最新桌面锁屏；Intel与最低系统未实测 |
| P4B Windows原生执行器 | passed（两架构列明范围） | 当前正式ARM64与x64 helper各原生52/52及对应架构真实Node隐藏5/5通过，ARM64 remote15/15通过；矩阵windows-pinning-native-matrix.json绑定精确SHA。x64原37项中36通过、humanInput断言1失败保留；只读排空stdout在原stale reply后20ms收事件，extraActions=0/extraHidInputs=0，未改PE或补输入。历史mouse-up30次P95 21.7592ms/最大24.1073ms、截图8项保留原代次，仍无原生x64硬件证据 |
| P5 悬浮实时预览 | failed / blocked（完整矩阵） | 共享Chromium17/17，当前两架构正式包各Host12/12及原生手动中文/四按钮/两次置顶通过；本轮只用原位暴露点，未走corner移动fallback。旧0eb/3c924的640×360 Edge30分钟passed不能移作新helper/WebView2/720p证据。新720p真实原生WebView2首轮30,073ms/300帧/fullwall9.9757<10、P9596ms/0invalid/1fault/WS1,411,133,440B，FPS与清理均failed。后续60秒整链13.2630FPS/P9540ms/0invalid/1fault及自然清理passed，正式30分钟进行中；Mac长稳failed后仍锁屏阻塞 |
| P6 独立环境 | blocked（反向实机） | 当前正式ARM64 helper Mac→Windows15/15，配对/撤权/心跳通过，environment内嵌report。手动文件交换35项、真实NTFS10/10、当前ARM64 Host UI8MiB上传/下载与同名拒绝通过，文件分支observe/lease/release/act/preview调用0（status查询不为0）。Windows→Mac因Mac锁屏未发送输入，不用回环替代第二目标 |
| P7 浏览器通道 | passed | Mac Chrome与Windows Edge各10项实际浏览器检查；独立持久profile、显式CDP、站点许可、导航/标签页、Agent注册及失败释放回归。没有随包日常profile浏览器扩展，真实视觉推理由P3另验 |
| P8 安装与更新 | passed（当前本地测试包范围） | 当前Mac58126d4a…、ARM64 5609bc04…与x64 95f0c9b9…各官方管理器5/5通过；x64是真实x64 Node在ARM来宾转译。上一代正式置顶包0d341525…/db8bdccc…各5/5保留。当前三包严格版本/协议/架构/hash/大小及隔离Host加载通过。CI未远程执行，正式签名、公证、公开发布not-run |
| P9 完整验收 | failed / blocked | 当前ARM64及x64包各实际UI12/12与安装5/5通过，两架构正式PE52+隐藏5及ARM64 remote15通过；Windows同快照全量529 passed/4 skipped/0 failed。原生WebView2/720p首轮短测FPS及清理failed，修正后的60秒整链passed，正式30分钟进行中。Mac长稳failed，后续Mac输入、反向目标与真实模型blocked；整体不能报告完成 |
| P10 Excel与锁屏扩展 | not-run，未实现 | 专用Excel加载项、macOS锁屏操控需独立实现和对应Office/系统会话环境；普通点击不替代专用扩展 |

## 主要修复及其依据

- 授权写入串行化并遵循最新意图；撤权立即停止输入，不等待磁盘写入；失败写入不会复活授权。
- 独立跟踪真实native lease epoch，保留失败释放与不确定获取；切换/卸载使用generation和取消信号，迟到连接不能重装执行器，退役失败在切换前重试。
- 双端桌面互斥、输入记录与guardian按owner隔离；Windows检查SendInput释放，保留Unicode scan unit；Mac真实持有输入后的恢复仍待解锁验证。
- 浏览器在down前记录释放义务，只有CDP确认up才清除；不确定释放阻止新租约，附着用户浏览器不强关进程掩盖失败。
- Windows截图隔离到无输入权的持久child；超时/协议损坏须确认退出，才允许一次只读重试；输入不重放。watchdog绑定PID及出生时间，避免遗留或PID复用。
- Windows隐藏启动恢复实际窗口显示；浮层按实际指针路径避让并持续可见，无安全位置在mouse-down前拒绝；hook消息线程与清理线程分离，历史实际mouse-up由约1秒降至P95约21.76ms。真实Host置顶缺口已改为preview CreateParams在句柄创建时声明WS_EX_TOPMOST；正式PE不含诊断源码，两架构原生52+对应Node隐藏5均重验通过；x64原humanInput失败只读排空stdout后复核通过，未改PE或重发输入，旧失败保留。
- 图片绘制从每帧data URL改为ImageBitmap→复用canvas→finally close；旧周期解码/手势清除；自动pause携带expectedEpoch，不能误停新周期。真实Chromium17项包含23次bitmap创建/关闭及真实坏JPEG。
- 手动文件交换默认关闭，专用真实目录、8MiB/文件、SHA256、原子不覆盖、事务预算与到期清理。目录进程独占按系统明确确认的死PID回收；不确定状态不删除已发布文件，不向模型开放路径读写。
- 批量归档订阅曾对所有状态通知无条件关闭菜单。独立可控复现后先加入失败回归，再按所选ID/标题和展示文案签名收紧刷新：无关变化保留同一菜单与焦点，相关变化仍关闭。22/22及typecheck通过；真实Windows该轮菜单失败没有同刻回调trace，不能声称已确定唯一原因。
- 发布校验原生版本、协议、架构与hash；Windows分架构产包，未提高64MiB压缩上限。三个最终资产及各native组件SHA见delivery-manifest。

## 长稳结果与当前阻塞

历史x64真实Node宿主首轮11/12，诊断轮10/12。已抓到浮层WS_EX_TOPMOST=false及手动点击目标后footer被遮挡；初次激活与第二次Continue的原因未完全确定。原包首次显示时间线未采到置顶，诊断副本SetWindowPos返回true/error0但即时及下一消息轮仍缺少置顶，不能说成已观察到UIA或导航事后撤销。后续只改变CreateParams初始化的诊断候选a469d15d…实际12/12通过，首次及目标点击后均置顶；该候选含诊断代码，不充当正式包验收。

生产正式PE从4dcb3af无诊断源码重建：ARM64 68,227,039字节/SHA `42889f9c6eda3d5971b9d33e06dc022c1d2731faad6e7b33d536995197ba4a63`，x64 72,050,776字节/SHA `3f0073ba52ff17bf2cdee9d65196b5753b7b334f497bb5f69693f8b7ea8a4594`。[构建回执](../artifacts/computer-use/windows-native-pinning-final-build/receipt.json)绑定编译输入及SourceRevisionId。上一代正式ARM64包0d341525…两轮各11/12：[首次](../artifacts/harness-e2e/windows-pinning-arm64-activation-failure/report.json)激活前置失败，[第二轮](../artifacts/harness-e2e/windows-pinning-arm64-archive-menu-failure/report.json)电脑case9全部通过、批量归档case10失败；x64包db8bdccc…[激活前置拒绝](../artifacts/harness-e2e/windows-pinning-x64-activation-failure/report.json)为11/12。各自安装5/5通过。这些旧候选报告不能替代当前包验收；当前ARM64与x64已各另行Host12/12及安装5/5通过。

当前x64正式PE另列：[原生首轮](../artifacts/computer-use/windows-native-x64-pinning-final/report.json)37项中36通过、humanInput通知断言失败保留；[只读事件排空后52/52](../artifacts/computer-use/windows-native-x64-event-drain-final/report.json)通过，通知在原stale reply后20ms到达，extraActions=0、extraHidInputs=0，未改PE或重发HID。[真实x64 Node隐藏启动](../artifacts/computer-use/windows-node-hidden-x64-pinning-final/report.json)5/5通过；当前ARM64 remote[15/15](../artifacts/computer-use/windows-remote-pinning-final/report.json)通过，环境信息内嵌report。[聚合矩阵](../artifacts/computer-use/windows-pinning-native-matrix.json)保留各原始报告和精确helper SHA。

当前ARM64包5609bc04…[实际Host12/12](../artifacts/harness-e2e/windows-bulk-stable-arm64-final/report.json)及[官方安装5/5](../artifacts/install-e2e/windows-bulk-stable-arm64-final/report.json)通过：actualhelper42889、两次TopMost=true、中文真实提交、trusted浏览器drag、8MiB文件交换与分支0原生误发。safe-placement本轮只在原位找到暴露点(1204,133)，没有走corner移动fallback，不能报告该分支已验。当前x64包95f0c9b9…由真实x64 Node在ARM来宾转译，[实际Host12/12](../artifacts/harness-e2e/windows-bulk-stable-x64-final/report.json)和[官方安装5/5](../artifacts/install-e2e/windows-bulk-stable-x64-final/report.json)均通过、exit0，实际PE3f007、两次TopMost=true、manual中文实际目标提交及回复、trusted拖出/批量归档/8MiB均覆盖。SetValue1次及Current.Value1次只读观察85.3236ms匹配；原位暴露点(808,133)可用，没有走corner移动fallback。两架构均为确定性主Agent运输，非真实视觉；所有fixture已退出且无保留租约。

批量菜单已独立修复0b5396e：[先红](../artifacts/computer-use/bulk-archive-refresh-repro/regression-before-fix.log)→[22/22通过](../artifacts/computer-use/bulk-archive-refresh-repro/regression-after-fix.log)，但本次实际Windows失败唯一原因尚不能定。当前新包与Mac533项已包含修复，当前ARM64与x64各Host12/12及安装5/5通过；Windows同快照全量529 passed/4 skipped/0 failed。

原生WebView2/720p[首轮短测](../artifacts/computer-use/windows-webview2-720p-smoke/report.json)failed：30,073ms/300帧，完整壁钟9.9757FPS<10（未放宽门槛），P9596ms、0invalid、0wrongDimensions、1fault，WS1,411,133,440B bounded。source/captured JPEG/canvas1280×720，Form600×420缩放，不能称物理720p viewport或scroll/drag endurance。runner conhost10996被误要求提前退出并forced killed，inner=false；outer4,704字符EncodedCommand执行失败，delivery=false；事后48身份均gone不能代替outer通过。原失败保留。第二轮60秒虽然12.7932FPS/P9551ms达标，仍因错误的GetConsoleWindow归属与空列表清理失败；该API推断已删除。独立CreateNoWindow实测20次均见自有Node直接conhost，Node自然退出后均消失，未使用kill。当前按同快照精确身份/路径/直接父关系仅将runner控制台基础进程延后核验，仍计入资源与outer自然退出；其他native/WebView2/source须先退出，任何强制清理使delivery失败，大PS改短File传输。

[修正后60秒整链](../artifacts/computer-use/windows-webview2-720p-lifecycle-smoke/delivery-verdict.json)passed：60,092ms/797帧/完整时段13.2630FPS/P9540ms/0invalid/0wrongDimensions/1fault，NodeRSS峰71,905,280B、自有WS峰1,459,101,696B。inner、runner退出后49身份、outer自然清理和launcher回执均passed，exit0、无强制清理。短测不替代30分钟，正式30分钟/5fault进行中；详细原始链接见测试报告。

清理语义[实际Session0预检6/6](../artifacts/computer-use/windows-webview2-pinned-cleanup-preflight-2/report.json)通过，仅自有15秒寿命Node子进程，无GUI/input；此前[SystemTemp staging失败](../artifacts/computer-use/windows-webview2-pinned-cleanup-preflight/report.json)保留，当次没有启动child。另[HTTP/File AST三个源解析](../artifacts/computer-use/windows-webview2-cleanup-review/powershell-parse-http.json)通过，执行进程操作0；不替代长稳或自然清理结果。

1. 历史3c924源码/0ebhelper的30分钟源画面→Edge renderer passed：1,801,027ms、23,025帧、完整时段12.7844FPS、P9532ms、0无效、5终止/显式重启、0附件spy写入，Node RSS峰133,132,288B，自有WS峰1,549,283,328B<1.5GiB。61份资源采样及私有提交趋势保留，完成回执exit0，171个采样进程身份事后均已退出。负载仅640×360的共享Edge前端，不代替原生WebView2/720p/滚动拖动长稳。
2. 历史Windows renderer完整30分钟画面指标通过但资源failed：既有PID复用误归属，也有真实自有进程超限。统计修复和图片/Blob对照后，采用位图释放修复；保留所有失败报告。旧native采集组件30分钟passed不是最终renderer全量证明。
3. Mac完整30分钟旧报告failed，显示器熄灭同秒源时钟冻结；fixture仅增加生命周期内防显示器闲置休眠和draw遥测，没有更改全局电源或登录。[最新预检](../artifacts/computer-use/preflight-during-final-pinning-validation/report.json)仍session-unlocked blocked、前台loginwindow，权限true不等于可输入。解锁后须重验Mac长稳、新WKWebView接管、真实持有输入后的guardian和Windows→Mac目标。
4. 真实视觉固定任务blocked：官方默认account/flash目录已确认text+image；现有desktop公开owner RPC401且锁屏未取得合法renderer，尚未调用真实推理。另一本机49506/v1/models的503只对应自定义route，不代表默认account无图片能力；解锁后应复用现有登录态验证。
5. 另需原生Intel Mac/Windows x64硬件、旧系统、全部DPI/物理多屏、AltGr/死键和完整路径矩阵。P10专用扩展及浏览器日常profile扩展仍未实现。

## 本地交付

- `artifacts/dsh-qiuya-tools-darwin-universal.tgz`：721,303字节，SHA256 `58126d4a95cb9e28962b31f4144259c315eb1a6a403478d3549ef8db343a09d2`。
- `artifacts/dsh-qiuya-tools-win32-arm64.tgz`：62,725,649字节，SHA256 `5609bc04963b13be517c5187821343c71c4bd5747a3dc5138e811a083a1bff14`；PD来宾使用此包。
- `artifacts/dsh-qiuya-tools-win32-x64.tgz`：66,978,457字节，SHA256 `95f0c9b968f9e5464b71d64e505804ecefe1ac2c1cd06abc48e1f55a79328604`。

均为未正式签名/公证的Harness插件tgz，本次没有公开发布。`dsh-qiuya-tools.tgz`仅为Mac通用包别名。正式运行前提和命令见[使用指南](computer-use-guide.md)。主要证据在`artifacts/computer-use/`、`artifacts/harness-e2e/`、`artifacts/install-e2e/`；置顶修复前包/helper保留于[pre-pinning-candidate](../artifacts/pre-pinning-candidate/preservation.json)，正式置顶但菜单修复前包保留于[pre-bulk-menu-candidate](../artifacts/pre-bulk-menu-candidate/preservation.json)，更早候选保留于`artifacts/pre-memory-candidate/`；不得把旧包测试误记到新SHA。
