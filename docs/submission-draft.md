# QiuYa 增强工具箱 · 收录申请待确认稿

本稿对应本地 v0.5.0 候选版本，确认后再发布安装包、更新线上申请。

---

添加 **QiuYa 增强工具箱**，分类 `ui`。

给 DeepSeek Harness 加一点顺手的小功能：

- **长文本转 TXT 附件**：粘贴达到字符数或行数阈值时自动转换，默认 1000 个字符或 15 行，支持调整。
- **会话独立窗口**：右键打开或拖出列表，按会话复用窗口，拖动时预加载。
- **多选与批量归档**：Shift / ⌘ / Ctrl 多选后右键归档，也可归档工作区全部会话。
- **计划批注**：选中文字评论，在同一张审批卡提交修改建议，保留输入草稿。
- **会话菜单增强**：未读标记、复制标题和目录、打开目录；置顶、重命名等沿用原生操作。
- **Q主题「鲸与海」**：白发少年与鲸鱼的手绘海面，支持浅色与深色外观。

在 **设置 → QiuYaTools** 中分别开关功能；左下角账号菜单也有入口。五项增强默认开启，Q主题默认关闭。提供 GitHub 正式版本检查和更新。

## 安装

在 **插件 → 添加插件** 粘贴：

```text
https://github.com/z1223473749/dsh-QiuYaTools/releases/latest/download/dsh-qiuya-tools.tgz
```

安装并启用后，打开 **设置 → QiuYaTools**。

- [源码与说明](https://github.com/z1223473749/dsh-QiuYaTools)
- [发布版本](https://github.com/z1223473749/dsh-QiuYaTools/releases)
- 当前验证目标：官方 macOS Harness `0.2.1-rc.2`；独立窗口支持 macOS 13+，安装包包含 Apple Silicon / Intel 组件。
- MIT 开源，包含可工作的源码、`dsh.bundle`、Cordis patch 和预构建安装包。
- 本 PR 只新增一条插件 YAML。满足仓库年龄要求并得到用户确认后再提交评审。
