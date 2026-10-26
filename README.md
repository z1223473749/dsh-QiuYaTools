<p align="center">
  <img src="./assets/icon-color.webp" width="96" height="96" alt="">
</p>

<a id="qiuya-增强工具箱"></a>

<h1 align="center">QiuYa 增强工具箱</h1>

<p align="center">
  <strong>让 DeepSeek Harness 更顺手：</strong><br>
  长文本附件、会话分窗、计划批注，以及可在聊天中调用的电脑操控。
</p>

<br>

<a id="安装"></a>

## 📦 安装

<a id="github-安装"></a>

### 🐙 GitHub 安装

1. 在 Harness 的 **插件 → 添加插件** 中输入 `https://github.com/z1223473749/dsh-QiuYaTools`，点击安装。
2. 安装器根据 Harness 所在系统和进程架构，安装同版本的预编译原生组件。无需编译、安装 SDK 或手动启动执行器。

也可从 [GitHub Releases](https://github.com/z1223473749/dsh-QiuYaTools/releases) 安装完整 `.tgz`：Windows 选择与 Harness 进程架构一致的 **ARM64** 或 **x64** 包，Mac 使用 **universal** 包。完整包内置原生组件，不重复下载平台依赖。下载到本地后的安装步骤见[使用指南](docs/computer-use-guide.md)。

<a id="npm-安装mac--windows"></a>

### 📦 npm 安装（Mac / Windows）

npm 与仓库地址安装使用相同的平台组件依赖。安装时请保留可选依赖；若网络或安装策略跳过了组件，设置页会明确提示安装不完整，可重新安装或使用对应系统的完整 `.tgz`。

1. 打开 Harness 的 **插件 → 添加插件**。
2. 输入 npm 包名 **`dsh-qiuya-tools`**，点击安装。[查看 npm 包](https://www.npmjs.com/package/dsh-qiuya-tools)。

> 安装后点击 **立即启用**，进入 **设置 → QiuYaTools**；左下角账号菜单也有快捷入口。各渠道的可用版本与平台包以对应发布页为准。

<a id="功能"></a>

## ✨ 功能

<table>
  <thead>
    <tr>
      <th width="27%" align="left">功能</th>
      <th align="left">使用体验</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>🖥️ 电脑操控</strong></td>
      <td>在聊天中说明任务，AI 发现应用并申请授权后，查看画面、点击和输入。支持 Mac、Windows、独立浏览器与已配对的远端电脑。</td>
    </tr>
    <tr>
      <td><strong>🎛️ 多任务与实时预览</strong></td>
      <td>同一聊天最多保留 8 个电脑任务。小预览可切换任务、在窗口内移动或单独弹出；悬停后显示暂停、接管、继续和停止。</td>
    </tr>
    <tr>
      <td><strong>📎 长文本附件</strong></td>
      <td>长文本粘贴时自动转为 TXT，默认阈值为 1000 字符或 15 行，可自行调整。</td>
    </tr>
    <tr>
      <td><strong>🪟 会话独立窗口</strong></td>
      <td>右键打开，或把会话拖出列表；再次打开会唤起已有窗口。</td>
    </tr>
    <tr>
      <td><strong>🗃️ 批量归档</strong></td>
      <td>Shift 连选、⌘ / Ctrl 多选后归档，也可归档工作区内的全部会话。</td>
    </tr>
    <tr>
      <td><strong>📝 计划批注</strong></td>
      <td>选中文字添加评论、提交修改建议，同时保留输入框草稿。</td>
    </tr>
    <tr>
      <td><strong>💬 会话批注</strong></td>
      <td>选中回复文字添加批注，正文显示编号，悬停查看意见；保存后在输入框内显示批注摘要，点击可查看或修改，发送时与文字、引用和附件一起提交，也可单独提交批注并保留草稿。选中文字还可“新会话提问”，将原文带入同工作区的新会话草稿。</td>
    </tr>
    <tr>
      <td><strong>📋 会话菜单</strong></td>
      <td>置顶、标记已读或未读、复制标题和路径、打开目录。</td>
    </tr>
    <tr>
      <td><strong>💡 提示词建议</strong></td>
      <td>根据当前会话推荐下一句，按 Tab 填入、Esc 隐藏，修改后手动发送。</td>
    </tr>
    <tr>
      <td><strong>🌿 Git 分支与改动</strong></td>
      <td>会话开始前选择或自定义新建分支；悬停增删统计查看仓库名和文件清单，点击在右侧查看对比、提交与管理三家平台的 PR。<a href="docs/git-guide.md">使用说明</a></td>
    </tr>
    <tr>
      <td><strong>🐋 Q 主题「鲸与海」</strong></td>
      <td>鲸鱼与白发少年的手绘背景，搭配浅色、深色半透明界面。</td>
    </tr>
    <tr>
      <td><strong>✅ 自动验收与模板</strong></td>
      <td>创建检查清单、保存模板、在当前聊天运行并查看结果与历史。</td>
    </tr>
    <tr>
      <td><strong>🔍 画面批注与网页诊断</strong></td>
      <td>将框选、箭头和修改建议发回聊天；网页日志与网络信息按需授权。</td>
    </tr>
  </tbody>
</table>

<a id="在聊天中使用电脑操控"></a>

## 🖥️ 在聊天中使用电脑操控

1. 在 **QiuYaTools → 电脑操控** 开启功能。
2. 回到聊天，直接说出任务，例如“帮我打开浏览器，整理这个页面”。无需手动关联聊天或预选窗口。
3. 根据授权卡选择 **允许一次 / 始终允许 / 拒绝**，随后通过小预览查看进度，随时暂停或接管。

需要独立浏览器或远端电脑时，在当前聊天输入框旁的环境菜单中选择。各任务分别保存目标与授权；停止一个任务不会结束其他任务。同一实际桌面的鼠标和键盘操作会按顺序执行。

> **始终允许的应用**支持名称搜索和图标辨认，可在设置中添加或撤销。授权由你确认，AI 不会替你开启系统权限。

<a id="更新与兼容"></a>

## 🛠️ 更新与兼容

- 目前适配 Harness **0.2.1-rc.2**。Mac 原生组件以 **macOS 13+** 为构建目标，提供 Apple Silicon / Intel universal 包；Windows 提供 **ARM64 / x64** 包，独立窗口需要 Microsoft Edge WebView2 Runtime。
- Mac 首次使用需给 **DeepSeek Harness** 开启**屏幕录制、辅助功能和输入监控**。工具箱由 Harness Host 直接启动执行器，使用宿主的系统权限；授权卡会自动核验并显示当前宿主应用，返回工具箱后自动检测。无需为插件单独申请 Developer ID 或修改权限配置。
- 原生桌面操作需要**可交互的桌面**；Chrome / Edge 独立浏览器通道支持**后台页面操作**。
- 插件默认在启动后自动检查更新，正常检查间隔为 24 小时；新版本会在工具箱设置、版本更新入口及账号菜单的工具箱入口提醒。可在 **QiuYaTools → 版本更新** 中手动检查或关闭自动检查，确认后手动安装。
- 提示词建议使用当前会话模型，会产生少量额外模型用量。

更多配置、权限说明与使用方法见[电脑操控指南](docs/computer-use-guide.md)。

<a id="界面预览"></a>

## 🎬 界面预览

聊天界面、电脑操控预览、长文本附件与计划批注的使用演示，含中文讲解。

https://github.com/user-attachments/assets/42aef75f-81ef-441b-92af-d2211296346f

---

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-qiuya-tools">npm</a> · <a href="https://github.com/z1223473749/dsh-QiuYaTools/releases">发布版本</a> · <a href="https://github.com/z1223473749/dsh-QiuYaTools/issues">问题反馈</a> · <a href="docs/development.md">开发说明</a> · <a href="https://www.qiuya.cc">www.qiuya.cc</a>
</p>
