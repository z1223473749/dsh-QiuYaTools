# Windows 真实 DeepSeek 三任务验收（2026-10-22，c8-4）

本轮 `真实DeepSeek-Windows-正式c8-4` 的 `report.status=passed`：三个 Windows 原生业务任务均有真实模型请求、保留图片、视觉 nonce、独立业务 oracle 与自然清理通过。任务 2 发生过一次工具错误，模型继续观察并完成业务；本结果不表示全程零错误。

实际目录为 `/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/真实DeepSeek-Windows-正式c8-4/`，下文证据路径均相对该目录。原始 JSON、图片、临时归档与回执保存在项目外，不进入 Git。执行与复验边界见 [运行手册](windows-real-model-runbook.md)。

## 本轮身份与冻结源码

| 项目 | 本轮绑定 |
| --- | --- |
| runId | `2aff7f47-25ce-4483-97fb-6b06861cbf97` |
| manifest SHA256 | `9f54fe987cae8c66fbee0576fc28d05495a341b01dc1c3021e76c2f886c8f504` |
| 临时 patch | `qiuya-live-vision-test-b7ee9e7a-d1f3-4051-97c6-3f7906fec05c` |
| 正式 native PE | `c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce`，68,268,891 字节 |
| 业务 fixture PE | `0d34a1e1e11d2d5fbc744257baa206050e8ed5958b9646f476edd42e3eab46ce`，67,847,306 字节 |
| PE 架构 | 两份运行输入均为 `0xaa64`（ARM64），与 guest 回执及准备清单 SHA 一致 |
| 模型 | 三任务均为 `provider=deepseek-account`、`model=deepseek-flash`，`modelDefaultsChanged=false` |
| Host | 当前 Mac Harness 的真实既有 owner/SDK；`hostPid=21704`，账号凭据保留在该 Host |
| Windows | Parallels Windows 交互 Session 1；冻结 Node `v22.23.3-win-arm64`，严格绑定本轮 PID、birth、父 PID、模块路径与计划任务身份 |
| 单任务边界 | 固定目标与四个工具，最多 12 次请求、180,000ms；本轮三个任务都在边界内完成 |

`preparation.json` 的 29 项 `sourceHashes` 已逐项与本次报告整理时的仓库文件核对一致。准备清单文件 SHA256 为 `6843fa6ddb3f946a81084b27b32d68dcabb9abd7ad0a8a2503582e43407e279f`；它保留完整源码闭包映射。`carrier-bundle/windows-carrier-manifest.json` 另绑定 carrier、guest、child audit 与独立 C# audit，文件 SHA256 为 `f9e871556878ac3268297de43734c41622a8503aec4aa9ed9e9e74c8a5ac11b1`。关键源码与冻结产物如下，避免把后续修改或重新编译的程序归到本轮：

| 源码或产物 | SHA256 |
| --- | --- |
| `scripts/live-vision-guard-core.mjs` | `a7116bdc1108472f26a3fdd9c35c70e161c15bff9a383629df96fc7e8472268e` |
| `scripts/live-vision-guard-plugin.mjs` | `8fbb375339f52ddc2e793186a5cc3612b0ca55a62fb7f706f1829f1496b02c70` |
| `scripts/live-vision-working-directory.mjs` | `b7258b5a35ac464bc578513dba640e27f888c3e2bd4f2939885ec5276838032f` |
| `scripts/live-vision-windows-guest.mjs` | `bb66fc541e7cd2c97ea12062f4114a9a7dc66cb7900a32960e33974a1ddcecd9` |
| `scripts/live-vision-windows-children.mjs` | `b3ae76f2d41ea8001f27e7bb0ef32fe255ecea6b818265d4bbe017f5f9336189` |
| `tests/fixtures/windows-remote-audit.cs` | `08b119104498bf997b9109196d2e8355a9ca30c029f5beae900af645d9b0a9d0` |
| 冻结 `guard-plugin.mjs` | `93e8c74b5aa2328b80b5786cf472114e52c3c5d28ad271f9b5933c14fbe81948` |
| 冻结 Windows carrier | `c042c77ea398c4c47ba363fb839e8697ba4869175521970bbb8d3d20c55132d5` |
| 冻结 Windows guest | `b701b0da7db47e0cda5f87641c000e21abdff21fcc0ba08d833aabbda41e07fc` |
| 本轮测试包 | `fa037290581f4c2f405f427588188dd26ab4122ebf17fff1319208b7ee03b7be` |

## 三个真实业务任务

`evidence/report.json` 逐任务保留模型请求元数据、工具调用有限投影、图片附件身份、事件、oracle、清理与助手显示摘要。`initialAccessibilityAnswerHidden=true`，三个 `visualNonceRead=true`；nonce 与业务答案由画面读取。本轮请求仅暴露 `qiuya_computer_act`、`qiuya_computer_observe`、`qiuya_computer_pause`、`qiuya_computer_status`。表中图片次数是随请求保留的出现次数，重复附件会重复计数，不表示独立截图数量。

