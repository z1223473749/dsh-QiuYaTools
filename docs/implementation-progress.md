# 双平台适配与电脑操控实施记录

## 2026-10-23 晚间最新状态

H1自动验收记录的生产接线已集成：会话工具、检查点、同次观察证据、结果卡、只读历史和导出；135项专项及当前源码1165/1165完整直接回归、TypeScript与独立真实SDK Host strict均通过。修复issued/ACK落盘回执丢失后的旧能力，以及异步mutation跨中断继续提交的问题。三个JS入口构建和三平台严格包校验通过，x64以只压缩JS空白保持原64 MiB门槛。实际Host/界面及Windows Node22/NTFS仍在验证，不能记为H1产品视觉验收完成。详见[H1接线范围](acceptance-runs-integration.md)。

Mac新8f组件的真实DeepSeek三任务已经实际通过：正确按钮、完整中文备注与Enter提交、订单卡拖动；24次真实账户请求、32次已保留fixture图片引用、三个随机码读取正确，三个最终图逐张核对。通过范围为当前公开SDK/现有个人Host入口与标准配对远端Mac执行器，一次授权由独立测试驱动模拟，不证明真人点击或个人Host本机TCC。各任务自有Agent/fixture/helper正常退出，原功能设置恢复、官方临时插件已移除、独立最终输入/lease清理通过；旧越界scroll失败和锁屏预检失败保留。H1新整包的真实模型验收仍待完成。

Mac同8f组件另已完成真实WK预览30分钟和5次故障恢复：20,771帧，11.539fps，P95 103ms，自有树资源低于原上限，118个精确进程身份退场通过。该轮绑定较早的JS运行时，不能继承为新增H1/预览完成态修改后的耐久验收。Mac完整原生UI第三轮仍为9/12：新增只读正文oracle的严格路径绑定在`/var`与`/private/var`规范化上误拒；预览物理命中校验观察到Dock系统矩形位于CG前层、AX却命中自有窗口，尚未放宽或忽略该图层。正常清理通过，原失败不改判。

Windows新原生两架构各52项基线、29项指针及d80c/b6e4包各UI12/安装5的结果继续有效，但不继承到新H1包。默认双会话尚未完成：原input-journal-failed尚未重现到具体I/O错误；最新有限阶段诊断发现一次10.48秒PD物理截图阻塞越过原held门槛，该轮保持失败。TXT/拖出最终图补验被测试标题超过Harness真实40字节fallback限制拦住；已用实际请求和回复确认原因，短标题新载体待实跑。Windows Node22/NTFS首轮因SID字符串规范化误拒，第二轮注册回传unknown，尚不能认定94项实际通过。

Windows真实拼音五例、同新组件真实DeepSeek、严格Windows→Mac反向闭环、新整包安装及最终逐功能画廊仍未完成。IME运行期回传已准备改为有界认证原始字节callback；旧任务与进程只按精确身份独立核对，读回时基错误的诊断不当作退场证明。H2–H7工作台扩展、Office专用加载项、锁屏扩展及日常浏览器profile扩展仍按原计划推进，不用已有基础结果代替。

以下为此前各快照；其中“最新／当前／待验”均以本节绑定结果覆盖，旧候选、原失败和未确认记录保留。

## 2026-10-23 早间增量快照

最新源码已完成 TypeScript 检查及 **1027/1027** 完整直接回归。归档公共入口修复已连同构建、测试用中文提交 `75d9797`；Windows 验收载体的单元回归现使用独立材料，实际入口的生成结果保持字节相等，详见[载体回归说明](windows-carrier-test-isolation.md)。新 Mac `40c3`、Windows ARM64 `d80c`、x64 `b6e4` 三个平台开发包已在项目外保存并独立核验，尚未作为完整验收交付或安装到个人 Harness。完整包 SHA 和构建范围见[归档入口记录](update-package-entry-check.md)。

Windows 新 ARM64／x64 原生指针各 **29/29**、原生基线各 **52/52** 已实际通过；新包 d80c／b6e4 的完整 UI **12/12**、安装 **5/5** 也分别通过，56张界面图已逐张审阅。TXT图仍是上传中、ARM拖出图仍是加载中，需要额外取得最终ready／真实正文画面；不把旧包补验证据继承过来。新组件默认双会话尚未通过：修正测试布局后，ARM一轮11项业务及物理指针像素均通过，却在只读进程退休核验中失败；后续ARM和x64分别复现 `input-journal-failed`，正确阻止未确认输入，正在定位具体I/O阶段。旧失败全部保留。

原 ce019／85ab Windows 两包的新一轮状态补验各 **5/5** 通过，各20张截图已逐张审阅；稳定置顶的实际顺序与状态分别有证据。Mac 新40c3完成隔离安装 **5/5**、headless DOM **8/8** 与24张图逐张审阅。Mac 8f47 的真实中文正例、兄弟窗口负例、独立即时退出零发送负例、指针 **13/13** 及默认双会话 **10/10** 均已通过；路径别名导致的旧载体失败保留。相关生产修复、universal构建及原生实测已作为完整单元中文提交 `a4c2213`。Mac 新40c3完整UI另有 **9/12** 通过，原生独立窗口正文、拖出后正文和预览接管文字发送3项仍失败，正在补充诊断，不能称完整UI通过。详见[逐候选视觉范围](current-candidate-visual-and-model-acceptance.md)。

