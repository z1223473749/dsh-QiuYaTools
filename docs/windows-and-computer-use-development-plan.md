# QiuYaTools 双平台适配与电脑操控开发计划

计划日期：2026-10-21。本文件保留开发前约定；后续用户已明确要求无人值守实施，当前执行结果见 [实施记录](implementation-progress.md) 和 [测试报告](computer-use-test-report.md)。起始版本为 `0.5.2`，开发候选为 `0.6.0-beta.1`，适配 Harness `0.2.1-rc.2`。

目标是在 macOS 和 Windows 上保留全部现有功能，并新增应用操控、真实电脑与独立环境两种模式、悬浮实时预览、AI 指针和人工接管。开发按阶段验收推进；基础交互完成、双平台验证完成和完整 Codex 功能对齐分别记录，避免用界面演示代替功能交付。

## 实施中的需求补充与验收口径

用户后续已明确：常态是在**每个聊天上下文显示实时小框**，由用户主动弹出/收回；独立原生窗口沿用现有尺寸/布局，不默认改成小悬浮窗。每聊天分别绑定环境、设备、目标与控制状态；同一物理桌面的实际输入仍需全局互斥/FIFO。A聊天弹出或收回不能暂停、换设备或撤销B聊天的租约，完整实机多聊天应另列验收。

指针需同时在真实被控应用与预览表达实际动作。批准形状为小号圆润纸飞机轮廓、半透明灰填充、细白边与宽软灰光晕；native OS cursor和AI cursor分别建模，human接管隐藏AI。不能用排除OS指针的截图证明用户最终看到的合成结果，也不能把计划动作坐标当作已经执行成功。收回预览的preserve语义与普通关闭暂停语义分别验证。

截至2026-10-21，实际Windows Node最新回执为636总/627通过/9跳过/0失败；Mac617项完整check属于其列明源码快照。最新Windows两架构正式PE各52+29通过，新候选整包UI/install仍待同SHA执行。真实账号external视觉首轮任务1通过、任务2达到12次请求失败；后续重测独立记录。Mac已解锁并有真实输入/held-crash分项，但当前AI/OS指针叠盖、WK资源归属/长稳和严格反向delivery仍未通过。上述是实施状态，不改变本计划既有12次/180秒、性能、自然清理和完整矩阵门槛；完整结果以测试报告的实际JSON为准。

## 1 交付范围和默认决策

**现有功能全部纳入双平台交付。** 长文本附件、会话独立窗口及拖出分窗、批量归档、计划批注、会话和工作区菜单、提示词建议、Q 主题、设置、关于与版本更新均需 Windows 真实验证，同时保持 macOS 行为。

**电脑操控纳入同一主 Agent。** 使用 Harness 公开工具、附件、连接、审批和 UI 扩展接口。电脑操控作为独立可关闭模块；新能力默认关闭，原有功能默认值保留。安装插件不会自动取得系统权限。

**双模式采用统一接口。** 真实电脑模式控制当前设备上的目标应用；独立环境模式连接已存在、已配对的虚拟机或远端桌面。首轮使用现有 PD Windows 做独立环境验证。PD 是开发测试资源，不是 Windows 用户运行插件的前提。自动创建虚拟机、安装操作系统、兼容所有虚拟化产品另列环境供给扩展；普通多桌面工作区不作为隔离环境交付。

**完整对齐保留专门阶段。** 浏览器专用通道属于主体计划；Excel 专用加载项和 macOS 锁屏操控列入后续完整对齐阶段，各自设置验收和外部前提。基础阶段结束不能标成“已完全复刻 Codex”。锁屏能力只按系统实际能力声明。

**系统支持以矩阵管理。** 原有 Mac 辅助程序最低目标是 macOS 13，不能因选择第三方依赖而静默提高整个插件要求。Windows 首轮以 Windows 11 为验收系统，构建 x64 和 ARM64 资产。最低系统版本、旧版 Mac 运行和各架构原生运行分别核验；未实测的单元明确标注。Windows 10 支持在预研后按实际系统 API 和 Harness 版本确定，不提前承诺。

## 2 已确认的环境与需要完成的预检

