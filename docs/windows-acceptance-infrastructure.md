# Windows 验收载体的准备与自然清退

这里保存 Windows 逐功能实测中已经定位的公共载体修复。它们是测试工具，不会注册到插件的生产 Host/Client，也不包含个人机器、历史截图、缓存位置、模型凭据或既往验收结果。调用方必须显式提供本轮 VM、网络入口、候选 SHA、架构、独立测试目录和精确任务身份。历史失败不能因为公共模块的测试通过而被改成成功。

## 先准备，再开始原有查询预算

`readonly-stdio.mjs` 的 `OwnedReadonlyStdio.prepare()` 只启动本轮自己的进程并等待 nonce、源文件 SHA、helper SHA 和进程身份都匹配的真实 ready 消息。它不发 pin、tree、listener 或 retired 查询。调用方在已经持有 reader 的 `try/finally` 中完成准备，随后才开始各次原有 2 秒查询；关闭时只发送 stdin EOF，不调用 kill。

```js
const reader = new OwnedReadonlyStdio({
  spawnChild: spawn,
  command: 'powershell.exe',
  argumentsFor: ({ nonce }) => [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', prepared.sourcePath,
    '-SourceSHA256', prepared.sourceSHA256,
    '-HelperAssemblySHA256', prepared.helperSHA256,
    '-ReaderNonce', nonce,
    '-OwnerProcessId', String(process.pid),
    '-OwnerExecutable', process.execPath,
    '-OwnerMarker', prepared.exactOwnWorkerPath,
  ],
  ownerPID: process.pid,
  sourceSHA256: prepared.sourceSHA256,
  helperSHA256: prepared.helperSHA256,
})
try {
  await reader.prepare(120000) // 独立环境准备；尚未开始业务或进程查询。
  const pin = await reader.query(exactPinArguments, 2000)
} finally {
  await reader.close(2000)
}
```

`prepared.sourceSHA256` 必须来自**实际复制的同一份** `windows-own-reader-stdio.ps1` 冻结清单，不能把另一个阶段的 literal SHA 一起复制。源文件和 helper 仍由 PowerShell 自行校验；错误、超时、迟到响应都会保留 unknown，并禁止继续查询或重放。EOF 只证明发送过正常关闭请求，最终还要核验原进程和任务自然退休。

只读 helper 源与可复现项目位于同目录。可在业务前构建一次，产物和中间文件放在项目外：

```text
dotnet build scripts/windows-acceptance/process-reader.csproj -c Release --output <outside>/reader -p:BaseIntermediateOutputPath=<outside>/obj/
```

项目固定 .NET Framework 4.8 官方引用版本及 AnyCPU，不在每个查询中冷编译。调用方记录自己实际产出的 DLL SHA/字节数，并在 Windows 准备阶段验证加载。编译通过本身不证明 Windows API 已执行。

## 单批准备与持久 Task 查询

`makeTaskReadyBatchPrepare()` 在一次固定 PowerShell 调用内校验、下载已声明的文件，再注册只读服务，收到真实 `mainTaskReads:0` ready 后才注册业务任务。准备期固定为 120 秒，与业务及终态预算分开。

允许 `guest/oracle/OwnWindowBodyOracle.cs` 一类预绑定、大小写保留的相对文件名；仍拒绝绝对路径、空段、`.`、`..`、驱动器、反斜线、ADS、Windows 设备名、尾点/空格、大小写别名和文件/父目录冲突。每级目录必须位于 canonical own root 下且无 reparse point，写入使用 CreateNew 并复核 SHA。重复原子 journal 使用 PowerShell 5 的 `[NullString]::Value`，不能把 `$null` 作为 File.Replace 的 backup 参数。

`PersistentTaskReady` 与 `task-ready-service.ps1` 在准备期建立同一 Interactive/Limited 用户的持久 COM 服务。准备阶段不预读业务 Task 状态。收到本轮密封 runner 终态后，才使用新 nonce 进行一次原有 **5 秒**终态读取；每次仍核完整 Task action、SID 规范化、LogonType/RunLevel、triggers、launcher SHA 和已运行状态。冷启动 PowerShell/prlctl 不占这 5 秒。未知查询不能补发；迟到的旧 query 回执不能覆盖 EOF 的新 nonce。

