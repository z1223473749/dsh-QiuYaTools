# 双平台适配与电脑操控实施记录

本文件为2026-10-21的证据快照，版本`0.6.0-beta.1`、分支`codex/cross-platform-computer-use`。提交规则已统一为完整功能的代码、构建与测试一起中文提交；本轮没有 push、Release 或 npm publish。详细SHA、实际JSON和历史失败见[测试报告](computer-use-test-report.md)，原始门槛见[开发计划](windows-and-computer-use-development-plan.md)。

当前实施依据已统一到[开发计划](windows-and-computer-use-development-plan.md)。提交粒度为可独立使用的完整功能，代码、构建和相关测试一起中文提交；不把整套长稳及真实模型矩阵当作所有功能提交的前置条件。本批统一交互源码已冻结、生成验证包并完成相关回归，尚未宣称完整交付。

## 本批完整功能与后续顺序

| 完整功能 | 当前状态 | 依据与下一步 |
| --- | --- | --- |
| 聊天自动入口与应用授权 | 已实现并完成相关回归 | discover／request_control、owner三选授权、generation取消、最终窗口身份绑定、launch FIFO及未知结果围栏；标准shell相关91/91；Mac旧候选实际主Agent Move与图片链通过 |
| 系统权限与应用管理 | 已实现，实际系统跳转矩阵继续验收 | 无聊天预检、固定设置入口、手动添加／撤销；Windows正式PE两架构目录／权限18/18纯无界面通过 |
| 统一设置与满幅小预览 | 已实现并完成相关回归 | 首位电脑导航、工具箱卡片／Switch、聊天授权与权限引导；固定300×180、X/Y铺满、hover/focus控件、−仅隐藏控件、弹出后同iframe保持实时；UI54/54、真实headless小框13/13、预览页25项；Mac全量730/730及universal构建通过 |
| 双平台原生操作与指针 | 原生基线已验证，独立风险继续修复 | Windows正式PE两架构各52＋29通过；Mac已发现同PID重叠窗口前台身份不足，下一次独立修复后冻结新helper，未计为已解决 |
| 后续独立修复与验收 | 继续执行 | 先修Mac exact窗口输入边界，再新候选Mac／PD Harness实际流程和安装；随后真实模型三任务、多聊天、双端长稳、反向严格清理及现有功能完整矩阵。历史通过仍只适用其SHA |
| 本批构建与Git | 本批统一提交，未公开发布 | 验证包 `artifacts/candidates-chat-full-frame-feature/`，完整SHA见相邻JSON；记录未通过项，后续修复各自构建、测试、中文提交 |

本轮开始前，已精确终止视觉测试第四轮的自有 carrier，两个已运行 fixture／helper 自然清理且 oracle 自然退出，`cleanupErrors=[]`；实际 Harness 官方卸载回执为 `changed=true/application=applied`。第四轮任务 1 通过、任务 2 达预算且出现一次拒绝，任务 3 未运行，未算作三任务通过。证据见 `artifacts/model-capability-resumed/actual-vision-external-attempt-4/`，私有模型正文未归档。

以下为本轮 UI／流程调整之前的历史快照。历史具体资产与结果保留用于对照，当前交付仍须以本轮冻结源码和包的实际报告为准。

## 阶段快照

| 阶段 | 当前状态 | 已取得证据及剩余范围 |
| --- | --- | --- |
| P0 基线、环境、构建 | passed（列明快照） | Mac完整check617/617、typecheck/universal通过；其后test-only变更另有targeted。Windows真实Node实际636总/627pass/9skip/0fail，逐文件与SDK验证、任务自然退出通过。此前628是错误预估，不能当实际计数 |
| P1 现有功能Windows适配 | 部分passed，完整矩阵未完成 | 旧5609/95f0包各实际UI12与安装5通过；新504999/752bc4包仍待同SHA整包UI/安装。新Mac e0a99基础UI10和安装5通过，扩展手动UI为11/12；OS剪贴板、全部路径/窗口恢复/DPI/输入法矩阵未全覆盖 |
| P2 控制核心、调度与隔离 | passed（逻辑/Host分项）；实机并发待验 | 类型化协议、应用授权、epoch/owner、互斥、释放义务、取消/断连/迟到结果隔离；默认manager按聊天隔离，动作FIFO，每act真实lease/release。真实双聊天drag与A弹出/收回不干扰B尚未完成 |
| P3 主Agent与图片/真实模型 | 图像运输passed；真实视觉首两轮failed | 确定性provider有真实JPEG与performed回执。真实账号external首轮task1pass、task2到12请求且2denials失败；第二轮task1pass、task2仍12请求失败但0denials/0act。不能再写“未发过推理”，也不能报告三任务通过；本机Harness TCC另有准备失败 |
| P4A Mac执行器 | 历史输入/guardian分项passed；新整体未通过 | 2965原生11项、4769独立OS-held drag后SIGKILL/guardian恢复5项通过，均精确保留旧SHA。6883小指针首轮8分项后GEOMETRY_CHANGED整体failed，后续像素/OS-empty轮次failed；新完整13项仍待验 |
| P4B Windows执行器 | passed（正式PE列明范围） | 正式4c7 ARM64与edc x64各原生52/52、AI/预览扩展29/29通过；x64为ARM来宾转译。新的held采样门槛200ms/10ms/>=5保持，分别11/12有效采样；新helper完整remote/P95另列待验 |
| P5 实时预览/指针/人工接管 | 分项passed，完整矩阵failed/not-run | 聊天inline与原生popout/redock已实现，approved小号白描边灰箭头与actor隔离有浏览器/Win实测。Mac showsCursor=true配对图证明OS黑箭头叠盖AI箭头；Mac WK唯一资源归属与30min失败。旧Windows720p30min通过只对应42889及该Host bundle |
| P6 独立环境/文件交换 | 部分passed，双向严格delivery未通过 | 历史Mac→Win15/15、NTFS10/10、UI8MiB通过。反向解锁后已真实点击/Unicode/快捷键/撤权/恢复/预览9项通过，但最终Windows身份/OS-empty审计失败，不能说未输入也不能算完整passed |
| P7 浏览器通道 | passed（既有10+10实测） | Mac Chrome/Win Edge独立profile、显式CDP、站点许可、导航/标签页、Agent注册；不等于随包扩展控制日常浏览器profile，真实模型另验 |
| P8 安装与更新 | 旧三包与新Mac分项passed；新Win待验 | 新Mac e0a99安装5通过；新Win两包严格校验通过但尚无同SHA实际UI12/install5。签名、公证、远程CI和公开发布未做 |
| P9 完整验收 | 未通过 | 当前Mac原生指针/WK/默认manager、严格反向delivery、真实视觉三任务、新Win完整包与新组件性能、完整硬件系统矩阵均有未完成项 |
| P10 完整Codex对齐扩展 | not-run，尚未实现 | Excel专用加载项、macOS锁屏扩展、随包日常profile浏览器扩展没有由普通鼠标/独立profile结果代替 |