| 项目 | 本轮证据 | 开发前动作 |
| --- | --- | --- |
| 仓库 | 当前工作区干净；现有 Node/Cordis Host、React Client、Swift 会话分窗 | 保存 git 状态、版本和现有测试基线，保留后来出现的用户 WIP |
| 现有测试 | `npm run check` 执行类型检查、构建和 node:test；使用 JSDOM、Cordis fixture 和模拟 helper | 不把这些结果等同于真实桌面或 Windows 已通过 |
| macOS | 当前机器 macOS 26.6.2，ARM64 | 检查 swiftc、采集与 Accessibility 权限、显示器、浏览器、磁盘 |
| PD | Parallels 26.4.1；已确认一台运行中的 Windows 11，来宾为 ARM64 | 重新枚举 UUID 和状态，不依赖 VM 名字；只对明确选定目标执行测试 |
| 来宾命令 | 已成功执行来宾只读 PowerShell，检测到登录用户 | 验证交互桌面 runner；来宾命令成功不代表 GUI 自动化运行在正确桌面会话 |
| Windows 工具链 | 当前来宾 PATH 未发现 Node 或 dotnet 命令 | 优先准备固定版本、测试目录内的工具链；区分 PATH 缺失与机器上完全未安装 |
| x64 与旧版 Mac | 本轮未确认可用的原生交互测试设备 | 构建可在 CI 验证；原生桌面运行需匹配的 runner，保持未验证状态直到实际完成 |
| Harness 与模型 | SDK 存在公开工具与图片接口 | 验证 Windows 可安装宿主、隔离测试 profile、模型图像能力与真实请求链路 |
| 发布身份 | 当前未核验签名、公证与 Windows 签名凭据 | 开发包可先产出；正式签名和发布状态单独记录 |

PD wrapper 在沙箱内出现过进程查询受限和连接错误；直接使用应用内 `prlctl` 并在允许的执行环境进行只读查询后成功。后续 runner 使用已验证的绝对路径，不能据最初错误自动执行重装、初始化、重启系统或修改服务。

## 3 总体结构与技术选择

```text
Harness 当前主 Agent
  └─ dsh-tools + dsh-attachment + approval
      └─ ComputerSessionService
          ├─ 应用/站点权限、目标绑定、状态机
          ├─ 命令队列、输入控制权、epoch、取消与清理
          ├─ DriverAdapter
          │   ├─ Mac 本机执行器
          │   ├─ Windows 本机执行器
          │   └─ 独立环境中的配对执行器
          ├─ ObservationChannel → 决策截图与 AX/UIA → Agent
          ├─ FrameChannel → 连续预览 → 共享 React 组件
          └─ EventChannel → 指针、动作、状态与错误

共享 UI
  ├─ Harness 设置与侧栏
  ├─ Mac 悬浮窗壳 Swift/AppKit/WKWebView
  └─ Windows 悬浮窗壳 WebView2

现有会话独立窗口
  ├─ 保留 Mac 实现
  └─ 增加 Windows 实现，复用公共启动/平台分发设施
```

现有会话分窗与电脑操控窗口保持独立生命周期和权限身份；共享协议工具和构建设施，避免新控制服务崩溃牵连原有分窗。

优先验证轻量原生窗壳。当前更新包限制为压缩 64 MiB、解压 256 MiB，不能直接内置大体积 Electron、浏览器或 VM 镜像后简单放宽限制。若需独立 native 资产，采用固定来源、平台架构 manifest、版本绑定、完整性校验与可回滚的分层分发。WebView2 Runtime 缺失时给出可执行安装路径，并测试真实安装前后的行为。

Windows 首选 C#/.NET 加 WebView2 验证开发效率，但最终用户不应依赖开发 SDK。若自包含运行时过大，采用明确的运行时引导或独立原生伴随包；若仍无法满足安装/体积要求，切换 Win32 C++ 加 WebView2 COM 小型壳。选择依据是干净 Windows 环境可安装、可启动、可更新，不能仅依据开发机能够运行。

Cua Driver 是执行内核候选，不是已经选定的依赖。P0 固定版本或 commit 后验证许可、传递依赖、可分发资产、系统版本、取消语义、输入释放、AX/UIA 与架构支持。只复用许可明确的目录；不把 Cua Spaces 的 FSL 流媒体实现当 MIT 代码复制。候选不满足核心要求时自动切换自有 Swift 和 C#/.NET 执行器，不等待用户选择实现语言。连续采集、会话控制和预览层保持可替换。

所选 .NET、WebView2、Playwright 和驱动版本在 P0 核对官方来源并锁定。原有最低系统目标与第三方兼容要求冲突时，优先保留原有功能兼容，电脑操控逐项报告能力。

## 4 先固定的协议和行为

