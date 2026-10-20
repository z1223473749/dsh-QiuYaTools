# 电脑操控使用与分发说明

本分支提供 `0.6.0-beta.1` 本地候选包。新增电脑操控默认关闭，原有功能开关保留。未推送、未公开发布；npm 和旧 GitHub 下载链接不代表本次候选版本。

## 选择安装包

| 使用 Harness 的电脑 | 安装资产 | 运行前提 |
| --- | --- | --- |
| Mac Apple Silicon / Intel | `dsh-qiuya-tools-darwin-universal.tgz` | macOS 13+ 构建目标；电脑操控需辅助功能和屏幕录制权限 |
| Windows ARM64 | `dsh-qiuya-tools-win32-arm64.tgz` | Windows 11 登录桌面；Microsoft Edge WebView2 Runtime |
| Windows x64 | `dsh-qiuya-tools-win32-x64.tgz` | Windows 11 登录桌面；Microsoft Edge WebView2 Runtime |

请按 **Harness 进程的架构** 选择 Windows 包；ARM 电脑上运行 x64 Harness 时应使用 x64 包。实际运行覆盖范围以测试报告为准，编译目标不等于旧系统或该架构已实机通过。

在 Harness 的插件管理器添加本地 tgz，或使用其 CLI：

```sh
dsh plugin --profile web add /absolute/path/dsh-qiuya-tools-darwin-universal.tgz
```

Windows 路径有空格时在 PowerShell 中使用双引号。若当前使用 desktop profile，请将命令中的 `web` 改成实际 profile；不要把测试 profile 的配置目录当作日常 profile。安装后完全退出再打开 Harness。

