# 新候选逐功能视觉与真实模型验收

记录日期：2026-10-23。本文只覆盖下列已绑定候选和正式组件；整个开发任务尚有Mac原生、双会话及严格反向环境待验。截图全部在项目外，安装包为未公开发布的开发候选。

## 新候选 Windows 双架构安装与逐功能验收（2026-10-23）

本轮已直接绑定新包重跑，Windows ARM64 和 x64 兼容运行均完成 **UI 12/12、官方安装生命周期 5/5**，每架构收集并逐字节校验 28 张隔离测试截图。ARM64 使用 `ce01953d4299e8a82d2768ebe980f494eec13244ce0bed2535fea7229bfd02d1`，x64 使用 `85ab5eb0d28ba15d16dcb0c7dd0303f59f4ed12ec70338dae09169b9df348764`；包内原生辅助程序分别保持 C8 和 3D 的 SHA，未重新编译。

| 范围 | ARM64 新包 ce019 | x64 新包 85ab |
| --- | --- | --- |
| 实装 UI 逐功能 | 12/12 通过 | 12/12 通过 |
| 官方安装、升级、坏包拒绝、回滚、重装 | 5/5 通过 | 5/5 通过 |
| 收集并校验截图 | 28 张 | 28 张 |
| 完整截图肉眼检查 | 已有 root 12 + agent 17 条，去重 28 张 | 本次逐张查看 28 张 |
| 首轮独立严格证据 8 项 | 准备阶段失败，未产生测试报告 | 前序失败后未运行 |

UI 12 项包括十个设置页及可写状态、设置持久化、隔离会话、提示词 Tab/Esc、长文本 TXT 上传入口、会话菜单、原生独立窗口与复用、可信浏览器拖出原生窗口、主 Agent 工具与图片传输、批量归档、计划批注与草稿保留、8MiB 文件交换及同名不覆盖。安装 5 项保留设置验证，状态按 `0.5.2 → 0.6.0-beta.1 → 候选包仍可启动 → 0.5.2 → 0.6.0-beta.1` 执行。

两次完整套件均通过原有严格收尾：自有载体、隔离 profile、临时目录及复用 runtime 范围无剩余进程，OS 按键未按下，租约空闲且 journal 不存在；wrapper 自然进入 Ready/result0，未强停并完成精确注销；只读 postflight reader Ready/result0、未发信号并注销。这些回执没有补足每个 Host 的自然退出证据。原 seed 保留 SIGTERM（Windows 可能走 TerminateProcess）和超时 SIGKILL 分支，不能写成“所有 Host 均自然退出 0”。

独立 strict ARM64 尝试在 `preparing` 阶段下载 `harness-workspace-prerequisite.mjs` 时命令失败；现有日志未提供足以确认更窄原因的传输诊断。未生成 `environment.json` 或逐功能报告，计划任务查询返回 NotFound，后续 postflight 因缺失 environment.json 失败，因此本次 strict 的清理不能计为已通过。外层串行器在此停止，x64 strict 未运行。四套总收据为 `passed=false`，保留这份失败，后续需修复载体准备并以新尝试目录补齐。外层已恢复 VM 原 paused / idle on 设置。

本轮运行环境为 PD 的 Windows ARM64，x64 在该虚拟机中兼容运行。主 Agent 图片路径使用本地确定性适配器；本报告不承担实际 DeepSeek 推理或物理 x64 / HID / IME 的证明。

视觉检查未发现可立即修复的重叠、溢出或不可读布局。内嵌预览为固定长方形、画面铺满、常态隐藏按钮、悬停显示按钮，并保留边界与阴影。独立原生预览保留控制栏和输入栏，目标画面周边有保持比例的细黑边。TXT 截图捕获的是上传中状态，归档截图仍有淡化行，图本身不替代行为及持久化回执。图片为隔离测试内容，未作裁剪、重绘或拼图替代逐张检查。

成功截图：

- `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-arm64-新包-ce019-逐功能12-安装5-1/`
- `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-x64-新包-85ab-逐功能12-安装5-1/`

有限独立审阅清单：`/Users/qiuya/QiuYaTools-验收/2026-10-22/报告/新候选-视觉与模型-20261023/windows-new-package-evidence-review.json`，SHA256 `32ed562bb96049453d232144e344a70737a4f7aff056baaeb600f482a3e760a7`。清单含全部 56 张图的 SHA/字节、两轮报告 SHA、x64 28 张实际像素观察、ARM 已有 28 张去重审阅来源，以及 strict 失败和未运行状态。仅只读检查，未运行 PD、Host、模型或输入，未修改源文件、Git 或原始图片。

## Mac 新候选安装与界面回归

Mac universal 候选 `4483c2cee7362a9b71f6f3a1100608baaac578a3888ad829e0d8ba8ed45feddc` 的官方隔离安装五项通过；五次自有 Host 按原正常关闭流程 exit0／无 signal，临时目录删除。新包另完成 headless Chrome 的8项已配置界面用例、十个设置页和24张状态图；实际原生调用0，不能代替独立原生窗口、拖出、电脑输入、真实模型或文件交换实测。