| 对象 | 必须携带或保证的内容 |
| --- | --- |
| 控制会话 | 聊天 ID、电脑会话 ID、设备 ID、真机/独立模式、目标应用与窗口身份、协议版本 |
| 操作命令 | actionId、当前控制租约与 epoch、目标、超时/取消；坐标操作绑定观察版本与几何版本 |
| 观察结果 | 实际图像尺寸、窗口/显示器、DPI/Retina、裁剪范围、AX/UIA 文本与元素作用域 |
| 预览帧 | frameId、时间、目标与几何版本、尺寸、光标是否已嵌入；队列有上限 |
| 动作事件 | 对应会话、目标、epoch、动作阶段、坐标、执行结果；区分计划中、已执行和失败 |
| capabilities | 每个平台实际支持的采集、输入、后台元素操作、剪贴板、窗口和独立环境能力 |
| 错误 | 缺权限、目标变化、过期观察、控制权变化、停止、断连、进程失败、模型能力不足等稳定错误码 |

状态包括 `idle / connecting / awaitingPermission / ready / running / pausing / paused / handingOver / humanControl / resuming / stopping / stopped / disconnected / faulted`，由一处状态机拥有最终决定权。

关键不变量：

1. 同一真实桌面的输入由一个有效控制权租约持有；不同聊天和子 Agent 不能同时抢输入。独立来宾是另一个设备，不与宿主混用坐标或权限。
2. 原生执行器在每次注入输入前复核租约 epoch、目标和取消状态。仅在 Host 清空队列不算停止完成。
3. 暂停或停止确认之后，旧 epoch 不得产生新的输入；允许必要的 keyup/mouseup 清理。已经送达系统的动作不声称可回滚。
4. 接管先撤销 Agent 输入权、取消待执行命令、等待操作停稳、释放按键，再开放人工输入。继续先取得新观察和新租约，丢弃旧坐标动作。
5. 超时、断线或收到重复请求时，不自动重放结果未知的点击、粘贴和拖动；有界 actionId 去重避免重复操作。
6. 桌面几何、目标窗口或授权发生变化时，旧观察失效。PID 重用、同名窗口、窗口移动必须纳入校验。
7. 插件禁用、卸载、Host 结束、Agent 取消和 helper 退出均撤销控制并清理资源。原生调用卡住时，独立 watchdog 能停止执行 worker 并完成输入释放。
8. 预览画面和模型截图分流。连续帧在内存和有界传输中处理，只有按需观察截图进入附件；不在聊天历史中保存全部视频帧。
9. 悬浮窗收起仅改变显示；关闭预览窗口默认暂停输入并保留任务。重新打开不会悄悄恢复操作，继续由明确动作触发。
10. “独立 AI 光标”是实际动作的反馈。只有明确支持后台交付的操作才宣称不影响用户指针与焦点；普通前台输入仍按独占控制处理。
11. 剪贴板临时替换采用所有权/变化检测，用户其间写入新内容时不覆盖恢复。
12. 使用 Host 鉴权和 Origin/身份校验；独立设备采用可撤销配对。工具调用、预览输入和原生桥接都不能绕过权限检查。

## 5 分阶段开发与验收

