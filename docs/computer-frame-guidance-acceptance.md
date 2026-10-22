# 模型帧指导与自然授权入口验收

记录日期：2026-10-23。整体交付仍未完成；本页分别记录生产改动、构建回归、真实模型结果和本地运行时加载。

## 生产改动与构建

旧真实 DeepSeek 回合在成功点击后沿用旧 frameId 输入，收到 `STALE_OBSERVATION` 后又重复完整点击。observe／act 的公开说明及 frameId 字段现在明确：成功动作消耗画面，下一动作前重新 observe；刷新不应重复已成功动作，结果未确认的输入不自动重放。公开错误保留固定代码与有限恢复说明，不转发原异常正文。执行、授权和预算没有放宽。

真实 SDK `ToolRuntime`＋真实 `ComputerSessionService` 回归验证 observe → click → 旧帧 type 在 driver 前失败 → 新 observe → type；driver 最终仅收到一次 click 和一次 type。native／PTC分别验证错误码、恢复说明和隐私边界，相关49项通过。

实际生产JS构建仅改变 `lib/index.js`，client／computer-agent逐字节不变；四份正式native、双manifest与品牌资源的SHA／大小／inode／mode不变。回执：`artifacts/computer-use/frame-guidance-js-build/d90954e7-8688-4cb4-ba7e-d35d8a7078f7/report.json`。

集成工作区typecheck及102文件、976/976项完整直接测试通过，零失败／取消／跳过；404份输入与受保护产物在各检查点稳定。回执：`artifacts/computer-use/final-direct-test-suite/aebcd132-bca8-460b-ba2c-1cf1440e333d/report.json`。该快照包含其他待实机验收的Mac／Windows工作，不代表它们已经实测通过。

## 自然入口实际结果

自然模式仅任务1发布生产discover／request_control／status／observe／act／pause六工具，模型发现并申请；独立测试驱动经原live owner的生产RPC模拟一次 `once`，模型没有decide权限，不写始终允许列表。报告明确 `humanClickProven=false`，不证明人工点击授权卡的像素结果。每任务仍限制12请求／12 steps／180秒。

| 轮次 | 结果与边界 |
| --- | --- |
| 自然c8-2 | 官方add退出0，但Host在模型／fixture／输入前拒绝配置。实际测试patch漏掉natural／once字段，已修复并增加真实JSON往返比较。零任务取消和临时包磁盘移除通过，运行时退休缺少回执 |
| 自然c8-3 | 任务1自然发现／申请／一次授权／观察点击通过，8 requests／7 steps；任务3通过。任务2业务和视觉nonce正确，但两次STALE、两次成功click后耗尽12请求，整轮仍failed。三任务清理、原设置恢复、官方移除与外层自然退出通过 |
| 新包后自然c8-4 | 官方add退出0、依赖选中，但60秒内没有Host激活／失败／consumed回执；模型／fixture／输入均零。零任务取消、OS审计、Ready0／注销、idle恢复和外层exit0通过；精确临时包已官方移除，运行时退休仍未确认 |

原始证据在项目外 `/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/真实DeepSeek-Windows-自然入口-c8-{2,3,4}/`。旧固定目标c8-4的真实三任务通过继续保留，不能替代自然入口或新metadata回归。

准备器修复字段遗漏，归档前比较实际序列化JSON的完整config，拒绝未知／部分字段。另修复未授权时收尾截图，负例保证capture／write零调用。自然入口及所有live-vision联合113项回归通过。详见[运行约束](windows-natural-entry-runbook.md)。

## 候选包与本地安装

三包均为未签名／未公证、未公开发布的 `0.6.0-beta.1` 开发候选。归档成员、正式JS／平台native／manifest逐项核验及64 MiB上限通过：`artifacts/candidates-frame-guidance-final-2/report.json`。

| 平台 | 字节数 | SHA256 |
| --- | ---: | --- |
| Mac universal | 1,063,051 | `4483c2cee7362a9b71f6f3a1100608baaac578a3888ad829e0d8ba8ed45feddc` |
| Windows ARM64 | 62,805,560 | `ce01953d4299e8a82d2768ebe980f494eec13244ce0bed2535fea7229bfd02d1` |
| Windows x64 | 67,053,327 | `85ab5eb0d28ba15d16dcb0c7dd0303f59f4ed12ec70338dae09169b9df348764` |

Mac新包隔离官方安装、升级、坏包保护、回滚、重装5项通过，配置保持；五个精确自有Host接受原正常关闭流程后exit0／无signal，临时目录删除。项目外证据：`原始截图/Mac-新包-4483-安装生命周期-1/`。没有GUI／桌面输入／真实账号，不能替代逐功能视觉验收。

个人Harness另经官方CLI单次升级，实际已装19份插件文件匹配4483归档，其他插件公开manifest不变；旧c7ea包及实际插件字节已备份。仅磁盘升级已确认，后续自然c8-4没有确认Host热加载。正常退出请求被自动审批拒绝，原因是个人应用可能有未完成任务且内部关闭可能升级终止；尚未执行重启，等待用户明确授权或证明无活动任务。没有读取或搬运账户凭据。

真实新Host的最小证据是SDK请求toolSchemas指纹：act description `cc6cb9ef27df8c7c46c5aa3077c60785e032644acaa5734e55973d4708424a5b`，observe description `d30a0d285b52f6bfd0f9a143f991d42b4b19bb9b682221296f7d8014a564bd88`，act parameters `ead907f76c3579f2d8b3a74d761a23fa215e93639859798183cbc38515c806f1`。CLI退出0不替代它；output说明也不属于该native请求投影。

剩余：新指导的真实三任务、最终双平台新包逐功能视觉复验、Windows跨helper自动前台切换及双聊天指针、解锁后的当前Mac键盘／指针／双聊天／真实模型／WK长稳，以及严格反向独立环境。既有75图成功画廊保持原绑定，失败轮未加入成功集。
