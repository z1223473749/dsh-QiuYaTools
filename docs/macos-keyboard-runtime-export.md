# Mac 键盘准备入口的 oracleRPC 导出

`test-macos-live-vision-keyboard.mjs` 使用真实 esbuild 入口，合并 `NativeCompanionDriver`、`oracleRPC` 和精确进程身份辅助函数。普通键盘复现和 sibling/quit 边界复现随后从这份 runtime 读取同一组导出。

`live-vision-external-carrier.mjs` 原来只在模块内部声明 `oracleRPC`，导致准备阶段构建 runtime 时出现 `No matching export ... oracleRPC`，尚未进入原生输入。修复只在原函数声明前加 `export`；原函数体、spawn 时机、请求序号、5 秒超时、进程与自然清退行为均保持原样。导入函数不会调用它，也不会启动 oracle 或 native helper。

```bash
node --test tests/macos-keyboard-runtime-export.test.mjs \
  tests/macos-live-vision-keyboard-repro.test.mjs \
  tests/macos-keyboard-boundary.test.mjs
```

新回归从真实准备文件读取静态 build 参数，实际执行 esbuild。移除这一行的 `export` 时必须得到缺失导出的构建错误；当前源必须完整构建并真实导入五个 runtime 导出。导入期间拦截 Node 的进程启动与端口监听 API，确认操作数为零；两份真实键盘入口也只作模块导入，不调用 prepare/run、原生函数、模型或 GUI。

这些检查只证明准备入口的 JavaScript 闭包可以构建和安全导入，不代替 Swift 编译、权限、真实键盘、窗口焦点或视觉验收。生产 Host/agent/client 的三入口另以 `write:false` 构建核对；本修复不应改变它们的产物字节。