| 阶段 | 开发工作 | 可审查交付物 | 进入下一阶段的验收条件 |
| --- | --- | --- | --- |
| P0 环境和技术验证 | 保存基线；完成 Mac/PD 预检；验证 Harness 截图与取消；验证窗壳/驱动/包大小；锁定依赖 | baseline、preflight、能力与版本表、选型记录、最小验证结果 | 区分可运行/缺前提/不可用能力；关键技术有实际证明或已选择 fallback |
| P1 现有功能 Windows 适配 | 增加 Windows 会话分窗；抽取平台 helper 解析；改造更新资产和包校验；修正快捷键、路径、输入与主题差异 | 可在 Windows Harness 安装的原功能候选包；逐功能测试报告 | 第 6 节 required 项全部 passed；Mac 自动回归和对应真实 E2E 通过；缺环境时阶段保持 partial/blocked |
| P2 电脑会话核心 | 实现 contract、状态机、命令队列、租约/epoch、权限表、FakeDriver、资源清理 | 无桌面依赖的核心与故障注入测试 | 不变量、跨会话互斥、乱序/取消/重复请求通过 |
| P3 主 Agent 和权限接入 | 注册工具、图像投影、native/PTC、应用选择、始终允许/撤销、工具结果卡片、能力检测 | 主 Agent 的观察→操作→验证循环；权限设置与审批 | 抓取 adapter 请求证明图像确实送入模型；真实模型 smoke 单独通过或记录外部阻塞 |
| P4A Mac 执行器 | 采集、AX、输入、目标身份、权限检测、进程/按键清理 | Mac helper、原生 fixture、平台测试 | 真实测试应用能够观察、输入、拖动、滚动和停止；构建架构正确 |
| P4B Windows 执行器 | UIA、采集、输入、桌面会话、窗口与缩放处理、原生进程清理 | Windows x64/ARM64 helper、fixture 与构建资产 | PD ARM64 完成相同闭环；x64 运行结果独立记录；受限系统界面明确返回不可用 |
| P5 实时悬浮预览 | 双端窗壳、连续画面、独立光标、点击/拖动反馈、控制栏、坐标转换、排除自身 | 可拖动置顶的真实预览；实际截图与短录屏 | 暂停/接管/继续/停止可用；多种缩放下落点正确；没有自采集套娃或焦点误投 |
| P6 独立环境 | 配对执行器、目标切换、连接/断连、已存在 PD VM 适配、明确的文件交换 | 真机/独立模式入口与远端执行链 | Mac 和 Windows 插件各自连接真实独立目标；Agent/人工输入作用于该目标；宿主可正常使用；断连无残留输入 |
| P7 浏览器专用通道 | 评估并锁定 Playwright MCP 扩展或自有扩展；Chrome/Edge 连接、标签页和站点权限 | 浏览器连接页、本地站点 E2E、扩展版本与兼容信息 | 在同意的已登录测试 profile 完成操作；导航/关闭/撤权正确；桌面与网页能力路由清晰 |
| P8 双平台分发和更新 | 合并完整平台 manifest、Mac Mach-O/Windows PE 校验、干净安装、升级、失败恢复、必要签名 | 本地候选包、SHA256、依赖与许可清单、更新回滚测试 | 双端实际安装并加载 helper；损坏/错平台/错架构/协议不兼容资产被拒绝 |
| P9 完整验收 | 现有功能回归、双端真实 E2E、性能/耐久、故障恢复、交叉审查 | 总报告、支持矩阵、截图/视频、差异表、可安装候选包 | 主体范围必测项 passed；任何 blocked/not-run 不计为完成；所有已知缺陷有明确状态 |
| P10 完整功能对齐 | Excel 专用加载项；macOS 锁屏授权插件、安装/移除/恢复；Codex 差异逐项处理 | 各扩展独立实现、安装资产和验证报告 | 满足第 12 节专门验收；不能由基础包或模拟测试代替 |

P1 和 P2 可并行，P3 依赖 P2。P4A/P4B 在协议固定后可由两个执行者并行。P5 的 React UI 和原生窗壳可提前开发，完整输入接管依赖 P2/P4。P6 复用已通过的执行器。P8 的平台资产基础工作在 P1 完成，P8 对新 helper 和整个候选包再验收一次。

每阶段先跑受影响的针对性测试；阶段完成跑现有完整回归。仅当代码、失败或未解决风险变化时重复扩大测试。互相独立的任务可以继续推进；依赖某项环境授权的真实验收保持阻塞，不能靠 mock 替代。

## 6 现有功能在 Windows 上的逐项验收

| 功能 | Windows 适配与自动化场景 | 成功依据 |
| --- | --- | --- |
| 长文本附件 | Ctrl+V、右键粘贴、CRLF/Unicode/emoji、字符/行阈值、纯空白、图片/文件、中文 IME、上传失败回退 | 输入框/附件真实状态与导出字节一致；短文本和原附件流程正确 |
| 会话独立窗口 | 菜单打开、拖出、重复唤起、拖动取消、窗口关闭/恢复、加载失败、Host 重启 | Windows 原生窗口固定正确会话；复用与取消无多余窗口；认证状态和会话 ID 正确 |
| 分窗附件与存储 | 文件/目录 picker、多选、上传、外链、下载、每 profile/会话隔离存储、多个窗口并发 | 实际上传内容和目标会话正确；不会打开其他会话或串用登录/草稿 |
| 批量归档 | Shift 连选、Ctrl 多选、右键、Esc、工作区全部、运行中会话、部分失败/重试 | 隔离测试 profile 的实际归档集合正确；不触碰真实聊天 |
| 计划批注 | 文本选中、添加/编辑/删除、高亮重定位、长计划、提交/失败保留、历史只读、Ctrl+Enter 与 IME | 会话真实回执后才清理；原草稿/附件保留；布局和选区正确 |
| 会话/工作区菜单 | 置顶、未读、复制标题/ID/目录、打开目录、工作区排序、菜单键盘操作 | Host 实际状态、Windows 剪贴板和资源管理器目标符合预期 |
| Windows 路径 | 盘符、反斜杠、空格、中文、长路径、允许环境中的 UNC、多 profile | 不发生 shell 拼接；复制与打开指向真实目标；不可用路径给稳定错误 |
| 提示词建议 | 当前模型路由、空输入/失焦、Tab 填入、Esc 隐藏、中文 IME、菜单、会话切换、取消 | 建议绑定正确会话；不自动发送；草稿/附件和菜单快捷键正确 |
| Q 主题 | 浅色/深色、设置页/会话/独立窗口、Windows 字体与滚动条、100/125/150/200% 缩放 | 真实截图和几何断言：无溢出、遮挡、不可点击区域，文字可读 |
| 设置和开关 | 总开关/独立开关、阈值、快速切换、多窗口同步、重启保存、卸载清理 | Host 配置持久化且组件/事件按开关真实启停，旧配置迁移正确 |
| 关于 | 版本、图标、中文/英文、项目链接与外链打开 | 真实页面可见且外链由正确系统处理 |
| 版本更新 | 检测版本、Windows 资产、下载校验、安装、重启后版本、失败恢复、旧配置保留 | 在隔离安装环境完成当前→候选→失败/回滚；不触发真实公开发布 |