## 提前部署脚本，结束时只提供本轮 pins 元数据

`prepareMainRetirement()` 在业务前生成并固定清退脚本、路径和 SHA。业务结束后 `mainRetirementCommand()` 只产生短 `-File` 参数，以及固定私有 HTTP 路由需要的一份动态 pins 缓冲；不能把整个 pins JSON 的 Base64 放进 prlctl 命令行。

`invokePreparedMainRetirement()` 是现有载体回调的窄封装。调用方的 `provideMetadata(name, bytes)` 必须同步把字节发布到**已有**的本轮 nonce HTTP 文件映射，`execute(argv, remainingMs, sourceSHA)` 只执行已经部署的那个脚本。它没有下载新脚本或新建 daemon 的能力。

清退原有 30 秒共享预算覆盖一次元数据 GET、完整 SHA/字节数校验、所有原 PID/birth pins 退休判断，以及精确 Task Ready 与元数据注销。源内有限 journal 区分这些阶段，错误只写有限 code/HResult/行号，不收任意异常原文。`metadataFetches:1` 表明确实发生了一次网络读取；历史字段 `lateTransfers:0` 仅表示结束时没有再传新脚本，不能写成“零网络”。

内层清理的字段合同是非空 `report.cleanup` 数组，且每一行都必须显式具有布尔值 `passed: true`。缺少字段、`undefined`、`null` 行或 `passed: null` 都是未证明状态，不能发布清退元数据、执行清退脚本或注销 Task。独立自然退休的证明并不自动补足内层清理结论。

旧载体若仅记录自然退出码而没有 `passed`，调用方需要先依据本轮已经核验的精确身份、自然退出、业务资源释放与 ACK 条件显式规范化，且保留原始字段和规范化依据。公共模块不会按“没有写 false”或单一 `natural: true` 默认放行。

正常退出码只接受已密封的 0 或 1，Task result 必须一致。业务失败的自然 1 可以完成独立清理，但 `finishKnownRunnerPostflight()` 仍会保留整轮失败。内层清理未知、pins 未退休、身份变化、缺 ACK 或超时都不能触发宽泛删除、强杀、Task Stop 或输入重放。

## 两项视觉载体修正

`tests/fixtures/workbench-browser-page.mjs` 是无业务数据的自有网页。每次真实 trusted mousemove 都同步更新可见文字/颜色并记录新序号。`waitMovedDOM()` 只等同 nonce/role/tab 的本次 DOM 更新回执；后台网页的双 requestAnimationFrame 可能暂停，因此它不再阻止原定的第二次真实截图。

这个序号不是截图成功证据。完整 H2 载体仍必须要求同一次真实动作 ACK、原定两张真实 JPEG 的 SHA 不同，以及 UI 选择 B 时模型仍观察 A。不能添加第二次动作、额外 observe、把 A 激活到前台，或用序号代替图像变化断言。

`staleStyleSurfaceFacts()` 只读取调用方已经定位的当前自有批注父面板。导航或滚动使 anchor 失效后，生产组件会删除“临时样式反馈”子面板，在父面板显示失效提醒；验收应读这个真实父状态。多个父面板、外部聊天的文本、仍存在的加入按钮或残留样式子面板都会拒绝。它不修改 DOM、样式或输入，也不能代替 Host 的 anchor/epoch 授权。

## 原子命令回执与未知状态的迟到退出

`command-receipt.mjs` 提供验收工具可复用的 `retainedCommand()`、`coordinatorFailure()` 和 `readCoordinatorResponse()`，不注册生产能力、启动环境或自动发送输入。调用方显式传入本轮命令、固定预算、记录数组和回调；物理调用继续使用原有 10000ms，不因环境迟滞增加预算。

