# 双平台适配与电脑操控实施记录

## 2026-10-22 最新索引与当前阶段

**整体尚未完成完整验收。** 本节覆盖下方历史快照中“当前／最新／待验”的旧称呼。版本为 `0.6.0-beta.1`，分支 `codex/cross-platform-computer-use`；完整功能连同构建、测试一起中文提交，未 push、Release 或 npm publish。详细资产 SHA、原始失败和当前剩余项以[测试报告](computer-use-test-report.md)为准，原始门槛以[开发计划](windows-and-computer-use-development-plan.md)为准。

| 本轮证据范围 | 已取得结果 | 依据与边界 |
| --- | --- | --- |
| Windows 当前双包 | ARM64 `8b5dca9f…5c6e3`、x64 `3542d877…90c` 各完成完整 UI **12项**、官方安装 **5项**、严格业务专项 **8项**；状态补验另各 **5项**、合计12张状态图 | [真实 Harness](windows-harness-pipeline-evidence.md)、[状态补验](windows-ui-state-acceptance.md)。对应正式 PE 为 `c8be`／`3d22`；x64 在 PD Windows 11 ARM 兼容运行，不代表物理 x64 硬件 |
| Mac 当前候选 | 包 `9b828d9b…5e6f3`／helper `66ae37d0…6e502`：真实隔离 Host＋headless Chrome **DOM 8项**、24张状态图；文件交换 **4项**、真实8MiB上传／下载／同名拒绝；官方安装生命周期 **5项** | [DOM界面](harness-dom-acceptance.md)、[文件交换](macos-file-exchange-acceptance.md)、[安装](macos-install-acceptance.md)。DOM排除原生分窗／拖出／电脑输入，文件交换仅 status/targets-only stub，不由这些结果证明native操控 |
| Mac 正式键盘修复 | 66ae universal构建及21项相关回归通过；同SHA真实中文正例、兄弟窗口／原进程退出负例尚未实测通过 | 旧0143红例、隔离ac88绿例分别保留；不能移记到66ae。旧0143正式指针13/13与WK30分钟／5恢复也只属于旧SHA |
| Windows 浏览器 | Edge与官方ARM64 Chrome分别 **10/10**，真实CDP及Agent注册回调、自然浏览器退出、精确任务注销、idle恢复通过 | [浏览器与依赖](windows-browser-test-dependencies.md)。Chrome首次MSI身份验收failed仍保留，事后独立签名／PE／默认关联证明依赖可用，不倒填安装通过 |
| Windows 当前 PE 预览性能 | ARM64 c8及x64 3d各三十分钟／五次恢复通过；x6424,490帧、13.605fps、P95 45ms、全树峰值1,567,682,560B低于原1.5GiB门 | [当前WebView2性能](windows-webview2-performance-evidence.md)。采样器自身计入，原资源失败与首轮FPS失败保留；实际x64为PD ARM兼容，性能轮不做输入，不代表物理x64 |
| 独立环境 | Mac→Windows当前c8组件 **15/15**，旧token拒绝、输入归还、精确自有进程自然退场、正常任务清理通过 | [远端实际验收](windows-remote-acceptance.md)。Windows→Mac当前正式组件的严格闭环尚未完成 |
| 真实 DeepSeek | Windows c8第四轮确认／中文备注及Enter／拖动三项全部通过；业务、图片nonce、自然清理及官方移除／owner恢复分别通过；Mac当前66ae真实模型待验 | [Windows真实模型三任务](windows-real-model-acceptance.md)。固定目标四工具不代替自然discover／request授权；备注任务一次旧帧拒绝并重新观察后完成，重复完整click及历史失败均保留 |
| 项目外视觉索引 | 已通过75张：保留原72张并追加真实DeepSeek三个最终画面；117份来源SHA／字节及200本地链接自检通过 | 新目录 `/Users/qiuya/QiuYaTools-验收/2026-10-22/视觉画廊-75图-真实DeepSeek追加-7ea2ea32-11a0-44a2-8182-d46ca7441d0c/`，原72图目录不变。新增3图仅标Windows ARM64固定四工具真实模型；不扩张自然入口或x64范围 |

