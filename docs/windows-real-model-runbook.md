# Windows 原生视觉模型验收：现有 Harness 账号与官方本地入口

本入口是临时验收工具，不属于发布插件。模型仍由当前 Mac Harness 的官方 Agent、默认模型服务和 session controller 驱动，实际操作仅发送到 Windows 的本轮三套自有原生窗口。账号、API Key、登录 Cookie 和启动 Token 不复制到测试进程或虚拟机。

## 已核实的官方接口

接口核对对象是本机 DeepSeek Harness `0.2.1-rc.2` 的安装内容，而非另一份 npm CLI。最初接口核对阶段仅执行 `dsh --help` 和公开安装源码读取；后续第四轮实际模型结果见下文。

真实可执行文件为 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，已核验为可执行的普通文件，启动器 SHA256 为 `61647349bd61a5cfff40c338c7d5af767a22f409ddce36feabfb2f693d1e66af`。它用 `ELECTRON_RUN_AS_NODE=1` 启动同一安装的 Desktop Host CLI，并完整转发 argv，不启动新的图形程序。命令顺序固定为 `plugin --profile desktop <pnpm 子命令与参数>`；不调用普通 npm `dsh`，不启动/dump Desktop profile，不增加版本豁免。

官方 CLI 沿用其标准 Harness home 解析规则。本工具不覆写用户 home 或环境；只从该次官方 `list --json` 的 profile 读取本测试 bundle 的有限字段，并用 canonical profile 路径哈希绑定前后操作。普通、开发和可选依赖三个范围都检查，避免把另一个范围的已有同名插件误判为未安装。实际 Host 的 runId/manifest/patch ACTIVE 回执是当前 Host 被加载的必要证明，不能因本地某个同名 profile 已安装就认为接入正确。

| 官方安装源码 | 已核实行为 |
| --- | --- |
| `dsh-desktop-host/lib/cli.js:94` | 安装内 CLI 调用 `runCli({ manageDesktopProfile: true, ... })`，支持管理已初始化的 Desktop profile。 |
| `dsh/lib/bin.js:115` | `plugin --profile desktop` 仅由该安装内入口允许；普通 npm CLI 拒绝保留 profile。 |
| `dsh-plugin-manager/lib/types/operations.js:95` | 新安装的 bundle 经验证后加入 `dsh.profile.bundles`。 |
| `dsh-hmr/README.zh.md:27`、`dsh/README.zh.md:37` | 已启用的 HMR 监听 manifest/patch 并重新组合；CLI 退出零不证明本次条目实际激活。 |
| `dsh-client-connection/lib/index.js:696,714,746` | `browserPeer` 是 Connection 构造时建立的共享 owner 对象，不是请求局部 getter；浏览器认证返回同一对象。 |
| `dsh-client-connection/lib/index.js:820` | 官方 `createSharedFetchHandler('/api').fetch(request, peer)` 显式接收已有 Peer，精确路由仍校验 owner。 |
| Desktop `lib/main.js:12406,13055` | `dsh-app://app` 由 Desktop 转发认证；`dsh://open` 只聚焦窗口，不能发起模型任务。 |

当前 Host 的 loopback HTTP/API 同样要求认证。`/connect` 是官方程序化 API，但要求本进程的启动令牌。本工具不提取它。Headless/SDK 新进程也不等于当前 Desktop 登录上下文；随附 headless 默认不使用 GUI 保存的登录凭据。

这里采用用户已授权安装的受信任本地测试插件生命周期。它只复用当前真实 `ctx.connection.browserPeer`，每次分派验证对象引用、`kind === 'owner'` 和 `signal.aborted === false`。没有创建 Peer、伪造 principal、读取凭据，也没有放宽现有 owner-only HTTP 路由。

## 一次性能力与运行边界

默认准备仍保留原 Console 方式。必须显式传 `--test-only-auto-run` 才生成 Host 触发配置、私有 manifest 与触发文件。完整约束包括：

