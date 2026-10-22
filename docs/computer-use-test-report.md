# 电脑操控与双平台适配测试报告

报告日期：2026-10-21；版本 `0.6.0-beta.1`；分支 `codex/cross-platform-computer-use`。本报告按资产 SHA 和实际 JSON 回执记录，不把单元测试、确定性 provider、真实模型、原生输入及性能测试相互替代。范围与门槛见[开发计划](windows-and-computer-use-development-plan.md)，操作方式见[使用指南](computer-use-guide.md)。

**整体尚未通过完整验收。** 本批已实现聊天自动发起、按应用授权、系统权限引导及统一工具箱视觉；小预览为固定长方形，画面按 X/Y 铺满，悬停显示控件，弹出后聊天画面继续实时显示。本批代码、构建及相关测试统一提交。发现的 Mac 同应用重叠窗口输入边界另立修复，未把当前开发验证包当作最终交付。

### 2026-10-22 聊天环境草稿与文件交换隔离修复

真实 React 红例共15项，其中5项失败，确认启用设置的迟到回执会清空远端草稿并让连接请求误发本机；切换聊天时浏览器目标可能残留，全局远端状态也可能让另一聊天显示文件交换。修复后，同一聊天的启用回执保留正在填写的环境；换聊天清空凭据、站点及CDP参数并保留环境类型，连接按钮须等待新参数。已有聊天ID时，文件交换只认该聊天实际连接且要求功能启用。

修复后17项面板回归及2项既有真实文件／异步digest测试 **19/19通过、零跳过**，证据为 `artifacts/computer-use/panel-environment-draft-repro/report.json`。集成源码快照的typecheck、Mac universal构建和 **741/741全量测试**通过，287个源码／配置输入前后稳定，见 `artifacts/computer-use/macos-full-check-current/e10b674b-1d1e-45ce-84b4-21c10a560ec9/report.json`。首次沙箱运行因回环端口、Swift缓存及只读窗口查询受限失败，原始报告保留于 `d46f4f64-0ca3-497a-82f4-7b309f538d27/`；标准权限重跑通过，没有改断言。

这证明状态污染修复与构建回归，不等于Windows真实Host的文件交换已重新验收，也不将其认定为此前Windows失败的唯一原因。新整包视觉／安装及原生输入另行记录。

## 0. 本批交互功能与当前验证（覆盖下面历史快照的“最新”称呼）

| 项目 | 当前实际结果 | 证据与边界 |
| --- | --- | --- |
| Mac 全量 check | **730/730，0失败／跳过；typecheck 与 universal 构建通过** | `artifacts/computer-use/macos-full-check-current/c9fc39b7-6398-4c19-8bc5-565cfe9c037f/report.json`；319个 tracked＋untracked 输入测试前后稳定，源码摘要 `4f2900b85272b649ca7f62d686c2770f8e9d7046eaea6767d957fb6c0f262bc7`。本节文字为测试完成后同步，不改变执行代码 |
| Windows 全量 Node 已验证快照 | **717总／705通过／0失败／12平台跳过** | `artifacts/computer-use/windows-current-node-unit/c80b1cba-490f-4674-bcdd-5994aed54de9/report.json`；源码及SDK后验通过。原 orchestration 读回错误保留；后续日志SHA与精确任务自然退出／注销回执独立保留。本批后加的启动围栏、窗口列表及满幅预览增量仍需Windows重跑，不能冒用该717项 |
| 满幅小预览 | **共享UI54/54；真实headless小框13/13；真实预览页25项通过** | `artifacts/computer-use/inline-full-frame-overlay-web/report.json` 与 `artifacts/computer-use/preview-full-frame-feature-final/report.json`。固定300×180／小viewport边界、阴影、hover/focus、−隐藏控件、顶部点击与拖动、同iframe弹出收回；像素四角满幅及角落输入映射分别检验 |
| 授权与启动并发 | 修复并回归通过 | 最终start/select绑定 `{id,appId,pid}`；停止后的迟到窗口列表拒绝、撤权后按最新授权过滤，session29/29。已发出的launch等实际回执后才放FIFO；未知结果封锁surface，仅owner重新连接可恢复；标准shell含真实paired HTTP的91/91通过，见 `artifacts/computer-use/launch-quiescence-review/` |
| Windows正式PE原生实测 | **ARM64 52/52＋29/29；x64 52/52＋29/29** | `artifacts/computer-use/windows-current-native-matrix/report.json`；Session1真实执行，来宾与本地PE SHA后验一致，两个指针组跟踪35／33身份自然退役、无held／lease／journal，四个任务最终缺席。x64是ARM来宾翻译；本轮未单独检验badge像素，也不替代新tgz的Harness界面 |
| Windows应用／权限自测 | **两架构各18/18** | `artifacts/computer-use/windows-applications-permissions-selftest/report.json`，指定正式PE、Session0纯无界面、自然退出，无桌面输入 |
| Mac实际Harness已验证快照 | **11/12；主Agent发现→owner允许一次→图片→实际Move→图片通过** | `artifacts/harness-e2e/macos-chat-first-minimal-preview/report.json`，绑定此前 `a6342c30…58f6`。失败在独立预览的严格测试命中检查；后续证据识别为系统WindowServer指针层并窄修夹具，接续轮次另遇AX窗口定位失败。失败均保留，未把人工接管记为通过，最新满幅整包仍待回归 |
| Mac官方安装已验证快照 | **5/5通过** | `artifacts/install-e2e/macos-chat-first-minimal-preview/report.json`；此前a634包的安装／升级／坏包恢复／回滚／重装，不能替代本批新包安装 |
| Mac同应用窗口边界 | **已增加精确窗口校验；全量回归通过，实机闭环未完成** | 以 `554acb4` 为基线的后续独立修复见下节；同几何兄弟窗口的真实 click／type 已拒绝且零输入，合法单窗口仍需完整复验。原始红例及全部失败保留 |
| 真实视觉模型第四轮 | 任务1通过；任务2到预算并出现1次拒绝；任务3未运行 | `artifacts/model-capability-resumed/actual-vision-external-attempt-4/evidence/report.json`；两个helper／fixture自然清理，oracle自然退出，cleanupErrors为空，官方卸载已应用；私有正文未归档 |

