# 可重复准备 Windows 自动化测试运行时

这些资产只用于隔离测试，不是插件的运行依赖，也不从用户已安装的 Harness 中复制个人配置或凭据。Windows 原生程序仍由平台构建脚本生成。测试运行时使用公开 npm 包，依赖版本与完整性锁位于 `tests/fixtures/windows-test-runtime/`。

固定的主要版本为 `@deepseek-ai/dsh 0.2.1-rc.2`、`pnpm 10.34.5`、`playwright 1.61.1`、`esbuild 0.25.12`；其余开发测试依赖同样锁定为确切版本。`package-lock.json` 固定全部传递依赖及 npm integrity。脚本拒绝本机路径、符号链接或无完整性信息的外部 lock 条目。

## 从干净源码准备

在源码根目录执行。首先为当前开发主机安装本仓库依赖；Windows 测试运行时安装在独立临时工作目录，不会替换主机 `node_modules`。

```sh
npm ci
node scripts/prepare-windows-test-runtime.mjs --plan
```

准备官方 **Node.js v22.23.3 win-arm64.zip** 本地文件。准备脚本不会下载 Node 或浏览器；可从 [Node 官方归档](https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-arm64.zip) 获取，并用同目录 [SHASUMS256.txt](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt) 复核。当前锁定 SHA256 为：

```text
33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535
```

然后执行：

```sh
node scripts/prepare-windows-test-runtime.mjs \
  --node-zip /absolute/path/node-v22.23.3-win-arm64.zip \
  --output artifacts/windows-test-runtime
```

脚本会按单独的 lock 执行 `npm ci --ignore-scripts --include=optional --os=win32 --cpu=arm64`，从公开 npm 注册表安装 Windows ARM64 可选二进制；不会执行包安装脚本或下载 Playwright 浏览器。它复制固定清单内的测试 runner 与源码，生成具有真实 CRLF 的 `pnpm.cmd`，打包并记录 SHA。需要可用的 Node/npm 和系统 `tar`；自定义 Node 分发找不到 npm CLI 时，可用 `--npm-cli /absolute/path/npm-cli.js` 明确指定，脚本不通过 shell 拼接执行 npm。

默认输出为：

- `artifacts/windows-test-runtime/qiuya-harness-windows-portable-arm64.tgz`
- `artifacts/windows-test-runtime/node-v22.23.3-win-arm64.zip`
- `artifacts/windows-test-runtime/manifest.json`

manifest 记录依赖 lock、Node、归档及有限源码清单的 hash。状态 `prepared-not-run` 只表示准备完成；必须在 Windows 的登录交互桌面运行后才能报告对应 E2E 通过。归档 gzip 时间戳或文件属性可能因构建时间不同产生不同文件 SHA，不能因此声称字节可重复；锁定依赖与 manifest 用于追溯和验证该次资产。

## 独立准备 x64 运行时

ARM64 归档不能直接替换 Node 后用作 x64 Host：其中的 esbuild、sharp、koffi 等 npm 原生依赖按 ARM64 安装，插件也按 Host 的 `process.arch` 选择 helper。x64 必须使用独立 Node、独立 npm 安装目录和独立 manifest；两个架构复用同一完整性 lock，不混用归档。

先准备 [Node.js v22.23.3 win-x64.zip](https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip)。对应官方 SHA256 为 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`，来源同一份 [SHASUMS256.txt](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)。

```sh
node scripts/prepare-windows-test-runtime.mjs --arch x64 --plan
node scripts/prepare-windows-test-runtime.mjs --arch x64 \
  --node-zip /absolute/path/node-v22.23.3-win-x64.zip \
  --output artifacts/windows-test-runtime-x64