- 新 UUID runId，二十分钟期限，manifest SHA、实际安装模块 SHA、归档 SHA、正式 native/fixture/audit SHA。
- 本轮预先分配的三个独立 `qiuya-vision-<UUID>`，固定的 Windows 配对与窗口身份。只允许该三会话的有限操作，不能调用任意插件或用户会话。
- 目录 `0700`、触发文件严格 `0600`，沿用 `O_NOFOLLOW` 与原子 `O_EXCL/link` 私有文件协议。任何模型/设置副作用前先持久化消费记录。进程中断、HMR 重载或未知响应不会重试。
- Console 与 Host 复用原来的同一个任务和恢复循环；每任务仍是四个工具、最多十二次请求、180 秒。业务 oracle、真实图片留存、视觉 nonce、模型调用和真实清理分别判定，不能用假 oracle 冒充真实模型通过。
- Host 先等待官方 Loader 中 manifest 固定 patch ID/name 的条目达到 ACTIVE，且 `entry.fiber === ctx.fiber`，再开始任务。
- 完成后恢复原功能设置、停止本轮会话、恢复本地连接。卸载等待原 guard 清理、移除其路由，并由有界只读 SDK 观察确认该 patch 已消失且原 Fiber DISPOSED。单纯的 UNLOADING 不通过。

Windows 通过 VM 私网主动连接 Mac relay，无 Windows 入站监听/防火墙修改。初始化只对同一 Process/SafeHandle 的缺失 loader 元数据允许四秒有界等待；CIM 出生、父 PID、路径和 Session 独立匹配，非空错误数据立即拒绝。原生捕获与动作超时未改。

Windows 每个案例收尾还复用 `tests/fixtures/windows-remote-audit.cs` 的独立只读 Snapshot：同 Session、活动桌面匹配、OS held keys 为零、租约作用域存在且空闲、input journal 缺失。双方进程自然退出、子进程退场和该审计均为必需。C# audit 源被完整冻结、传输并核 SHA，adapter 缺证据即失败。

Host 的 `owner-rpc-NNNN.json` 在真实共享 handler 调用前写 started 回执，答复后只保存有限方法名、阶段、HTTP/Remote 成败、rpcId 是否匹配与公开 gateway/settings 错误码。未知消息和代码只保存 SHA，不保存模型参数、整个 describe、原始 schema 或其它 namespace。第一个唯一匹配且 rpcId 正确的 `qiuya-tools` 读取会先保存 `owner-settings-original.json`：两个字段的 own/raw boolean/effective boolean、字段存在性、revision 的类型/可空性、全局 writable 与可选 row writable。初始 namespace 必须唯一、两个 effective 值必须为 boolean；重复、缺失、无效 revision 或明确 row writable=false 时，在修改前失败。

连接状态在 enable 前先读取，并仅保留 nativeMode、是否存在 native 状态、是否有活动会话等有限字段。收尾区分“未派发 connect 且前后读值一致”与实际恢复本轮远端会话；不再把 enable 前失败留下的未赋值 mode 当成已发生远端切换。

若初始两项功能已开启，enable 会再次读取并确认原两字段未变，然后直接进入会话准备，不发送多余的 settings/mutate。仅 false 字段才执行一次明确 revision 的 CAS 写入；当前官方 SettingsController 返回写后 namespace view，已安装 settings provider 对一次 raw 变更增加一个 generation。guard 同时要求写结果为精确的旧 revision+1、写入字段 own/raw=true，以及随后独立 describe 的相同 revision 与两字段快照，缺失或多跳都保持未确认。对这一路径的 SDK 实现作过安装内容逐 SHA 核对。

恢复仅撤销本轮已确认写过的字段，且当前 revision、own/raw/effective 快照必须仍精确等于本轮写后读回值；CAS 冲突或别人后续改动时保留当前设置并报告 restoration=false。整轮未派发设置写时，恢复也只读，绝不会回写外部变化。已派发但 ACK/读回未知的写不会重新发送或补偿，之后布尔值偶然相同也不记作已确认恢复。

## 先做只读 Host 探针

