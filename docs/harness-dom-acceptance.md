# Mac 隔离 Harness 无头视觉验收

2026-10-22 在本机 macOS 实际运行官方 Harness CLI、全新的隔离 profile 和工作区、真实 headless Chrome，使用本地确定性测试模型完成 **8/8** 项。本轮补齐提示词、会话菜单和保存后阈值的状态截图，共 **24 张**项目外图片。它验证 Mac 上的渲染、DOM 交互和真实 Harness Host 集成，不计入原生窗口、桌面拖出、电脑输入或真实 DeepSeek 模型验收。

## 候选、源码与结果

- 候选包：`/Users/qiuya/QiuYaTools-验收/2026-10-22/安装包/Mac-键盘修复-66ae-验证包/dsh-qiuya-tools-darwin-universal.tgz`。
- 候选 SHA-256：`9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3`。
- 包内 Mac helper SHA-256：`66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502`，准备阶段只读解包核对，不重新编译或修改它。
- 实际入口：`artifacts/harness-e2e/macos-dom-prepared-9998ef64-83da-49ab-85b3-2e17176a34a7/entry.mjs`；源码及快照依赖散列在执行前后保持一致。
- 运行器自然退出：`code=0, signal=null`。Host PID `24399` 经本运行器原有的正常 SIGTERM 关闭，实际 `hostExitCode=0, hostSignal=null, hostRetired=true`；`browser.close()` 已完成且没有清理错误。DOM 分支没有 SIGKILL 兜底，不把未退休 Host 算作通过。
- `nativeCommandCalls=0`、`nativeDriverStarted=false`、`nativeFixtureCompiled=false`。没有调用 PD、OS 输入、原生截图或真实视觉模型。
- 初轮 `8931e965-0d5f-400b-8356-05ecda281b29` 同样行为 8/8，但原用例缺少提示词/菜单/保存阈值的状态截图；保留初轮证据，完整视觉结果以本轮 `9998ef64` 为准。

## 逐功能行为与视觉结果

| 用例 | 实际验证 | 视觉证据 |
| --- | --- | --- |
| 设置十页 | 每页选中关系、标题、专属控件与可写状态；等待字体及图片加载，按实际面板滚动取图 | `settings-01-computer*.png` 至 `settings-10-updates.png`，电脑操控排在长文本前；十页字体、间距、卡片和图像正常 |
| 阈值与主题 | 保存字符数 60、行数 4，关闭并重新打开设置仍为 60/4；Q 主题实际应用 | `thresholds-saved.png`、`theme.png`；重开后的数值清晰可见，主题与工具箱样式一致 |
| 新会话 | 从真实新建按钮得到稳定的空白 Session，首次提示进入同一 Session；实际 Host 返回并渲染回复 | `conversation.png`，只有本轮 E2E 会话和虚构工作区 |
| 提示词 | 灰色建议出现；Tab 真正填入输入框，清空后 Escape 行为正确 | `prompt-suggestion.png`、`prompt-accepted.png`；填入前后清晰区分，未自动发送 |
| 长文本 | 浏览器 ClipboardEvent → 官方二进制上传 HTTP 200 → 独立文件句柄验证实际内容 → 官方附件 ready UI | `pasted-txt.png` 显示 TXT 395B，无“上传中”或失败；内容 SHA 与原文本相同 |
| 会话菜单 | 浏览器内 writeText 精确复制 Alpha 标题，未读标识出现并在重访后消失，置顶菜单变为“取消置顶” | `session-menu-copy.png`、`session-menu-unread.png`、`session-menu-pin.png`，菜单、未读圆点和置顶状态可见；不写用户系统剪贴板 |
| 批量归档 | 真实 Host archived 集合只新增 Beta/Gamma，Alpha 保留，工作区会话总账一致 | `archived.png` 与精确集合 JSON；集合判定来自 Host，截图不代替持久状态证明 |
| 计划批注 | 批注文本及引用真实保存；修正后在准确计划 Session 得到一条新的普通 user/message；保留原草稿 | `plan-comment-saved.png`、`plan-comments.png`；引用、高亮、批注卡片、修正消息和原草稿可见 |

