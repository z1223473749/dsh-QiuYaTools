# Mac 完整 12 项验收的可重复准备

完整 Mac 验收采用源码与明确候选包准备新的 UUID 入口。准备器从包内 macOS manifest 校验 Computer 与 Sessions 两份组件，绑定实际生产三份 JS、构建输入、官方 Harness/Chrome 和测试依赖；不再使用固定历史包 SHA、项目外历史 Swift 二进制或某次 `/private/tmp` 运行目录。

准备与实际验收是两个阶段。准备会在新的项目外目录编译自有、只监听的 Swift 测试观察器，并运行无启动行为的 `--plan`。它不执行编译产物，不启动 Host、浏览器、模型或原生窗口，也不发送设备输入。准备成功不能算完整 12 项或真实 DeepSeek 测试通过。

## 输入与准备

先用当前正式源完成生产 `write:false` 三入口构建，生成包含实际源 SHA 的构建报告，并保存可安装候选包。选定一份已有的项目外验收根目录。准备选项必须来自明确文件，例如：

```json
{
  "archive": "/absolute/candidates/qiuya-tools-macos-universal.tgz",
  "archiveSHA256": "完整候选包的64位小写SHA256",
  "buildReport": "/absolute/build/build-report.json",
  "buildReportSHA256": "构建报告的64位小写SHA256",
  "buildInputRoot": "/absolute/frozen-production-source",
  "directory": "/private/tmp/qiuya-mac-full12-新的UUID",
  "evidenceRoot": "/Users/qiuya/QiuYaTools-验收/本次日期"
}
```

`directory` 的父目录和 `evidenceRoot` 必须已经存在；准备目录本身必须不存在。二者都必须位于项目外。候选包上限仍为 64 MiB。构建报告必须证明三份 JS 均来自实际 `write:false`、无警告构建，包含每份实际字节/SHA、源输入数量和 SHA 映射；准备器逐字节核对归档内输出与构建输入。`buildInputRoot` 用于解释报告的相对输入，不从未知目录猜测依赖。

```sh
node scripts/prepare-macos-full-harness-acceptance.mjs /absolute/full12-options.json
```

准备器使用已安装的官方 Harness CLI、主程序、app.asar 和 Google Chrome。实际执行器只接受这些官方路径；注入的合成编译器/运行时仅供隔离单元测试，生成的入口明确拒绝实际运行。Swift 编译使用本轮独立 module cache，超时保留精确自身进程信息，不发送信号、不自动重试，也不把未知产物视为可用。

准备成功返回新 `entry.mjs` 的路径、完整 SHA、manifest SHA、candidate/组件 SHA、观察器源码与编译收据、冻结依赖数和项目外输出路径。原先已运行的入口与证据无需迁移或覆盖。

`npm run test:compat -- --package …` 的 Mac 原生完整测试必须通过上述准备流程；直接入口在创建输出、安装包或启动 Host/浏览器前以中文说明拒绝未绑定的零 SHA 模板。额外的 `--root-approved`、`--gui-gate` 或同名环境变量不能替代准备。已有 `--pasted-text-only` 与生成的文件交换 headless 子集保持可用。冻结入口先校验 manifest，再执行带有本轮准备前检标记的源码。

## 只读计划和实际执行

```sh
node /private/tmp/qiuya-mac-full12-新的UUID/entry.mjs --plan
```

计划核对包、源码、冻结副本、观察器、支持模块及运行时字节，并检查冻结 Node 模块符号链接的精确目标。它不创建截图输出、不启动任何程序。依赖或应用更新后必须重新准备新入口，不能绕过 SHA 门。准备器从源码编译观察器并把相对模块与真实 SHA 放进冻结副本；源码仓库中不需要提交 Swift 二进制。

provider 会被 esbuild 合成为本轮临时目录中的 `provider/index.mjs`，其中相对 `import.meta.url` 也会指向该目录。完整 runner 在启动 Host 前，把本轮已绑定的观察器和编译收据安全复制到 bundle 旁：核对完整 SHA、单链接、自有文件和可执行权限，以排他创建写入，再读回验证。它不执行产物，也不为 headless 子集部署观察器；原有运行时 nofollow／身份／SHA 门保留。失败或未知轮次保留自有临时 profile，便于检查真实 bundle 与部署文件。