需要先确认真实 namespace 的元数据时，在新的准备命令中同时加 `--test-only-auto-run --test-only-probe-only`。probeOnly 必须同时绑定在 manifest 与 patch config，仍使用原子一次性能力和真实 ACTIVE/owner 回执。此模式不启动 external carrier，不需要 PD 槽；载体入口遇到 probe 配置也会在任何 PD 命令之前拒绝。

此模式只允许官方 settings/describe 和电脑状态读取。独立 adapter 拒绝 settings/mutate、fixture prepare/arm、session prompt、connect/start；即使调用者错误地请求，也不能执行。原任务循环仅做原始快照与收尾读回，结果明确为 `QIUYA_READ_ONLY_OWNER_PROBE`、`probePassed`，`passed=false`、模型和设置变更请求均为 false。未变更读回确认后可按正常精确卸载流程移除；探针通过不代表三任务视觉模型通过。原 Console 与正式三任务默认行为保留。

根任务已用单独 fresh 目录实际验证此探针与正常精确卸载：namespace 唯一、两项 effective=true、writable=true、revision 为整数、本地连接空闲；模型/设置变更/连接分派均为零，前后读回一致。该实际结果仅证明只读 Host 路径和本轮原始状态，不倒填之前 owner-enable 失败的未知回执。

## 零任务正常取消：先单独验证载体收尾

先在新的独立目录执行下节同一准备命令，但去掉 `--test-only-auto-run`，也不传 `--test-only-probe-only`。这只冻结程序，不安装 Host、不生成可自动运行的模型能力。持有 PD 槽后启动该目录 `external-carrier-command.json` 的冻结入口，待它确认自己的交互 Node/计划任务身份并产生 carrier-ready，再执行同一目录 `external-cancel-smoke-command.json`；等价命令为：

```sh
node <目录>/carrier-bundle/windows-cancel-smoke.mjs \
  --config <目录>/external-config.json --root-approved
```

该入口不访问 Host、不发模型、不准备业务窗口、不注入输入，只原子写入同 runId、nonce、cancelId 与三个来源 SHA 绑定的有限取消请求。guest 接受时必须为零 records、唯一 carrier 初始化、尚无 native/fixture；正常退出前执行原独立只读 OS/桌面/held/lease/journal 审计。Mac 端另核 guest 自然退出、计划任务 Ready/result=0、精确注销和 pause-idle 恢复后，才发布 cancelled ACK。未知结果不能重写请求。

验收依据为 `evidence/cancel-smoke-report.json`、`external/carrier-cancelled.json` 的独立 audit、`evidence/windows-guest-report.json` 与最终 carrier report；外层启动器还必须另证 carrier 自然 exit=0。零任务取消仅为 `status=cancelled`、`businessCompleted=false`，绝不变成三任务 completed。完成三个独立 clean 记录仍是 completed 的必要条件。

正式 Host 任务若在 owner-settings-read/owner-enable/owner-status 阶段失败且尚无任何 prepare，会用同一协议自然取消空闲载体；原业务失败保留 failed。已进入 prepare、存在 records/active、来源/nonce 不匹配或取消响应未知时拒绝该零任务分支，继续原有严格清理且不重发模型或输入。取消 smoke 与正式三任务必须使用不同 fresh 目录，不复用能力或旧回执。

## 实际运行顺序

2026-10-22 全新第四轮 `原始截图/真实DeepSeek-Windows-正式c8-4/` 已实际通过三任务：`report.status=passed`；任务 1/2/3 分别为 35,359ms／5 requests／4 steps、107,791ms／12／11、36,465ms／5／4，business、视觉 nonce、自然 cleanup 均为 true。模型为当前账号 `deepseek-account/deepseek-flash`，正式 native SHA 为 `c8be449d…559ce`，fixture 为 `0d34a1e1…b46ce`，两份 PE 均为 ARM64。任务 2 成功 click 后继续使用旧 frame 的 type 收到公开错误 `STALE_OBSERVATION`；原报告仍保留有限投影 `unclassified`。模型 fresh observe 后进行了第二次完整 click，再 observe/type/observe/Enter 并完成业务；不能写成全程零错误或零重复动作。输入分派前拒绝的结论依据源码控制流与自有工具事件顺序，本轮未直接检查原生输入事件。

