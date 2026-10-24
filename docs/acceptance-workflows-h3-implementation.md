# H3 自动验收与有限修复（隔离开发候选）

本单元为第 16 节 H3 的可审实现。它使用当前会话的真实 Harness 主 Agent、H1 运行账本和 H2 已授权目标，不创建另一套模型循环或旁路输入。未完成新包安装、Mac／Windows 逐功能视觉和真实 DeepSeek 验收之前，不将本文件当作产品验收通过记录。

## 用户交互与执行顺序

用户可直接在会话说“帮我验收本地登录页：空密码要有提示，测试账号能登录，退出后应返回登录页”。模型沿现有电脑／浏览器入口选择真实目标、申请站点／应用许可，再调用 `qiuya_acceptance_plan`。聊天中显示可编辑的检查清单。用户可修改标题、描述、必需项、明确的应用预期值，增删检查项和调整冻结前预算；新增但尚未确定校验方法的项目默认不可自动通过。用户也可直接放弃未开始清单，零设备停止和零 Agent 取消。

模型以最新 revision 调用 `qiuya_acceptance_start`，此时冻结清单、预算、必需／可选以及独立断言，并将当前真实 Agent、服务、环境、目标与 epoch 固定。视图标签切换不改变执行目标。模型明确切换执行目标再切回，也不能复活旧 workflow 的能力。

每项检查必须先 `qiuya_acceptance_checkpoint(start)`，再调用既有真实 observe／act 工具并取得新图片证据；随后 `checkpoint(verify)` 只提交已落盘的 evidence ID。Host 在原图片附件归一化、实际字节回读与 H1 证据提交后建立自己的独立事实，不接收模型提供的事实、JS、verifier、passed 或许可值。结束通过 `qiuya_acceptance_finish` 的 H1 汇总。

当独立检查明确失败时，模型可在原预算内调用 `qiuya_acceptance_repair`。该调用等待聊天卡中的“允许本次修复／不修复”。允许仅消费一次有限修复与复验名额，文件、终端、应用、站点权限仍走 Harness 原授权；它本身不会执行修复或扩大范围。复验必须创建新 attempt 并重新观察，旧失败与旧图片始终保留。inconclusive／blocked 的检查不得以“重新检查”静默开始新 attempt；先补足信息，必要时结束本轮并显式关联创建新清单。拒绝时不得新增 attempt。

缺少账号或预期不明确时复用 Harness 原提问能力。依赖信息缺失的检查保持 unavailable，其余可独立执行。不得把密码、令牌等凭据放进预期值。H3 不提供通用终端执行器、Git 推送或发布权限。首版一个 workflow 固定一个真实服务／环境／应用来源；同源多页面可持续检查，跨应用／跨来源变更须显式新建关联 workflow，不能把新目标图片记进旧 run。

## 独立校验的范围

| 类型 | 能自动确认的事实 | 不能确认时的行为 |
| --- | --- | --- |
| browserValue | 实际非忽略 AX 投影中唯一的 role＋name，且实际字符串 value 与冻结预期精确相等 | 缺失、重复、非字符串、错误来源、解析失败、1500 节点／4000 字符／200000 字符投影边界均 inconclusive |
| nativeText | 实际原生 AX 投影中出现完整的预期字符串；可提供明确失败字符串且失败优先 | 不以子串、缺少失败文案或控件缺失证明成功；300 字符原生截断边界／缺失 AX 均 inconclusive |
| unavailable | 记录需要补充的独立依据 | 不自动通过；纯视觉风格、未提供独立 oracle 的主观需求保持待确认 |

这些是确定性的应用状态断言，不宣称通用视觉模型能独立验收所有任务。每个自动通过项目仍要求 H1 当前 attempt 的实际图片引用、哈希、目标、epoch、frame 和 geometry 全部匹配且可回读。模型的“完成了”、performed、许可或旧绿色报告不能替代结果。

## 权限、取消与未知结果

Owner RPC `qiuya-tools.acceptance-workflows` 只允许 list/get/edit/repair/cancel。使用真实公开 HostConnectionService 的 canonical Service 身份，保留 exact peer／principal、请求和宿主生命周期；body 流每 await 围栏、上限 256 KiB、2 秒读取预算。每次先通过公开 sessionQuery 的 `projectionMode:none` 核对本聊天 header，立即释放观察；查询预算结束后不会错误取消合法的后续处理。请求不接受 Agent、环境 service 或执行 capability。

运行中取消先持久记录 intent，同步撤销 H1 与事实缓存，随后对捕获的真实 H2／原生服务停止输入，并调用该真实 root Agent 的公开 `cancel({kind:'user'},{keepInbox:true})`，保留尚未开始的其他用户消息。取消回执分别保存 deviceReleased／agentIdle／inboxEmpty：除旧目标同服务停止、epoch 前进和输入释放外，还须等待真实 root Agent 的公开 whenIdle()，随后核对 status=idle 且 nextTurn／nextStep 队列均为空，才记录 quiescent=true。仅有 void cancel()、设备停止或 status=idle 均不足；未开始的用户消息不会被删除来制造空队列。等待仍受原清单剩余 deadline 与 owner 请求信号约束，超时保留已确认的设备释放并将 Agent 退场标为未知。旧版缺少三项事实的回执只读显示停止未确认，不重写原事实；未知或 Owner 变化保留未知、只读，不重试输入／停止。历史、重启、Agent 替换、环境变化、H1／workflow 写入结果未知均不能恢复控制。取消／中断后重新发起需显式 previousWorkflowId 关联；这是新的 H1 run 和新观察，不重放旧动作。关闭结果卡只取消读取。

