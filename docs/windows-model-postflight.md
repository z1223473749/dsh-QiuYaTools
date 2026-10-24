# Windows 真实模型的预热收尾测试载体

本单元只改隔离验收基础设施，不改生产插件、原生输入、模型提示或业务成功条件。Windows 的三个任务仍各限 12 次请求、12 步、180 秒；owner delivery 仍为 30 秒，carrier 的自然退场门仍为 15 秒。

真实轮次曾出现三个业务任务、全部工具和原生清理通过，但完整结果没有在 owner 的 30 秒内交付。该轮末尾 Task 清退、九份证据读取与 VM 配置恢复串行约 46.5 秒。Task 自己的 guest 时钟仅 1.129 秒，而调用外层为 25.862 秒；剩余约 24.7 秒没有足够边界证据，不能全部归因于 PowerShell、prlctl、磁盘或诊断写入。旧失败报告保留，不能由本次准备改成通过。

## 源码与构建入口

共享 `live-vision-windows-carrier.mjs` 保持原样。`makePreheatedWindowsModelCarrier()` 用唯一锚点检查生成预热版本，缺失、重复或重复适配均拒绝。独立的 Node 归档与 owner-end 模块保留已使用的自有运行时和正常终止边界；Task 清退生成器、九证据生成器与解码器不被简化。

```bash
node scripts/prepare-windows-preheated-model-carrier.mjs \
  --output /absolute/project-external/fresh-carrier
```

该命令只冻结源、`write:false` 构建并真实导入三份 relay 模块，不创建 guard archive、授权 capability、Host、Windows 进程、窗口或模型任务。输出的 `preparation-binding.json` 绑定原始源、检查后的生成源、构建工具源、完整静态闭包与 bundle SHA。上层实际验收生成器仍须另行绑定当前生产归档、原生 PE、已加载 SDK 工具元数据、精确官方 Node ZIP，以及新的 Root 运行授权。此命令本身不是完整模型验收通过证明。

归档来源由 `WINDOWS_NODE_PINS` 和显式 `nodeArchive` 元数据约束；每轮在全新自有 guest root 中校验并提取。不再依赖可能已消失的历史临时 Node 路径，不复制账户凭据，也不切换默认模型。公开 carrier builder 额外接受显式源码仓库参数；省略时的原始构建行为保持不变。

## 准备与真正收尾

准备阶段，在原私有 bridge 的固定 `/bridge/postflight` 路由启动一个 PowerShell worker，沿用原 bearer 与 guest-IP 限制，不新增 Windows 入站端口。它校验 worker/config/两个原脚本的 SHA、规范路径与 reparse 边界，并绑定自己的 PID、出生 ticks、系统 PowerShell 路径与 SHA、session 和 SID。只预热公开 ScheduledTasks 模块，主 Task 此时尚未注册；ready 必须明确主 Task 和证据读取数均为零。

真正结束后才发送新 nonce 的一次 `finalize` 命令。worker 在同一 PowerShell 中通过 `&` 依次执行原 Task 清退脚本和原九证据脚本，仍作当前状态读取。Task 的 action、完整 arguments、SID、Interactive/Limited、Ready、LastRun 和注销后不存在检查都保留。九文件的固定顺序、每项 1 MiB、Base64、SHA、长度、路径、无 reparse 和读期间稳定门也全部保留。

Host 必须先验证整份回执，再保留原 Task 的 durable receipt，随后保存九文件；实际本地 spawn 对象的 exit 与 stdio close 都须自然 0。完整收尾仍受同一个 30 秒门约束。超时、迟到 ACK、落盘失败、非零退出或身份变化均不能报告成功，也不能重发已经派发的命令。准备早退使用独立的一次 EOF 命令，不执行 Task 或读取业务证据。

VM pause-idle 则先 fresh read。已经等于目标值时跳过写入，但仍 fresh verify；不等时只执行一次原 set 后复核。读取、必要的写入与确认共享原 30 秒。未知结果不重发。若 Root 持有批次的 pause-idle=off 临时租约，本轮的进入值和恢复值都是 off，两个阶段只读复核；租约最终恢复 on 的证据由外层单独保存。

## 验证范围

纯 Node 测试覆盖准备零业务读取、一次新 nonce、错误身份/序号/SHA/顺序/大小、durable receipt 先后顺序、迟到 ACK 保持 unknown、文件写入失败、真实 Node 子进程的自然 close，以及 VM 的幂等与未知结果不重发。源码适配测试实际构建、导入完整三模块闭包，并检查与已准备的测试候选字节一致；生产与 guest/action 源没有改变。

这些测试不证明 PowerShell 5 在 Windows 上已运行。实际模型轮必须先取得真实 ready，失败时不得继续启动业务；最终成功还须通过原 Task、原生/fixture、held/lease/journal、owner 恢复、SDK 图片与工具 schema、模型业务和自然清退的全部检查。截图和报告始终保存到项目外目录，只有人工复核后的成功截图才能进入外部成功图库。

## 2026-10-25 真实 ARM64 与 x64 组件验证

