# QiuYa 增强工具箱

支持长文本转 TXT 附件、会话独立窗口、批量归档和计划批注，常用功能一处设置。

在 **设置 → QiuYaTools** 中管理四项功能，也可从左下角账号菜单的 **QiuYaTools** 入口直接打开。当前版本 `0.3.0`，面向官方 macOS Harness `0.2.1-rc.2`。

[GitHub 开源仓库](https://github.com/z1223473749/dsh-QiuYaTools) · [下载与发布记录](https://github.com/z1223473749/dsh-QiuYaTools/releases) · [问题反馈](https://github.com/z1223473749/dsh-QiuYaTools/issues)

图标采用已确认的 B「温柔手绘」方案：白发少年坐在鲸鱼背上。插件列表使用彩色图标，设置导航和账号菜单使用同一黑白轮廓，并随深浅主题调整颜色。正式资源位于 `assets/`；原图与生成提示词保存在 `design/icon-concepts/`。

## 功能与操作

| 功能 | 操作 | 默认 |
| --- | --- | --- |
| 大文本粘贴转 TXT | 在会话输入框粘贴，达到字符数或行数阈值时转换为一个 TXT 附件 | 开启；1000 个字符或 15 行 |
| 会话独立窗口 | 会话右键“新窗口打开”，或将单条会话拖出列表/窗口 | 开启；macOS 原生窗口 |
| 会话多选与批量归档 | Shift 范围选择，Command/Ctrl 逐条选择；右键批量归档或取消选择；工作区菜单归档全部成员 | 开启 |
| 计划评论与单卡修正 | 在待审计划全文中选中文本添加批注；原审批卡切换为修正卡并可直接提交修改意见 | 开启 |

“启用全部功能”一次开启或关闭四项功能，每项也能独立开关。更改通过原生 ConfigForm 保存，并即时安装/释放相应功能；设置页本身始终可访问。

设置页顶部的名称、版本和总开关保持固定；下方五个图标标签分别打开四项功能与“关于我们”，内容只在当前面板内滚动。切换标签会保留尚未保存的阈值和更新进度。

### GitHub 更新

打开 **关于我们 → 检查更新**，查看 GitHub 最新正式版本与发布说明。有新版时点击“更新至 v…”安装；完成后完全退出并重新打开 Harness。原有功能开关、阈值和会话保留。

更新仅使用本仓库的正式 GitHub Release，验证下载包的 SHA-256、包名、版本与原生程序架构，再交给 Harness 自带的插件安装管理器。不会自动重启应用。开发者以 `link:` 方式安装时，点击更新会把当前 profile 切换为发布包；原来的源码目录保留。

### 大文本阈值

在设置页编辑“字符数”和“行数”，点击“保存阈值”。字符数允许 `1–1,000,000`，行数允许 `1–100,000`，均为整数；达到任一阈值即转换。Unicode 字符按码点计数，CRLF 算一个换行。原文和换行保留在 TXT 中。

短文本、纯空白、图片、文件及非输入框粘贴保留原行为；原生附件接收失败时回退普通粘贴。旧版本官方 continuable 子代理输入仅接受图片，因此该输入不转换 TXT。上传、重试、删除、发送沿用原生附件流程。

### 多选与归档

Shift 范围按当前可见顺序选择；Command/Ctrl 可增减单条。**仅保留右键菜单操作，不显示多选悬浮条、归档进度或归档完成提示。** 右键已选会话可批量归档、取消选择，Esc 也可取消。

工作区归档按真实成员 ID 处理，也包含折叠隐藏成员，保留工作区和目录；排除空白、子代理与已归档会话。逐条调用官方归档服务，运行中的会话保留 Host 限制。部分失败不会阻断其他成员，失败项保留以便重试；重新打开右键菜单可查看失败信息。

### 独立窗口

窗口按会话 ID 复用，继续连接当前 Harness Host，不创建另一份会话。每个窗口固定到自己的目标会话，加载沿用 Harness 页面风格，确认实际正文与目标一致后才显示内容。拖动开始时提前加载该会话，松手分离时显示已经准备的窗口；取消或在列表内放下会清理隐藏窗口，已打开的窗口保留。关闭该功能后撤下菜单与拖拽入口。取消拖放、列表内部排序、已接受的其他拖放以及多选拖动不会触发分离。

窗口会复用会话目录正在进行的读取；读取结束仍未就绪时，进行三次有限重试，持续失败则显示可关闭的失败页。首次通过菜单打开仍需初始化独立网页客户端，速度取决于 Host 与会话大小；已经打开的窗口会直接唤起。

官方 Electron 应用没有开放原仓的窗口 IPC，所以插件带一个 Swift/AppKit/WKWebView 辅助应用。认证地址只通过 stdin 传递，程序退出随 Host 生命周期清理。每个会话使用独立的 WebKit 网络与存储实例，避免多个页面的长期更新连接挤满同一个 HTTP 请求池。macOS 14+ 按 Harness 配置目录和会话 ID 分配稳定的持久存储，关闭再打开同一会话继续复用；旧的共享存储保留。macOS 13 使用各窗口独立的临时存储。独立窗口使用标准 Web 附件上传，不提供官方 Electron preload 的本机路径引用接口。

会话数据和功能开关连接同一 Host。批注草稿保存在各浏览器的本地存储中，主窗口与辅助窗口的批注草稿不互通；辅助窗口的本地存储还受 Host 端口对应的网页来源限制。macOS 13 的辅助窗口关闭后不保留本地批注草稿，主窗口不受影响。

目前原生独立窗口支持 macOS。其他系统明确报告该能力不可用，其余功能不依赖 macOS。

### 计划评论

每个待审计划自动打开一次全文预览，也可手动“查看全文”。在原文中选择文字添加批注，支持高亮、悬停阅读、编辑、单项和批量删除，评论保存在客户端。原文改变且无法可靠定位时标记为已变化，不错误定位。

无评论时只有计划审批卡；有评论后同一位置切换为修正卡；删除最后一条立即切回审批。修正直接提交独立提示，不覆盖原有输入草稿和附件。失败保留评论；只有相应用户消息真正写入会话记录后才清理已提交评论。历史卡片只读，编辑评论期间暂停计划等待计时。

## 安装与加载

从 [GitHub Releases](https://github.com/z1223473749/dsh-QiuYaTools/releases) 下载 `dsh-qiuya-tools.tgz`，或在应用的 **插件 → 添加插件** 填写：

```text
https://github.com/z1223473749/dsh-QiuYaTools/releases/latest/download/dsh-qiuya-tools.tgz
```

安装后点击“立即启用”，再打开 **设置 → QiuYaTools**。发布包支持 macOS 13+，同时包含 Apple Silicon 和 Intel 原生窗口组件。

应用完全退出后才可用官方 CLI 管理 desktop profile：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add \
  "https://github.com/z1223473749/dsh-QiuYaTools/releases/latest/download/dsh-qiuya-tools.tgz"
```

开发者可先克隆本仓库，在插件添加框使用 `link:/absolute/path/to/dsh-QiuYaTools`。修改代码后执行 `npm run build`，完全退出并重新打开 Harness。`link:` 默认不监听源码；涉及 Host Config 或通信通道的修改需要重启 Host。

打包：

```sh
QIUYA_TOOLS_UNIVERSAL=1 npm run check
mkdir -p artifacts
npm pack --ignore-scripts --pack-destination artifacts
node scripts/prepare-release.mjs
```

生成 `artifacts/dsh-qiuya-tools-0.3.0.tgz`，并准备固定文件名 `dsh-qiuya-tools.tgz`、`dsh-qiuya-tools-darwin-universal.tgz` 和校验清单。包内含 Host、Client、中文插件信息、图标、Cordis patch、原生辅助应用和 Swift 源码。`QIUYA_TOOLS_UNIVERSAL=1` 同时编译两个 Mac 架构；普通本地构建仅编译当前架构。

推送与 `package.json` 版本一致的 `v*` 标签后，GitHub Actions 会执行完整检查、构建通用安装包并发布到 GitHub Release。插件更新器只安装正式 Release，不追随开发分支。

## 开发与验证

Node.js `^22.19.0 || >=24`，npm；macOS 原生窗口构建还需要 Command Line Tools 的 `swiftc`。

```sh
npm ci
npm run build
npm run check
```

`check` 执行严格类型检查、完整构建和测试。测试覆盖真实 DOM/React 交互、配置原子保存、快速启停和异步清理、附件接收、批量归档目标与失败处理、计划批注定位和耐久回执、窗口 RPC/进程生命周期及拖拽排序保护。归档测试使用隔离 fixture，不操作真实会话。

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | Host volatile Config 和窗口通道 |
| `src/shared.ts` | 共享配置、默认值和字段校验 |
| `src/client/index.tsx` | QiuYaTools 设置页 |
| `src/client/about.tsx` | 关于我们、开源地址与更新入口 |
| `src/updates/` | 固定 GitHub 来源、版本比较、包验证与官方安装管理器接入 |
| `src/client/features.ts` | 按配置启停各功能子 fiber |
| `src/client/feature-switchboard.ts` | 串行启停与异步资源清理 |
| `src/features/pasted-text/` | 大文本附件 |
| `src/features/session-windows/` | 会话菜单、拖拽、Host 和原生窗口 |
| `src/features/bulk-archive/` | 范围选择及右键归档 |
| `src/features/plan-comments/` | 计划全文评论、单卡修正和回执 |
| `scripts/build.mjs` | Host ESM、客户端 lazy-CJS/CSS 与原生辅助程序构建 |

运行时通过官方 slots、会话/工作区服务、连接服务和配置接口协作，不修改原项目或官方安装包。少数没有公开插件扩展点的行为以官方 `0.2.1-rc.2` 的稳定 DOM 与输入提供者契约适配，升级 Harness 后应重新验证。

## 来源

迁移来源为 DSH Desktop [#1163](https://github.com/anywhere-labs/dsh-desktop/pull/1163)、[#1167](https://github.com/anywhere-labs/dsh-desktop/pull/1167)、[#1162](https://github.com/anywhere-labs/dsh-desktop/pull/1162)、[#1304](https://github.com/anywhere-labs/dsh-desktop/pull/1304)。原代码的许可证和归属见 `NOTICE`。本插件采用 MIT License。