本轮 Host autorun passed，两项初始 true 的设置经只读确认、未派发 settings/mutate；localMode 与 featureFlags 恢复均 true。carrier completed、三条 clean、计划任务自然 Ready/result=0、精确注销、idle 恢复；外层自然 exit=0/signal=null。官方 add/remove 各单次 exit=0，卸载后 dependency/selection 缺席，原 patch 缺席、原 Fiber DISPOSED、资源清理与路由移除均通过。完整身份、源码/证据 SHA、截图复制回执、异常和覆盖限制见 [Windows 真实模型验收记录](windows-real-model-acceptance.md)。截图保存在项目外全新 `成功截图/Windows-真实DeepSeek-三任务-c8-4/`，不进入 Git。

2026-10-22 的零任务取消已在项目外 `原始截图/真实DeepSeek-Windows-正式c8-cancel-1/` 实际通过：没有Host、模型、fixture或输入请求，guest正常退出、Task Ready／结果0、精确注销、OS held／lease／journal审计及idle恢复均通过；外层另记录carrier自然exit0／signal=null。该结果只证明取消，`businessCompleted=false`。

随后全新第三轮 `原始截图/真实DeepSeek-Windows-正式c8-3/` 已实际激活官方临时包、复用真实owner、以初始两项true跳过设置写入，并创建Windows隔离目标及取得session/prompt ACK。但首个turn在6ms内以error结束，模型requests=0、steps=0，最终达到原180秒上限，尚未进入真实模型／工具任务。两项设置和local连接恢复均true；原生与fixture正常退出、OS held=0／lease空闲／journal缺席，但子进程取证报 `VISION_WINDOWS_CHILDREN_UNCONFIRMED`，整轮仍failed。

第三轮只单次调用官方remove：CLI实际exit0、dependency与selection缺席、原patch缺席且原Fiber DISPOSED、路由移除；由于缓存的子进程取证失败，正常卸载的整体核验仍failed，不追认为通过。另一次独立只读后验确认精确PID＋birth、UUID可执行路径／命令行范围及自有计划任务均缺席，idle恢复；它只证明现在退净，不重建此前缺失的子进程身份。错误类别和子进程取证继续独立修复，旧cap和原报告不重放、不覆盖。

上述取消与第三轮失败记录保留原结论；第四轮通过仅覆盖固定 target 的四工具 Windows ARM64 VM 真实视觉业务，聊天自动 discover/request 与授权选择流程、Mac 原生目标、物理 x64 实机均不在本轮覆盖内。后续每轮须先取得独占PD槽，再生成新的准备目录；不要使用已经审阅或过期的runId/cap，不与Windows WebView2长测或其他输入测试并发。

1. 在项目外新建父目录，选择新的唯一子目录。使用当前已审核 PE；若正式 PE 更新，先换成新 SHA 并重新准备。

   ```sh
   node scripts/prepare-live-vision-windows.mjs \
     --output /private/tmp/qiuya-windows-real-vision-本轮唯一目录 \
     --native /Users/qiuya/code/zh-code/dsh-QiuYaTools/lib/native/win32-arm64/qiuya-windows.exe \
     --native-sha256 c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce \
     --fixture /Users/qiuya/code/zh-code/dsh-QiuYaTools/artifacts/computer-use/windows-visual-business-fixture-build-utf8/win-arm64/QiuYaTools.VisualFixture.exe \
     --fixture-sha256 0d34a1e1e11d2d5fbc744257baa206050e8ed5958b9646f476edd42e3eab46ce \
     --test-only-auto-run
   ```

2. 核对 `preparation.json`、`carrier-bundle/windows-carrier-manifest.json`、`official-cli-driver-command.json` 的源码闭包、哈希和实际 import smoke。准备器没有访问 PD、安装插件或发出推理。全部程序入口都是独立冻结 bundle。

