# Windows 输入日志原子替换与原生资源预算

持有桌面独占租约时，原 File.Move(overwrite:true) 在已分享 Delete 的并发只读句柄下仍可能报 AccessDenied5，阻止下一次输入。真实 ARM/x64 自包含 .NET8 文件矩阵已复现，与 PRL 截图延迟是两件事。

WriteJournal 仍先写新临时文件、Flush(true) 并关闭，然后在原租约内单次 FileRenameInfoEx(REPLACE_IF_EXISTS | POSIX_SEMANTICS) 重命名。源句柄不跟随重解析点且要求单链接普通文件；路径必须同目录。FileName 是 UTF16 NUL 终止缓冲区，长度字段不计终止符。没有删除旧日志再移动、重试、放宽只读属性或补输入。系统错误继续原有 fail-closed 路径，原恢复/guardian/lease 生命周期不变。

独立文件回归入口：`node scripts/test-windows-journal-files.mjs --dotnet <8.0.426 SDK executable>`。9项不进入常规无需SDK的JS单元测试入口；缺SDK明确失败，不静默skip。它编译真正生产 AtomicJournalPublish.cs，在自己的新临时目录验证实际写盘/文件冲突及真实ABI编码。Mac上只执行普通文件与ABI检查，不调用Windows PInvoke；Windows上同一测试还执行真正POSIX first、R|D/RWD共享句柄旧内容保持、无D拒绝32及64次并发完整记录。无GUI/HID/屏幕/模型/生产lease访问。

正式Windows发布保留完整 WPF/WinForms 与所有主程序集/原生依赖，只用官方 SatelliteResourceLanguages=en;zh-Hans;zh-Hant 排除未使用的11种框架界面语言卫星文件。neutral英文与简繁中文资源保留，其他系统界面语言回退neutral英文；该属性不筛选IME或输入语言功能代码。固定SDK8.0.426双架构对照中，移除的187项均为resources.dll，其他269/270个bundle输入每个SHA相同，PE各减少约4.9MB；不提高64MiB包上限，不删界面资产，不使用不可靠反射trim。

原9项离线、主52项+29项专项、完整双会话/持有期物理取帧、IME与真实DeepSeek的验收边界各自保留，不以文件矩阵替代业务验收。新资源配置的正式两架构包仍须实际跑原52+29清单、IME、双会话和DeepSeek，保留所有失败原目录。现存截图放项目外，不加入Git。

2026-10-24 完整改动验证：从当时 HEAD 加本单元的8个文件制作普通独立快照，排除尚在开发的工作台、前台交接和验收基础设施；9项真实生产源／ABI／文件回归全部通过，SDK 8.0.426 的 ARM64 与 x64 自包含构建通过。该独立快照的 PE 分别为 `75c9e48b…7476e`、`50b952db…4e8da`；它们用于确认本提交自身可构建，不冒充集成候选的实机结果。

PD Windows 普通交互用户的真实文件矩阵绑定生产 `AtomicJournalPublish.cs`（SHA256 `8c96e6c4ac1b080604e9ea1825f5a5692245b3a799fcb1af6c8f2c3ba0ef6040`），两种架构均通过新发布、共享读取下旧句柄内容保持、64次并发完整发布及32次缺少 Delete 共享的正确拒绝；旧 File.Move 对照失败原样保留。项目外证据根目录为 `/Users/qiuya/QiuYaTools-验收/2026-10-22/`，文件矩阵在“报告/Windows-日志单步替换终止符真实矩阵-9d14965d-bd72-4384-a805-d0c11a4992ad”，独立快照构建回执在本机临时验证目录。

集成新原生候选的52项业务验收首轮在独立测试观察器5秒 ready 阶段失败，尚未启动产品业务；原240秒外层等待也暴露测试终态漏收问题。该轮维持失败，观察器修复后重新验收，不把文件级通过写成整套电脑操控已经完成。