`retainedCommand()` 的 stdout 是原始输出，不假定它是 JSON。自然退出回执保存原 Node ChildProcess 对象对应的随机 spawnNonce、实际 PID/父 PID、可执行路径、argv SHA、退出和管道关闭时间，以及原字节输出摘要。这里不声称额外读取过操作系统的进程出生时间；需要 OS birth pin 的调用方仍须另行核验。stdout 最多保留 32MiB、stderr 最多保留 8192 字节供诊断；SHA 和总字节数则持续覆盖完整原始管道字节，并显式记录截断。正常回执要求同一 child 的 exit 与 stdio close 都已发生，不能在 exit 时就声称管道已经排空。正常退出只是传输结果，调用方还要检查 code/signal、精确业务 nonce 和独立物理观察。

绝对 deadline 从 spawn 起计算，真实 child 的 error/exit/close 和 timer 先绑定，再执行 onStart 记录回调。onStart 慢、失败或 child 先退出都不会丢失终态，也不能在预算外补 ACK；回调成功、原 child exit 与管道 close 必须共同在原期限内满足。start/stdio 错误保留 unknown。

超时时先保留 unknown，再 unref 同一 child 和两个管道引用，不关闭管道或发送信号。`onTimeout` 记录该时刻未确认的结果；同一原 child 日后 exit 且管道 close 后只触发一次 `onLateExit`，不能调用正常 `onExit`、清除 unknown、重发命令或把之前失败改为通过。调用方必须继续保持自己的未知操作禁重放门；本工具不创建重试队列，也不代替完整进程/Task 自然退休检查。迟到证据落盘失败会保留有限 `lateExitEvidenceError`，不会生成成功 ACK。

HTTP 协调器遇到错误时通过 `coordinatorFailure()` 返回有限 JSON 与 `noAcknowledgement:true`；`readCoordinatorResponse()` 只接受 HTTP 成功、明确 `ok:true` 且真实存在 `result` 的响应。HTTP 409 的原始超时原因得以保留，空响应、损坏 JSON、缺字段和超 65536 字节响应都拒绝，不再用通用 JSON 解析异常掩盖原错误。错误正文最多 2048 字符。该 HTTP 结果仍需由调用方按精确业务身份验证；它不是 Windows LL hook 或真实模型运行的替代证明。

此公共模块只提取可维护的命令与回执合同。隔离原生 IME 观察器、实际 guest runner、每轮 nonce、C# 编译产物和个人 PD 日志保留在项目外冻结载体，不作为虚构的公共运行路径加入仓库。旧实验入口也不因此自动成为本轮严格验收入口。

## 离线验证与实机证据边界

```text
node --test tests/windows-acceptance*.test.mjs tests/windows-command-receipt.test.mjs tests/harness-workbench-acceptance-evidence.test.mjs tests/harness-annotation-stale-surface.test.mjs
```

回归运行真实 Node 子进程/stdio、真实流式回调、固定 5 秒超时与迟到回执，以及当前生产 AnnotationEditor 的 React DOM。浏览器作者回调在隔离 JSDOM 中执行，明确不声称合成对象等于真实 trusted 浏览器输入。测试不启动 Harness、浏览器、PD 或 Windows API。命令回执回归另行覆盖真实 Node 子进程空 stdout、慢/失败 onStart、child 先退出、迟到零退出、exit 后管道尾部和 HTTP 409/空响应。5ms 预算与 30ms 回调的旧红新绿复现属于纯载体测试，不是对旧实机结果改判。实际 Mac/Windows 逐功能验收、真实 DeepSeek、截图和可安装包的结论仍以项目外的独立实测报告为准。

## 原进程句柄与同快照归属核验

`windows-own-reader-stdio.ps1` 仅在完整 `pin` / `tree` 操作成功并产生可解析结果后，提交该操作取得的原进程句柄。保留表按精确 PID 与 UTC birth ticks 去重，committed 与 pending 合计最多 128 项；这个上限不代表每次正常读取的瞬时局部句柄也算在表内。失败事务释放全部 pending，EOF 或协议异常释放整个保留表，单项释放异常不会阻止清理其余项。

