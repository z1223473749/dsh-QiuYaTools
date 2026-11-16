# Windows 会话独立窗口

官方 Harness 已提供相同的电脑操控功能，插件已移除桌面捕获、鼠标键盘控制、预览与远端执行代码。

当前程序仅接收 `open`、`prepare`、`cancel` 会话窗口操作，通过 WinForms 与 WebView2 显示当前 Harness Host 的聊天页面。认证地址经 stdin 传入，用户数据按 Host profile 和会话存储标识隔离，关闭时等待所属浏览器进程退出。

构建固定使用 .NET SDK 8.0.426 和锁定的 WebView2 SDK。运行包自包含 .NET；用户仍需安装 Microsoft Edge WebView2 Runtime。

```sh
node scripts/build-windows-native.mjs arm64 x64
```
