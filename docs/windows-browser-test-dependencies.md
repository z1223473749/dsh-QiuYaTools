# Windows 浏览器验收与 Chrome 测试依赖

本文件只记录测试准备，不属于插件安装流程。浏览器依赖仅安装在已授权的 PD 测试虚拟机 `ffba3614-b0e4-4b38-b185-b9a4b7ba5aec`。初始准备阶段未下载 MSI、安装软件或执行 PD 命令；其后的授权下载与实测状态记录在下文，不能把下载完成当成安装成功。

## 独立执行 Chrome 与 Edge

```sh
node scripts/prepare-windows-browser-acceptance.mjs --browser edge
# 使用命令返回的全新 entry：
node artifacts/computer-use/windows-browser-prepared-edge-<UUID>/entry.mjs --plan --browser edge
node artifacts/computer-use/windows-browser-prepared-edge-<UUID>/entry.mjs --run --root-approved --browser edge
```

`--browser chrome` 和 `--browser all` 同样支持。每个入口固定所选浏览器、源文件散列和输出目录，不能运行时切换。实际执行需由主任务持有 PD 槽。截图和报告只写入项目外目录；准备文件只包含源码与散列。

每个已选浏览器有自己的 `launch-report.json`，其业务 `summary.json` 与进程树 `natural-closure.json` 分开保留。缺少 Chrome 记录 `not-run` 和确切原因；`all` 仍继续执行 Edge，但整体验收失败。只选择 Edge 时，Edge 的十项通过仅证明 Edge。不会自动安装或替换用户浏览器。对完整源码及快照进行 SHA-256 校验，准备时用 esbuild 解析 guest、smoke 与 module 的完整字面导入闭包。缺失依赖、进程身份不完整、强制退出、未自然收尾或测试不足十项都不能通过。

浏览器使用本次专属临时 profile、回环 CDP、本地虚构网站。十项覆盖真实截图与 AX、Unicode 输入、Cookie 登录、选择器点击、截图坐标映射、实际网页滚动与租约屏障、站点撤销、只附着 CDP 的隔离、专属 profile 登录恢复，以及注册 Agent 工具的导航/新建与关闭页签。它不证明 OS 桌面输入或真实模型推理，报告保留相应 `false` 字段。

## 官方下载证据