24张图片逐张检查并与原报告SHA／字节核对，没有发现高置信排版缺陷。计划批注的待审状态图与提交后的聊天状态图分别记录；截图名称本身不当作完成证明。审阅记录：项目外 `成功截图/Mac-新包-4483-headless-DOM8-1/visual-review-mac4483-dom24.json`，SHA `20f60f62eca4654de8aaf3a171d6d7c0d090f0112965776e4b97cc7248d33d83`。原始安装和DOM回执分别在 `原始截图/Mac-新包-4483-安装生命周期-1/`、`原始截图/Mac-新包-4483-headless-DOM8-1/`。

用户确认无活动任务并授权正常重开后，个人 Harness 已正常退出并重新打开；自然入口第5轮 actualHostReceipt 与 SDK 新工具说明指纹共同确认新JS实际加载。19份已装插件文件此前与4483归档一致；没有读取或搬运账户凭据。之前自动审批拒绝和第4轮无Host激活回执的失败保留，不追改为成功。

## Windows 真实 DeepSeek：自然入口第 5 轮（2026-10-23）

本轮在现有 Mac Harness 的真实 owner/SDK 中使用当前 `deepseek-account / deepseek-flash`，通过 PD Windows 的正式 C8 原生辅助程序执行三个新业务窗口，**3/3 完整通过**。三个任务的业务 oracle、视觉核验码读取、turn/end completed、独立清理均通过；未提高每任务 12 次请求和 180 秒边界。

| 任务 | 实际 SDK 请求尝试 | Agent 步数 | 耗时 | 实际工具路径与结果 |
| --- | ---: | ---: | ---: | --- |
| 1：发现应用、申请控制、确认订单 | 9 | 8 | 82.511 秒 | status → discover → request_control → observe → click → observe → pause；正确点击 1、错误点击 0 |
| 2：中文备注及 Enter 提交 | 9 | 8 | 94.974 秒 | observe → click → observe → type → observe → Enter → observe；提交成功、文本逐字匹配 |
| 3：拖动订单卡到目标框 | 5 | 4 | 40.211 秒 | observe → drag → observe；业务拖动命中、down/up 成对 |

共 23 次 SDK provider 请求尝试，其中 20 次含工具定义，另外 3 次没有工具定义；不要将 23 次全部写成含工具推理请求。五次 act 全成功、每任务使用不同的 frameId、没有相同 action 重复执行、没有工具错误/STALE_OBSERVATION/denial。此轮行为验证了新帧提示在当前模型上的效果，不能推广成所有模型永久不再产生过期帧。

任务 1 从未授权候选开始，模型通过 discover/request_control 发起应用授权，再由独立本地测试驱动通过正式 owner RPC 模拟“允许一次”。授权前实际 observe / preview / lease / act 均为 0；Windows 只读桌面审计确认 Session 1、可交互桌面、按键未按下、租约空闲、journal 不存在。授权只针对本轮精确 session/app/request/version，始终允许列表不变，模型没有 decide 权限。**humanClickProven=false**；此处证明 Host 授权协议链及一次性决策，未证明真人点击授权按钮。只有任务 1 走自然入口，任务 2/3 保留固定授权载体。

独立审阅通过 TypeScript AST 提取当前生产工具注册的原始 description/parameters，未执行工具注册或模型请求，逐项比对真实 SDK request 的 **96 个工具 schema 记录**。新 act 描述长度 625、SHA `cc6cb9ef27df8c7c46c5aa3077c60785e032644acaa5734e55973d4708424a5b`；observe 长度 353、SHA `d30a0d285b52f6bfd0f9a143f991d42b4b19bb9b682221296f7d8014a564bd88`；输入参数的字节和 SHA 也全部相等。这证明模型调用前的 SDK 参数已携带新提示。未检查 provider 的 HTTP 原始请求、隐藏图片预处理、内部路由或后端实际模型身份，不把 SDK 观测当成 provider 内部实现证明。

默认模型没有被设置或更换：验收读取 `ctx.agentDefaultModel.currentSelection()` 并传给新建的自有 Agent，报告 `modelDefaultsChanged=false`，全部请求选择一致。原本地电脑连接已恢复，原功能开关已读回未变。现有证据没有“先更改个人模型下拉，再恢复”的前后对照，不作这种表述。

官方 CLI 安装和移除均 exitCode 0、actualHostReceipt=true。移除后临时验收插件依赖不存在、bundle 未选中；Host 确认 runner 已 settled、路由已移除、原设置/连接已恢复；精确测试 patch inactive、自己的 Fiber 已 disposed。这是临时插件清理证据，未声明个人 Harness Host 进程退出。

三个记录中的 fixture/native 均自然退出，未强停，OS 审计均按键 0、租约空闲、journal 不存在。已记录的直接子进程身份审计通过，但它是有限快照，明确不覆盖任意递归进程树及关闭中新创建的子进程。载体 task Ready/result 0、身份匹配、已注销、idle 恢复；最外层进程 exit 0 / signal null，原 idle on 恢复。账号凭据未转移到 Windows，未开放 Windows 入站端口。

