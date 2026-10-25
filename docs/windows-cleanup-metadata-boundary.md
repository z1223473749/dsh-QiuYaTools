# Windows 完整界面验收的清退取证边界

本页只说明测试仪器；它不添加插件能力，不修改可安装包，也不把纯测试当作 Windows 实机通过。

完整界面用例完成后，隔离载体需要在自己的 Host 和无头浏览器仍存活时，取得它们的精确子树，随后才分别发送原 EOF 或 Browser.close。这个 tree 是关闭前的只读元数据准备，并非原生窗口的退出性能计时。普通 `OwnedReadonlyStdio.query()`、普通 tree/pin/listener/retired，以及 reader EOF 继续使用原 2000ms 上限。

仅 `queryCleanupMetadataTree()` 接受 `full12-close-host-tree` 或 `full12-close-browser-tree` 两个显式阶段，操作必须是 tree，单次 cap 不得超过 5000ms，且须提供原 guest 720000ms 生命周期尚余的单调时间。调用者从原 runner 的 `process.uptime()` 扣除累计时间，不能在进入清理时重开总 deadline。这是对测试取证限额的明确修订：单次最多比原来增加 3000ms，两处合计最多增加 6000ms 的 EOF 前等待。旧 2 秒失败保留失败，不能追认迟到结果。

每条查询回执保存 phase、capMs、elapsedMs。新的专用限额超时仍 poison reader；后续查询、重放和将 late OK 变成身份/pin 的行为都拒绝。在实际绑定的 aaa7df 轮次中，原生 observer 的 1500ms EOF、官方 Host 的 3000ms EOF、无头浏览器的 15000ms 自然关闭，以及最终原句柄 retired 查询的 2000ms 均保持该轮原值。所有精确原 pin 退休、实际 ExitCode 0、原输入释放和精确任务 metadata 删除仍须分别证明；“后来全退”不能替代原时限内的零退出。后续生产窗口收尾合同若另行修改，必须单独构建并实测、明确记录新旧时限，不能将它归入本项元数据限额修订。

同次快照中的行查询改为 PID → 原行列表索引。它只保留这一次 fresh CIM 返回的原对象，重复 PID 的行数和顺序、缺失 PID 的空数组、属性类型、出生校验和每次 live kernel 读取均保留；不缓存跨查询身份，不按进程名或路径排除候选。原 128 个保留句柄/成员上限、16 层和同快照父子出生因果门保持不变。

```sh
node --test tests/windows-acceptance-readonly.test.mjs tests/windows-cleanup-metadata-cap.test.mjs
```

这些回归运行真实 Node 子进程与 stdio：同一 2100ms 回复在普通 2 秒调用中必须判未知，只有显式专用调用可按其新 cap 接纳；剩余生命周期不足时按更小余量截断。错误 operation、阶段、上限和余量都在启动资源前拒绝。它们不执行 Windows API、Harness、PD、模型或原生输入。

完整 Windows runner、UIA 三源、实际安装的 renderer、每轮 nonce 和归档原文位于项目外冻结载体；本页及公共 helper 不声称仅凭仓库即可复现那些独立入口。最终报告须另列入口/源摘要、包与原生摘要、实际查询限额、零退出和截图。索引的 PowerShell 黄金对照只证明返回行等价及局部查找成本，不证明整树取证已经达到原 2 秒或新的 5 秒，更不把旧失败改绿。