3. 先运行本轮 `external-carrier-command.json` 中的 executable/args。它确认 Session 1 交互用户、正式 PE 与 Node SHA、严格进程身份、精确计划任务 action/principal，再写 `external/carrier-ready.json`。不要打印该文件的 nonce 或配对 token。

   每个准备阶段都会先持久化 `evidence/windows-carrier-stage-NNNN.json` 的 started 回执，再执行该阶段；远端创建目录、传输、注册并启动自有任务均有此前置回执。completed/failed 关联 startedSequence；最终 `external-carrier-report.json` 的 failureDiagnostic 保留精确阶段。所有 PD/PowerShell 命令只记录退出码、信号、stdout/stderr 的字节数与 SHA，绝不记录 argv、PowerShell 正文或原始错误消息。数字进程退出码与 EPERM 等 Node 错误区分，未知消息/未知代码只保留摘要；PowerShell 仅投影 parser/command-not-found/access-denied/download-or-network 类别。诊断写入失败不允许未开始的动作执行；命令已经失败时，后续诊断落盘失败保留原失败，不重发命令。

   第一轮载体启动失败的回执与一次性能力原样保留，不能用新诊断重放旧目录；只生成新 runId。查询交互用户的简化 `Where-Object` 管道已将属性与运算符规范为独立的 `SessionId -gt 0` 参数；不能凭此推断缺失阶段证据的首轮失败已确定根因，真实 Windows 的只读旧/新管道对照另行记证。没有 carrier-ready 时不安装插件，也不发模型任务。

4. 对本轮冻结 CLI driver 执行只读投影。这里 `<目录>` 为第一步生成的绝对路径。

   ```sh
   node <目录>/official-cli.mjs --prepared <目录> --mode list --root-approved
   ```

   输出仅为本测试 bundle 的 dependencyPresent/bundleSelected/version 和字节数/哈希，不输出整个 profile、其它插件信息或原始命令日志。测试 bundle 必须尚未安装、尚未选择，否则不借用旧实例。

5. 单次安装并自动触发：

   ```sh
   node <目录>/official-cli.mjs --prepared <目录> --mode install --root-approved
   ```

   driver 在调用官方安装 CLI 前写入 `cli-install-attempt.json`，随后仅执行一次已冻结 `dsh plugin --profile desktop add --save-exact <归档>`。未知结果不会重发。除官方 CLI 零退出外，还必须有 dependency/selection 存在和匹配 runId/manifestSHA/patch ID 的 `host-activation.json`，其中 `exactPatchActive`、`existingPeerReused`、`ownerPeerActive` 必须为真。

   不再执行 `00-run.txt`，否则会产生第二次触发尝试。该文件只为默认 Console 模式保留。

6. 等待 `evidence/host-autorun-result.json`、`evidence/report.json` 和 `evidence/external-carrier-report.json`。三任务成功图像均为 Windows 自有窗口，保存在本项目外准备目录。每个任务必须有真实模型请求、图片、nonce 与独立业务通过，且 cleanup/audit 全部通过。carrier 的计划任务还需自然 Ready/结果零、精确注销、pause-idle 恢复及启动进程自然退出。

7. 恢复回执确认后单次卸载：

   ```sh
   node <目录>/official-cli.mjs --prepared <目录> --mode remove --root-approved
   ```

   driver 只删除已有本轮安装 attempt 对应的临时 bundle。删除前还核对实际已安装 package/guard SHA 和唯一 patch 的 ID/name/完整本轮 config，防止借用别人的同名包；前后比较排除本测试依赖和 selection 后的 profile manifest 哈希，检测无关字段变化。通过条件包括官方 CLI 零退出、dependency 不存在、bundle 不再选择、`host-deactivation.json` 确认原有资源/路由/设置恢复，以及 `host-patch-inactive.json` 中固定 patch 不存在、原 Fiber DISPOSED。没有这两类运行时回执，不能声称卸载验收通过。

   正常卸载的前提是本轮身份、cleanup 和 restoration 已确认，不要求三个业务任务通过；业务失败仍保留 failed，也可以正常卸载。

### 安装已落盘但 guard 没有激活