所有现有测试在 Mac 上继续通过；本表核心行为用平台对应快捷键在 Mac 再跑真实 E2E，尤其是共享 UI、分窗、附件和更新，不能只以 `npm run check` 代替。Windows 特有问题不能通过隐藏功能入口或持续显示“不支持 Windows”作为完成方案。Q 主题不为适配而重做设计，保留现有视觉方向。

Windows 共用验收维度还包括 AltGr 与 Ctrl+Alt 的区分、微软拼音组合输入、死键和多语言布局；路径含 `#`、`%` 时的规范 file URL；任务栏、Alt+Tab、最小化/恢复、Alt+F4、贴靠、屏幕外位置恢复；更新时被占用的 exe、下载中断、并发更新和失败回滚。主窗口与分窗的本地草稿、批注、未读存储遵循现有已定义行为，不为“同步测试”擅自改变存储语义。

合成 composition 事件只证明输入事件处理逻辑；至少执行一次真实 Windows 微软拼音组合输入，覆盖 Tab、Enter、Ctrl+Enter、Escape 后才能标记中文输入验收通过。升级还需验证 Mac bundle/签名身份、Windows helper 安装路径、旧应用授权和设备配对，确认没有无提示失效或错误继承。

已支持 Ctrl/Meta 的共享功能优先复用现有实现并回归。打开目录继续走官方文件管理器服务，验证 Windows Explorer 的实际目标，不改成拼接 shell 命令。Windows Harness 中的路径、浏览器和剪贴板按来宾语义执行，不能把来宾盘符交给 Mac Finder。

## 7 自动化测试分层

| 层次 | 工具和运行环境 | 覆盖重点 |
| --- | --- | --- |
| 协议/状态机 | node:test、FakeDriver、可控时间和固定 seed | 租约、epoch、取消、幂等、队列、状态转移、坐标变换、权限与资源释放 |
| Host/SDK 集成 | 真实 Cordis/工具/附件服务与本地 provider stub | 注册/卸载、session scope、审批、图像真实投影、native/PTC、取消传播 |
| React 交互 | 现有 JSDOM 加 Playwright 实际 Chromium | 控制栏、设置、多窗口状态、焦点、键盘、缩放和断连恢复 |
| 平台原生测试 | Swift 测试与 Windows .NET 测试、平台 fixture | 窗口身份、采集、AX/UIA、输入、剪贴板、按键释放和 watchdog |
| 真实桌面 E2E | 已授权 Mac、PD Windows 登录桌面、其他可用交互 runner | 原功能和电脑操控完整闭环；独立验证真实接收事件 |
| 浏览器 E2E | Chrome/Edge、独立测试 profile、本地测试站 | 已登录测试上下文、元素/坐标、标签页、上传、导航与站点撤权 |
| 独立环境 E2E | 配对 guest runner、PD、网络故障注入 | 来宾输入、宿主隔离、人工接管、重连和版本不兼容 |
| 包与更新 | Mac/Windows 干净测试目录、平台 manifest | 无开发依赖加载、架构、签名状态、协议、坏包拒绝、升级与回滚 |
| 性能和耐久 | 双端真实 runner、有界缓冲观测、固定负载 | 帧延迟、输入停止时间、CPU/内存、反压、附件增长、孤儿进程 |
| 真实模型 smoke | 当前 Harness 可用图像模型和测试应用 | 自然语言任务→正确观察→操作→真实结果验证 |

普通 CI 负责类型检查、逻辑、包校验和编译；需要登录桌面和系统授权的测试运行在专门交互 runner。编译成功、JSDOM 成功和模拟驱动成功分别报告，不替代 native E2E。桌面测试不加入 `prepack`，避免用户打包时启动控制或触发授权。

## 8 原生测试应用与独立判定依据

