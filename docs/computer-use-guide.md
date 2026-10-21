# 电脑操控使用与分发说明

本分支提供 `0.6.0-beta.1` 本地候选包。新增电脑操控默认关闭，原有功能开关保留。未推送、未公开发布；npm 和旧 GitHub 下载链接不代表本次候选版本。

当前开发版还加入聊天内小预览、多聊天独立环境和原生 AI 箭头。下文说明这些新行为；旧候选的桌面验证不会自动覆盖本次改动，新 GUI 的实际验收以绑定对应版本和哈希的[测试报告](computer-use-test-report.md)为准。

## 选择安装包

| 使用 Harness 的电脑 | 安装资产 | 运行前提 |
| --- | --- | --- |
| Mac Apple Silicon / Intel | `dsh-qiuya-tools-darwin-universal.tgz` | macOS 13+ 构建目标；电脑操控需辅助功能和屏幕录制权限 |
| Windows ARM64 | `dsh-qiuya-tools-win32-arm64.tgz` | Windows 11 登录桌面；Microsoft Edge WebView2 Runtime |
| Windows x64 | `dsh-qiuya-tools-win32-x64.tgz` | Windows 11 登录桌面；Microsoft Edge WebView2 Runtime |

请按 **Harness 进程的架构** 选择 Windows 包；ARM 电脑上运行 x64 Harness 时应使用 x64 包。实际运行覆盖范围以测试报告为准，编译目标不等于旧系统或该架构已实机通过。

桌面版请在 Harness 的插件管理器添加对应的本地 tgz。`desktop` profile 由桌面应用独占，不能通过 CLI 安装。

使用独立的 `web` 等非桌面 profile 时，可使用其 CLI：

```sh
dsh plugin --profile web add /absolute/path/dsh-qiuya-tools-darwin-universal.tgz
```

Windows 路径有空格时在 PowerShell 中使用双引号。只将 `web` 替换为实际的非桌面 profile；不要把测试 profile 的配置目录当作日常 profile。安装后检查插件管理器中的版本和运行状态；管理器确认已应用时可继续使用，仅在明确要求重启时重启 Harness。

Windows 原生程序自包含 .NET，使用者不需要开发 SDK；WebView2 Runtime 缺失时会给出明确错误。可从 [Microsoft WebView2 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/) 获取运行时。候选包未做正式开发者签名和 Mac 公证，签名状态也写入资产旁的 JSON。

## 本机应用操控

1. 打开 **设置 → QiuYaTools → 电脑操控**，启用新功能。
2. 先选择“关联聊天”。保持目标应用窗口打开，选择“这台电脑”，点击“为此聊天连接环境”。连接与目标只绑定这个聊天。
3. 点击“刷新窗口”，选择目标窗口，再点击“允许本次并开始”。需要重复使用的应用可由你设置“始终允许”。
4. 返回关联聊天，顶部默认显示实时预览小框。在这个聊天选择支持图片输入的模型，再发送任务；需要更大画面时点击“弹出”，也可在设置中使用“弹出大预览”。
5. 预览中的 **暂停** 撤销 AI 输入权；**接管** 允许你点击预览、拖动、滚动和输入文字；**继续** 获取新画面与新租约；**停止** 结束本次授权。

模型通过 `qiuya_computer_status / targets / select / observe / act / pause` 使用当前会话。模型不能自行授予应用权限、从暂停恢复或更换设备。只有明确观察的画面写入聊天附件；连续预览帧不写附件。

### 小预览、大窗口与多个聊天

小框可以收起后再展开，也可以弹出为单独的大窗口。大窗口打开时，小框显示“预览已弹出”；点击“收回到聊天”即可恢复小框。**收起小框、收回大窗口或切换聊天都继续后台任务；直接点击大窗口的关闭按钮会暂停对应聊天。** 要结束授权请使用“停止”。

每个聊天有自己的目标、连接、暂停状态和预览。可以让多个聊天分别连接本机、不同远端电脑或独立浏览器；切换一个聊天的环境、暂停或停止它，不会停止其他聊天。新聊天没有连接时使用自己的本机环境，不会继承另一个聊天的配对密钥或目标授权。

同一个 Harness 连接内，多个聊天操作同一台电脑或同一配对端点时，鼠标与键盘按动作顺序排队，观察和模型思考不会一直占着输入权。不同的远端环境、独立浏览器配置可以并行工作。同一真实桌面仍共享鼠标和焦点，不能当作互不影响的多台电脑；目标被移动、遮挡或改变后，任务可能需要重新观察。

“始终允许”的应用列表由当前 Harness profile 统一管理。撤销某个应用会停止所有正在操作该应用的聊天；关闭电脑操控开关会停止所有聊天的电脑任务。其他原有增强功能仍使用各自的开关和存储，包括长文本、会话分窗与拖出、批量归档、计划批注、菜单、提示词、Q 主题、设置、关于和更新。会话分窗依然使用自己的窗口组件，并按宿主版本检测支持状态。

Mac 系统权限属于 `QiuYaTools Computer.app`，与普通会话分窗应用独立。在系统设置中允许该应用的屏幕录制与辅助功能后，重启 Harness 再检查权限状态。插件不会自动更改 TCC 或系统登录配置。

原生应用输入使用前台桌面的实际鼠标和焦点。AI 执行指针动作时，桌面显示单独绘制的 AI 箭头，预览也反馈 AI 的动作位置；箭头随实际 AI 操作出现，暂停、停止或人工接管后隐藏。它是动作反馈，不代表原生应用能够后台独立操作，也不会替代你的系统鼠标指针。Windows 的本地物理输入、Mac 的物理 Escape 或拖动中点击预览会触发当前原生输入的中断。最小化、目标消失、窗口几何改变等情况需要重新观察或重新选择。