| 任务 | 业务与独立 oracle | 时长 | 请求 / steps | 保留图片出现次数 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 点击绿色「确认本单」；`correctClicks=1`、`wrongClicks=0`、down/up 各 1 | 35,359ms | 5 / 4 | 4 | business、nonce、cleanup 全部 true |
| 2 | 逐字输入截图内收货备注，按 Enter 提交；`submitted=true`、`textMatches=true` | 107,791ms | 12 / 11 | 26 | business、nonce、cleanup 全部 true |
| 3 | 把蓝色订单卡拖入绿色「已核验」框；`dragged=20`、down/up 各 1 | 36,465ms | 5 / 4 | 4 | business、nonce、cleanup 全部 true |

三任务 `denials=[]`、`fatal=null`、`terminalError=null`，turn 均以 `reason=completed` 结束。任务 2 的原始报告保留 1 次 `qiuya_computer_act isError=true`，有限投影为 `failure.code=unclassified`、`nativeStatusAvailable=false`，原文件不改写。补充复核 `/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/真实DeepSeek-Windows-正式c8-4/evidence/owned-task2-tool-error-review.json` 仅检查本轮 task 2 的自有会话，确认公开工具错误码为 `STALE_OBSERVATION`，并非参数形状错误；原始投影之所以是 `unclassified`，是 `runtimeFailureCodes` 未列入此公开码。复核文件 SHA256 为 `c8a8b34899fc861f2194d611dae86ed42acfc7c8ccce59c5afd182cb14bee18d`，其原始压缩会话来源 SHA256 为 `5e103c17430ee88f0255237b64c14806f3b0900c96fe41b64905bfbf0a4e0508`，`originalArtifactChanged=false`。

精确序列是 observe → 成功 click → 沿用该旧 frame 的 type 被拒绝 → fresh observe → 第二次完整且成功的 click → observe → 成功 type → observe → 成功 Enter → 最终 observe。两次 click 的 action SHA 相同，失败与成功 type 的文字 SHA 相同。这属于模型在新观察后纠正旧帧使用；存在第二次点击，不能写成零重复动作。`session.ts` 在成功动作后清除 `lastObservation`，过期观察检查位于 `driver.act` 之前。依据该源码控制流与本轮工具事件顺序，失败 type 为输入分派前拒绝；此次复核未检查原生输入事件（`nativeInputEventsInspected=false`），不把控制流推断描述为直接观测原生事件。最终业务 oracle 与自然清理仍通过，零 denial 不等于零工具错误。

## 安装、执行与自然收尾证据

| 阶段 | 实际回执与有限结论 |
| --- | --- |
| 冻结准备 | `preparation.json`、carrier manifest：源码闭包完整，实际 import smoke 通过；准备时的 `prepared-not-run` 是准备阶段状态，不能代替执行结果。 |
| carrier 启动与交互身份 | `windows-carrier-stage-0001..0156.json` 共 78 个 started、78 个 completed、无 failed 阶段；`windows-node-binding.json` 与 `windows-identity-initialization.json` 绑定同轮 Node、fixture、native，身份初始化均通过。 |
| 官方安装 | `cli-install-attempt.json` 与 `cli-install-result.json`：本轮单次官方 add，exit=0，dependency/selection 存在；`host-activation.json` 确认固定 patch ACTIVE、复用原 owner、owner active、`credentialsRead=false`。 |
| 一次性触发 | `host-autorun-consumed.json` 与 `host-autorun-result.json` 绑定同一 runId/manifest/patch，最终 `status=passed`。 |
| 设置 | `owner-settings-original.json`：唯一 `qiuya-tools` namespace，revision=7，两字段 own/raw/effective 均 true。`enableProof=already-enabled-readback`，60 个 owner RPC 回执中无 `settings/mutate`；收尾 `featureFlags=true`、`unchanged-readback`。 |
| 模型任务 | `report.json` 三任务 passed，模型、工具、图像、nonce 与 oracle 分别有证据；`delivery.passed=true`、`noOwnedActiveTask=true`。 |
| 单任务自然清理 | `windows-guest-report.json`、`windows-children-task-{1,2,3}.json`：三套 fixture/native 自然退出，`forced=false`；独立 OS 审计为 Session 1、活动桌面匹配、heldKeyCount=0、lease 空闲、journal 缺席。 |
| 子进程有界审计 | 三次 audit 均 passed，限定为 `one-live-native-direct-child-snapshot`；冻结 native 直接子进程匹配，系统 conhost 路径、稳定文件身份、有效 Microsoft 签名校验通过。回执明确 `coversRecursiveTree=false`、`coversShutdownChildren=false`，不声称覆盖任意递归树或退出阶段新生子进程。 |
| carrier 收尾 | `external-carrier-report.json status=completed`，三条 clean records，cleanupErrors=[]；自有计划任务自然 `Ready/result=0`，精确注销，pause-idle 恢复。 |
| 外层进程 | `carrier-resume-audit.json`：自然 `code=0`、`signal=null`，环境恢复 `restored=true`；这是独立于 guest/计划任务的外层退出证据。 |
| 连接恢复 | `host-autorun-result.json`：initial local，无原活动会话；最终 `restoration.localMode=true`、`restored-local`。 |
| 官方卸载 | `cli-remove-attempt.json`、`cli-remove-result.json`：单次正常 remove，exit=0，dependency/selection 缺席；未使用 recovery 分支。 |
| 原 patch 退场 | `host-deactivation.json`：runner settled、owned cleanup、routes removed、restoration 均 true；`host-patch-inactive.json`：固定 patch 缺席、原 Fiber DISPOSED、只读核验 passed。 |

