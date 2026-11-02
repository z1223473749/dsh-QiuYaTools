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

## 落日山野

`sunset` 是第三个独立预设，插画为 `assets/q-sunset-scene.jpg`。暖色调浅深色配色独立保存，复用 `landscape-scene.ts` 的轻柔鼠标视差与漂浮微光。动效层只移动插画，不移动原生控件或阅读纸面；页面隐藏、退出视口、减少动态效果和主题卸载时停止并释放动画。主题卡片列表在独立滚动区域显示。

## 用户自定义主题

设置页右侧的「＋ 新建主题」打开独立编辑弹窗。支持导入 JPG、PNG、WebP 静态图，调整缩放与画面位置，选择轻柔视差／缓慢平移、微光／花瓣／飘雪，以及动效强度、速度、主题色和阅读遮罩。支持浅深色预览、重新编辑和删除。内置的「落日山野」始终是独立预设，不会被自定义编辑覆盖。

- 内置主题仍由 `Q_THEME_IDS` 注册；自定义记录使用 `custom:<id>`，由 `getQThemes` 在运行时合并。自定义名称是用户文本，不作为 locale key 或 CSS 代码执行。
- `src/custom-themes.ts` 定义记录和边界；Host schema 与客户端读取均限制图片类型、ID、颜色和数值。源图上限 10 MiB／4000 万像素，客户端重新编码为最长边 1600 像素、最多 256 KiB 的图片，每份配置最多 8 个自定义主题。
- 压缩图片和参数一起保存在 Host 的 `qCustomThemes` 配置中，通过既有配置服务持久化及同步到客户端。无需远程图床或额外图片 API，不依赖关闭页面后失效的 Blob URL。图片未保存前只留在编辑草稿；临时 Blob URL 在处理完成后释放。这里选择有界内嵌图片，避免新增一套资源存储和孤儿文件清理流程。
- 「保存并应用」在一次带配置版本校验的原子写入中保存记录和当前主题。失败保留草稿；取消不写入。编辑页发现同一主题已被其他窗口修改时拒绝覆盖，需重新打开读取最新版本。删除当前自定义主题会在同次写入中切回 `sunset`。
- `custom-theme-definition.ts` 将安全记录转换为配色、插画和通用动效参数。同 ID 的内容改变也会更新样式和重建动效。静态模式、隐藏预览、减少动态效果沿用公共生命周期。
- 主题选择器为固定高度的 flex 布局。只有 `.qyt-theme-choices` 卡片区域使用 `overflow-y:auto`，标题与「＋ 新建主题」是它的同级元素，所以滚动卡片不会带走新增按钮。
- 编辑弹窗使用原生模态 dialog，编辑内容独立滚动，页头和保存按钮固定在弹窗内；窄窗口下也可以保存、取消或删除。

验证：

```sh
npm run typecheck
node --test tests/custom-themes.test.mjs tests/q-theme.test.mjs tests/landscape-scene.test.mjs tests/begonia-scene.test.mjs tests/settings-features.test.mjs
node scripts/test-custom-themes.mjs
npm run test:ocean:settings
node scripts/test-q-themes.mjs
```

浏览器测试验证上传、草稿隔离、浅深色预览、保存拒绝与重试、重载持久化、静态模式、取消、删除、窄窗口布局，以及列表实际滚动时新增按钮的位置保持不变。截图输出到 `artifacts/custom-themes/`。