本轮 manifest SHA：`a13174a995dfbc3714b9676b4fa2b937661fc4ba88fb9edf9e70298563ddb15f`；31 份冻结源文件逐项验证一致。正式 Windows 辅助程序 SHA：`c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce`。本轮测试插件压缩包 SHA `bc6068294ebf003f604694cd4b02b4c6068e0400ca8f4fc4ca5e46306ea56543` 是临时验收载体，**不能作为交付的 QiuYaTools 安装包**。

三个最终业务图片已分别完整 `view_image` 肉眼检查，按原 SHA 逐字节复制到项目外新目录：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-真实DeepSeek-自然入口-三任务-c8-5/`

只包含自有隔离业务窗口，未复制私人聊天或失败图片，未改图；目录内 `copy-and-visual-review.json` 含每张源/目标路径、SHA、字节和实际视觉观察。最终图不承担运行中 AI 指针或真人点击授权按钮的证明。此前失败尝试的目录和报告保持原样，不被此轮成功覆盖。

有限验收摘要：`/Users/qiuya/QiuYaTools-验收/2026-10-22/报告/新候选-视觉与模型-20261023/natural5-acceptance-review.json`，SHA `882e73448ef411b1b70d404a2d7b2389e8238e503f1a5faa6a1892307efb81aa`。SDK metadata 独立比对：`/Users/qiuya/QiuYaTools-验收/2026-10-22/报告/新候选-视觉与模型-20261023/natural5-sdk-metadata-review.json`。

## 项目外离线画廊与报告

新的离线画廊保留旧75条记录，加入新Windows56条、Mac headless24条和真实DeepSeek自然5最终3条，共158条验收画面。按文件SHA去重为125种图片内容，33条为跨平台／包重复内容；各自验收绑定保留，不宣称158张不同图片。过程状态图明确标注，完成以行为回执为准。

画廊位于 `/Users/qiuya/QiuYaTools-验收/2026-10-22/视觉画廊-158条-新包与自然入口-9cce1e8e-ec19-4516-9881-6b82903e36a2/index.html`。249份来源资产逐项SHA／字节、158图／158报告／571证据引用和894个本地链接自检通过；筛选、按SHA去重、全部158卡放大／关闭的离线DOM验证通过。`gallery-index.json` SHA为 `fba8df78afa2f292f414cadf8b3db54788447ef78afdfc53f4a5d66cb06b93f0`，`self-check.json` SHA为 `92dd7a01c17b8943f87995f63b95e635a4d26721a90fa315295619aa9dc42ae7`。旧75记录及11个原文件逐项不变，截图与HTML均未加入Git。

独立有限JSON审阅和复制清单位于项目外 `报告/新候选-视觉与模型-20261023/`；`source-copy-manifest.json` SHA为 `919d73ea4dfce2f6dc9313859e5f7bd8cc71e4a2da4a51f7aeab7c8e591cc387`。补充manifest明确 `complete=false`，不覆盖旧候选包内／交付目录中的历史manifest。

## 严格证据补验（新尝试2）

原八项断言未改，ce019 ARM64和85ab x64的新尝试均8/8通过，仍为UI12中的严格子集，未重复安装，不累计成8项额外功能。原始新回执分别在 `原始截图/Windows-新包-ce019-arm64-严格8-传输诊断-2/` 和 `原始截图/Windows-新包-85ab-x64-严格8-传输诊断-2/`，`new-candidate-carrier-verdict.json`均passed。独立postflight确认自有范围无剩余进程、OS按键0、租约空闲且journal无；wrapper和reader均Ready/result0并注销，外层exit0／signal null，idle恢复。Host仍有原SIGTERM及超时SIGKILL路径，不泛称所有Host自然退出。

ARM64的27张截图已逐张实看并校验源／副本SHA与字节，包含ready的395字节实际TXT及独立handle校验、1000×800的内嵌painted-frame、原生预览／接管送达、精确归档集合及计划消息seq33与原草稿保留。没有16KB实际TXT证据。有限报告位于 `报告/新候选-视觉与模型-20261023/windows-strict2-arm64-review.json`，SHA `a1da4fb332ece39cb7abc841fc68575dbe3ddbc78ce753d5762f223cdb33c00b`。x64同样27张已逐张实看且源／副本SHA和字节一致；计划消息seq33及395字节TXT逐项匹配。x64有限报告为同目录 `windows-strict2-x64-review.json`，SHA `e6ce4b0a00faf436b86f1d57df8f1db9ddb91777cbc0dc0aa986701340a282aa`。本批54张属于后续专项补验，旧158条画廊保持原样，没有将其倒填进去。

两架构均有24个资源各一次GET成功，各149条客户端命令均exit0／无signal或killed，重试0；此前失败的workspace7463字节本轮单次分别331／288ms返回0。新增有限诊断和早期自有资源身份记录，未增加重试或离线绕过。服务端finish只证明服务端写出，原最初传输失败根因仍未被追认。原失败与所有旧冻结保持。cleanupPolicy的字符串中存在[object Object]展示瑕疵，实际边界依据冻结代码及真实回执。