| 阶段 | 当前状态 | 仍需完成或明确边界 |
| --- | --- | --- |
| P0 基线、冻结与最终全量检查 | 当前源码快照的生产JS只读构建、typecheck及940/940完整直接测试通过，397个输入稳定 | 四个native／包元数据未改写；后续源变化需新快照检查，不重建后继承旧SHA |
| P1 现有功能与双平台界面 | Windows双包12＋5＋8及各5状态补验通过；Mac DOM8＋文件4＋安装5通过 | Mac真实原生分窗／拖出等仍须同包实测，系统／硬件／输入法完整矩阵未全覆盖 |
| P2 控制核心、调度与隔离 | 实现与逻辑／Host分项通过；默认manager实际多聊天闭环未完成 | 双聊天并发、FIFO及A弹出／收回时B指针需完整实际通过，不把分项绿作为全轮绿 |
| P3 主Agent图片与真实模型 | Windows当前c8固定目标四工具真实DeepSeek三任务通过；确定性provider链路另有证据 | 自然discover／request／授权补验及Mac当前66ae真实三任务仍待验，不把其中一条链路替代另一条 |
| P4A Mac执行器 | 当前66ae已构建／相关回归通过，同SHA原生实测未完成 | 中文配对、歧义／退出负例、指针及默认多聊天逐项绑定新SHA；锁屏期间不输入、不绕登录 |
| P4B Windows执行器 | 当前c8／3d各原生52＋预览指针29、应用权限18项通过 | 与整包UI、真实模型、预览性能分别记证；不推导未测的系统／设备矩阵 |
| P5 实时预览与恢复 | 当前c8与3d WebView2各三十分钟／五次恢复通过，完整壁钟、资源与自然清退过原门槛 | Mac66ae新绑定仍待通过，旧0143不可继承；性能轮不代替held-input或停止延迟 |
| P6 独立环境与文件交换 | Mac→Win15及当前Mac8MiB文件交换通过 | Win→Mac严格delivery未完成；文件服务stub不当作native权限证明 |
| P7 浏览器通道 | 当前Windows Edge10＋Chrome10通过 | 只证明隔离profile／显式CDP／站点许可与注册工具，不等同日常profile随包扩展或真实模型 |
| P8 安装与更新 | 当前Windows双包各install5、Mac当前包install5通过 | 均为隔离测试安装生命周期；最终包本机安装及受影响视觉复验仍需收口，未签名／公证／公开发布 |
| P9 完整交付 | **尚未通过** | Mac当前真实DeepSeek／原生／多聊天、自然会话入口补验、Windows默认manager双聊天、严格反向环境、最终变更回归及安装包汇总仍有未完成项 |
| P10 Codex扩展 | 计划已收集，独立能力未全部实现 | Office专用加载项、锁屏扩展、日常profile浏览器扩展及工作台H阶段不由鼠标或独立profile结果代替 |

后续按完整修复单元继续：Windows工作目录／可信子进程与真实模型三任务已完成，当前双Windows长稳已通过，继续自然会话入口与Windows双聊天补验，再完成Mac解锁后的正式原生与反向闭环，最后冻结源码做最终检查、同字节包与安装／视觉复验。每个完整改动连构建、测试中文提交；成功截图继续保存在项目外。

## 2026-10-21 至早期 10-22 历史记录（原样保留用于对照）

以下保留历史计数、候选和失败；其中“当前／最新／待验”只指当时快照。上方索引和阶段表是本页当前口径，历史通过不继承给不同SHA。

以下原记录为2026-10-21的证据快照，版本`0.6.0-beta.1`、分支`codex/cross-platform-computer-use`。提交规则已统一为完整功能的代码、构建与测试一起中文提交；本轮没有 push、Release 或 npm publish。详细SHA、实际JSON和历史失败见[测试报告](computer-use-test-report.md)，原始门槛见[开发计划](windows-and-computer-use-development-plan.md)。