构建两个专用测试应用：macOS AppKit/Swift 和 Windows 原生 UI。包含文本框、多行中文/emoji、按钮计数、下拉框、滚动列表、拖放区、菜单、弹窗、小目标、定时变化画面及可移动窗口，行为和任务语义一致。

测试应用通过独立 JSONL/IPC 输出实际收到的键鼠事件与最终业务值，作为判定依据。执行器报告“成功”本身不能令测试通过。画面嵌入帧序号、时间与几何标记，测试端从真实预览画面读取，验证延迟、帧内容和指针对应。

主 Agent 图像测试同时验证：工具 schema 对当前 Agent 可见；图像通过 attachment 引用和 output.render 投影；抓取 adapter 实际发出的请求，确认有图像字节/引用和正确尺寸；文本模型分支正确报告能力不足。先用本地确定脚本模型验证管线，再用真实视觉模型做端到端任务，二者分开计数。

真实模型 smoke 首轮每个平台使用 3 个固定任务：填写并核验文本、定位并操作界面目标、在接管后继续完成剩余步骤。每任务最多 12 次模型往返、总计 180 秒；达到上限保存观察/动作和失败原因。依赖当前 Harness 已配置的可用模型，不将凭据复制进脚本；没有可用图像模型时只阻塞真实模型验收。固定任务先由确定性 runner 验证确实可完成；最终以测试应用接收事件和业务状态判断结果。

Windows guest 内执行 CLI 只负责编排。GUI fixture、helper 与 E2E runner 必须位于已登录用户的交互桌面，不能把 Session 0 中启动成功当作桌面测试通过。

Mac 客户端连接 PD Windows 只覆盖该方向。Windows Harness 内的独立模式还需连接另一真实独立目标，验证入口、配对、预览、接管和重连；缺少第二目标时保留未验证，不以回环到同一来宾代替隔离验证。

## 9 必测故障和并发场景

1. 暂停发生在入队前、排队中、helper 已收到未执行、鼠标按下后、拖动中、粘贴中、截图中、等待审批中。
2. 重复暂停、停止、接管、继续；停止与继续并发；旧停止结果迟到；旧租约在新任务开始后迟到。
3. 两个聊天同时操作同一设备、同聊天多个 Agent、真机和 VM 同时运行；同名窗口和 PID 重用。
4. 网络断开、慢消费者、乱序/重复帧、预览重开、helper 卡死/崩溃、Host 重启、插件快速开关/卸载。
5. 权限撤销与输入竞争、浏览器跳转/关闭、目标窗口消失或移动、显示器拔插、DPI 与裁剪变化。
6. 恢复后不得重放暂停前点击；未知结果重试不得双击、重复输入或重复提交。
7. 拖动取消和异常退出释放全部 mouse/key down；watchdog 独立于可能挂住的执行 worker。
8. 临时粘贴期间用户更新剪贴板，清理保留用户新内容。
9. 预览窗不遮挡目标后令输入误投自身，不被反复采集形成镜像。
10. 未鉴权、跨会话、过期凭据、错误 Origin、旧配对令牌、超大消息、NaN/Infinity、非法路径和控制参数被拒绝。
11. 帧队列、命令队列、actionId 去重表有明确上限；慢消费者不会造成无界缓存。
12. 模型超时、输出无效动作、不支持图片、取消后迟到响应均不能绕过已停止状态。

坐标覆盖 Mac Retina、Windows 100/125/150/200% DPI、负显示器坐标、等比留边、裁剪、不同显示器与窗口移动。纯几何变换可自动生成输入验证；真实多屏或显示器拔插缺少设备时记录未验证，不用纯数学测试冒充实机覆盖。

## 10 性能目标和结果记录

以下是初始验收目标，P0/P5 根据实际硬件、编码和系统约束测量并固定基准；调整需在报告中说明原因，不能为隐藏失败临时降低：

| 指标 | 初始目标 | 测量方法 |
| --- | --- | --- |
| 本机预览 | 720p 目标 15 fps；持续变化场景稳定达到至少 10 fps | 从源 fixture 和预览实际画面比对时间/帧序号 |
| 预览延迟 | 本机 P95 不高于 500 ms | 同一设备时钟测源画面到 renderer；guest 需校准时钟或采用往返测量 |
| 暂停/停止 | 本机请求到输入停稳 P95 不高于 500 ms；watchdog 最大时限在 P0/P5 冻结，发布候选前必须有数值并通过卡死测试 | 比对控制请求时间与独立 fixture 接收事件；ACK 后不得出现旧输入 |
| 界面定位 | 测试目标的实际接收落点均在有效命中区域 | fixture 命中事件加截图几何校验 |
| 连续预览存储 | 不产生逐帧 attachment；附件仅随明确观察增加 | 预览前后附件计数/磁盘差异与观察次数对应 |
| 长稳 | 每端至少 30 分钟代表性负载 | 内存趋势、有界队列、输入释放、进程/句柄和断连恢复 |