Windows 可能拒绝后台进程激活窗口。若提示 `foreground-denied` 或“Activate the target window before input”，请先在桌面点击目标应用使其激活，再明确继续任务；插件会保留焦点校验，失败的输入不会自动重放。

## 浏览器专用通道

先选择关联聊天，再选择“浏览器专用通道”、Chrome 或 Edge，填写允许的网站来源和起始地址，然后为此聊天连接。网站来源示例是 `https://example.com`，可每行填写一个。仅这些来源内的页面可以被观察和操作；修改许可后重新连接会先停止这个聊天的原电脑任务。

默认在当前 Harness profile 下按聊天建立独立、持久的浏览器配置。两个聊天不会共用默认浏览器 profile；你可以分别登录，之后在原聊天中复用各自的登录态，不会复制日常浏览器的 Cookie。需要连接已有浏览器时，可以在高级选项填写用户自己开启的本机调试地址；它只接受回环地址或已经建立的可信隧道。显式连接同一个已有浏览器时，该浏览器原有的页面和登录态由你管理，不能把它当作两个默认隔离的配置。连接结束不会关闭用户原有的浏览器进程。

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

默认只监听 `127.0.0.1`。使用已有的 SSH/TLS 隧道接入后，在插件先选择关联聊天，再选择“独立虚拟机或远端电脑”，填写配对地址和令牌，为这个聊天连接。其他聊天的连接保持独立。只有明确可信的私有网络才启用“允许通过受信任的私有网络连接”；若代理要直接绑定私有地址，需显式设置 `QIUYA_COMPUTER_HOST` 和 `QIUYA_COMPUTER_PORT`，并由环境所有者配置网络访问。插件不会自动开放系统防火墙。

Windows 代理必须在登录桌面运行。系统服务的 Session 0 或普通非交互远程命令中启动成功，并不表示能操控用户桌面。断连后不会自动重放点击、拖拽或文字；需要重新连接并明确开始。旋转令牌后旧配对和旧设备应用授权不继承。

### 手动文件交换

文件交换默认关闭。代理管理者需先建立一个专用真实目录，再设置 `QIUYA_COMPUTER_EXCHANGE_DIR` 并重启代理；不要将整个用户目录、日常文档目录或系统目录作为交换目录。直接指向符号链接或 Windows junction 的配置会被拒绝。目录需位于支持同目录原子硬链接发布的文件系统，例如 APFS 或 NTFS；不支持时上传会明确失败，不会退化为覆盖式写入。

```sh
# 在远端 Mac 上：显式建立并授权一个独立目录
mkdir -p "$HOME/QiuYaTools-Exchange"
export QIUYA_COMPUTER_EXCHANGE_DIR="$HOME/QiuYaTools-Exchange"
node scripts/computer-agent.mjs
```

```powershell
# 在远端 Windows 上：保留原有配对令牌环境设置
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\QiuYaTools-Exchange" | Out-Null
$env:QIUYA_COMPUTER_EXCHANGE_DIR = "$env:LOCALAPPDATA\QiuYaTools-Exchange"
node scripts/computer-agent.mjs
```

本机插件为选定聊天连接该独立电脑后，在“手动文件交换”中点击“检查并刷新交换目录”，手动选择本机文件上传，或下载列表中的文件。界面上的文件操作跟随当前所选聊天的远端连接；切换聊天会更换文件区域。这个区域只在实际连接远端电脑时提供，本机和浏览器专用模式不提供该交换目录。本机选择器只传文件名和字节，不发送本机目录路径，也没有注册为聊天模型工具。

为兼容已有调用，不带聊天 ID 的所有者文件交换接口仍有效，使用自己的默认远端连接，不会切换或停止其他聊天的环境。新的界面操作先关联聊天，再使用该聊天选定的远端目录；两种入口都只允许所有者手动操作。

单文件上限 **8 MiB**，传输使用 **128 KiB** 分块，并在发布前检查完整大小和 SHA256。已有同名文件不会覆盖；路径、Windows ADS/保留名称、链接、子目录和超过限制的文件不在交换范围内。列表最多显示 100 个普通文件；文件上传后若被远端用户修改，旧列表的下载版本会失效，需要刷新。没有执行、删除或任意路径读写入口，已发布文件由目录管理者自行整理。

最多同时保留两个未完成上传，临时预算不超过 16 MiB，事务超时为两分钟。正常断连、撤销配对和代理关闭会等待未完成事务清理；清理失败会报错并保留重试状态。旧连接已被撤权时，退出只表示旧文件权限失效，不能证明临时文件已删除；远端代理继续承担清理和临时预算约束。上传遇到未知响应或发布结果需要确认时，插件不会自动重播上传或提交，请先刷新列表确认。撤销不能回滚已经完成的磁盘发布；已发布文件及远端用户对它的修改不会被撤销操作删除。

同一专用目录只允许一个代理管理，目录内的 `.qiuya-` 前缀为内部事务和锁文件保留，不会列出、下载或接受同名上传。代理重启后，新鲜的遗留临时文件仍占用两个文件/16 MiB 额度；到期后会由有界周期清理恢复。主锁仅在系统明确确认旧 PID 已不存在时自动回收；PID 存活、复用、权限不足或记录损坏都会拒绝启用。初始化的短恢复门若因进程异常退出而遗留，则不会自动猜测删除：需由目录管理者先确认相关代理均已退出，再检查并整理 `.qiuya-exchange.recovery`。初始化或关闭清理因权限问题失败时，恢复目录权限后重试会先处理本进程记录的遗留清理，不会删除另一代理的锁。

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
