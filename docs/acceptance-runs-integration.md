# H1 自动验收记录与电脑操控接线

H1 复用当前聊天的真实主 Agent 和电脑操控工具。用户启用电脑操控后，模型可从会话正常发现应用、等待授权并调用工具；没有新增“关联聊天”设置、第二套模型循环、额外截图循环或自动恢复输入。

## 正常调用顺序

1. 已有 `qiuya_computer_discover` / `qiuya_computer_request_control` 完成实际应用授权，电脑环境处于 ready/running。
2. `qiuya_run_begin` 固定检查计划和预算，Host 绑定实际 live root Agent 对象、Host 生成的实例 UUID、真实环境 UUID、epoch 和已授权目标。它不授予操控权限。
3. `qiuya_run_checkpoint(phase:start)` 建立唯一未结束的检查尝试，然后照常 observe / act。observe 的同一次 SDK saveImage 引用自动成为可信证据，不另拍一张图。原始几何来自真实 observation，图片摘要来自归一化后 readImage 的真实存储字节。
4. Native observe 的文字结果和 PTC 结构化值都返回 evidenceId / attemptId / 当前 revision。调用结果丢失时，`qiuya_run_get` 里的 committedEvidenceIds 可恢复已提交证据，不需要重新截图。evidenceIds 仍表示已选择参与 assessment 的证据。
5. `checkpoint(phase:verify)` 提交模型建议和已提交证据 ID；`finish` 由 Host 汇总事实。默认没有通用业务验证器，模型建议 passed 会得到 `VERIFIER_UNAVAILABLE` / inconclusive。收到真实操作 ACK 也不等于业务验收通过。

当前每次电脑操作必须属于唯一当前 run / 未结束 attempt；同聊天同时有多个未结束 run 会拒绝猜测，先使用正常工具汇总旧记录再建立新记录。其他聊天的独立电脑环境仍可同时存在。

## 输入与控制生命周期

可信 recorder.interrupt 只撤销该 run 的内存执行能力，不补写事实。真实 CAS 落盘但 issued / ACK 回执丢失时，同时中断 core 与 bridge：模型 get / checkpoint / finish 和 owner history 都变为只读待确认。每个正在进行的 mutation 在异步 evidence / verifier 返回及 CAS beforeRename / afterCommit 围栏还会重新检查该 run 的能力，不能仅凭 Agent / 环境仍相同继续提交。只有显式 previousRunId 能开启关联的后续 run，不能自动忽略未知旧记录。

`issued` 必须在调用既有 service.act 之前原子落盘。只有原 SDK exec 未取消、真实 Agent / 环境 / epoch / target 仍一致，才可记录匹配 ACK。失败、迟到、未知或取消不会重放输入；无法写 ACK 时保留 issued，历史投影显示待确认。

暂停、人工接管、目标更换、应用撤权、重连或 Host 重启后，旧记录只供读取。历史读取不伪造 Agent、AbortSignal 或执行上下文；需要继续时可由当前真实会话建立 previousRunId 关联的新 run。未确认原生输入继续由既有电脑操控状态机阻止，不由验收记录恢复。

`ComputerEnvironmentManager.runEnvironment` 仅读取现有运行态，不创建 router、不调用 status、不查询 OS，也不恢复已退役的快照。环境创建和 owner connect 会生成新的不透明 UUID；聊天 ID 不能冒充环境 ID。

## Owner 历史与证据

只读 RPC 仅允许 list / get / evidence / export。请求读取 body 之前固定本次 owner peer、principal、connection 和请求/Host lifetime；每个 body await 及后续 await 后复查同一对象。Body 最多 32KiB、2 秒。公开 SessionQuery 只观察当前 profile 的指定 Session header（projectionMode:none），不读取聊天事件，lease 始终释放，迟到 lease 也会回收。

持久图片只经公开 attachment readImage 读取，Host 复查完整 ref、长度和 SHA，Client 再核对实际字节与解码尺寸。导出白名单不含路径、权限凭据、聊天内容、输入文字、按键、URL 或 selector。

默认目录为真实 profile 的 `qiuya-tools-runs/v1`；采用有界存储、跨进程 CAS、独占锁、不可变历史快照、原子 head 更新以及符号链接/硬链接拒绝。重启只读，不自动恢复动作。

## 公开 SDK 与构建边界

Host / Client 的 `Context.sessions` 不是同一个服务。生产只引入所需公开成员的 capability interface，遵循既有 computer-use/tools.ts 的边界；`tests/types/acceptance-runs-sdk.ts` 另在真实 SDK 的独立 Host 图核对 AgentRegistry、ProfileContext、AttachmentStore、SessionQueryEngine、ToolRuntime、ToolDefinition、ToolRunContext 的赋值兼容。没有修改原批量归档和计划批注业务，也没有 any、ambient SDK 桩或私有 API。

该单独 strict 检查需官方 @types/js-yaml@4.0.9（只供开发）。普通完整项目源码 tsc 和 Host strict（skipLibCheck:false）均通过。Client strict 仍保留当前 SDK 的 28 条库声明闭包错误；不能称全量 SDK strict 完成。

## 本轮状态

生产接线已集成到当前源码。135/135专项、109个测试文件中的1165/1165完整直接回归与TypeScript检查实际通过，无skip、cancel或todo，源码和正式lib的SHA/inode围栏保持不变。完整回归在沙箱下曾有23项回环监听EPERM及1项Swift缓存写入失败；原报告保留，在正常本机权限下执行同一套测试后全部通过，没有修改门槛。

三个生产JS入口通过write:false独立构建，绑定99个实际输入（包含构建脚本）。加入H1后的未压缩x64包超出原64 MiB限制619字节，原失败保留；三个入口改为minifyWhitespace、保留标识符后，三平台候选均通过原大小门槛、生产归档验证器和空目录Host导入/Config/apply注册检查。首批H1开发包为Mac `69b848c4…`（1,116,365字节）、Windows ARM64 `8c7782cd…`（62,841,342字节）、x64 `d513f109…`（67,091,071字节）。这些是绑定当时README的中间开发候选，不是最终发布或个人安装回执。

Windows Node22/NTFS首轮在注册自有普通用户任务时停止，未启动Node、Host或输入。只读实际投影确认TaskScheduler将注册SID规范化成用户名，解析后的SID与预期相同，Interactive/Limited及执行路径/参数/driver SHA均匹配；载体直接比较principal原字符串导致误拒。该轮保持failed，任务处于Ready/267011（尚未运行），后续只修规范化身份比较并使用新UUID重测，不放宽真实用户或文件系统门槛。

仍须安装完整候选，在Mac / Windows做真实会话与UI验收，核对当前版本实际模型schema / image receipts、权限、NTFS及卸载清理。H1尚未完成产品视觉验收；这些回归不能证明业务验收通过，也没有写正式lib或安装到个人Harness。

更新README后的Mac候选`69a11ece…`已在真实官方Harness隔离profile安装，并完成原8项headless DOM回归：十个设置页、设置保存、真实主Agent的确定性模型会话、提示词、TXT ready、会话菜单、批量归档及计划批注。前端错误为0，Host正常退出0，浏览器正常关闭，nativeCommand/helper/原生输入均为0，源码与候选围栏稳定。这证明新增Client接线及空白压缩后的整包加载和原功能回归，H1新结果卡、历史证据与真实模型闭环仍须单独验收。