本批验证包保存于 `artifacts/candidates-chat-full-frame-feature/`，各包的完整SHA和字节数见相邻 `.tgz.json`。它们已通过严格包校验，均为未签名的 `0.6.0-beta.1` 开发验证包；整包回归和上述Mac窗口边界修复完成前不作为最终发布。此前 `candidates-chat-first-toolbox/` 和 `candidates-chat-first-minimal-preview/` 保留历史回执，不覆盖原始失败。

Mac本批helper为universal，SHA `ad57146885f640988ac34f23d3c80df02ef2a345356d8f0a3cbe0287b785b63b`（1,419,416B）。Windows ARM64正式PE为 `9cf240d3336646bdd2a031ff72ad2cf5f0a18b2de0895cb1f5eb371503f0a6a6`（68,257,179B），x64为 `5c20b96566f080ca2e3ef6ff6667b7f00f1ddae7ee785259d08a9f003fd59c43`（72,080,922B）。后续Mac窗口修复必须产生新的冻结SHA及实际回归。

### Mac选中窗口归属校验的独立修复

修复在每次正常输入前校验同一进程出生身份、所选CG窗口、可见性、几何与前台顺序；同PID／同几何兄弟窗口继续拒绝。自有按键／鼠标释放沿用独立清理路径。公开AX无法读取内容的应用在没有额外组件阻挡时仍可使用CG校验。

实际第4轮发现AppKit标题栏按钮会产生独立normal-layer CG surface，严格前台检查因此误拒绝合法主窗。新增组件判定要求AXFocusedWindow、AX命中元素的AXWindow归属、PID及几何共同证明，最多3个组件、总AX预算60ms，并在证明后重读CG顺序；没有按名称、尺寸或同PID直接忽略窗口。这不等于覆盖所有AX不可见浮层或模态路径。

该修复快照的typecheck、universal构建和全量 **733/733** 通过，0失败／跳过，322个输入测试前后稳定，摘要 `f249de5933079d4c1481152958b6e5f4fc34a488cd3223081e6ac0a0c7e33394`。证据为 `artifacts/computer-use/macos-full-check-current/fd65da7e-2d5a-4806-81af-e2bc7600072f/report.json`。新helper SHA256为 `715d946c7a62c17a1d52160777719b316b1f5cc217e2d9f796b9261debff6174`（1,477,480B）；严格包校验通过的未签名验证包在 `artifacts/candidates-macos-exact-window-component/`，tgz SHA256为 `b5101b80a9add1a5f6a8f237ace2155283af50221ae04787d8f64111158e96da`（997,845B）。它尚未通过新整包验收。

实机原始报告 `artifacts/computer-use/macos-exact-window-focus-actual-4/` 至 `-9/` 全部保留。第7轮click／type歧义拒绝均取得A/B业务计数0、inputPosted=false、OS空输入及最终lease空闲／自然退役证据，但合法单窗前置检查被标题栏组件挡住，整轮仍为failed。测试夹具随后改为独立CG动作中心点命中检查，保留精确key/front PID、CG与AppKit几何一致、连续3次稳定及业务零输入门槛。第5轮中途出现Shift状态，第8轮启动前左键已按下，第9轮在观察期间失去前台；来源不确定，未强制释放其他输入、未重放操作，也未把分项或自然退出改记为整体通过。后续合法单窗实测等待本机空闲。