2026-10-22 核查：Google 的 [安装说明](https://support.google.com/chrome/answer/95346?hl=en) 要求 Windows ARM 使用 Windows 11 及以上；x86 系列为 Windows 10 及以上。Google 已发布 [Windows ARM 原生版](https://blog.google/products-and-platforms/products/chrome/download-google-chrome-windows-pc-arm/)。[Chrome Enterprise 下载页](https://chromeenterprise.google/download/) 的官方组件源码 [1882.min.js](https://chromeenterprise.google/static/js/1882.min.js) 明确映射下列 Stable MSI，并以 `https://dl.google.com` 为下载源：

| 系统架构 | 官方 MSI | 本轮只读 HEAD |
| --- | --- | --- |
| ARM64 | [GoogleChromeStandaloneEnterprise_Arm64.msi](https://dl.google.com/dl/chrome/install/GoogleChromeStandaloneEnterprise_Arm64.msi) | HTTP 200；174,944,256 字节 |
| AMD64 / x64 | [googlechromestandaloneenterprise64.msi](https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi) | HTTP 200；170,979,328 字节 |

上述大小是本轮响应值，不作为未来版本的固定校验值。源码映射和 HEAD 证明链接来源与当时可用，不证明下载文件签名或安装成功。后两项须在 Windows 实际完成并保存回执。

Google 支持 [MSI 静默安装](https://support.google.com/chrome/a/answer/7650247?hl=en)，同时提醒系统级 MSI 可能覆盖既有用户级安装。因此，本轮只补测试 VM 中已经确认为缺失的 Chrome；若再次发现已有安装，先使用原安装做验收，不执行覆盖。默认浏览器设置是 [独立的配置步骤](https://support.google.com/chrome/a/answer/7009292?hl=en)，本测试不执行该步骤，不写入默认关联，不修改 UserChoice。

## 交给主任务的安装命令

以下为可审查的后续 Windows 命令，尚未执行。通过指定 PD UUID 执行，不能直接在宿主机或其它 VM 运行。`$InteractiveSid` 须来自同一 VM 的已核对交互用户绑定，不能用 SYSTEM 的 HKCU 代替实际用户。文件放入新建的专属临时目录；安装前再次确认 Chrome 缺失。MSI 系统级安装需要该 VM 的安装权限。

```powershell
$ErrorActionPreference = 'Stop'
$arch = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
$url = switch ($arch) {
  'ARM64' { 'https://dl.google.com/dl/chrome/install/GoogleChromeStandaloneEnterprise_Arm64.msi' }
  'AMD64' { 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' }
  default { throw '本轮只验收 Windows ARM64 或 x64' }
}
$own = Join-Path $env:TEMP ('QiuYaTools-chrome-dependency-' + [guid]::NewGuid())
if (Test-Path -LiteralPath $own) { throw '专属目录必须全新' }
[void][IO.Directory]::CreateDirectory($own)
$msi = Join-Path $own 'GoogleChrome.msi'
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $msi
$sig = Get-AuthenticodeSignature -LiteralPath $msi
$publisher = $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if ($sig.Status -ne 'Valid' -or $publisher -cne 'Google LLC') { throw 'Google MSI 信任链或发布者校验失败' }
$shaBefore = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash
@{ url=$url; architecture=$arch; sha256=$shaBefore; signatureStatus=$sig.Status.ToString(); publisher=$publisher; certificateThumbprint=$sig.SignerCertificate.Thumbprint } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $own 'download-verification.json') -Encoding UTF8
```

下载命令运行后、安装前必须对**实际交互用户**的 `http`、`https`、`.htm`、`.html` UserChoice 做只读快照，安装后再次读取并比较 `ProgId` 与存在状态；访问失败应抛错，不能冒充不存在。示例读取路径为：

```powershell
# $InteractiveSid 来自已核对的 VM 交互用户绑定。
$httpChoice = 'Registry::HKEY_USERS\' + $InteractiveSid + '\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
$httpsChoice = 'Registry::HKEY_USERS\' + $InteractiveSid + '\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
$htmChoice = 'Registry::HKEY_USERS\' + $InteractiveSid + '\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.htm\UserChoice'
$htmlChoice = 'Registry::HKEY_USERS\' + $InteractiveSid + '\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.html\UserChoice'
# 对四条路径分别保存安装前后状态；不能写入这些键。
```

安装命令如下；只有签名通过、前述状态已保存且 SHA 再次一致才执行。`/qn` 无交互、`/norestart` 阻止自行重启；MSI 返回 3010 需要重启时记录待处理，不擅自重启 VM。参数含义见 [Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/win32/msi/standard-installer-command-line-options)。

```powershell
if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -cne $shaBefore) { throw '安装前 MSI 已变化' }
if ((Get-AuthenticodeSignature -LiteralPath $msi).Status -ne 'Valid') { throw '安装前签名失效' }
$install = Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart', '/L*v', ('"' + (Join-Path $own 'install.log') + '"')) -PassThru -Wait
if ($install.ExitCode -ne 0) { throw ('MSI 尚未成功完成；退出码 ' + $install.ExitCode) }
# 继续：比较四项默认关联；核对实际 chrome.exe 的 Valid 签名 / Google LLC、版本、SHA-256、PE 架构；然后生成 fresh --browser chrome 验收入口。
```

签名检查使用 Windows 的 [Get-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.5)，不接受仅文件名、产品名或网站可访问作为来源验证。实际 exe 需读取 PE Machine：ARM64 为 `0xAA64`，x64 为 `0x8664`。下载 SHA、MSI 签名、安装退出码、已装 exe 身份与默认关联前后对比都写入项目外的测试依赖证据目录。

测试启动参数在现有 `BrowserSession.launch()` 中包含 `--no-first-run` 和 `--no-default-browser-check`，并使用独立 `--user-data-dir`。不通过添加系统 policy、写默认关联、导入真实浏览数据或卸载已有浏览器来规避测试依赖。

## 本轮实际证据与当前边界

- Edge：主任务已在 PD Windows ARM64 实际执行 `9fe015ce-9509-4e7e-91b0-7f93a8470f88`，十项全部通过。载体在原 VM paused / idle on 状态下先正常 resume，再运行测试；两次自有浏览器父进程自然退出，22 个已绑定进程身份均无残留，任务自然 Ready / 结果 0 后注销，无 Stop 或进程信号，原 idle on 已恢复。证据在项目外 `/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-browser-edge-9fe015ce-9509-4e7e-91b0-7f93a8470f88`。
- Chrome：Google 官方 ARM64 MSI 已下载到 `/private/tmp/qiuya-chrome-official-arm64-e6451d3d-c800-4af2-9700-ed60e94625c9/GoogleChromeStandaloneEnterprise_Arm64.msi`。HTTP 200、TLS 已验证、无重定向、174,944,256 字节，SHA-256 `e906538e01f465666c0e7f14bb9b754b8d2f23f8c386b8ddcde4b934e8c892a6`。同目录保存下载回执与响应头。其后实际 Windows 签名已核验为 Valid / Google LLC，并发生安装；原载体身份断言失败，后续只读核验与该失败的边界见下文。Chrome 十项业务尚待实际执行。
- 安装准备器：`node scripts/prepare-windows-chrome-dependency.mjs --download-receipt /private/tmp/qiuya-chrome-official-arm64-e6451d3d-c800-4af2-9700-ed60e94625c9/download-receipt.json`。准备阶段不调用 PD。返回的 entry 支持 `--plan`；只有主任务分配 PD 槽后执行 `--run --root-approved`。
- 安装载体先检查指定交互用户 SID、已知安装路径、机器和交互用户的 App Paths/卸载注册项；存在既有 Chrome 或 Application 目录就拒绝覆盖。MSI 散列与 Google LLC 有效签名通过后才静默安装，安装进程保留原始身份并自然退出。完成后检查已装 exe 的有效签名、SHA、版本和 `PE Machine=0xAA64`，比较四项真实用户默认关联。Google 服务/计划任务的前后状态只读保存，不杀进程、不停止任务、不清理其它 Google 项。
- 安装成功后仍需 fresh Chrome 业务入口：`node scripts/prepare-windows-browser-acceptance.mjs --browser chrome`，或者 `--browser all` 重跑两种浏览器。入口不增加额外的二十分钟有效期限制，只检查实际冻结依赖是否变化。

### 本轮 Chrome 安装后的只读核验

实际 `d4bc394d-5ad0-4962-97c7-88ecb4b152ef` 在 Valid Google LLC / MSI SHA 校验、Chrome 路径及注册项均不存在之后启动了 MSI，随后触发 `Owned MSI process path/session mismatch`。原脚本在身份断言之后才赋值 `report.installer`，导致原子进程 PID / birth / path / session 没有保存，且当时没有等待该进程自然收尾。**原安装载体验收保留失败，不改写为通过。**

主任务随后仅授权本次 OwnRoot 的只读后验，没有再次安装、卸载、停止或终止任何进程。核验时唯一 OwnRoot MSI 命令行匹配进程为 0；原 MSI 自有日志记录 `Installation completed successfully`，client / server 的 `MainEngineThread` 都返回 0。新安装的 `C:\Program Files\Google\Chrome\Application\chrome.exe` 实际为 Valid / Google LLC，版本 `156.0.8078.48`，大小 3,258,008 字节，PE Machine `43620 = 0xAA64`，SHA-256 `fefbd72ebb19730cd67c5dd35cb552e8f2b267eae77ae7b90d8e166866fbe673`；x86 路径没有 Chrome。真实交互用户的四项 UserChoice ProgId / Hash 与安装前完全相同，仍为 Edge。

只读后验的宿主记录为 ARM64、8 字节指针、System32 PowerShell、session 0，没有证据可以认定原失败由 WOW 重定向导致。已经结束且未记录身份的原 MSI 进程不能靠后验重建精确 birth 证明；日志成功和当前无匹配进程也不冒充该证明。可直接用已验证的新 Chrome 继续浏览器业务验收，不允许为补测试证据重新覆盖安装。

项目外有限报告：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-Chrome-依赖安装-d4bc394d-5ad0-4962-97c7-88ecb4b152ef/read-only-postflight-2/report-finite.json`

该核验只正常 resume 当时 paused 的测试 VM，临时 idle off，最后恢复原 idle on；没有来宾写入、安装、进程信号或任务停止。初次只读尝试遇到来宾 CP936 输出解码问题，修正宿主解码后第二次完成。原安装载体故障即时采样的 Google 服务/任务前后均为空；不将该早期采样冒充更晚时间点的更新器终态。

为避免再次丢失诊断，准备器中的测试安装脚本现先保存原始子进程身份与预期路径/会话的独立启动回执，再分别执行原有路径和会话判据；无论断言是否失败，finally 都在同一原始 Process / SafeHandle 上等待原有四分钟总期限内的自然退出。没有放宽身份门槛，不按 PID 重开进程，不再次安装，也不强杀。该修正已完成有限纯测，但因测试 VM 已装 Chrome，本轮没有重新执行 MSI 来伪造一次全绿安装。

### 最终独立浏览器实际验收

Chrome 的 fresh `43941111-77ca-4c9b-a7fd-1c8903547d72` 已在已核验的新 Chrome 上实际完成 **10/10**；Edge 的 `9fe015ce-9509-4e7e-91b0-7f93a8470f88` 同样 **10/10**。两者分别生成并运行独立冻结 bundle，当前浏览器业务 module SHA 均为 `0c8ccf479af1c781d7e01760c5d131b6fe12571ff8264b9d2363db1b25276306`，smoke/guest 及实际调用的源闭包散列绑定在各自 prepare-data.json。

| 实际浏览器 | Chrome | Edge |
| --- | --- | --- |
| 版本 | 156.0.8078.48 | 155.0.4283.62 |
| 十项真实 CDP / 注册工具 / 站点状态 | 10/10 | 10/10 |
| 自有浏览器父进程自然退出 | 2/2，exit0、无signal、无kill | 同样通过 |
| 退出时精确绑定的已观察进程树身份 | 20，remaining=[] | 22，remaining=[] |
| 外层任务身份、结果、注销 | 精确匹配、Ready、result0、自然注销 | 同样通过 |
| Stop、进程signal、残留、清理错误 | 均无 | 均无 |
| 原 pause-idle 恢复 | on | on |
| 整体 delivery | passed | passed |

两套真实截图来自本次专属 profile 内的本地虚构页面：实际 JPEG、页面状态、Unicode、Cookie、坐标映射、独立网页滚动、站点撤销、CDP 只附着连接、专属登录恢复及真实注册工具均有对应 smoke 检查。该浏览器通道使用 headless CDP，不声称 OS 桌面输入或真实视觉模型推理。

Chrome 完整报告：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-browser-chrome-43941111-77ca-4c9b-a7fd-1c8903547d72`

Edge 完整报告：

`/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-browser-edge-9fe015ce-9509-4e7e-91b0-7f93a8470f88`

各目录保留 `delivery-verdict.json`、`report.json`、对应浏览器的 `summary.json` / `natural-closure.json` / `owned-process-pins.json` 与 before/after 原图。原 MSI d4bc 的失败和只读后验依旧单独保留；浏览器成功不把失败的安装载体改成通过，也不声称修正后的 MSI 脚本已重新执行安装。

本单元相关纯测试 **13/13**（浏览器7、Chrome依赖6），无跳过，独立 bundle 与完整模块闭包已在两轮实测前重新构建、校验；它不涉及生产 JS/Native 改动或额外 native 编译。
