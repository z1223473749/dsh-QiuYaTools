# Windows 配对远端操控验收

2026-10-22，版本 `0.6.0-beta.1`。本次只验收 Mac 客户端到 PD Windows 11 ARM 的标准配对通道；反向 Windows→Mac、真实模型和长时间预览分别记录，不能由本次结果替代。

此前的载体出现过静态传递依赖遗漏、Windows 新进程初始化时 `MainModule`／Session 尚不可读，以及外层 console 尚未退出就提前宣布回收的问题。现在准备器冻结完整导入闭包，实际执行正常导入与缺失依赖反例；进程以同一 SafeHandle、100ns 出生时间和独立 CIM 元数据绑定。只有模块尚未就绪、独立身份仍一致时才允许最多4秒初始化等待，非空错误路径、错误 Session 或出生变化立即拒绝。任务及 console 的自然退场由外层最终审计确认，不发送补杀后改记成功。

实际正式 helper 为 `c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce`。准备器完成 esbuild 闭包构建、真实导入与缺失传递依赖拒绝；相关 Node 回归 **7/7通过、零跳过**，其中实际 .NET 编译并运行 C# 进程绑定策略的11项检查。当前 Windows PE 没有因测试而改动。

在 PD Session1 的实测结果：

| 验收 | 结果 |
| --- | --- |
| 交互桌面、状态、鉴权、版本、来源与目标身份 | 通过 |
| 实际观察、点击、Unicode输入、互斥、释放和继续 | 通过 |
| 实际预览、断连及心跳撤权 | 通过 |
| 全部业务检查 | **15/15通过** |
| 配对撤销后的旧token请求 | 实际拒绝 |
| native退出 | 自然退出0，无signal |
| 精确身份后置审计 | 15个已跟踪身份全部自然退场 |
| 输入与物理租约 | 活动桌面匹配，heldKeyCount=0，leaseFree=true，journalPresent=false |
| 专属任务 | Ready、结果0后注销，stopRequired=false |
| 补杀或强制回收 | 无；forced=[]、errors=[] |

12帧短预览往返均值为25.544ms，只是这一短用例的测量，不代表长稳、物理显示延迟或零丢帧。实测前 VM 为自动暂停状态；仅正常 resume 并临时关闭 idle pause，外层最终恢复原 `pause-idle:on`。载体和业务报告分别通过，源码快照前后稳定；原始失败没有被覆盖。

原始报告、图片及独立回收回执全部保存在项目外：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/Mac到Windows-严格收尾-3d0dd861-a077-4152-95af-5b842d854721/`

关键结果为 `report.json`、`delivery-verdict.json` 和 `carrier-verdict.json`；对应准备入口为 `artifacts/computer-use/macos-to-windows-strict-prepared-3d0dd861-a077-4152-95af-5b842d854721/entry.mjs`。可复用准备器见 `scripts/prepare-windows-remote-acceptance.mjs`；每次实测使用新目录，不覆盖失败记录。