相关Harness夹具增加精确自有Host父进程／出生身份／路径绑定、独立重复打开的稳定窗口检查与授权前一次AX激活；该准备仅作用于测试自有窗口，不产生业务键鼠事件。先前整包轮次 `artifacts/harness-e2e/macos-full-frame-exact-window/report.json` 为10/12，窗口准备失败仍保留，未由静态全量通过替代。

### 2026-10-22 焦点准备预算与有限诊断

用户提供空闲窗口后立即执行的第10轮确认：两个歧义拒绝均零输入且最终清理通过；合法单窗的CG／AppKit几何、key、前台PID及动作点命中在前后都正确，但准备在501ms截止，仍未发送输入。不能把该次失败归因于用户操作。源码发现准备阶段每次AX调用前后的metadata检查会反复计算并丢弃组件前台证明，可能放大预算消耗。

本次仅在准备请求的metadata校验中跳过这部分组件AX读取，仍保留进程出生、CGID／PID、几何、歧义拒绝及CG复读。最终两次严格就绪采样和每次正常输入前的组件证明保持启用，500ms、取消、人工介入和epoch门槛不变。增加action内的阶段、采样次数、组件证明次数／累计耗时及有限AX错误码；不保存AX正文、窗口标题或路径，诊断不能覆盖控制字段或参与放行。

该快照typecheck、universal构建与 **733/733、0失败／跳过** 通过。证据为 `artifacts/computer-use/macos-full-check-current/17eec6f8-e400-45a7-a56c-7c133ffb4f01/report.json`，287个Git列出的源码／配置输入前后稳定，摘要 `547fcb439ad2af433ec0c475d516cf2be0c358999b5cd92f0ea4d0ec1c271d64`。本次输入清单口径与前次322文件快照不同，分别保存原清单，不将其作为同一快照。新universal helper为 `919f38d7ef05ffc75df8c5ae0fc0f4c00ae115b5eb46657b2fed6e48a3c76e21`（1,563,896B）；验证包在 `artifacts/candidates-macos-focus-budget/`，tgz SHA256 `3f6d6708150fa4fd52501d2092f9ecf7c2d64085c5856e5c3712c20508df08ed`（1,031,910B），严格包校验通过、未签名。两个Windows正式PE SHA保持不变。

第11轮同样正确拒绝歧义输入，但合法单窗在准备请求7ms时提前中断、组件证明调用为0；原测试投影未识别该原生错误，不能追认其具体代码。失败紧后的前台仍为fixture、鼠标为空，收尾时另见左键按下；四个进程自然退出，OS空输入不满足，因此整体仍failed。第12轮先做最多20秒的只读空闲预检，没有观察到连续5秒键鼠空且光标稳定，fixture和输入均未启动，状态为not-run。后续runner已补确切人工介入错误的有限投影，并使OS-empty与lease审计独立执行；没有修改产品门槛或重放未知输入。合法单窗修复的实机闭环仍未通过。

用户进一步授权真实DeepSeek会话及本地安装后的逐功能视觉验收。确定性provider、真实模型、自然发现授权和本机TCC仍分别记载。最终成功截图按要求存储在项目外的本地验收目录，不加入Git；README及更新日志在对应验收后同步，更新与兼容在前、界面预览置底。

以下编号章节保留本轮重设计之前的历史结果与原始失败。它们只适用于各自列明 SHA，不能用其中“当前／最新”字样覆盖本节，也不能替代本轮新候选验收。Excel 专用加载项、锁屏扩展、未具备的原生硬件／最低系统矩阵仍分别记录。

## 1. 当前候选、组件与环境

下表为 `artifacts/candidates-capture-fifo-rounded/` 的独立候选名录。根目录旧 `artifacts/delivery-manifest.json` 仍绑定38b929d及58126/5609/95f0旧包，不能将它当作本表新包的交付回执。最新组件通过不自动等于其整个tgz通过；Windows这两份新tgz尚未完成实际Harness12项及安装5项。