```

此分支使用 `npm ci --ignore-scripts --include=optional --os=win32 --cpu=x64`，默认输出 `artifacts/windows-test-runtime-x64/`，归档名为 `qiuya-harness-windows-portable-x64.tgz`。ARM64 默认路径和现有文件保持独立。

测试 x64 包时，额外设置：

```sh
export QIUYA_WINDOWS_ARCH=x64
export QIUYA_WINDOWS_RUNTIME_MANIFEST="$PWD/artifacts/windows-test-runtime-x64/manifest.json"
export QIUYA_WINDOWS_CANDIDATE="$PWD/artifacts/dsh-qiuya-tools-win32-x64.tgz"
unset QIUYA_WINDOWS_HARNESS_ROOT
node scripts/e2e-windows-harness-pd.mjs
```

wrapper 按选定架构提取精确候选的 helper、选取 Node 路径，并在来宾执行前核验实际 `process.arch`。跨架构 manifest 和不匹配的官方 Node ZIP 均会拒绝；重新使用来宾目录仍要求运行时归档与 Node 的完整 SHA 一致。ARM Windows 上的 x64 Node/Host 验收属于 x64 转译环境，不等于 Intel/AMD x64 硬件验收；最终报告必须保留这一边界。

## 运行 PD Windows Harness

在已授权的 Mac 上设置确切 VM UUID 与 host-only 地址。它们必须由本次实际枚举确认，不根据 VM 名字推断。来宾需要已登录的交互桌面与安装好的 Edge/WebView2；不要将 Session 0 启动成功算作 GUI 验收。

```sh
export QIUYA_PD_VM='<selected-vm-uuid>'
export QIUYA_PD_HOST_IP='<mac-host-only-ip>'
export QIUYA_WINDOWS_RUNTIME_MANIFEST="$PWD/artifacts/windows-test-runtime/manifest.json"
export QIUYA_WINDOWS_CANDIDATE="$PWD/artifacts/candidates/dsh-qiuya-tools-win32-arm64.tgz"
node scripts/e2e-windows-harness-pd.mjs
```

wrapper 默认读取准备脚本的 manifest，并校验归档 SHA、固定 Node SHA 与本仓库 lock。`environment.json` 记录实际输入 hash 及 `runtimePreparation`，以便关联候选包、helper 与 runtime。

有限清单内的测试源码会从当前 checkout 重新传输，并以该次 `testSourceHashes` 记录实际内容；manifest 的 `sources` 记录最初打包时的快照。新增的 Win32 状态 fixture 同时加入准备与传输清单，无需把旧归档误记为包含后来的源码。

需要定位真实 Host 的预览层级时，可设置 `QIUYA_WINDOWS_PREVIEW_WINDOW_DIAGNOSTIC=1`。它保留前八项 UI 前提和主 Agent 图像/Move 链。点击“悬浮实时预览”前先编译并启动只读 Win32 监视器，绑定该隔离配置唯一的 `--computer` 子进程 PID、启动时间、实际路径与 hash；同登录会话内以 10ms 请求间隔枚举包含隐藏窗口的 HWND，连续八秒记录窗口首次出现、style、owner、visible 与 foreground 的变化及实际采样间隔。之后在预览第一次 UIA 观察前、UIA 后、native observe 截图后分别记录窗口状态，然后停止预览按钮及后续验收。监视器不安装全局钩子，也不调用 UIA、窗口修改或输入 API。成功取证的 `report.status` 为 `diagnostic`，不能作为 UI12 通过；该模式拒绝同时运行安装生命周期。10ms 是请求间隔，Windows 调度可能加长实际间隔，日志记录最大采样间隙，不能据此声称捕获了间隙内的每次变化。

保留的旧测试归档也可通过显式路径运行：

```sh
export QIUYA_WINDOWS_PORTABLE_TGZ='/absolute/path/existing-portable.tgz'
export QIUYA_WINDOWS_NODE_ZIP='/absolute/path/node-v22.23.3-win-arm64.zip'
unset QIUYA_WINDOWS_RUNTIME_MANIFEST
node scripts/e2e-windows-harness-pd.mjs
```

此模式仍检查 Node 官方 hash 并记录归档 hash，但标为 `explicit-external-artifacts-no-lock-manifest`，不把已有临时资产追溯成新 lock 的构建结果。不要将只在某台电脑 `/tmp` 下存在的文件作为默认测试前提。

## 更新依赖与当前验证范围

需要更新 runtime 时，先显式修改 fixture 的确切版本，再在该目录解析并审查新 lock；禁止从当前用户的 npm 配置或本机绝对路径生成 lock。示例：

```sh
cd tests/fixtures/windows-test-runtime
npm install --package-lock-only --ignore-scripts --os=win32 --cpu=arm64 \
  --registry=https://registry.npmjs.org --userconfig=/dev/null --no-audit --no-fund
```

`/dev/null` 示例适用于 Mac/Linux；Windows 可指定一个只写有公开 registry 的临时 `.npmrc`。准备脚本会自行创建该隔离文件。更新后重新运行 `--plan`、生成资产、校验 manifest，并完成实际 Windows runner。

本次已实际完成独立 lock 的完整 `npm ci --ignore-scripts`（668 个包）、归档打包与官方 Node ZIP 校验，生成记录见 `artifacts/windows-test-runtime/manifest.json`；不是只执行 dry-run。该次 lock SHA256 为 `dd08239ab518fa1bd0254774b8209853122bffe0c87c1734deab145a82e70dea`，最新准备归档 SHA256 为 `d73549cd1bd3421674e648c407ed7f4517c9ca2cf4ddbf467ea23a6d123e329a`。这次准备包含明确激活自有目标的 fixture；准备完成不等于其最终 E2E 已执行。

首个 lock 资产（归档 SHA256 `8200ae0ad4769178d68d45687a7e4c31cd5a444d6a9693fa0b5ffb9d1713a342`）已解包到全新的 Windows 来宾 UUID 目录并实际启动 Harness/Edge。该轮为 9/10：主 Agent 观察成功且图片进入 adapter，移动动作被原生层以 `foreground-denied` 拒绝，要求先激活目标窗口；该轮没有运行到悬浮窗手动输入分支。正在为这一前台条件补充明确的测试操作并重跑，不能把此前旧外部 runtime 的 10/10 算成新 lock 的通过。最终结果和候选包绑定见 [测试报告](computer-use-test-report.md)。

另外已验证 `--plan`、错误 Node 文件拒绝、不匹配 manifest 拒绝及显式旧归档来源标记。新运行时不会从用户日常 Harness profile 复制配置、账户或凭据。