本轮 TXT 为 395 字节，SHA-256 `2239e309faa2d4f5b689ea793db80e3ee1b1db2f824930e94261d80ce4fc9680`。读取验证了本轮 profile、唯一 nonce 文件、非符号链接、前后同一文件身份、实际字节和散列；文件链接数为 2，不把合法的内容寻址硬链接误判为失败。

计划修正之前的 surface 序号为 26，之后为 35，唯一完整匹配的普通 user/message 序号为 **32**。它证明主会话确实收到完整修正文本；页面上出现文字或截图本身不作为收件证明。归档集合恰好新增本轮 Beta/Gamma，Alpha 未归档，未移除任何原 archived 成员。

24 张图已人工复核：新增六张状态图、重新渲染的聊天/附件/归档/计划/设置整体图均已查看；十设置页的 11 张裁切图与已逐张查看的初轮图 SHA 完全相同。未发现缺图、私有会话、用户文件、密钥、图片加载失败或页面控件遮挡。

## 报告和截图位置

全部图片在项目外，不进入 Git：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Mac-headless-DOM-8项-9998ef64-83da-49ab-85b3-2e17176a34a7`

原始 JSON 与日志：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Mac-headless-DOM-8项-9998ef64-83da-49ab-85b3-2e17176a34a7`

该目录中的关键文件：

- `carrier-verdict.json`：执行结果、源码稳定、子进程退出、范围门槛。
- `report.json`：8 项用例、十设置页、Host 退出码和浏览器关闭回执，以及 `screenshotEvidence` 内 24 张图片的项目外路径、大小、SHA-256。
- `pasted-text-upload-evidence.json`：HTTP 200、独立实际文件字节与 SHA、ready UI。
- `archive-exact-collection-evidence.json`：真实 Host 集合前后投影与精确增量。
- `plan-revision-durable-evidence.json`：准确 Session 的 before/after 序号、完整修正文本散列和唯一新 user/message。
- `carrier-binding.json`：候选、包内 helper、12 项源文件和快照绑定；不含用户凭据。
- `carrier-stdout.log`、`carrier-stderr.log`、`host-startup.log`：本轮隔离运行日志。

## 可复用入口与验证

```sh
node --test tests/harness-dom-acceptance.test.mjs
node scripts/prepare-harness-dom-acceptance.mjs
# 使用准备命令返回的新入口；旧入口和旧失败/通过目录不覆盖。
node artifacts/harness-e2e/macos-dom-prepared-<UUID>/entry.mjs --plan
node artifacts/harness-e2e/macos-dom-prepared-<UUID>/entry.mjs --run --root-approved
```

本单元纯测试 **4/4**、无跳过：精确八项和十页门槛，缺项/原生调用/错误 Host 退出不能假绿，快照白名单及原生命令拒绝，完整静态与字面动态导入闭包、候选散列及零执行准备。源码仅新增准备器和测试；不修改 live E2E/provider、SDK 或插件生产代码。可复用已验证候选进行测试，无需为测试脚本改动重新构建 Mac helper。

## 范围边界

- 官方 Harness CLI 使用 `--no-open`，Chrome 强制 headless；新 `DSH_HOME`、profile、工作区和本地模型均独立。浏览器上下文拒绝所有非 loopback 网络请求，正常应用功能走真实 Host API。
- 浏览器 DOM 输入、程序构造的 ClipboardEvent 和浏览器内剪贴板替身不等同 OS 鼠标键盘、系统剪贴板或物理 IME；报告没有这样声称。
- 排除 `native-independent-window-and-reuse`、`trusted-browser-drag-to-native-window`、`computer-main-agent-tools-and-image-adapter-pipeline`；本次也未选择额外的文件交换用例。原生独立窗口、拖出和真实电脑操控仍需另行实测。
- 电脑操控设置页本轮保持默认未启用状态，仅证明设置布局。它不证明系统权限引导、真实授权、实时画面、专属指针、多任务或人工接管已在锁屏期间完成。
- 该确定性本地模型用于验证插件 UI、Host 持久行为与协议集成，不能替代真实 DeepSeek 推理验收。
