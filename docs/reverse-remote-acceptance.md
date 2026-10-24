# Windows 到 Mac 反向操控验收

这组验收用 Windows 中的真实 `RemoteComputerDriver` 调用 Mac 原生助手，操作单独创建的 Mac fixture。原九项业务、独立进程身份核验、自然退出和输入状态恢复需要同时成立；九项业务成功不能覆盖清理失败。

## 公开准备入口

显式提供本轮已审阅的 Mac helper SHA256 和 Windows runtime receipt：

```sh
node scripts/prepare-reverse-remote-acceptance.mjs \
  --expect-helper-sha256 '<本轮已审阅的完整 SHA256>' \
  --runtime-receipt '/绝对路径/本轮-runtime-receipt.json'
```

`--expect-helper-sha256` 校验本仓库 `lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer` 的真实文件字节，不能沿用历史默认。`--runtime-receipt` 必须来自已完成验证的 Windows 运行环境；本入口当前接受 ARM64 Node 运行时，并校验 Node 原始 ZIP 和实际成员字节。只有需要覆盖 receipt 中的已审阅访客目录时，才显式传 `--guest-node-root`。

准备阶段固定源码和模块依赖、做 import/syntax 控制，输出唯一 `entry` 和项目外 `output`。它不启动 GUI、不调用 PD、不发送输入，也不编译原生 fixture。缺少任一必填参数时，在准备写入或启动子进程前拒绝。

```sh
node '<准备输出的 entry.mjs>' --plan
node '<准备输出的 entry.mjs>' --run --gui-gate root-approved
```

实际运行者需独占 Mac 与 PD 输入槽。每次使用新准备目录和新输出，捕获与客户端身份检查通过后只开一次输入门；已发送但结果未知的操作不重放。实际结果按候选、环境和源码 SHA 单独留档。

## 原九项与完整成功条件

| 原检查 | 实际证明 |
|---|---|
| `REVERSE-WIN-CLIENT-MAC-STATUS` | Windows 客户端取得可用 Mac 状态 |
| `REVERSE-MAC-TARGET` | 命中本轮 fixture 的 PID、appId 和窗口标题 |
| `REVERSE-CAPTURE-AX` | 取得真实 JPEG 与 fixture 辅助功能内容 |
| `REVERSE-ACTUAL-MAC-CLICK` | fixture 原生点击计数准确增加 |
| `REVERSE-ACTUAL-MAC-UNICODE` | 原生文本为 `Windows to Mac 中文🙂` |
| `REVERSE-MAC-SHORTCUT` | `CMD+A` 后文本准确替换为 `replaced` |
| `REVERSE-RELEASE-FENCE` | 释放后旧控制代次返回 `CONTROL_CHANGED` |
| `REVERSE-RESUME` | 新控制代次输入后为 `replaced resumed` |
| `REVERSE-PREVIEW` | 释放后仍能只读预览，预览不返回 AX 元素 |

完整成功还要求 Mac fixture/native/guardian 的 PID、出生秒/微秒和路径证据完整，Windows client/console 的出生 ticks、路径和退出覆盖完整，双方自然退出且没有 Stop、终止信号或未知对象。准确 Task 自然 Ready0 后注销；旧 token 被拒绝，访客配置删除、内存配置清空；最终 OS 无按键或鼠标按住、物理租约空闲且 journal 不存在。

Mac `/tmp` 与 `/private/tmp` 别名通过真实路径、单链接文件、权限、inode/大小/时间和 SHA 共同核验，保留 PID、出生时间与父进程约束。Windows 准备 ACL 仅对本轮新 UUID 目录、准确交互用户添加可继承 Modify，验证三份自有文件继承；不改父目录、全局 ACL 或其他规则。

VM 原状态为 off 时跳过无意义写入并复核 off；原状态为 on 时才临时关闭并恢复 on。一次子验收恢复自身 off 状态，不代替外层批次最后恢复用户原设置的证明。

## 已记录结果与范围

2026-10-25 的 `45dc7b73-17d8-4548-8663-23c3f1c9f977` 实际记录原九项全部通过，delivery 和 carrier 的严格复算也通过，Mac 三个自有进程与 Windows 两个自有进程均退净，Task Ready0 注销，token/config/held/lease/journal 检查完整。原状态 off、set 调用为 0，保持并复核 off。

该轮使用 Mac helper `69a23738beab5f363ab47efe8f1b887f16d12f339ff64781ec9568bc19b0bdb3` 和未变的五份 Remote/Native 组件源码。其实际 `remote.mjs` SHA 为 `7a4fa5c9e07d334e2d776e646de8814d64d96c334eb5aea4b10ca4b2a1a3efed`，从当前五份组件源码以 `write:false` 重建仍逐字节相同。当前 H5 修复后的整包 index 为 `4cbb…`；本轮九项不能冒写为新整包安装验收或 DeepSeek 模型验收，也未覆盖 x64 Windows 客户端的实际执行。

原记录固定31份源文件和8份快照。公开准备器之后取消历史默认并明确新输出位置，准备器本身与旧实际准备器存在这一可说明的差异，其余30份源及8份快照保持原字节。旧记录和源码 pin 保留，不因公开入口整理而改写。

最近定向检查为四份 `reverse-*.test.mjs` 的44/44，通过的完整全量回归快照为2550/2550、195测试文件、760源文件。公开入口另有5项真实 Node 缺参拒绝控制：缺 SHA、仅 receipt、缺 receipt、空 receipt、无效 SHA 均拒绝，子进程启动及准备写入钩子计数为0。各记录保留独立范围。

```sh
node --test tests/reverse-remote-delivery.test.mjs \
  tests/reverse-executable-pin.test.mjs \
  tests/reverse-owned-directory-acl.test.mjs \
  tests/reverse-checkpoint-coordinator.test.mjs \
  tests/reverse-prepare-cli.test.mjs
```

成功截图与报告保存项目外。该轮唯一原始 JPEG 是输入前的隔离 fixture 捕获图；最终点击、中文、快捷键和恢复状态由实际 fixture transcript 与原九项回执证明，不能从这张初始图反推最终文本。