Windows 真实拼音输入五例尚未通过。新IME4的Host-only在启动Host前发现PD plain `-Command`把自有身份JSON的双引号去掉，已用只读AST与原始文件字节确认；原脚本本身无语法错误。正在修复传输，未发送HID输入，不将旧IME3单项自然退出算作新整轮通过。Mac新组件30分钟／5次恢复已在独立窗口开始实测，尚未结束；真实DeepSeek新组件验收、严格反向环境及最终安装仍待完成。

工作台 H1–H7、Office 专用加载项、锁屏扩展及日常浏览器 profile 扩展没有由这些基础结果代替。当前仍先完成受影响的 Mac／Windows 原生与双会话，再验证真实模型、反向环境、性能及最终安装；工作台按统一计划继续实现。以下段落保留此前快照及各自候选绑定，其中“最新／尚未实现”按本节上方更新覆盖。

模型帧指导、自然入口配置序列化及未授权收尾修复已完成生产JS／三平台候选构建，typecheck与976/976完整直接回归通过。用户授权正常重开后，新工具说明已在真实SDK请求中确认加载，Windows自然c8-5真实DeepSeek三任务全部通过，23次请求尝试、5次成功act，无工具错误或重复action。任务1的owner允许一次由独立测试驱动模拟，真人授权UI未计为已验。Windows新ce019／85ab两包各UI12／安装5及56张图、Mac4483安装5／headless DOM8及24张图通过。旧自然3预算失败、自然4启动未确认及strict ARM准备失败保持原样。[候选视觉与模型记录](current-candidate-visual-and-model-acceptance.md)及[构建记录](computer-frame-guidance-acceptance.md)为最新口径，下方旧索引保持各自绑定。

新Windows两包的strict第二次独立尝试各8/8通过，保留最初准备失败；158条／125种图片内容的离线画廊及报告已在项目外生成，详见新候选验收。当前未提交的Mac隔离候选8f47已完成universal构建、typecheck及工作区980/980直接回归；正例在锁屏预检阶段零输入停止，不能计为原生验收通过。

当前优先顺序：先修Mac完整中文输入和完成态，确认正例及兄弟窗口／进程退出负例；再完成Mac指针与默认双会话，修Windows跨helper焦点并跑默认双会话；之后重跑受影响原生／真实模型／完整12项、严格反向与性能，最后冻结全量回归、安装包和交付报告。Mac当前正例仍有AX暂忙导致的失败；Windows隔离焦点交接实验两次原动作成功，但生产交接尚未实现，均不能计为完整通过。

## 2026-10-22 历史索引与阶段快照

**整体尚未完成完整验收。** 本节为10月22日快照，其中“当前／最新／待验”以本页上方10月23日增量覆盖。版本为 `0.6.0-beta.1`，分支 `codex/cross-platform-computer-use`；完整功能连同构建、测试一起中文提交，未 push、Release 或 npm publish。详细资产 SHA、原始失败和当前剩余项以[测试报告](computer-use-test-report.md)为准，原始门槛以[开发计划](windows-and-computer-use-development-plan.md)为准。

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
| P3 主Agent图片与真实模型 | Windows当前c8固定目标及新指导自然入口三任务通过；确定性provider链路另有证据 | 自然授权为独立driver模拟一次，真人UI和Mac当前组件真实三任务仍待验，不把其中一条链路替代另一条 |
| P4A Mac执行器 | 当前66ae已构建／相关回归通过，同SHA原生实测未完成 | 中文配对、歧义／退出负例、指针及默认多聊天逐项绑定新SHA；锁屏期间不输入、不绕登录 |
| P4B Windows执行器 | 当前c8／3d各原生52＋预览指针29、应用权限18项通过 | 与整包UI、真实模型、预览性能分别记证；不推导未测的系统／设备矩阵 |
| P5 实时预览与恢复 | 当前c8与3d WebView2各三十分钟／五次恢复通过，完整壁钟、资源与自然清退过原门槛 | Mac66ae新绑定仍待通过，旧0143不可继承；性能轮不代替held-input或停止延迟 |
| P6 独立环境与文件交换 | Mac→Win15及当前Mac8MiB文件交换通过 | Win→Mac严格delivery未完成；文件服务stub不当作native权限证明 |
| P7 浏览器通道 | 当前Windows Edge10＋Chrome10通过 | 只证明隔离profile／显式CDP／站点许可与注册工具，不等同日常profile随包扩展或真实模型 |
| P8 安装与更新 | 当前Windows双包各install5、Mac当前包install5通过 | 均为隔离测试安装生命周期；最终包本机安装及受影响视觉复验仍需收口，未签名／公证／公开发布 |
| P9 完整交付 | **尚未通过** | Mac当前真实DeepSeek／原生／多聊天／完整12项、Windows默认manager双聊天／strict补验、严格反向环境、最终变更回归及安装包汇总仍有未完成项 |
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