## 原始证据校验与成功截图

| 文件 | SHA256 |
| --- | --- |
| `evidence/report.json` | `c7a3a1b741251cc244eab8fbeabd747d97396af0d6e12cf4fbb8b12e42b67144` |
| `evidence/host-autorun-result.json` | `758e4ef13d7262a03cb0e81cbc2a148560347ddb389ee2ef8b6443f1907849d3` |
| `evidence/external-carrier-report.json` | `2b1a8c948a99d3a1ec2952553e5d3116c815fcb58c06f546459014ddf278926a` |
| `evidence/windows-guest-report.json` | `6e7086c26f727fba073cf65a96ee0a205ab56c633f12e7e7fda24f681136afa8` |
| `carrier-resume-audit.json` | `673d71ac867d73a55b55c9324bb99c89a7feed8a080b894227c8c7abc0397875` |
| `evidence/cli-install-result.json` | `4698ba69e4a7095e71d5ef8b0934bae08ad2a33a23325a322ab20e66ea0f81db` |
| `evidence/cli-remove-result.json` | `06dfc6acb8ab7e170f00cad79bd47371912adeb2055cfc5201c99b4e11076f13` |

三张 `evidence/task-N-final.jpg` 已逐字节复制到全新目录 `/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-真实DeepSeek-三任务-c8-4/`，未覆盖旧文件，未编辑或重编码图像。该目录的 `copy-receipt.json` 记录 runId、原 report SHA、每图来源、业务案例、目标、字节数、两端 SHA 与 `byteIdentical=true`。图片是各任务最终画面；业务结论仍以对应 oracle、图像/nonce 与清理证据联合判定。

| 成功原图 | 字节数 | 原文件与复制件共同 SHA256 |
| --- | --- | --- |
| `task-1-final.jpg` | 29,770 | `cc6b6676bc35a96421853a23b84588d95940826e71b08c6646d185c2d154179d` |
| `task-2-final.jpg` | 42,666 | `eb0321e270866083ddb7d6acb41eca7c2d6c04248618095144527a418f809e2c` |
| `task-3-final.jpg` | 30,200 | `1d4a558aebbe7bebb450a7ee8cdf28a0bf1c881dd1ff49abd611c2159af89b36` |

## 历史失败与覆盖边界

第三轮 `真实DeepSeek-Windows-正式c8-3` 保留 failed：首 turn 在 6ms 内 error，模型 requests=0/steps=0，原 180 秒上限不变；后续归因为 Host 工作目录不存在，并另修复固定、可验证的 workingDirectory。该轮子进程取证未确认及卸载整体 failed 的事实仍保留。第一次独立 lifecycle 检查又暴露系统 conhost 被拒绝；修复可信系统 console 的严格身份分类后，第二次 lifecycle 三套无输入检查通过。它们是修复来源，均不能代替 c8-4 的真实模型三任务。

本轮前的 [完整直接单元测试回执](../artifacts/computer-use/final-direct-test-suite/86c39dc4-4b95-4b85-9303-67e08b22419e/report.json) 为 `status=passed`：typecheck exit=0，direct tests 940 pass、0 fail、0 skipped；各阶段与最终的源码、HEAD、受保护输入稳定性均通过，`productionBuildsExecuted=0`、`productionRestoreAttempted=false`。回执 SHA256 为 `0e1760860fe35814cefcde7a5b5751ca769253d85afd7db72bc194e30e18c3bc`。这组回归用于支撑修复和源码稳定性，不扩张真实模型或平台覆盖范围。

本轮证明的是：当前 Mac Harness 既有账号/Agent 通过固定目标四工具，实际操控 Windows ARM64 VM 内三套隔离自有原生窗口，完成点击、视觉抄录提交、拖拽与对应自然清理。聊天自动 discover/request、用户授权选择目标的完整入口尚未在本轮覆盖；本轮也不证明 Mac 原生目标的真实模型三任务通过、物理 x64 Windows 实机通过，或另行进行的 WebView2 长测通过。后续 PE、fixture、源码或模型版本变化需按新哈希和新 runId 重新验收。
