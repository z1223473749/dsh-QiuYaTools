# Q 主题接入

鲸与海、大鱼海棠共用设置、主题单选、配置保存、Host 表面适配和安装生命周期。主题只提供自己的配色、静态插画和可选动效适配器。

## 框架边界

- `src/shared.ts`：主题 ID、默认值和安全读取。旧配置继续默认鲸与海；已保存的关闭和静态选择保留。`qThemeSettings[themeId].motion` 按主题独立保存。
- `src/client/theme-catalog.ts`：主题注册表，包含文案、插画、强调色、配色 CSS 和可选 `installScene`。可通过 `bannerPosition`、`previewPosition` 指定共用设置页的插画裁切位置，让人物避开预览气泡。注册表按 `Q_THEME_IDS` 排序，并通过 `Record<QThemeId, ThemeDefinition>` 检查是否遗漏主题。
- `src/client/q-theme.ts`：每个 Document 共享一个展示层。切换主题先销毁旧动效，再替换配色和插画；静态模式只停止动效。最后一个使用者卸载时恢复原主题标记并释放展示层。
- `src/client/q-theme.css`：共用侧栏装饰、阅读纸面、输入框、菜单、Todo、会话标签、浅深色和辅助功能适配。配色留在 `themes/*.css`，不复制整份展示层。
- `src/client/index.tsx`、`styles.css`：由注册表生成选择卡片和当前主题预览。整卡点击、圆形勾选和描边使用卡片自身的主题色；支持键盘方向键、Home/End。只有 Host 接受保存后的快照会改变选中状态。
- `src/client/theme-preview.tsx`：设置页在自己的同源 Document 中复用公共安装器和原场景适配器。动态选项显示实际动画，静态选项释放动效资源；关闭面板、退出视口或页面隐藏时停止预览，不影响主界面场景。

主题切换不修改 Harness 自己的浅深色偏好、代码高亮和错误/成功/警告等语义色，也不修改工具开关。

## 新增主题

1. 在 `Q_THEME_IDS` 和 `DEFAULT_Q_THEME_SETTINGS` 添加 ID 和默认动静态设置；Host schema 根据 ID 列表生成。
2. 添加静态插画，并在 `scripts/build.mjs` 中作为 data URL 打包到 `brand-assets.ts`。运行时不依赖远程图片。
3. 新建 `src/client/themes/<id>.css`，提供浅色和深色 token；静态图使用 `__QYT_THEME_SCENE__` 占位。不要复制公共布局规则。
4. 在中英文 locale 添加名称、说明、阅读提示和动效控件标签。
5. 在注册表新增 `ThemeDefinition`。共用设置页会自动生成卡片、圈选和动静态入口。
6. 如需动效，提供 `installScene(doc): () => void`。动效必须不接管用户交互，遵循减少动态效果、高对比度和页面可见性，并在卸载时释放帧、监听和观察器。不可用时保留静态插画。

鲸与海沿用原有 WebGL 动效、鼠标视差、涟漪和输入区镜像。大鱼海棠使用透明 Canvas 的花瓣与微光，不对女孩或鱼做鲸鱼式形变。两者共享上层框架，场景自身的绘制逻辑由各自的适配器维护。

## 验证

```sh
npm run typecheck
npm run build
node --test tests/q-theme.test.mjs tests/ocean-scene.test.mjs tests/begonia-scene.test.mjs tests/settings-features.test.mjs tests/host-package.test.mjs
npm run test:ocean:settings
node scripts/test-q-themes.mjs
```

浏览器预览使用本地模拟 Host，不连接真实账号，也不会更新正在使用的插件安装。