| 最新候选 | 字节数 | SHA256 | 本轮实际整包结果 |
| --- | ---: | --- | --- |
| [Mac universal](../artifacts/candidates-capture-fifo-rounded/dsh-qiuya-tools-darwin-universal.tgz.json) | 784,883 | `e0a99a113c90a8b17aa05520f1519b55c47252ddc6c6aad55e4d521cfd1a7fdc` | 基础Harness10/10、安装5/5；扩展手动轮次11/12，见第3节 |
| [Windows ARM64](../artifacts/candidates-capture-fifo-rounded/dsh-qiuya-tools-win32-arm64.tgz.json) | 62,761,241 | `50499928e9e14d77ffe7cfc835ef7019e6171fe94c51fece2e12327b35d59901` | 严格包校验通过；该tgz实际UI/安装尚未测 |
| [Windows x64](../artifacts/candidates-capture-fifo-rounded/dsh-qiuya-tools-win32-x64.tgz.json) | 67,010,873 | `752bc49871e64dc77b9881b7426ec3626415d3370d45acc8a00e25f2ecb2bcc5` | 严格包校验通过；该tgz实际UI/安装尚未测 |

当前Mac computer helper为912,504字节，SHA256 `688315b434eecca56292301950d2237900f266856bb0cb3c996e9130b6d945b8`，包含arm64及x86_64。Mac session helper仍为 `bb0d6b21…f5875d3`，两者生命周期与权限身份分开。

当前Windows正式PE来自源码元数据 `4739c9d9e5b915e0779bf85e906d2db3e59f7818`：ARM64为68,247,785字节/SHA256 `4c7dec7049e1094e8b9128e0ed9191dc0cd1b770d8a030b180419593c16041a7`；x64为72,071,521字节/SHA256 `edc1883deb5abc84e72ddb483ddaf067d512a5a8223365015fc60f5c2e349f11`。它们包含批准的小号灰色白描边箭头、预览创建时置顶和短UDF槽方案，不含临时z-order诊断副本。

实际环境为macOS 26.6.2 / Apple Silicon，以及PD 26.4.1中的Windows11 ARM64、已登录交互桌面Session1。Mac主Node为24.17.0；Windows原生及Node套件使用22.23.3。x64 PE和x64 Node在ARM Windows转译执行，不代表原生x64硬件。Windows .NET SDK为8.0.426、WebView2 SDK为1.0.3912.50；用户运行自包含helper不需要开发SDK。macOS13是构建目标，未取得旧系统及Intel实机运行证据。

## 2. 当前自动化与组件验证

| 项目 | 实际结果 | 边界与证据 |
| --- | --- | --- |
| Mac完整check | passed：617/617、0失败/跳过，类型检查及universal构建通过 | [回执](../artifacts/computer-use/macos-full-check-post-capture-fifo/239bb68d-3e73-4a52-b498-aee8dae64b61/report.json)绑定17314fb；唯一复制前后漂移是并行修改的Windows测试fixture，生产/Mac/Node测试输入稳定。它不包含其后的全部test-only视觉诊断修改 |
| Windows完整Node | passed：**636总数、627通过、9跳过、0失败**，约49.75秒 | [实际报告](../artifacts/computer-use/windows-current-node-unit/6f9f36ac-d502-4c2e-9f1c-967e6be780a4/report.json)、[逐文件/SDK验证](../artifacts/computer-use/windows-current-node-unit/6f9f36ac-d502-4c2e-9f1c-967e6be780a4/source-verification.json)、[自然任务退出及清理](../artifacts/computer-use/windows-current-node-unit/6f9f36ac-d502-4c2e-9f1c-967e6be780a4/orchestration-cleanup.json)；绑定258e301、289文件和79 SDK包。此前628为错误预估，正式计数以Node输出636为准 |
| Windows跳过项 | 9项，未计为通过 | 4个Mac session/架构检查、1个Mac预览Swift编译、3个Mac私有文件/路径测试、1个未携带的可选旧归档fixture。没有用Windows总数推算Mac总数 |
| 原生截图并发兼容 | passed：先真实JSONL复现CAPTURE_BUSY，再验证截图专用FIFO/preview合并 | [回执及前后日志](../artifacts/computer-use/native-capture-concurrency/report.json)。最多16个capture job/128 caller；独立调用取消不提前释放活动截图，status/lease/release/act不串在截图后。不声称这是旧实际Harness失败的唯一原因 |
| 共享预览与批准指针 | passed（浏览器分项） | [批准纸飞机轮廓与预览交互](../artifacts/computer-use/preview-approved-rounded-pointer/report.json)；不替代实际桌面系统指针的合成效果或完整Mac原生13项 |
| Windows ARM64原生 | passed：52/52 | [原始报告](../artifacts/computer-use/windows-preview-sampler-arm64-formal/baseline-52/report.json)、[采样/身份摘要](../artifacts/computer-use/windows-preview-sampler-arm64-formal/baseline-52/acceptance-summary.json)，精确4c7dec…；真实held状态下200ms采样，11个有效样本全部可见，未放宽>=5门槛 |
| Windows x64原生 | passed：52/52 | [原始报告](../artifacts/computer-use/windows-preview-sampler-x64-formal/baseline-52/report.json)、[采样/身份摘要](../artifacts/computer-use/windows-preview-sampler-x64-formal/baseline-52/acceptance-summary.json)，精确edc188…；12个有效样本全部可见，ARM来宾转译 |
| Windows ARM64指针/预览扩展 | passed：29/29 | [报告](../artifacts/computer-use/windows-preview-slots-arm64-formal-2/report.json)、[交付摘要](../artifacts/computer-use/windows-preview-slots-arm64-formal-2/acceptance-summary.json)，35个精确身份自然退出，无forced、无held、journal为空、锁释放 |
| Windows x64指针/预览扩展 | passed：29/29 | [报告](../artifacts/computer-use/windows-preview-slots-x64-pointer29-formal/report.json)、[交付摘要](../artifacts/computer-use/windows-preview-slots-x64-pointer29-formal/acceptance-summary.json)，36个精确身份自然退出；该29项不曾代替旧52采样失败，后者另以sampler正式重验通过 |