静态桌面可降低帧率，不以重复相同帧冒充性能。长稳使用稳定场景和滚动/拖动场景，加入至少 5 次受控断连；性能报告记录硬件、OS、架构、分辨率、编码、帧率和资源趋势。生成式状态机测试固定 seed，失败保留可复现事件序列。

每次运行生成 `artifacts/computer-use/<run-id>/`：`summary.json`、JUnit、`events.jsonl`、关键前后截图、失败短视频/帧组、崩溃诊断和包 manifest/SHA256。测试只使用专用应用、测试会话和测试浏览器 profile；日志不记录认证 token 或私人剪贴板内容。

报告至少包含 commit、测试环境、OS、架构、helper/协议/模型版本、权限状态、每项结果、耗时、重试次数、证据路径和限制。状态固定为 `passed / failed / blocked / not-run`。未运行或跳过不能计入通过；必测项 blocked/not-run 时总体不得报告全部完成。

仅对已识别的启动/连接瞬态故障有限重试，保留首次失败。产品行为失败必须定位修复，不能靠重试获得绿色结果。

## 11 计划新增的测试入口和 CI

下列命令为开发阶段新增目标，当前仓库尚未全部提供：

```sh
npm run check
npm run test:compat -- --platform darwin --suite all-existing
npm run test:compat -- --platform win32 --suite all-existing
npm run test:windows:features
npm run test:computer:unit
npm run test:computer:host
npm run test:computer:web
npm run test:computer:preflight -- --target local
npm run test:computer:preflight -- --target pd-windows
npm run test:computer:native -- --target local --suite core
npm run test:computer:native -- --target pd-windows --suite core
npm run test:computer:browser -- --browser chrome
npm run test:computer:browser -- --browser edge
npm run test:computer:vm -- --target pd-windows
npm run test:computer:model -- --target local
npm run test:computer:model -- --target pd-windows
npm run test:computer:soak -- --target local --minutes 30
npm run test:computer:soak -- --target pd-windows --minutes 30
npm run test:computer:package -- --platform darwin --arch arm64
npm run test:computer:package -- --platform darwin --arch x64
npm run test:computer:package -- --platform win32 --arch arm64
npm run test:computer:package -- --platform win32 --arch x64
```

`--target pd-windows` 由 runner 将固定测试命令交给已选定 guest 内执行，不是仅在 Mac 上测试一个 Parallels 窗口。VM UUID、来宾工作目录、测试 profile 和证据目录在本地测试配置中指定，不把个人设备信息写入发布包。

`test:compat` 是所有现有功能的统一入口；`test:windows:features` 作为 Windows 编排入口或别名，不维护两套分叉用例。用例采用稳定 ID，如 `WIN-PASTE-01`、`WIN-WINDOW-DRAG-04`、`WIN-UPDATE-ARCH-02`，报告可以逐项关联第 6 节。

CI 增加 Mac/Windows 构建与协议/Host/Web/包校验矩阵，区分原生构建、交叉构建和模拟运行。交互 runner 运行真实桌面与长稳测试。增加手动验证工作流，测试阶段不调用现有发布 job；任何推 tag、Release 或 npm 发布仍是单独交付动作。

## 12 完整 Codex 功能对齐的专门验收

| 能力 | 开发内容 | 专门验收与前提 |
| --- | --- | --- |
| 应用与浏览器权限面板 | 系统权限状态、应用始终允许/撤销、浏览器连接和站点列表 | 授权持久化、撤销即时生效；系统权限和应用许可分开 |
| Excel 加载项增强 | 已打开工作簿的结构化读取、编辑、活动文档连接和撤销/恢复；Mac/Windows Office 验证 | 需要可运行 Office 和加载项连接环境；不能用鼠标点单元格代替该专用能力 |
| macOS 锁屏操控 | 独立系统授权插件、可信活动会话、安装/移除、显示器保护、本地输入中断与重锁、恢复 | 先在专用可恢复环境验证；系统授权/安装环节需实际用户配合；不在当前工作机上未经明确执行指令改变登录/锁屏机制 |
| 体验差异清单 | 将已证实 Codex 行为和本产品行为逐项对应 | 每项记录支持/有限支持/未完成及测试证据；后台操控和模型成功率按实测陈述 |

