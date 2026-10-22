# Mac 当前包文件交换补充验收

2026-10-22，当前Mac包的真实文件交换用例及3项必要前置共4/4通过；8 MiB上传文件、浏览器下载文件、同名上传被拒绝后的原文件，三次实际读取均为8388608字节，SHA256均为 `a282bc85b1e332d2183949d82587a689142d58ed8032296a66a4db8454ea27cc`。相关纯测6/6通过，3张新增状态截图已逐张打开视检。

本轮使用正式Mac universal包，SHA为 `9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3`，与当前DOM和安装验收包相同。没有重编native、修改live E2E/已提交DOM8或改动用户安装。

## 实际链路与边界

实际链路为：从该已核SHA的包中只读提取 `package/lib/computer-agent.js`，启动其中真实的认证HTTP/FS交换实现；在全新临时Harness profile中启动真实官方Host与已安装插件，通过headless Chrome中的真实React文件input、SDK owner路由上传，直接读取专用目录实际文件，再经浏览器下载读取真实落盘文件。文件名含中文及本轮随机标识；随后用同名但首字节不同的内容再次上传，验证被拒绝且原文件完整未变。关闭文件server后receipt为 `serverClosed:true`。

文件server的设备driver仅为 **status/targets-only stub**，没有桌面截图、输入或租约能力。实际调用为status7次，targets0次，observe/lease/release/act/preview均0次。这证明打包的文件服务、Host路由和浏览器功能，不能当作Mac桌面remote、原生输入或外部模型推理的证明。会话前置使用隔离的确定性provider，不使用个人账户或真实模型。

runner的 `nativeCommand` 仅接受精确的 `tar -xOf <当前9b828包绝对路径> package/lib/computer-agent.js`，实际执行固定 `/usr/bin/tar`，读前/读后再次核对包SHA和canonical路径；其他命令、包路径、tar选项和member一律拒绝。实测只放行1次、拒绝0次，未启动runner原生driver或编译原生fixture，未运行PD或发送桌面输入。

## 四项实际结果

| 用例 | 结果 |
| --- | --- |
| 实际十页设置 | 通过，当前插件页面真实渲染 |
| 阈值与主题保存 | 通过，保持原公开UI断言 |
| 真实隔离Alpha会话 | 通过，本地provider完成回复 |
| 实际包文件交换 | 通过，8 MiB上传/下载/同名拒绝及未覆盖，耗时8902ms |

文件结果不只保存预先计算的摘要：`uploadedActualSHA256`、`downloadedActualSHA256`、`afterDuplicateActualSHA256`分别从三次实际文件读取计算；三次长度和摘要均相同，原有完整字节deep-equality断言同时保留。`uploadedBytesVerified`、`browserDownloadVerified`、`duplicateRejectedWithoutOverwrite`均为true。

Host PID39526在正常SIGTERM关闭后实际exit0、signal=null，浏览器公开close成功、finally errors=[]、前端错误=[]；冻结副本删除了旧SIGKILL兜底，超过正常关闭等待预算会失败。runner最终exit0，无signal；原runner已等待清理自有临时目录后结束。本轮没有独立全局OS进程扫描，不把Host退出收据扩大解释为所有系统资产的自然退役证明。

## 视觉验收与截图

三张图均为实际页面元素截图，只包含手动文件交换卡片；不包含配对密钥、个人桌面或业务内容。标题、8 MiB限制说明、中文文件名、8388608字节、下载按钮与结果提示完整可读，无裁切或重叠。

| 图片 | 实际可见状态 |
| --- | --- |
| `file-exchange-uploaded.png` | 文件已列出，提示“文件已上传至远端专用交换目录。” |
| `file-exchange-downloaded.png` | 同一文件仍列出，提示“文件已交给本机浏览器下载。” |
| `file-exchange-ui.png` | 同一文件仍列出，提示“专用目录中已存在同名文件，请改名后上传。”；文件实际字节及SHA复读不变。 |

项目外截图目录：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Mac-文件交换-8MiB-2aa699f7-c066-4fff-9d15-f11a08dcaf9d/`

原始报告目录：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Mac-文件交换-8MiB-2aa699f7-c066-4fff-9d15-f11a08dcaf9d/`

其中 `report.json`记录4项、Host退出与图片摘要；`file-exchange-ui-evidence.json`记录实际三次SHA、完整文件业务和stub调用计数；`carrier-verdict.json`记录sourceStable、runner退出及明确scope。原始报告/图片未覆盖或修改，截图字节与报告SHA逐一核对一致。

## 可复验入口与验证

准备器为 `scripts/prepare-macos-file-exchange-acceptance.mjs`，纯测为 `tests/macos-file-exchange-acceptance.test.mjs`。本轮冻结载体为 `artifacts/harness-e2e/macos-file-exchange-prepared-2aa699f7-c066-4fff-9d15-f11a08dcaf9d/`。准备阶段只核定当前包、复制依赖、bundle检查及本地plan，不启动Host、浏览器或PD；实际执行必须显式带 `--run --root-approved` 并使用fresh目录。

6项纯测包括精确命令/member白名单与实际只读提取、上传/下载/拒绝覆盖三份真实字节投影的完整判据、native调用和非正常退出不能通过、原业务断言/截图时机，以及fresh snapshot/plan。原始日志为载体 `related-tests.log`。最后机器汇总 `final-file-exchange-acceptance.json`再次核对live源、冻结源、policy、entry和正式包SHA，记录3张实际视检结果及明确的stub边界。JS syntax和scoped diff检查通过。
