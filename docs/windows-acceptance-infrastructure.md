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

## 离线验证与实机证据边界

```text
node --test tests/windows-acceptance*.test.mjs tests/harness-workbench-acceptance-evidence.test.mjs tests/harness-annotation-stale-surface.test.mjs
```

回归运行真实 Node 子进程/stdio、真实流式回调、固定 5 秒超时与迟到回执，以及当前生产 AnnotationEditor 的 React DOM。浏览器作者回调在隔离 JSDOM 中执行，明确不声称合成对象等于真实 trusted 浏览器输入。测试不启动 Harness、浏览器、PD 或 Windows API。实际 Mac/Windows 逐功能验收、真实 DeepSeek、截图和可安装包的结论仍以项目外的独立实测报告为准。