清单状态与 H1 verdict 分开：draft／discarded／running／awaitingRepair／cancelRequested／closed／interrupted 管理交互；passed／failed／inconclusive 等真实结论仍由 H1 保存。`closed` 并不表示通过。

## 存储和接线

草稿编辑保存的每次 CAS 围栏同时校验 exact active 对象、原 Agent 身份与 owner 请求；同 ID 新 Agent 在文件写入过程中替换旧句柄时，禁止提交旧编辑。

私有 profile 下新增 `qiuya-tools-workflows/v1` 清单头，SHA 完整性、目录与文件身份、无 symlink／hardlink、私有权限、独占锁和原子 CAS。默认最多 64 份清单、8 MiB 总量、256 KiB 单文件；不删除未知锁，不自动恢复旧控制。失败 attempt／图片仍在 H1 账本中，清单编辑头不改旧事实。

`src/index.ts` 在 H1 构造时注入固定 Host verifier 和 committed-observation hook，在 H2 就绪后安装 H3。Client 用公开 conversation event projector 和 ChatNode slot 显示清单，证据详情打开已有 H1 公共资源地址；没有私有聊天追加、iframe 或手动关联聊天设置。安装和卸载对 partial registration／disposer 异常逐项清理。

## 本单元验证与后续实际门槛

可运行 `npm run test:workflows`、`npm run typecheck:workflows:host`。开发测试使用真实 H1 store／service、H2 manager／registry／session、公开 Cordis ToolRuntime 和实际 HostConnectionService 内存实例；设备、Agent、附件和查询中的业务输入由明确的 unit fixture 代替，不冒称真实浏览器、图片解码或 OS 视觉。图片字节 fixture 的用途是验证引用与 Hash 围栏。

整合方须在新 UUID／新 nonce 的隔离工作区安装候选包，保存 schema 热加载收据，再以真实模型完成三个固定成功任务及各自业务错误／证据不足／环境不可用负例。每任务仍沿用原 12 轮／180 秒外部模型预算，H3 不提高它；修复等待也占原 deadline，不另起预算。须验证编辑后冻结、真实图片与独立断言、批准／拒绝、失败 attempt 保留、取消和目标切换只读；在 Mac 和 PD Windows 各记录截图、输入／lease／进程与资源回收事实。开发测试全绿不能代替这些实际门槛。

本单元没有修改 Mac／Windows 原生代码、原物理输入时序、TTL、FIFO、屏幕权限或安装包 64 MiB 上限。最终包体与安装兼容性需要整合方以实际完整包重验。


## 2026-10-24 核心单元构建与真实SDK验证

- 从精确暂存33文件独立还原，排除未完成的前台交接／原生与测试基础设施改动；普通类型、公开SDK Host严格检查及426项相关回归通过。整合工作区在最后一处轮询提示修正前通过1557项全回归；修正后另经相关回归及实际界面验证。
- 129个精确输入的三生产入口构建、Mac／Windows ARM64／x64三归档的原64 MiB门和空目录Host导入通过。Mac包 `42aff4685da90a5969e0c5d401d40389ee007b7d9eb3e4efb0b32755ea8acf89` 经官方管理器装入独立配置，实际主Agent的公开工具schema另保留加载收据。
- Mac真实SDK／界面／浏览器五项闭环通过：自然网站授权与草稿；正常UI编辑及同版本并发CAS一成一拒；保留BUSINESS_MISMATCH后一次用户授权修复、真实可信点击及新图片独立VERIFIED；失败和成功attempt的三份实际图片字节／SHA／目标归属；正常取消得到deviceReleased、agentIdle、inboxEmpty全部true。独立进程身份审计确认浏览器和Host自然退出，未清空用户队列或发送设备输入重试。
- 首轮取消测试在服务器已进入等待修复时，界面仍显示上一版本运行卡；该轮未形成取消记录并超时，保留失败证据。后续载体在原共享15秒内等待实际当前修复按钮可用，再正常点击一次取消，独立网络回执确认expectedRevision=5且成功。没有修改服务端CAS或延长预算。
- 顺便修复成功的后台读取抹去未知提交错误提示的问题；真实React延迟轮询回归确认提示持续且不重复mutation。共享图标拆成独立模块，H1原公共Modal及导出行为保留。
- 原始图、逐项事实和完整清理收据位于 `/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Mac-H3-待修复表单围栏-42aff4-20261024/`；整理报告与开发验证包分别放在同根的“报告/H3-自动验收核心-20261024”和“构建包/H3自动验收核心-20261024”。

这些是确定性适配器的真实SDK、界面和业务状态闭环，尚不代表真实DeepSeek或Windows界面验收。完整历史检查点展开、各平台最终新包及其模型负例继续单独验证。