当前实施依据已统一到[开发计划](windows-and-computer-use-development-plan.md)。提交粒度为可独立使用的完整功能，代码、构建和相关测试一起中文提交；不把整套长稳及真实模型矩阵当作所有功能提交的前置条件。本批统一交互源码已冻结、生成验证包并完成相关回归，尚未宣称完整交付。

## 本批完整功能与后续顺序

| 完整功能 | 当前状态 | 依据与下一步 |
| --- | --- | --- |
| 聊天自动入口与应用授权 | 已实现并完成相关回归 | discover／request_control、owner三选授权、generation取消、最终窗口身份绑定、launch FIFO及未知结果围栏；标准shell相关91/91；Mac旧候选实际主Agent Move与图片链通过 |
| 系统权限与应用管理 | 已实现，实际系统跳转矩阵继续验收 | 无聊天预检、固定设置入口、手动添加／撤销；Windows正式PE两架构目录／权限18/18纯无界面通过 |
| 统一设置与满幅小预览 | 已实现并完成相关回归 | 首位电脑导航、工具箱卡片／Switch、聊天授权与权限引导；固定300×180、X/Y铺满、hover/focus控件、−仅隐藏控件、弹出后同iframe保持实时；UI54/54、真实headless小框13/13、预览页25项；Mac全量730/730及universal构建通过 |
| 双平台原生操作与指针 | 原生基线已验证；Mac窗口校验独立修复已构建并完成全量回归 | Windows正式PE两架构各52＋29通过；Mac新helper715d增加进程出生／精确窗口／几何／前台校验和有界AX组件归属，733/733通过。同几何兄弟窗口click／type真实拒绝且零输入；合法单窗口闭环仍待本机空闲复验，不宣称整体验收完成 |
| 后续独立修复与验收 | 继续执行 | 完成Mac合法单窗口闭环与新候选Mac／PD Harness实际流程和安装；随后真实模型三任务、多聊天、双端长稳、反向严格清理及现有功能完整矩阵。历史通过仍只适用其SHA |
| 本批构建与Git | 本批统一提交，未公开发布 | 验证包 `artifacts/candidates-chat-full-frame-feature/`，完整SHA见相邻JSON；记录未通过项，后续修复各自构建、测试、中文提交 |
| Codex工作台／用户自动验收扩展 | 已收集并纳入计划，尚未实现新增产品能力 | 开发计划第16节：27项能力、7个完整交付单元、8组自动化／实机门槛；来源区分官方文档、用户截图、现有源码及设计。基线A→F继续优先，自动验收／开发测试／执行审批分开 |

本轮开始前，已精确终止视觉测试第四轮的自有 carrier，两个已运行 fixture／helper 自然清理且 oracle 自然退出，`cleanupErrors=[]`；实际 Harness 官方卸载回执为 `changed=true/application=applied`。第四轮任务 1 通过、任务 2 达预算且出现一次拒绝，任务 3 未运行，未算作三任务通过。证据见 `artifacts/model-capability-resumed/actual-vision-external-attempt-4/`，私有模型正文未归档。

Mac窗口校验修复与对应universal构建、733项全量回归、测试夹具及报告作为同一独立提交。验证包在 `artifacts/candidates-macos-exact-window-component/`；完整SHA和实机各轮失败见测试报告。实际第7轮歧义拒绝及最终清理通过，但合法单窗前置校验失败；后续轮次又检测到按住输入或前台变化，因此停止该轮，不降低门槛或重放输入。当前等待本机空闲继续实测。

2026-10-22：第10轮在用户明确提供空闲窗口后证实合法单窗仍触发501ms准备截止。已减少准备阶段反复计算后丢弃的组件证明，并增加不含AX正文的有限故障回执；新helper919f和验证包完成733/733与universal构建。第11轮提前中断，第12轮空闲预检未满足，均未据此宣布实机修复完成。用户已授权在新候选本地安装后使用真实DeepSeek会话逐功能视觉验收；成功截图保存项目外，不加入Git。现有基线收口、工作台H阶段和Office／锁屏扩展仍分别记录。

以下为本轮 UI／流程调整之前的历史快照。历史具体资产与结果保留用于对照，当前交付仍须以本轮冻结源码和包的实际报告为准。

## 历史阶段快照

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