新Windows扩展验证AI/human actor、指针状态/像素、透明不拦截点击、不抢焦点、失焦/释放隐藏、普通close与preserve收回的不同事件，以及WebView2初始化/退役。UDF根路径113字符，完整UDF上限165字符；每helper完整GUID范围内用完整SHA256内存key映射s00至s1f，拒绝超预算与reparse路径。此前长路径controller等待30秒的失败保留；短槽通过不能解释为任意Windows长路径都已支持。

原生报告明确仍未验证“物理HID鼠标在按住拖动时点击自己的预览”。本轮物理中断证据为绑定自有目标的VM-specific Escape；普通点击/移动是Win32 SendInput OS合成事件。acceptance摘要中的宽泛coverage文字不能覆盖原始report的unverified字段。PD截图比较未检出系统指针像素，只能说明该采集模式，没有证明物理显示器上不存在系统指针。

## 3. 真实Harness、既有功能与多聊天

最新Mac候选[基础官方Harness10/10](../artifacts/harness-e2e/macos-capture-fifo-rounded/report.json)、[官方安装5/5](../artifacts/install-e2e/macos-capture-fifo-rounded/report.json)通过。确定性provider的真实主Agent执行observe→native move→observe，adapter保留实际JPEG及performed=true回执；这证明公开SDK工具与图像运输，不证明真实模型视觉推理。

同包扩展到trusted拖出、手动预览和文件交换的[12项轮次为11/12](../artifacts/harness-e2e/macos-capture-fifo-rounded-manual/report.json)：新会话拖出与8MiB上传/下载/同名拒绝通过，电脑case9因“可见预览没有读到成功帧延迟”失败。不能用同包较短10项通过覆盖这个失败，也不能只凭空canvas或AX按钮当实时图像已经出现。

现有多环境manager已在源代码中按聊天隔离设备/目标/epoch，物理桌面动作由全局FIFO调度。每个动作真实获取/释放native lease，逻辑ready不等于持续持有OS输入；AI箭头在动作结束释放后隐藏是当前边界。聊天中有实时小框，用户可主动弹出/收回；独立原生预览沿用已有尺寸布局，收回使用preserveSession，普通关闭由绑定会话pause。

这些manager/inline/调度回归纳入单元与Host测试；**真实双聊天长drag FIFO、并行观察、A弹出/收回不影响B的完整实机runner尚未通过**。单helper、legacy driver或同一页面的预览通过不能代替默认manager两聊天集成。

旧Windows ARM64 `5609bc04…` 和x64 `95f0c9b9…` 各[实际UI12/12](../artifacts/harness-e2e/windows-bulk-stable-arm64-final/report.json)、[x64 UI12/12](../artifacts/harness-e2e/windows-bulk-stable-x64-final/report.json)，各官方安装5/5。这些对应42889/3f007旧helper，保留为既有功能证据，**不移记为504999/752bc4新候选整包通过**。