若官方 add 已写入依赖，但 guard apply 报错、没有 `host-activation.json`，默认 remove 不会拿缺失的 restoration 当成成功。此时可以显式运行同一冻结 driver 的有限恢复入口：

```sh
node <目录>/official-cli.mjs --prepared <目录> --mode recovery-remove --root-approved
```

这个入口仍要求：本轮 install attempt 记录证明安装前没有该依赖/selection；canonical profile 身份相同；当前实际安装 guard SHA、package 名称/版本/入口、唯一 patch ID/name/config 完全匹配本轮。存在 activation 回执、包已变更、profile 已变化或无法确认身份时不执行恢复删除。它只单次执行官方 `remove qiuya-live-vision-test-only`，正常删除与恢复删除共用同一个 `cli-remove-attempt.json`，不能换 mode 重试未知删除。

恢复删除确认该依赖和 selection 已消失、无关 manifest 字段保持一致后，结果固定为 `recovered-runtime-unconfirmed`，进程退出仍为失败。它不把“没有 activation”推断为“未推理”，也不把依赖移除声称为自然清理、运行时 patch 已退场或三个任务通过。根任务保留原失败回执，另核对自己的载体与进程退场后才开始新 runId；不得复用旧 cap 重试任务。

安装结果未知或恢复未确认时，保存原始失败回执，不重跑 install/prompt/input。根任务先依据已核验的本轮身份处理自有资源；必要的明确恢复不能被记作自然清理成功。

### 已激活、零任务失败，但设置恢复未确认

这种情况不能套用无 activation 的 recovery-remove，也不能伪造正常 remove 所需的两个恢复标记。经根任务明确授权，使用 `prepare-live-vision-failed-remove.mjs --prepared <旧目录> --output <全新清理目录>` 冻结新的 cleanup-only driver 与绑定；旧 driver、cap 和失败回执保持原样。

该分支只接受精确本轮的 activation、终态 failed/tasks=[]、noOwnedActiveTask=true、Windows records=[]、本次 deadline 取消后的 Ready/result=1、完整 cleanup-own-task/restore-idle 阶段、外层自然 exit=1 与 idle 恢复。还复用原安装 attempt、实际 package/guard SHA、完整 patch/config/profile 身份和无关 manifest 哈希检查。单次 remove 共用原来的 `cli-remove-attempt.json` 防止未知重发；不因推理能力过期而拒绝合法清理，不延长任何推理权限。

只有原 guard 正常 disposer 确认 ownedCleanup/routesRemoved、固定 patch 消失且原 Fiber DISPOSED 后，结果才记为 `removed-restoration-unconfirmed`，退出码仍为 1。原 false 恢复标记、业务失败和设置恢复未确认原样保留；该分支不修改任何用户设置，不声称模型或设置恢复通过。

## 离线验证与限制

本单元已实际运行原 guard/Console/external/Windows adapter/carrier/新 Host 入口、有限阶段诊断、零任务异常卸载、只读 owner 证据、设置并发恢复与零任务正常取消联合 87 项，全部通过，零跳过；另用 .NET 8 实际编译并运行原 C# BindingSelfTest 的十一项元数据策略检查。验证了私有文件原子竞争、防重、参数隔离、原 Console 兼容、未知 CLI 结果不重发、CLI 零退出不冒充 Host 激活、UNLOADING 不冒充释放、业务失败仍可按清理证据正常卸载，以及恢复删除不冒充模型/设置恢复通过。实际 Node 子进程失败验证了数字退出码和 stdout/stderr 摘要，且诊断本身失败不会改写原始命令失败或重放命令。设置测试另覆盖零写时外部变更、仅本轮字段恢复、写后并发 revision、ACK 到读回之间多跳和未知结果不补偿。准备器实际导入 guard、host/guest relay、零任务取消 smoke 和冻结 CLI driver。

这些是离线代码/协议验证，不是本轮 PD 的 PowerShell、真实 HMR 安装或 DeepSeek 图片推理结果。实际运行结果由上述项目外回执和截图判定。默认 Console 安装/触发/卸载文件继续保留，未更改发布插件与原生正式 PE。