两轮均由 Root 使用已有 Mac 个人 Harness 的当前真实 DeepSeek 账户和公开 SDK，经标准配对桥控制 PD Windows ARM64 虚拟机中的自有隔离业务夹具。ARM64 轮使用 ARM64 原生组件；x64 轮使用同一 Windows ARM64 虚拟机的 x64 兼容层。这不建立原生 x64 Windows 操作系统或 Windows 本地 Harness 推理已通过的结论，不把该轮作为 Mac 本地 TCC 验证。模型默认值未变，没有复制账户凭据；首次任务由模型自然 discover/request，再由独立测试驱动模拟 owner 允许一次，不称真人点击。

| 组件与轮次 | 订单确认 | 完整中文加 Enter | 拖动 | 实际 SDK／schema |
| --- | --- | --- | --- | --- |
| ARM64：`876ac7d0-8319-49d3-8b53-c441d313406d` | 7 步／8 请求／31,437ms | 9 步／10 请求／40,023ms | 5 步／6 请求／21,461ms | 24 请求／98 schema |
| x64 兼容层：`97f381c9-0439-4384-9057-6cd2df1e7277` | 7 步／8 请求／92,434ms | 9 步／10 请求／129,520ms | 5 步／6 请求／64,682ms | 24 请求／98 schema |

六个业务 oracle 均通过，工具错误均为零；各请求的工具描述和参数 schema SHA 与实际 `live-public-ctx.tools` 元数据逐项一致。两轮保留原每任务 12 次请求、12 步、180 秒，owner 交付 30 秒和 carrier 自然退场 15 秒门。六张最终图均已独立逐张查看：订单完成、完整中文与 Enter 提交完成、卡片落在绿色目标框内；JPG 原字节 SHA 也对应各任务实际 SDK 最后图片附件。

| 实际收尾时序 | ARM64 | x64 兼容层 |
| --- | --- | --- |
| 预热收尾 stage／完整回执 | 2,121／2,114ms | 2,499／2,492ms |
| 原 Task 脚本／九证据脚本时钟 | 1,647／119ms | 1,853／125ms |
| 两次 VM 新读取 | 12,952／12,107ms | 6,660／43ms |
| VM restore stage | 25,069ms | 6,710ms |
| 收尾 stage 开始至 VM stage 完成 | 27,196ms | 9,215ms |

worker 均在主 Task 注册之前 ready，主 Task 与证据读取数均为零。ARM64 为 Windows PID 4292／本机实际 spawn PID 81427；x64 为 Windows PID 10300／本机实际 spawn PID 81987。各轮 ready、唯一 finalize 和最终回执中的 PID、birth ticks、canonical path、镜像 SHA、session、SID、worker/config SHA 一致。两轮原 Task 的 action、完整 arguments、SID、Interactive/Limited、LastRun、Ready0、精确注销及注销后不存在检查均通过；固定九证据按原顺序读回，逐项长度和 SHA 与本机落盘字节一致。同一实际 worker 的 exit 和 stdio close 均自然 0，未发信号。fixture/native 自然退出、held0、lease free、无 journal、原设置和本地连接恢复、官方 CLI 移除临时插件及 Host patch inactive 均已核对。

本轮 owner 的 `externalRead(..., 30000)` 原门均通过。内部精确 delivery 起点没有单独持久保存；独立复核另记录同机 owner 状态答复文件至最终报告的时间区间，ARM64 为 26,332ms，x64 为 8,230ms，不把文件时间冒充内部计时器。新 finalize UUID 在唯一派发点生成，实际应答受相同 nonce 匹配门约束；nonce 原值未单独落盘，不补造或声称独立取回缺失值。两次较慢 VM 读取的内部原因没有归因。

两轮执行时 Root 已持有 pause-idle=off 批次临时租约；进入与恢复各 fresh read + fresh verify，均读到 off、均为 0 次 set。这只证明各轮恢复到进入值 off；整个批次最终恢复租约原值 on，仍须由 Root 在租约结束时另存独立恢复报告，本段不声称已完成。

所有证据位于项目外 `/Users/qiuya/QiuYaTools-验收/2026-10-22/`：

- ARM64 原始证据：`原始截图/真实DeepSeek-Windows-ARM64-当前包-预热单次收尾-20261025-1`；成功图：`成功截图/最终候选-20261025/Windows-arm64-真实DeepSeek`；独立脚本与回执：`独立复核/Windows-arm64-当前预热模型876ac7-20261025`。
- x64 原始证据：`原始截图/真实DeepSeek-Windows-x64-当前包-预热单次收尾-20261025-1`；成功图：`成功截图/最终候选-20261025/Windows-x64-真实DeepSeek`；独立脚本与回执：`独立复核/Windows-x64-当前预热模型97f381-20261025`。

独立报告 `independent-review.json` 的 SHA 分别为 ARM64 `0d75bb2ede1ba91eee053203712992efbe3d1d63cd9d47c649980e4e0cc12d78`、x64 `8ba662f244dbdb33508754377ec2015549d242c3e14a399404188749736a35b6`。目录中的 `archive-index.json` 记录脚本、报告与复制回执的原字节 SHA；此前失败轮全部保留原结论。这两轮只证明上述真实模型三任务与收尾，不代替其他功能的完整视觉验收。