| 既有功能 | 已有真实证据 | 仍未覆盖 |
| --- | --- | --- |
| 长文本转TXT、附件 | ClipboardEvent→官方上传、阈值/空白/文件逻辑 | OS真实剪贴板所有入口及输入法组合 |
| 分窗、菜单、拖出 | 双端原生分窗与复用，浏览器trusted拖出、置顶/未读/复制调用 | 桌面硬件拖出、全部任务栏/贴靠/恢复、盘符/UNC/长路径 |
| 归档、计划批注、设置、Q主题 | 真实会话归档、评论/草稿、设置持久化；无关刷新关闭归档菜单缺陷已先红后绿 | 所有快捷键、复杂长计划、全部字体/DPI/跨窗组合 |
| 提示词与中文输入 | [历史微软拼音5/5](../artifacts/computer-use/windows-ime-final/report.json)：PD硬件扫描码，实际“你好”及Enter/Tab/Escape/Ctrl+Enter | 未捕获trusted compositionend，不扩大为AltGr/死键/其他IME全通过 |
| 文件交换 | 手动默认关闭、专用目录、8MiB、SHA与原子不覆盖；[真实NTFS10/10](../artifacts/computer-use/windows-exchange-final/report.json)及新Mac UI8MiB通过 | 不开放模型任意路径；文件分支零observe/lease/act不代替原生输入验收 |
| 安装更新 | 官方管理器隔离profile的安装/升级保留设置、坏包拒绝、回滚和重装 | 当前新Win tgz整包5项、所有占用exe/并发下载、正式签名/公开发布 |

## 4. Mac解锁后原生、指针与资源边界

“Mac仍锁屏，所以全部未测”已经过时。解锁后[2965旧helper原生11项](../artifacts/computer-use/macos-native-click-trace-resumed/report.json)通过，含真实点击、Unicode、快捷键、滚轮、WK预览接管、drag中撤权/释放及旧epoch零事件。最初解锁轮次首次click计数失败仍保留，没有把未知来源动作重放为通过。

[4769旧helper的独立held-crash](../artifacts/computer-use/macos-lease-independent-held-crash-final/report.json)5项通过：独立OS oracle确认左键按住，fixture收到down/drag、journal记持有后，对精确自有helper SIGKILL；guardian释放后OS左键false、fixture收到up，新owner恢复、旧owner不误清新租约，最终自然清理及OS-empty通过。[环境](../artifacts/computer-use/macos-lease-independent-held-crash-final/environment.json)精确绑定4769aff…，不是6883的新完整回归；held-key-crash与物理HID项仍未测。

当前6883批准的小指针形状为18×20 viewBox、约14×16轮廓、hotspot(2,3)、半透明灰填充、细白边和软灰光晕。它是独立不激活、click-through的NSPanel，AI/human来源由Host lease actor决定，不接受模型伪造source。

[6883实际首轮8项通过后整体失败](../artifacts/computer-use/macos-approved-small-ai-cursor-actual/report.json)：实际CGWindow/SCK像素、透明点击、drag中多点位置、真实held释放、human隐藏、旧epoch隔离、失焦和移出屏幕隐藏均取得分项证据；show/activate后新动作因GEOMETRY_CHANGED停止，整份报告仍failed、自然清理通过。配对保存的showsCursor=false/true图片证实：孤立AI图形符合批准样式，但**真实OS黑箭头会覆盖它**。不得用排除OS指针的截图声称用户最终看到了独占灰色箭头。

[稳定几何轮次](../artifacts/computer-use/macos-approved-small-ai-cursor-stable/report.json)仍failed：首帧像素不符，前后独立OS已见Escape按住并出现humanInput；因果尚不能唯一归到动画或外部输入。旧runner先做OS-empty断言再EOF，断言失败导致observer未获正常EOF即被强制退役；这不是已经证明的SCK EOF卡死。测试清理/几何窄修另有纯回归，完整真实13项仍待重验。

Mac WK长稳也未通过。[归属诊断](../artifacts/computer-use/macos-wkwebview-attribution-diagnostic/report.json)不能唯一确认owned WebContent：实际XPC路径在Cryptex，responsible PID为Codex且coalition共享，不能仅按名字/新出生时间收编。已确认的10个自有身份自然退役不等于全部共享WebKit资源已归属。[test-only SETEXEC/disclaim carrier短实验](../artifacts/computer-use/macos-wkwebview-self-responsibility-smoke/report.json)因责任变化后Screen Recording未获授权而零帧失败，已记录身份自然清理；没有修改TCC或用别的宿主权限假装该实验通过。

## 5. 真实账号视觉任务

原生权限与模型能力分开核验。当前默认 `deepseek-account / deepseek-flash` 的实际目录读取未披露inputModalities（null/undisclosed），不能据此推断仅文本，也不能反称目录明确声明text+image。实际图片保留和任务1读图/随机码成功另有运行证据；最早401/锁屏探测是历史前置失败。后来已进入合法owner renderer，通过官方插件管理器临时安装测试guard。首个本机Harness方案在准备阶段读到helper四项TCC均false，未发送模型请求：[actual-vision-attempt-2](../artifacts/model-capability-resumed/actual-vision-attempt-2/report.json)。没有复制账户凭据、伪造cookie或修改系统权限。

