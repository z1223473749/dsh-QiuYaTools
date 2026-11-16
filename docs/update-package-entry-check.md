# 更新包入口校验

更新包必须包含非空的 `lib/index.js` 和 `lib/client.js`。官方 Harness 已提供相同的电脑操控功能，因此当前包已移除电脑执行器和相应入口。

小包用 `qiuyaNative.sessionWindows=true` 和协议版本 1 声明会话独立窗口支持，三个可选原生依赖固定到 `qiuyaNative.version`。小包不内嵌原生程序；完整平台包必须携带正确架构的会话窗口程序与包含版本、大小、SHA256 的清单。

归档预检保留压缩及解压大小上限、路径和普通文件检查、架构检查与完整性检查。测试见 `tests/updates-archive.test.mjs`、`tests/updates-windows.test.mjs` 和 `tests/native-packaging.test.mjs`。
