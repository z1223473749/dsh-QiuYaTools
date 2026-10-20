# QiuYa 增强工具箱

给 DeepSeek Harness 加一点顺手的小功能。

当前开发分支为 **0.6.0-beta.1**：增加 Mac/Windows 原生组件、电脑操控、悬浮实时预览和浏览器专用通道。该版本尚未公开发布，请使用交付目录中匹配系统/架构的候选 tgz；下面的 npm/历史 Release 安装入口仍以公开版本为准。详见[电脑操控与候选包说明](docs/computer-use-guide.md)。

## 安装

本次 Windows 候选版请安装对应的 `dsh-qiuya-tools-win32-arm64.tgz` 或 `dsh-qiuya-tools-win32-x64.tgz`；步骤与架构选择见[安装包说明](docs/computer-use-guide.md)。下方 npm 包名和通用 `dsh-qiuya-tools.tgz` 下载入口保留为 Mac universal 分发，不包含 Windows 原生程序。

1. 打开 Harness 的 **插件 → 添加插件**。
2. 输入 npm 包名 **`dsh-qiuya-tools`**，点击安装。
3. 点击 **立即启用**，进入 **设置 → QiuYaTools**。

左下角账号菜单也有 QiuYaTools 入口。[查看 npm 包](https://www.npmjs.com/package/dsh-qiuya-tools)。

也可在“添加插件”中粘贴 GitHub 安装包链接：

```text
https://github.com/z1223473749/dsh-QiuYaTools/releases/latest/download/dsh-qiuya-tools.tgz
```

镜像源同步新版本可能稍有延迟。暂时找不到包或新版本时，可稍后重试、切换到 [npm 官方源](https://registry.npmjs.org/)，或使用上面的 GitHub 链接。

## 功能

| 功能 | 怎么用 |
| --- | --- |
| 长文本附件 | 粘贴长文本自动转为 TXT，默认 1000 个字符或 15 行，阈值可调。 |
| 会话独立窗口 | 右键打开，或把会话拖出列表；再次打开同一会话会唤起已有窗口。 |
| 批量归档 | Shift 连选、⌘ / Ctrl 多选后右键归档，也可归档工作区全部会话。 |
| 计划批注 | 选中计划文字添加评论，提交修改建议，保留输入框原有草稿。 |
| 会话菜单 | 右键置顶、手动标记已读 / 未读、复制标题 / 会话 ID / 工作目录路径、打开目录；工作区也可移到顶部。 |
| 提示词建议 | 回复结束且输入框为空时，根据当前会话推荐下一句，失焦仍保留。聚焦后按 **Tab** 填入、**Esc** 隐藏，可修改后手动发送。 |
| Q主题「鲸与海」 | 手绘鲸鱼与白发少年背景，搭配柔和的半透明界面，支持浅色、深色外观。 |
| 电脑操控 | 关联当前聊天，授权应用窗口，悬浮查看实时画面与 AI 指针，随时暂停、接管、继续或停止。支持本机以及已配对的独立电脑/虚拟机。 |
| 浏览器通道 | Chrome/Edge 独立登录配置或用户提供的调试连接，按网站来源授权；支持截图坐标、选择器、导航与标签页操作。 |

六项原有增强默认开启，可单独开关，也可一键全选。Q主题和新增电脑操控默认关闭，分别设置。新功能不会因原有“全部启用”自动取得桌面权限。

提示词建议使用当前会话所选模型，会产生少量额外模型用量。

## 界面预览

主题截图来自实际使用界面；设置页和提示词演示使用隔离示例。

**Q主题 · 新会话**

![Q主题鲸与海的新会话界面](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/q-theme-home.png)

**Q主题 · 会话阅读**

![Q主题半透明会话与输入框](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/q-theme-conversation.png)

**功能设置**

![QiuYaTools 双排功能入口与长文本转换阈值](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/settings.jpg)

**Q主题设置**

![QiuYaTools 鲸与海主题设置与预览](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/q-theme.jpg)

**提示词建议**

空输入框显示当前会话的建议，聚焦后按 Tab 填入。以下用示例回复演示交互，不调用真实模型。

![QiuYaTools 灰字提示词与 Tab 填入示例](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/prompt-suggestions.jpg)

## 更新与兼容

在 **QiuYaTools → 版本更新 → 检查更新** 中升级，完成后完全退出并重新打开 Harness，原有设置保留。

当前适配 Harness **0.2.1-rc.2**。Mac 原生组件以 **macOS 13+** 为构建目标，包含 Apple Silicon 和 Intel；Windows 候选包分别提供 ARM64 与 x64 的自包含程序，独立窗口需要 Microsoft Edge WebView2 Runtime。各系统与架构的真实运行、现有功能、模型、耐久和安装结果分别记录，不把编译通过当作运行验收。

电脑操控需要支持图片输入的模型。原生操作使用前台鼠标与焦点；浏览器专用通道支持后台标签页操作。Excel 专用加载项与 macOS 锁屏操控属于单独的完整对齐阶段，当前基础包不宣称已完全复刻 Codex。

同一交互桌面同时只允许一个 QiuYaTools 原生执行器控制输入，包括不同配置与已配对的代理。执行器异常退出时，独立守护进程会根据输入记录尝试释放本插件按住的键与鼠标；新执行器也必须先完成旧输入恢复，系统拒绝清理时会阻止新控制。Windows 会检查系统是否接受释放事件；macOS 的事件接口没有键盘送达确认，验收依据权限、可读取的鼠标状态及受控应用实测，不能据此保证任意应用均已处理每个键盘事件。

[npm 包](https://www.npmjs.com/package/dsh-qiuya-tools) · [发布版本](https://github.com/z1223473749/dsh-QiuYaTools/releases) · [问题反馈](https://github.com/z1223473749/dsh-QiuYaTools/issues) · [使用与开发](https://github.com/z1223473749/dsh-QiuYaTools/blob/main/docs/development.md) · [www.qiuya.cc](https://www.qiuya.cc)