随后采用**Codex显式启动的test-only carrier＋标准paired remote产品模式**。fixture、随机业务值和独立业务oracle仍由测试guard拥有；carrier每RPC只允许本轮精确PID/出生/路径/父进程/二进制SHA/bundle/window。0600一次性rendezvous不把token、备注或nonce塞给模型。它验证远端模式的真实Agent链路，**不替代日常安装的Harness本机TCC验收**。

[external首轮原始报告](../artifacts/model-capability-resumed/actual-vision-external-attempt-1/report.json)总体failed：

| 固定任务 | 实际结果 |
| --- | --- |
| 任务1：读图定位并确认 | passed：4 step、5 stream attempts、4次保留图片出现；fixture业务通过、随机码读对，native及fixture自然清理通过 |
| 任务2：读图输入完整备注并提交 | failed：12 step/12请求上限；2次VISION_ACTION_NOT_ALLOWED，合法type单字符和Backspace确有执行，最终空框、业务false；随机码读对不能替代输入业务完成 |
| 任务3：视觉拖拽分拣 | not-run：首轮在任务2失败后结束，没有跳过失败直接算第三项成功 |

[carrier原始收尾](../artifacts/model-capability-resumed/actual-vision-external-attempt-1/external-carrier-report.json)的两个native均自然退出，但外层tty Ctrl-C同时命中oracle，oracleNaturalExit=false、VISION_EXTERNAL_ORACLE，总体清理failed。该操作失误保留，不能只看native退出把delivery改绿。后续应对精确carrier身份发TERM或等三任务自然结束，不向整个终端进程组发Ctrl-C。

后续test-only诊断已补充有限action kind分类、固定参数字段存在/类型/长度/SHA，未保存拒绝文本或任意字段名；prompt仅说明现有type/text、key/Enter、frameId与局部坐标API，未提供任何备注/nonce/坐标答案。12次/180秒/工具和动作白名单未放宽。[28项回归](../artifacts/model-capability-resumed/external-carrier-action-diagnostics/targeted-tests.log)通过。准备文件00-run使用`?run=bundleSHA`避免浏览器缓存旧owner函数；同URL缓存/新query加载回归通过。[external第二轮](../artifacts/model-capability-resumed/actual-vision-external-attempt-2/report.json)仍总体failed：任务1再次4step/5请求、定位点击和随机码通过；任务2达到12step/12请求，28次图片保留出现、0denials，但只有4次observe、一次status、一次pause，没有act，business和nonce均false，任务3未发送。不能据此断言模型不支持图片或已经定位了不操作的唯一原因。其后的[精确carrier取消](../artifacts/model-capability-resumed/actual-vision-external-attempt-2/precise-carrier-stop.json)和[carrier回执](../artifacts/model-capability-resumed/actual-vision-external-attempt-2/external-carrier-report.json)记录cancelled、两个native清理通过、oracleNaturalExit=true、cleanupErrors=[]；临时插件官方移除已确认。自然清理通过不改变任务2业务失败。接下来先补仅ownSID可展示文本与实际工具schema摘要诊断，不自动提高上限或换模型。

## 6. 性能：历史通过的范围与新资产未测

| 负载 | 实际结果与资产范围 |
| --- | --- |
| Windows原生WebView2、1280×720、30分钟 | [旧42889 helper正式delivery passed](../artifacts/computer-use/windows-webview2-720p-final/delivery-verdict.json)：1,800,064ms、24,309不同源时钟帧、完整壁钟13.5045FPS、P95 44ms、0invalid/0wrongDimensions、5次终止/显式重开/CDP重连，238个身份自然退出，无forced |
| 上述资源 | Node RSS峰90,710,016B、全自有树WS峰1,478,590,464B<1.5GiB；61个资源样本，PrivatePageCount峰939,827,200B。采样之间瞬时峰未测，不称无限运行无泄漏；600×420窗缩放1280×720画面，不是物理720p视口 |
| Windows输入短测 | [旧42889 helper 121秒delivery passed](../artifacts/computer-use/windows-input-owner-lifecycle-final/delivery-verdict.json)：83正常drag、166已验证wheel、5次held撤权/旧epoch拒绝/新owner恢复。视口查询有界只读重试，未重发输入；并非30分钟混合renderer/scroll/drag负载 |
| Windows在途暂停数值 | [旧hook修复helper 30次](../artifacts/computer-use/windows-pause-latency-hook-final/report.json)：OS独立mouse-up P95 21.7592ms、最大24.1073ms，旧epoch拒绝、ACK后100ms稳定。不是当前4c7/edc的新P95测量 |
| 新4c7/edc、聊天inline与多聊天 | 完整30分钟/5恢复及混合输入not-run；旧采集/位图组件证据保留，不能直接移记完整新资产性能 |
| Mac完整30分钟 | [旧报告failed](../artifacts/computer-use/macos-soak-fixed/report.json)：源时钟冻结、892无效/过旧时间戳；显示器熄灭同秒是环境证据。后续WK归属和权限实验失败，不存在新的Mac30分钟passed |