## 历史候选和组件（本轮重设计前）

最新候选独立存放于`artifacts/candidates-capture-fifo-rounded/`；Mac为`e0a99a113c90a8b17aa05520f1519b55c47252ddc6c6aad55e4d521cfd1a7fdc`，Windows ARM64为`50499928e9e14d77ffe7cfc835ef7019e6171fe94c51fece2e12327b35d59901`，Windows x64为`752bc49871e64dc77b9881b7426ec3626415d3370d45acc8a00e25f2ecb2bcc5`。详见测试报告资产表。

当前Mac computer helper为`688315b434eecca56292301950d2237900f266856bb0cb3c996e9130b6d945b8`、912,504字节、arm64+x86_64；Windows ARM64为`4c7dec7049e1094e8b9128e0ed9191dc0cd1b770d8a030b180419593c16041a7`，x64为`edc1883deb5abc84e72ddb483ddaf067d512a5a8223365015fc60f5c2e349f11`。根目录`delivery-manifest.json`与58126/5609/95f0包仍是旧资产名录，不能当作新候选已完成交付的证据。

## 新增实现与实际修复

- 每个聊天保存自己的环境、设备、目标和状态；共享物理桌面通过FIFO调度逐动作lease，不用一个全局连接开关覆盖全部聊天。logical ready与native lease分开。
- 聊天上下文显示实时小框；用户主动弹出/收回，普通close仍pause绑定会话，preserve收回不发previewClosed。不同聊天的生命周期不得互相撤权；完整实机多任务仍待验。
- 实际目标上AI箭头采用批准的18×20 viewBox、hotspot(2,3)、半透明灰填充/细白边/软灰光晕。native OS cursor与aiCursor分开，human lease隐藏AI；不靠模型提供actor。Mac系统指针叠盖是明确未决问题，不用无系统指针截图掩盖。
- NativeCompanionDriver截图队列修复真实JSONL CAPTURE_BUSY：最多16capture jobs/128 callers，同target preview合并，model observe单独fresh FIFO；单caller abort不取消其他caller、不提前放开活动capture；输入/status/release不被截图排队阻塞。旧实际Harness失败唯一原因仍未定。
- Windows preview专属CreateParams保证初始TopMost；Show隐藏兼容、真实轨迹避让、hook独立线程、有界截图worker、owner journal/guardian与失败释放保持。新WebView2每helper完整GUID范围内32个短槽，完整SHA仅在内存做key；165字符UDF预算在创建前失败，旧session UUID存储与reparse拒绝不变。
- 真实模型测试使用公开SDK/图片附件/现有默认模型、四工具白名单与自有fixture。外部carrier通过标准paired remote暴露唯一目标，不修改TCC；0600一次性rendezvous、精确进程/路径/SHA绑定。owner connect/status/恢复限定本轮newSID，模块import带bundleSHA query避免旧owner函数缓存。

## 失败、边界和下一步

历史失败原样保存：Win采集挂起/约1秒暂停尾延迟、旧浮层未真正TopMost、菜单无关刷新关闭、WebView2资源/生命周期和9.9757FPS短测、Mac熄屏源时钟冻结、解锁前FOCUS_CHANGED、反向bootstrap/身份/OS-held失败、当前Mac指针/预览以及真实模型任务2失败。

最新Windows[52采样ARM64](../artifacts/computer-use/windows-preview-sampler-arm64-formal/baseline-52/acceptance-summary.json)、[52采样x64](../artifacts/computer-use/windows-preview-sampler-x64-formal/baseline-52/acceptance-summary.json)、[29 ARM64](../artifacts/computer-use/windows-preview-slots-arm64-formal-2/acceptance-summary.json)、[29 x64](../artifacts/computer-use/windows-preview-slots-x64-pointer29-formal/acceptance-summary.json)均passed，但物理HID点击自己的预览仍unverified；真正VM Escape中断与Win32 SendInput分开记。x64不能涂绿为原生x64硬件。

后续顺序以统一开发计划第 5 节为准。任何必测项 failed／blocked／not-run 均不报告完整复刻；正式签名、公证、公开发布与 Office／锁屏扩展分别记录，不擅自改变用户登录与系统安全配置。
