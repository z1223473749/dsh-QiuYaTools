# Windows 三类状态补图与正常退出验收

记录日期：2026-10-22。ARM64和x64两轮均通过5/5所选用例，分别补充了已保存阈值、提示词和会话菜单的六张状态图。本轮使用真实Windows中的官方Harness Host及已安装插件、headless Edge，以浏览器协议操作自有隔离会话；没有发送原生桌面输入，不证明外部模型推理或新增一轮完整电脑操控验收。

冻结载体为 `artifacts/harness-e2e/windows-ui-states-prepared-d6255b1f-1a79-4588-bbc1-e2fd0143aec2/`，entry SHA为 `66090f3610a95f09563ddb053fdcf9302431108d87df46909fc094a4cb5314c1`，runner SHA为 `3322d012f3430050709dfad2ccf0a348c9d8477a201dc297d9d1a1613b670e42`。实际运行槽为ARM64的98636与x64的33860，均退出0。实测系统是Parallels Windows11 ARM；x64使用系统兼容运行，不能等同于物理x64机器验证。

## 包和范围

两架构继续使用1160完整验收、7da严格专项中的相同正式包，没有使用诊断PE：

| 架构 | 正式包SHA256 | 正式native SHA256 |
| --- | --- | --- |
| ARM64 | `8b5dca9fa3017414ac8ad88f99afa86cfb056b3887b3b330c98334c147b5c6e3` | `c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce` |
| x64 | `3542d877955c57bf381e89c8ad856929bd87b90f198a52416cdf2734582c090c` | `3d2206f3b12e3e26406e60c9b11b7400e89d7cd3373e3b569e3331e4f5f7ce58` |

所选用例严格为十页设置浏览、阈值/主题保存、新建真实本地模型会话、提示词Tab接受/Escape、会话菜单复制/未读/置顶，共5项。`fullUIAcceptance:false`、`nativeUIAcceptance:false`明确保留。长文本上传、归档、计划、独立窗口、预览、原生输入及安装流程不在本轮重跑；它们引用各自既有报告。

冻结快照沿用已核定owner/profile/runtime准备，增加截图时机并保留原业务断言；不修改live `e2e-harness.mjs`、live provider或生产插件。强制headless，`nativeCommand`设置硬拒绝tripwire。两轮实际均为 `nativeCommandCalls:0`、`nativeDriverStarted:false`、`nativeFixtureCompiled:false`、`frontendErrors:[]`。

## 六种截图状态的逐张视检

两架构各六张，共12张实际图片均已打开检查。没有修改、裁切或覆盖原始PNG。每架构总计收集20张，40张收集文件均重新计算实际字节及SHA，与来宾清单逐一一致、missing=[]；下表只描述本轮补充的12张视觉证据，不将其扩大为其余28张重新视检。

| 图片 | ARM64和x64实际可见状态 |
| --- | --- |
| `thresholds-saved.png` | 关闭并重开长文本设置后显示字符60、行数4，保存按钮灰置；卡片、输入框、说明完整，电脑操控在首个功能tab，无重叠或裁切。 |
| `prompt-suggestion.png` | 自有Alpha会话已完成，输入框内有浅色建议“继续检查本地测试结果。”及Tab标记。 |
| `prompt-accepted.png` | 同一建议已变成普通可编辑文本，Tab标记消失、发送按钮启用；原用例另断言随后清空与Escape行为。 |
| `session-menu-copy.png` | Alpha上下文菜单显示复制会话标题、复制/打开工作目录等项目；文字、图标、快捷键和分隔线可读，菜单无裁切。实际复制结果由浏览器局部clipboard spy核验，不写用户系统剪贴板。 |
| `session-menu-unread.png` | Alpha行左侧出现青色未读圆点；Gamma仍是当前会话。原用例随后明确访问Alpha并验证圆点消失。 |
| `session-menu-pin.png` | Alpha移至列表首位并显示实心置顶图标，菜单显示“取消置顶”；菜单间距和文字正常。 |

截图位于项目外，未加入Git：

- `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-arm64-UI三状态-d6255b1f-1a79-4588-bbc1-e2fd0143aec2/`
- `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-x64-UI三状态-d6255b1f-1a79-4588-bbc1-e2fd0143aec2/`

## Host正常关闭与独立后置审计

Windows上的Node `child.kill('SIGTERM')`不能等同于POSIX优雅信号。此前1160/7da/a2f源有显式kill及fallback，旧报告不提供Host自然退出收据；其业务通过和最终退净结果保留，不能用本轮结果回填旧轮。

本轮只在冻结的自有test-provider中安装stdin EOF适配：runner结束自有Host stdin，provider记录有限receipt，并调用当前官方 `runProfile` 已注册的Node SIGTERM生命周期事件。它不发送OS进程kill、不增加网络退出API、不改官方Host或生产插件。判定要求receipt存在且无process kill，随后实际Host退出码0、无signal、浏览器公开close成功；任一缺失均failed。等待有界，删除了该快照旧的SIGKILL兜底。

| 实际关闭/回收记录 | ARM64 | x64 |
| --- | --- | --- |
| 自有Host PID | 716 | 9116 |
| EOF receipt | `own-stdin-eof-to-official-sigterm-handler` | 相同 |
| 已注册官方生命周期监听数 | 1 | 1 |
| Host结果 | exit0、signal=null、retired=true | 相同 |
| OS process kill | receipt `noProcessKill:true` | 相同 |
| Playwright公开browser.close | 成功 | 成功 |
| finally | passed、errors=[] | 相同 |
| 独立自有资产/OS输入/租约 | remaining=[]、held=[]、lockFree=true、journal=null、killSent=false | 相同 |
| wrapper任务 | Ready后注销，forced=false | 相同 |
| 独立只读审计任务 | 自然完成后注销，signalSent=false | 相同 |
| VM原idle | on，已恢复 | on，已恢复 |
| 顶层退出 | code0 | code0 |

这里的Host结果是**测试EOF请求触发官方正常关闭后退出**，不是未经请求自行退出；浏览器结果是公开close请求成功，也不称为自发退出。后置OS审计、wrapper自然完成及Host生命周期分别有独立收据。

## 证据及改动边界

每架构 `runs/<arch>/evidence/report.json` 包含精确5项、六张图片字节/摘要、EOF receipt和真实Host exit；`screenshots-collection.json`保存来宾到项目外目录的实际字节核对。`ui-state-verdict.json`要求精确用例集、六图完整、无native执行与正常退出。独立回收证据为 `post-run-owned-input-assets.json`、`wrapper-task-cleanup.json`、`postflight-assets-task-cleanup.json`；原idle恢复见根目录 `vm-pause-restored-<arch>.json`。

最终只读汇总为载体根目录 `final-ui-state-acceptance.json`：39个输入条目中37个live源、2个snapshot-only bootstrap，当前live源及全部冻结快照/entry/runner均无漂移；两包实际SHA保持。12张视检观察和40张收集字节核验结果一并记录。原始报告和图片均保留。

本单元新增 `scripts/prepare-windows-ui-state-acceptance.mjs` 与 `tests/windows-ui-state-acceptance.test.mjs`。准备阶段5项相关纯测全部通过，包括正常退出/缺图/非法scope拒绝、native tripwire、EOF到官方事件的有限适配及双架构纯本地plan。实际两轮5/5随后通过。本次收尾只读取报告、核定hash和查看已有图片，没有额外PD/GUI操作或编译。生产JS/native未修改，既有正式包构建证据继续适用。