阈值仍为完整壁钟>=10FPS、源到renderer P95<=500ms、原1.5GiB资源上限等既定门槛。RPC往返或首末有效帧区间不能替代完整端到端指标，热身与恢复不从整段壁钟扣除。旧30秒9.9757FPS失败、错误提前清理conhost的两次失败、旧PID树误归属/真实资源超限均保留在原目录，不靠四舍五入或放宽阈值变绿。

## 7. 跨设备与仍未完成的矩阵

[历史Mac→Windows正式旧helper15/15](../artifacts/computer-use/windows-remote-pinning-final/report.json)以及[NTFS文件10/10](../artifacts/computer-use/windows-exchange-final/report.json)通过，各自保留SHA和环境。当前4c7/edc完整remote15尚无同SHA新回执，不把旧结果改名搬过来。

Windows→Mac已经在解锁后实际执行，[deferred-fixture轮次](../artifacts/computer-use/windows-to-macos-deferred-fixture/report.json)的status/target/capture、点击、Unicode、快捷键、撤权、恢复、预览9项业务检查通过。但Windows精确身份数组解析和最终OS-held审计失败，delivery=false；较早轮次另有命名空间/长命令bootstrap/ownership checkpoint失败。不能再说该方向“未发任何输入”，也不能把部分业务通过记成完整双向验收通过。

| 未完成范围 | 当前判定 |
| --- | --- |
| 当前新Win tgz的UI12/安装5；新helper remote15和完整性能 | not-run，历史包/旧组件分开列明 |
| Mac6883完整13项、真实OS与AI指针最终合成效果 | failed / 待修复重验；系统指针叠盖有真实配对图 |
| 默认manager双聊天实机并发、弹出/收回互不影响 | not-run；单元/legacy/单helper不代替 |
| Mac WKWebView资源唯一归属及30分钟/5恢复 | failed；不以共享Codex责任或测试carrier权限冒充通过 |
| 真实视觉三固定任务、接管后继续、两平台模型矩阵 | 首轮failed；任务1部分成功，不是完整三任务通过 |
| Windows→Mac严格delivery | failed；部分实际业务通过，最终清理/OS-empty未通过 |
| Mac held-key-crash、原生Intel Mac/Windows x64硬件、旧系统 | not-run；构建/转译运行分别陈述 |
| 全部DPI、物理多屏/拔插、AltGr/死键、盘符/UNC/OS剪贴板 | not-run或部分覆盖；微软拼音/纯数学变换不能代替 |
| Excel专用加载项、macOS锁屏操控、日常profile浏览器扩展 | not-run，尚未实现对应专用能力 |
| 正式签名、公证、远程CI、push/Release/npm publish | not-run；本地测试候选不是公开发布 |

## 8. 保留失败与可复现入口

关键历史故障包括：Windows浮层Show隐藏/SetWindowPos返回成功但未真正置顶，CreateParams修复后正式旧包另验；批量归档无关刷新关闭菜单的独立先红后绿回归；Win capture卡顿隔离worker与输入guardian；两个约1秒暂停延迟失败及后续修复；Mac锁屏/显示器熄灭、真实held-crash前置失败；当前Mac指针/预览/资源和真实模型失败。详细原始日志保留在`artifacts/computer-use/`、`artifacts/harness-e2e/`、`artifacts/install-e2e/`和`artifacts/model-capability-resumed/`；旧文档快照亦保留于`artifacts/documentation-review/current-evidence/`。没有删除旧失败来换取当前通过率。

```sh
QIUYA_TOOLS_UNIVERSAL=1 npm run check
node scripts/test-computer-preview.mjs
node scripts/e2e-harness.mjs --package /absolute/frozen-candidate.tgz
node scripts/test-harness-install.mjs --package /absolute/frozen-candidate.tgz --old-package /absolute/previous.tgz
node scripts/test-windows-native-pd.mjs
node scripts/test-windows-ai-cursor-pd.mjs
node scripts/test-macos-ai-cursor.mjs --native /absolute/frozen-helper --expect-sha256 EXACT_SHA
node scripts/test-macos-computer-lease.mjs --action-crash
```

这些命令中包含真实输入；应按测试目标、精确SHA与桌面gate串行执行，不自动重放未知结果。长稳/输入runner不能同时抢物理桌面租约。临时真实模型插件通过官方管理器安装和移除，owner连接与恢复只限定本轮新sessionId；不得复制账户凭据、改TCC或用不相关应用替代自有fixture。