`retired` 命中同一原 PID/birth 时，以原内核句柄的一次 `WaitForSingleObject(...,0)` 判断：signal 0 使用已有契约 `same-handle-signaled`，258 仍是 `exact-original-alive`，closed / invalid / 其他结果继续拒绝。这个缓存不用于 `pin`、`listener` 或新的输入授权。缓存未命中时保留原严格读取；如果 .NET/PowerShell 返回空 `SafeHandle`，只在独立 fresh `GetProcessById` 的 `ArgumentException` 确证不存在时使用已有 `process-absent`。重新取得一个 Process 对象本身不证明原进程已退，访问错误、仍在或未知都不能转成 gone。

有限诊断只包含阶段/门的枚举、PID、birth SHA、白名单异常类型和数值码，不记录任意异常原文、命令行、窗口正文或令牌。树的 parent snapshot 明确标为原 CIM 微秒时间，不冒充持有的实时父进程句柄，也不改变原成员归属、身份或退休门。

`tests/fixtures/windows-retirement-contract.mjs` 保存已冻结完整 UI 载体的原 `auditOwnedRetired()` 消费器合同，仅移除模块导出并注入其原有的 `pinsFile` / `readOwn` 依赖；它不是公共 `e2e-harness.mjs` 中的函数。六项回归通过真实 Node 子进程与 stdio 读取该合同：接受已有的 `same-handle-signaled` / `process-absent`，拒绝两个旧的未声明 reason、未知 reason，以及仍活着的精确原进程。每例仅发一次原查询，EOF 自然退场，不发信号或重放。

```sh
node --test tests/windows-retirement-consumer.test.mjs
```

这六项是消费者合同回归，不冒充 Windows API 实测。持有原句柄的 Windows PowerShell 自有控制子进程七项实测单独保存在项目外，其原 reader 摘要为 `3f6ba406…`；随后公共 reader 增加了已有 reason 的兼容映射、有限诊断与同快照因果检查，不能把整个当前文件宣称为那轮旧源的逐字重跑。实际 full12、UIA、原生窗口自然退出和截图仍以各自的实测报告为准；旧失败与 unknown 不因此补绿。

Win32_Process 的 ParentProcessId 是数字引用，父 PID 被复用后可能指向更晚出生的进程。tree 先保持原 live 根身份核验，再使用**同一次** CIM 枚举建立 UTC 出生索引，且根的 CIM 微秒出生必须与已 pin 的内核 birth 对上。只有 child 在同一快照中明确早于 parent，才在读取候选内核句柄之前否定这条不可能的父子边。相同微秒、缺失、重复、无效日期（包括 MinValue/MaxValue）仍保留原候选并执行原严格读取；不能用时间戳授予所有权或声明退休。既有 pin 不从集合删除，所有原内核句柄的退休检查保持不变，128 个保留表项、16 层、原 query/清退预算及 unknown 拒绝都不变。最多 16 条有限边诊断只含 PID、两个快照出生、固定原因和两个 false 声明，不含命令行、窗口正文或令牌。

Windows PowerShell 5.1 的七组自动控制直接提取两份公共 PS 的同一函数块，仅在本进程读取一次 fresh CIM 与 kernel birth；其余为日期/根边界数据，不启动业务子进程、Host、浏览器或输入。先明确绑定当前两份源摘要，再执行：

```powershell
$warmSHA=(Get-FileHash scripts/windows-acceptance/windows-own-reader-stdio.ps1 -Algorithm SHA256).Hash.ToLowerInvariant()
$coldSHA=(Get-FileHash scripts/windows-acceptance/windows-owned-process.ps1 -Algorithm SHA256).Hash.ToLowerInvariant()
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tests/fixtures/windows-tree-snapshot-control.ps1 -WarmSHA256 $warmSHA -ColdSHA256 $coldSHA
```

这七组控制不能代替 full12、UIA、原生窗口自然退出或原内核句柄证据。2026-10-25 同源七组实测已通过（372 ms，两个准备/执行命令均自然 0，输入/信号/Task/VM 设置变更均为 0），永久原始回执存放项目外；旧 832 未知与其原失败不因此补绿。规则依据微软 [Win32_Process / ParentProcessId 官方说明](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process#properties)。