Windows 原生程序自包含 .NET，使用者不需要开发 SDK；WebView2 Runtime 缺失时会给出明确错误。可从 [Microsoft WebView2 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 获取运行时。候选包未做正式开发者签名和 Mac 公证，签名状态也写入资产旁的 JSON。

## 本机应用操控

1. 打开 **设置 → QiuYaTools → 电脑操控**，启用新功能。
2. 保持目标应用窗口打开。选择“这台电脑”，点击“连接所选环境”。
3. 选择关联聊天，再刷新并选择目标窗口。点击“允许本次并开始”。需要重复使用的应用可由你设置“始终允许”。
4. 打开“悬浮实时预览”。在关联聊天选择支持图片输入的模型，再发送任务。
5. 预览中的 **暂停** 撤销 AI 输入权；**接管** 允许你点击预览、拖动、滚动和输入文字；**继续** 获取新画面与新租约；**停止** 结束本次授权。

模型通过 `qiuya_computer_status / targets / select / observe / act / pause` 使用当前会话。模型不能自行授予应用权限、从暂停恢复或更换设备。只有明确观察的画面写入聊天附件；连续预览帧不写附件。

Mac 系统权限属于 `QiuYaTools Computer.app`，与普通会话分窗应用独立。在系统设置中允许该应用的屏幕录制与辅助功能后，重启 Harness 再检查权限状态。插件不会自动更改 TCC 或系统登录配置。

原生应用输入使用前台桌面的实际鼠标和焦点。预览里的 AI 指针表示实际动作位置，不代表原生应用能够后台独立操作。Windows 的本地物理输入、Mac 的物理 Escape 或拖动中点击预览会触发原生中断；关闭预览也会暂停。最小化、目标消失、窗口几何改变等情况需要重新观察或重新选择。

Windows 可能拒绝后台进程激活窗口。若提示 `foreground-denied` 或“Activate the target window before input”，请先在桌面点击目标应用使其激活，再明确继续任务；插件会保留焦点校验，失败的输入不会自动重放。

## 浏览器专用通道

选择“浏览器专用通道”，选择 Chrome 或 Edge，填写允许的网站来源和起始地址，然后连接。网站来源示例是 `https://example.com`，可每行填写一个。仅这些来源内的页面可以被观察和操作；撤权后重新连接会先停止原会话。

默认使用当前 Harness profile 下的独立持久浏览器配置。你可以在这个浏览器中登录，之后继续复用该测试或业务登录态；不会复制日常浏览器的 Cookie。需要连接已有浏览器时，可以在高级选项填写用户自己开启的本机调试地址；它只接受回环地址或已经建立的可信隧道。连接结束不会关闭用户原有的浏览器进程。

浏览器动作支持截图坐标、CSS 选择器点击/输入、导航、新建和关闭标签页。它们经过与原生输入相同的租约、帧校验和暂停控制，并受网站许可约束。浏览器通道可在后台向指定标签页发出输入。任意 JavaScript 执行和任意本机路径文件上传没有作为模型工具开放。

## 独立虚拟机或远端电脑

独立环境必须已有操作系统、已登录的交互桌面和对应平台的本插件原生程序。普通多桌面工作区不提供隔离。PD 仅用于本次测试，普通 Windows 用户使用本机功能不需要安装 PD。

在独立环境解包对应包，准备 Node.js 22.19+ 或 24+，在登录用户的终端运行配对代理。以下命令都在 **代理所在电脑** 执行。先把随机生成的至少 32 字符令牌保存在仅自己可读的文件中，再指定文件路径；不要将令牌写入聊天或提交 Git。

```sh
# macOS / zsh，当前目录为解包后的 package/
export QIUYA_COMPUTER_TOKEN_FILE=/private/path/pair-token.txt
node scripts/computer-agent.mjs
```

```powershell
# Windows / PowerShell，当前目录为解包后的 package/
$env:QIUYA_COMPUTER_TOKEN_FILE = 'C:\Users\YourName\Private\pair-token.txt'
node scripts/computer-agent.mjs
```

默认只监听 `127.0.0.1`。使用已有的 SSH/TLS 隧道接入后，在插件选择“独立虚拟机或远端电脑”，填写配对地址和令牌。只有明确可信的私有网络才启用“允许通过受信任的私有网络连接”；若代理要直接绑定私有地址，需显式设置 `QIUYA_COMPUTER_HOST` 和 `QIUYA_COMPUTER_PORT`，并由环境所有者配置网络访问。插件不会自动开放系统防火墙。

Windows 代理必须在登录桌面运行。系统服务的 Session 0 或普通非交互远程命令中启动成功，并不表示能操控用户桌面。断连后不会自动重放点击、拖拽或文字；需要重新连接并明确开始。旋转令牌后旧配对和旧设备应用授权不继承。

## 开源参考与本次取舍

以下是 2026-10-21 复核的项目主页，作为设计参考，不是本插件的运行依赖：

| 项目 | 可参考部分 |
| --- | --- |
| [Cua](https://github.com/trycua/cua) | 原生电脑驱动、跨系统沙箱与测试基准。该仓库按目录区分许可；其 README 明确区分 MIT 部分与 FSL 的 Spaces/部分基准工具，不能视作整仓同一种许可。 |
| [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop) | 本机、远端电脑与浏览器操作器，以及多模态 Agent 的桌面交互。 |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | macOS 截图 CLI、可选 MCP 接入及视觉问答。 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 浏览器独立/持久配置、CDP 连接和浏览器扩展连接已有登录态。 |

本次执行内核使用自有 Swift/AppKit/ScreenCaptureKit 与 C#/WinForms/UIA/SendInput；浏览器生产通道使用 Node 内置 WebSocket 和公开 CDP。这样可以保留插件现有安装包上限、明确的原生输入租约和取消边界。Playwright 只用于自动化验证。Codex 的专有二进制、私有认证和 IPC 不进入安装包。

## 验证入口

以下命令在源码仓库的开发环境中运行：

```sh
npm ci
npm run check
node scripts/computer-preflight.mjs --target local
node scripts/test-computer-preview.mjs
node scripts/test-computer-browser.mjs --browser chrome
node scripts/e2e-macos-computer.mjs --evidence-dir artifacts/computer-use/macos-native
node scripts/e2e-harness.mjs --package /absolute/path/candidate.tgz
node scripts/soak-computer.mjs --minutes 30 --faults 5
```

PD Windows 原生测试由 `scripts/test-windows-native-pd.mjs` 编排，需指定已经选择的 VM UUID 和 Mac 的 host-only IP；详细命令见 `src/native/windows/README.md`。不自动创建、删除或回滚用户 VM。真实模型推理、硬件多屏、旧系统、各架构运行、Excel 加载项与锁屏扩展均单独计入报告，不能用编译或模拟测试替代。
