<p align="center">
  <img src="./assets/icon-color.webp" width="96" height="96" alt="">
</p>

<a id="qiuya-增强工具箱"></a>

<h1 align="center">QiuYa 增强工具箱</h1>

<p align="center">
  <strong>让 DeepSeek Harness 更顺手：</strong><br>
  附件增强、会话与 Git 管理，以及智能动态主题。
</p>

<br>

<a id="安装"></a>

## 📦 安装

<a id="github-安装"></a>

### 🐙 GitHub 安装

1. 在 Harness 的 **插件 → 添加插件** 中输入 `https://github.com/z1223473749/dsh-QiuYaTools`，点击安装。
2. 安装器根据 Harness 所在系统和进程架构，安装会话独立窗口所需的预编译组件，无需编译或安装 SDK。

也可从 [GitHub Releases](https://github.com/z1223473749/dsh-QiuYaTools/releases) 安装完整 `.tgz`：Windows 选择与 Harness 进程架构一致的 **ARM64** 或 **x64** 包，Mac 使用 **universal** 包。完整包内置原生组件，不重复下载平台依赖。下载后在 Harness 的插件管理中选择本地安装包。

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
      <th align="left">功能摘要</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>📎 附件增强</strong></td>
      <td>支持文件拖入、粘贴和内容预览，长文本自动转为 TXT 附件。</td>
    </tr>
    <tr>
      <td><strong>🪟 会话独立窗口</strong></td>
      <td>右键打开或拖出会话，在独立窗口中继续聊天。</td>
    </tr>
    <tr>
      <td><strong>🗃️ 批量归档</strong></td>
      <td>支持多选归档，或一键归档整个工作区的会话。</td>
    </tr>
    <tr>
      <td><strong>📝 计划批注</strong></td>
      <td>选中计划文字添加批注，并提交修改建议。</td>
    </tr>
    <tr>
      <td><strong>💬 会话批注</strong></td>
      <td>选中回复添加批注，或带到新会话继续提问。</td>
    </tr>
    <tr>
      <td><strong>📋 会话菜单</strong></td>
      <td>快捷置顶、标记已读或未读、复制信息和打开目录。</td>
    </tr>
    <tr>
      <td><strong>💡 提示词建议</strong></td>
      <td>根据当前会话推荐下一句，支持快捷填入和编辑。</td>
    </tr>
    <tr>
      <td><strong>🌿 Git 分支与改动</strong></td>
      <td>选择或新建分支，查看改动、提交代码并管理 PR。<a href="docs/git-guide.md">使用说明</a></td>
    </tr>
    <tr>
      <td><strong>🎨 Q 主题与自定义主题</strong></td>
      <td>提供八款预设主题，包含「桃华白狐」和「伽罗 · 月下冰弦」静音视频主题。视频首次使用时从 GitHub 下载并缓存，侧栏、会话和工具面板同步显示。也可上传图片自定义配色、构图和动态氛围，适配浅深色界面。<a href="docs/q-theme-framework.md">主题接入说明</a></td>
    </tr>
    <tr>
      <td><strong>✨ AI 智能动态主题</strong></td>
      <td>识别图片对象并生成局部动效，支持选区修正和实时调速；保存后加入列表，可随时删除。</td>
    </tr>
  </tbody>
</table>

## 电脑操控功能已移除

**官方 Harness 已提供相同的电脑操控功能，请直接使用官方入口。** QiuYaTools 已移除电脑操控及相关代码，包括桌面与浏览器操控、远端执行器、实时预览、授权入口，以及依赖它们的工作台、画面批注、网页诊断和自动验收模块。

插件继续提供附件增强、会话独立窗口、批量归档、计划与会话文字批注、提示词建议、Git 管理和 Q 主题。旧配置中的 `computerUseEnabled` 不再生效；无需修改已保存的主题和其他设置。迁移说明见[功能移除说明](docs/computer-use-guide.md)。

<a id="更新与兼容"></a>

## 🛠️ 更新与兼容

- 支持 Harness **0.2.1-rc.2 / 0.2.2-rc.2 / 0.2.2-rc.3** 的 Agent 注册表接口；0.2.2 兼容更新修复 `agents.roots is not a function` 导致的聊天失败。Mac 原生组件以 **macOS 13+** 为构建目标，提供 Apple Silicon / Intel universal 包；Windows 提供 **ARM64 / x64** 包，独立窗口需要 Microsoft Edge WebView2 Runtime。
- 插件默认在每次启动时检查更新，持续运行期间每 24 小时检查一次；新版本会在工具箱设置、版本更新入口及账号菜单的工具箱入口提醒。可在 **QiuYaTools → 版本更新** 中手动检查或关闭自动检查，更新按钮显示实际下载进度，确认后手动安装。
- 自动更新优先下载界面与业务代码小包；原生组件版本不变时复用 Harness 的包管理缓存，只有原生版本变化或缓存缺失时才下载对应平台的原生包。旧版工具箱更新器可能仍要求电脑操控组件；遇到更新包校验失败时，请通过官方 Harness 插件管理安装新包并重启。发布维护说明见[原生组件版本与更新](docs/native-updates.md)。
- 提示词建议与智能主题生成会产生额外模型用量；主题播放和调速在本地完成。


<a id="界面预览"></a>

## 🎬 界面预览

以下为历史版本演示，其中的电脑操控已由官方 Harness 提供，当前插件已移除该部分。附件增强与计划批注继续保留。

https://github.com/user-attachments/assets/42aef75f-81ef-441b-92af-d2211296346f

---

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-qiuya-tools">npm</a> · <a href="https://github.com/z1223473749/dsh-QiuYaTools/releases">发布版本</a> · <a href="https://github.com/z1223473749/dsh-QiuYaTools/issues">问题反馈</a> · <a href="docs/development.md">开发说明</a> · <a href="https://www.qiuya.cc">www.qiuya.cc</a>
</p>