官方安装包中的专有原生二进制、私有 IPC 与认证协议不作为分发依赖。截图未展示或本轮未运行验证的交互按用户要求设计并独立验收，不声称已证实 Codex 内部实现。

## 13 无人值守执行方式与恢复

本计划最初只约定开发流程；后续用户已明确要求开始无人值守开发，按本计划推进实现、构建、测试、修复和本地候选包准备。每个完成步骤分别提交 Git，提交说明使用中文。

1. 开始时读取本计划、当前 diff 与相关源码，重跑环境预检。创建本次执行的阶段状态和测试报告，区分历史证据与当前结果。
2. 优先完成 P0 和现有 Windows 适配的实际缺口；协议冻结后并行进行 Mac、Windows 和预览/测试实现。每个执行者限定文件范围，合并后统一回归与审查。
3. 普通实现选择由开发者按本计划解决；候选依赖失败按已列 fallback 前进。阶段失败自动定位修复，修复后重跑受影响测试。
4. 持久记录完成阶段、文件、决策、失败原因、可复现命令和下一步；上下文切换或进程中断后从最后可信结果继续，重做环境与关键连接核验，不重放未知结果的桌面动作。
5. 对权限、外部账户、缺少交互设备等外部阻塞，标明具体动作与需要的前提；继续不依赖它的工作。缺少 Mac 系统权限、Windows UAC 确认、模型凭据或签名凭据时，不伪造通过。
6. 用户已允许使用 PD 测试，后续无需再问是否可以测试。优先使用专用测试目录、profile 和测试应用；不自动回滚/删除用户 VM、强制重启、改系统登录或安装来源不明程序。需要恢复环境时使用测试资源自身的清理机制。
7. 工具链与依赖可在授权工作范围内准备；遇到系统首次授权等只能由用户处理的环节，说明具体原因，保留独立工作进度。最终验收不能因这些环节未完成而写成全部成功。
8. 保留无关 WIP。计划本身不授权推送、公开发布、改真实业务账户或对当前工作机安装锁屏授权组件。需要本地提交时按后续用户指令执行，提交范围限定为本任务。

## 14 完成标准与最终交付

主体交付必须同时满足：现有功能 Windows 逐项可用且 Mac 回归通过；两端电脑操控闭环完成；真机与独立模式有真实证据；预览、指针、接管和停止通过竞态测试；主 Agent 实际收到图像；候选包完成干净安装、升级与坏包验证；性能和耐久报告完整。

Windows ARM64、Windows x64、Mac ARM64、Mac x64 以及最低系统版本分别记载。缺少某架构原生 runner 时，其构建通过和运行未验证分别呈现，不将总支持表涂绿。测试环境中通过的功能，不直接扩大为所有 Windows/Mac 系统版本和硬件都通过。

最终交付包括：源码变更、完整自动化测试入口、本地可安装候选包、平台/架构与能力矩阵、逐功能结果、演示截图与录屏、故障/性能报告、已知差异和阻塞清单、安装更新说明。Excel 与锁屏阶段未通过时，主体交付可准确报告为“基础电脑操控完成”，完整复刻目标继续保持未完成。

## 15 实施时的主要来源

- 当前插件源码和测试：`src/`、`tests/`、`scripts/`、`.github/workflows/release.yml`。
- Harness 公共 SDK：`@deepseek-ai/dsh-tools`、`dsh-attachment`、`dsh-client-connection`、`dsh-user-approval` 的本地 README 与类型定义；实施时以实际安装版本核验。
- [OpenAI Computer Use](https://learn.chatgpt.com/docs/computer-use)：系统权限、应用许可、Mac/Windows 差异与锁屏能力。
- [Apple ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/) 和 [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)：连续画面采集。
- [Windows UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-clientportal) 与 [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)：Windows 元素与输入边界。
- [Cua](https://github.com/trycua/cua) 与 [目录许可证清单](https://github.com/trycua/cua/blob/main/legal/LICENSING.md)：候选执行器和独立环境参考。
- [Peekaboo Visualizer](https://github.com/openclaw/Peekaboo/blob/main/docs/visualizer.md)、[UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop)、[Terminator](https://github.com/mediar-ai/terminator)：平台执行与反馈参考。
- [noVNC API](https://github.com/novnc/noVNC/blob/master/docs/API.md) 与 [Playwright MCP](https://github.com/microsoft/playwright-mcp)：独立桌面查看/输入与浏览器专用通道。
- Parallels 本机 CLI `list --help`、`exec --help`，以及 [Parallels 开发文档](https://docs.parallels.com/landing/parallels-desktop-developers-guide/command-line-interface-utility)：虚拟机测试编排。脚本使用实际版本支持的命令，不猜测参数。
