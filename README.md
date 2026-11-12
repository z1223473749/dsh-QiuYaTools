<p align="center">
  <img src="./assets/icon-color.webp" width="96" height="96" alt="">
</p>

<a id="qiuya-增强工具箱"></a>

<h1 align="center">QiuYa 增强工具箱</h1>

<p align="center">
  <strong>让 DeepSeek Harness 更顺手：</strong><br>
  电脑操控、附件增强、会话与 Git 管理，以及智能动态主题。
</p>

<br>

<a id="安装"></a>

## 📦 安装

<a id="github-安装"></a>

### 🐙 GitHub 安装

1. 在 Harness 的 **插件 → 添加插件** 中输入 `https://github.com/z1223473749/dsh-QiuYaTools`，点击安装。
2. 安装器根据 Harness 所在系统和进程架构，安装插件指定版本的预编译原生组件。原生组件独立版本化并复用安装缓存，无需编译、安装 SDK 或手动启动执行器。

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
      <th align="left">功能摘要</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>🖥️ 电脑操控</strong></td>
      <td>在聊天中授权 AI 查看和操作电脑，支持 Mac、Windows、浏览器及远端电脑。</td>
    </tr>
    <tr>
      <td><strong>🎛️ 多任务与实时预览</strong></td>
      <td>支持多任务切换、实时画面预览、暂停和手动接管。</td>
    </tr>
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
      <td>提供七款预设主题，包含「桃华白狐」和「伽罗 · 月下冰弦」静音视频主题。视频首次使用时从 GitHub 下载并缓存，侧栏、会话和工具面板同步显示。也可上传图片自定义配色、构图和动态氛围，适配浅深色界面。<a href="docs/q-theme-framework.md">主题接入说明</a></td>
    </tr>
    <tr>
      <td><strong>✨ AI 智能动态主题</strong></td>
      <td>识别图片对象并生成局部动效，支持选区修正和实时调速；保存后加入列表，可随时删除。</td>
    </tr>
    <tr>
      <td><strong>✅ 自动验收与模板</strong></td>
      <td>使用检查清单和模板运行验收，查看结果与历史。</td>
    </tr>
    <tr>
      <td><strong>🔍 画面批注与网页诊断</strong></td>
      <td>标注画面并反馈到聊天，按需授权查看网页日志与网络信息。</td>
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

- 支持 Harness **0.2.1-rc.2 / 0.2.2-rc.2** 的 Agent 注册表接口；0.2.2 兼容更新修复 `agents.roots is not a function` 导致的聊天失败。Mac 原生组件以 **macOS 13+** 为构建目标，提供 Apple Silicon / Intel universal 包；Windows 提供 **ARM64 / x64** 包，独立窗口需要 Microsoft Edge WebView2 Runtime。
- Mac 首次使用需给 **DeepSeek Harness** 开启**屏幕录制、辅助功能和输入监控**。工具箱由 Harness Host 直接启动执行器，使用宿主的系统权限；授权卡会自动核验并显示当前宿主应用，返回工具箱后自动检测。无需为插件单独申请 Developer ID 或修改权限配置。
- 原生桌面操作需要**可交互的桌面**；Chrome / Edge 独立浏览器通道支持**后台页面操作**。
- 插件默认在每次启动时检查更新，持续运行期间每 24 小时检查一次；新版本会在工具箱设置、版本更新入口及账号菜单的工具箱入口提醒。可在 **QiuYaTools → 版本更新** 中手动检查或关闭自动检查，更新按钮显示实际下载进度，确认后手动安装。
- 自动更新优先下载界面与业务代码小包；原生组件版本不变时复用 Harness 的包管理缓存，只有原生版本变化或缓存缺失时才下载对应平台的原生包。旧客户端仍使用完整包完成过渡；从完整包首次切换到小包时可能需要下载一次独立原生依赖。发布维护说明见[原生组件版本与更新](docs/native-updates.md)。
- 提示词建议与智能主题生成会产生额外模型用量；主题播放和调速在本地完成。

更多配置、权限说明与使用方法见[电脑操控指南](docs/computer-use-guide.md)。

<a id="界面预览"></a>

## 🎬 界面预览

聊天界面、电脑操控预览、附件增强与计划批注的使用演示，含中文讲解。

https://github.com/user-attachments/assets/42aef75f-81ef-441b-92af-d2211296346f

---

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-qiuya-tools">npm</a> · <a href="https://github.com/z1223473749/dsh-QiuYaTools/releases">发布版本</a> · <a href="https://github.com/z1223473749/dsh-QiuYaTools/issues">问题反馈</a> · <a href="docs/development.md">开发说明</a> · <a href="https://www.qiuya.cc">www.qiuya.cc</a>
</p>
