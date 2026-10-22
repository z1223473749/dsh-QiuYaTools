# Mac 当前包官方安装生命周期验收

记录日期：2026-10-22。此记录只证明官方 Harness CLI 在全新临时 `DSH_HOME` 中管理插件、启动真实 Host、保留配置及正常关闭；不替代桌面视觉、电脑输入、真实模型或下载更新界面的验收。测试未操作用户的现有安装配置。

本轮使用当前 Mac universal 包 `dsh-qiuya-tools-darwin-universal.tgz`，SHA256为 `9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3`，computer helper为 `66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502`。对照旧版0.5.2包SHA为 `c30441ec6cf75ec12963ad3e1b46911fbebe10d10259773ed93576b86c0fc0a7`。实际系统为当前Apple Silicon Mac；这不是在Intel硬件上的复验。

| 官方管理流程 | 实际结果 |
| --- | --- |
| 旧版干净安装并启动真实Host | 通过，版本0.5.2 |
| 升级候选包并重新启动 | 通过，版本0.6.0-beta.1，设置保持 |
| 安装损坏tar包失败后再次启动当前版本 | 通过，坏包未破坏当前0.6.0-beta.1及设置 |
| 明确回滚旧版并重新启动 | 通过，恢复0.5.2，设置保持 |
| 回滚后再次安装候选包 | 通过，恢复0.6.0-beta.1，设置及包字节保持 |

配置对照为字符阈值4321、行数23、Q主题启用；以实际profile patch完整字节相等验收。每次启动均通过真实Host返回的owner303引导取得隔离cookie，再验证主页面HTTP200及HTML；没有使用个人账户、真实模型、浏览器GUI或桌面输入。

源 `scripts/test-harness-install.mjs` 保持不变。本轮仅在冻结副本中将Host停止步骤改为：给确切的自有 `ChildProcess` 一次正常SIGTERM，再用最多5秒只读等待观测真实exit，不升级到SIGKILL，不按进程名清理。若Host不正常退出，该项失败且保留仍占用的临时profile；finally不能把退出失败改写为成功。

实际五次Host的PID分别为32368、32380、32406、32438、32452，均记录stdin已结束、正常SIGTERM被接受、`exitCode:0`、`exitSignal:null`、`timedOut:false`、`forced:false`。这里的关闭是**请求正常SIGTERM生命周期后成功退出**，不是未经请求自行退出；与Windows旧轮显式终止的证据口径分开。最终临时profile已移除，carrier退出码0、无signal，源文件、官方CLI、候选包和旧包的绑定hash前后保持。

准备器及测试为 `scripts/prepare-macos-install-acceptance.mjs`、`tests/macos-install-acceptance.test.mjs`。6项相关测试全部通过，包括真实自有Node进程的正常SIGTERM退出、挂起时不重复/升级信号、异常退出不能冒充正常退出、五项报告完整性及无实际Host启动的准备/plan。未重编native或修改生产插件，使用已经构建并核定的当前包。

原始证据目录：

`artifacts/harness-e2e/macos-install-prepared-3cdd76a2-f37f-4dd5-9b97-8496bb60b519/`

- `prepare-data.json`：候选/旧包/CLI/源/快照全部hash绑定。
- `actual/report.json`：实际五项结果、配置保留和关闭收据。
- `actual/owned-host-exits.json`：五个确切Host的退出方式和exit结果。
- `actual/carrier-verdict.json`：全轮通过、源稳定、临时profile清理及scope。
- `actual/carrier-stdout.log`、`actual/carrier-stderr.log`：本轮有限执行日志。

该流程使用官方CLI的 `plugin ... add`、web profile和 `--no-open`，所有安装均指向 `mkdtemp` 后的专用 `DSH_HOME`；不执行用户profile升级、桌面应用重启、公开发布或远端推送。没有截图产出，也不将该安装测试算作视觉验收。