实际运行仅在 Root 已核实当前 Mac 处于已解锁的交互桌面、对应组件与批准指针的前置验收完成、桌面输入槽独占，且没有 Mac/PD 输入竞争后进行：

```sh
node /private/tmp/qiuya-mac-full12-新的UUID/entry.mjs --run --gui-gate root-approved --root-approved
```

这些参数是前置事实的显式声明，不会自动解锁或调整系统锁屏设置。缺门、重复门或混用 plan/run 均在启动 Host 前拒绝。准备目录可保留；实际执行使用新的项目外输出目录，避免覆盖历史轮次。

## 固定业务范围与判定

固定运行 12 项：设置入口和全部功能页、阈值/主题保存、隔离真实会话、提示词 Tab/Escape、TXT 附件上传、会话菜单、原生独立窗口及复用、浏览器拖出、主 Agent 工具和真实图片传输及人工预览控制、批量归档、普通持久 user/message 计划修订、8 MiB 文件交换。三个 native/manual/file 参数由入口固定传入，部分选择不能算完整通过。

主链使用隔离的确定性本地模型验证真实 Host/Agent 工具和图片传输；这与外部 DeepSeek 推理测试分开报告。文件交换子用例的 status/targets-only stub 不代表桌面输入成功。完整通过仍要求 12 项按原顺序全部通过、候选包身份一致、前端无业务错误、真实输入与授权门成立、浏览器正常关闭以及自有 Host 正常退出 0。

源码来自已经实际验证的完整链路；新增公开入口准备前检、Host 前观察器部署与失败 profile 留存条件，逆向移除这些明确差异后，生成业务正文仍逐字匹配 837 完整链路。新生成文件不能称为全文件字节相同。准备器对原生与焦点、租约、人工打断、窗口身份、逐字正文 oracle、上传文件读回和业务预算保持原合同。Host 关闭保留正常 SIGTERM 与原 3000ms 等待，未加入 Host SIGKILL 兜底。失败、超时或清理未知都保留失败和本轮自有临时 profile，不重放已发输入或用后来进程消失改写原判定。

实际报告与截图放在 `evidenceRoot/原始截图/Mac-完整12项-UUID/`，截图位于其 `screenshots/` 子目录。源码和构建支持可提交 Git；实际成功/失败证据与编译产物留在项目外。

## 离线检查及适用边界

`tests/macos-full-harness-acceptance.test.mjs` 验证完整业务转换的固定摘要、执行门、真实归档/构建输入读取、源码编译收据、相对产物绑定、计划零启动、依赖篡改拒绝、缺失/合成依赖禁止执行，以及未知编译进程不重放。相邻测试验证空白会话前提、真实 native 图片引用、被动输入来源、持久正文 oracle 与 workspace 归属。测试用合成 Mach-O/图片字节明确只验证结构与绑定，不冒称实际 Swift 编译或肉眼视觉通过。

每个实际候选必须使用自己的新准备入口和运行报告；历史完整 12/12 仅证明当时绑定的源码、包和运行时。未来重建或重新绑定不自动继承该结论。

## 2026-10-24 当前候选实测

Mac 候选 `569042900890ab11a4b7f1bd1486432feaf95ec352b4b5c883dff3cf26e3fccd` 使用本入口完成新一轮完整 **12/12**，实际输出标识为 `ef9adb83-0003-4ce0-bcc8-9f114b18d2ea`。观察器由真实 Swift 编译产生，源摘要为 `6f401a2e…8ea560`，二进制摘要为 `a52cd8fe…9a531b`，部署和只读输入来源证据分别核对。Host 正常退出 0、signal 为 null，浏览器正常关闭，自有资源清理通过；39 张原始截图在仓库外逐张复核。

首轮 `5272f2d9-69f5-4012-af63-519aa9a0d455` 的 11/12 失败保留：观察器仅位于冻结源码旁，合成后的 provider 无法从自身目录取得它，原二进制边界在输入前拒绝。后续修复部署路径，以真实 esbuild 与文件系统红绿用例验证，没有放宽运行时 SHA、nofollow、身份或业务时限。

三入口 JS 在隔离副本重新构建，164 个生产输入和三个输出摘要均与当前候选一致；八套类型检查及 2122 项完整直接测试通过，零失败、取消或跳过。此处的 12/12 使用公开 SDK 的确定性测试 provider；真实 DeepSeek 三任务与当前组件另记结果，不能由这轮通过替代。
