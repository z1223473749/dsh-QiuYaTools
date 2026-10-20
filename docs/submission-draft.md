# 收录 QiuYa 增强工具箱

给 DeepSeek Harness 加一点顺手的小功能，MIT 开源，分类为 `ui`。

## 功能

- **长文本附件**：粘贴长内容时自动转成 TXT 附件，转换阈值可以调整。
- **会话独立窗口**：右键打开，或将会话拖出列表，方便同时查看多个会话。
- **多选与批量归档**：多选会话后右键归档，也能归档工作区内的全部会话。
- **计划批注**：选中计划中的文字添加评论，再提交修改建议，保留原有输入草稿。
- **会话菜单增强**：右键置顶、标记未读、复制标题或路径、打开工作目录；工作区支持移到顶部。
- **提示词建议**：在空输入框显示当前会话的下一句建议，按 Tab 填入、Esc 隐藏，修改后手动发送。
- **Q主题「鲸与海」**：白发少年与鲸鱼的手绘海面，支持浅色和深色外观。

前六项增强默认开启，可在 **设置 → QiuYaTools** 中单独开关或一键全选。Q主题默认关闭，可按喜好开启；左下角账号菜单也有设置入口。

提示词建议使用当前会话所选模型，会产生少量额外模型用量。

## 安装

打开 Harness 的 **插件 → 添加插件**，输入 npm 包名 **`dsh-qiuya-tools`**，安装后点击 **立即启用**。

[查看 npm 包](https://www.npmjs.com/package/dsh-qiuya-tools) · [源码与使用说明](https://github.com/z1223473749/dsh-QiuYaTools)

<details>
<summary>GitHub 备用安装链接</summary>

也可在“添加插件”中粘贴：

```text
https://github.com/z1223473749/dsh-QiuYaTools/releases/latest/download/dsh-qiuya-tools.tgz
```

镜像源同步新版本可能稍有延迟；暂时找不到包或版本时，可切换到 [npm 官方源](https://registry.npmjs.org/)，或使用此链接。

</details>

## 界面预览

**功能设置**

![QiuYa 增强工具箱设置页](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/settings.jpg)

**Q主题「鲸与海」**

![Q主题鲸与海的新会话界面](https://raw.githubusercontent.com/z1223473749/dsh-QiuYaTools/main/docs/images/q-theme-home.png)

## 兼容与验证

适配官方 macOS Harness **0.2.1-rc.2**。独立窗口需要 **macOS 13+**，安装包包含 Apple Silicon 和 Intel 组件。

[v0.5.2 已发布](https://github.com/z1223473749/dsh-QiuYaTools/releases/tag/v0.5.2)，393 项测试与构建检查通过：[CI 验证记录](https://github.com/z1223473749/dsh-QiuYaTools/actions/runs/39444860345)。

<details>
<summary>收录自查</summary>

- [x] 本 PR 只新增 `data/plugins/z1223473749__dsh-QiuYaTools.yml`。
- [x] 插件提供有效的 `dsh.bundle` 声明。
- [x] 插件类别为 `ui`。
- [x] 中英文描述与实际功能一致。
- [ ] 插件仓库创建已满一天，满足时间为北京时间 **2026-10-21 15:15:40**。
- [x] 插件仓库已添加 `dsh-plugin` topic。

</details>
