# 电脑操控与双平台适配测试报告

验收根目录由最终交付消息提供。下文证据位置相对于该目录；完整可点击机器报告保留在项目外。

记录更新：2026-10-25；候选0.6.0-beta.1。当前仅指a2b7f4／7170f2／baea。

当前三端完整12项均整轮通过，已独立查看并原字节归档Mac39张、Windows各31张原图。官方安装五项均有当前包证据；ARM需结合原终态的严格离线重评，原聚合器失败保持不变。当前真实模型九任务也已通过；功能、构建、验收和环境恢复均有独立回执，文档提交的最终交接另列。确定性SDK/UI结果不代替真实DeepSeek推理结果。

## 当前可安装归档

| 平台 | 归档字节 | 当前 SHA256 |
| --- | ---: | --- |
| macOS universal | 1,240,806 | `a2b7f473ed11b20edfd1cffe62c96e93967245825742bce339b0584981c23560` |
| Windows arm64 | 58,075,197 | `7170f249073e3b5d2f171aecf4ebfa2d24cf382d54648f4033dab6c4dc92bc6b` |
| Windows x64 | 62,325,529 | `baeaf6749272ae2eb496a0bb6f7862ff9c66d3c0c39fa11c55dc411d4c8bd5d4` |

永久安装包目录：两阶段输入释放与窗口自然退出-20261025（证据位置：`安装包/两阶段输入释放与窗口自然退出-20261025`）。三包均为0.6.0-beta.1、19个regular成员、MIT许可、gzip小于64MiB；安装和来源回执均绑定相应归档。包内README保持 `bbd754cd…`，本报告不改包、不重新打包。

当前Host/client/agent分别为 `fd8cc6bb…`／`6d744505…`／`811af9af…`。165个生产输入write:false构建与三产物字节一致；当前Windows原生发布输入为30份，ARM PE `46d4e8a3…`、x64 PE `e4a468cb…`。Mac computer `69a23738…`、session `bb0d6b21…`保持原字节。历史58/59份跨平台来源集合不作为当前30份发布输入。

## 当前整包验收

| 当前平台 | 完整12项／原图 | 官方安装5项 |
| --- | --- | --- |
| Mac a2b7f4 | 12/12；39图；自然退出与原身份退净 | 实际5/5 |
| Windows ARM64 7170f2 | 12/12；31图；46 inner／52 outer pins退净 | 原五项实际通过；终态离线重评通过 |
| Windows x64 baea | 12/12；31图；46 inner／52 outer pins退净 | 实际5/5 |

完整12项覆盖十个设置页（含关于页）、设置保存／主题、隔离会话、提示词Tab/Esc、TXT395B、复制／未读／置顶、原生独立窗口与复用、可信拖出、主Agent图片／动作与手动预览click/type/Enter、归档、计划批注／草稿、8MiB交换及同名拒绝。原生正文要求精确owned窗口的完整nonce回复、共享35秒内两个稳定样本与真实图像，不使用摘要或OCR替代。

Mac本轮隔离Host加入只读DOM旁观，12项业务与原policy保持。实际type链有可信click→原action-entry→act-call→原HTTP请求→独立提交成功；仅证明本轮，旧5cfe失click原11/12保持失败，未据此宣称唯一原因已修复。DOM68条记录无丢弃，但缺pagehide，不能称整个文档生命周期trace完整。

Windows两轮均保留原完整正文1500ms／35秒oracle，三个已认证native原exit/close0且browserShutdown通过，Host正常EOF，精确原pins和双Task退净。点击/输入成功不以pressed、HTTP200或进程已消失单独判断。

## 安装、升级与恢复

Mac实际原五项全部通过：旧版安装、候选升级、坏包拒绝、显式回滚、候选重装；五个精确Host各一次正常SIGTERM、原5000ms内exit0/signalnull，无升级强停。4321字符／23行阈值与主题true保存并读回一致，临时profile删除，个人profile未改。不是“所有测试零信号”。

Windows x64实际原五项通过，五个Host自然exit0、16个原pins与双Task退净；六次官方CLI自然退出中五次为正常exit0，坏包一次为预期exit1。设置保留与临时profile删除独立核验。Windows ARM64原五项、五个Host和16pins/Tasks也已实际通过；原carrier因漏传candidateVersion仍为false。新离线sidecar只用原终态、原五门及19成员绑定的package.json版本0.6.0-beta.1严格重评为通过，没有重跑或更改原报告。

安装五项证明官方CLI与隔离Host生命周期，不推导图形安装器、GitHub下载或自动更新。Mac个人a2b7已由Root官方安装并正常quit/reopen，磁盘19/19和fresh Host公开SDK激活链接另有回执；磁盘SHA不称为内存字节哈希。

<!-- CURRENT_MODEL_UNIT_BEGIN -->
## 当前真实模型结果

当前三个平台各完成看图确认、完整中文提交与拖动，**共9/9通过，72次SDK请求、294次schema出现**。九任务63步骤、15次act，中文各一次type与一次Enter；原每任务12请求／12步骤／180秒及精确文字／图像nonce门通过。

| 当前平台 | 三任务耗时（秒） | 结果与执行范围 |
| --- | --- | --- |
| Mac a2b7 | 13.495／18.078／12.065 | 3/3；当前fd8/811公开SDK与原69a标准paired路径；3张final原图已看。 |
| Windows ARM64 7170 | 51.079／63.438／47.701 | 3/3；当前46d4原生组件；14张原图已看，fixture确认实际点击／拖动交付。 |
| Windows x64 baea | 47.970／62.894／34.288 | 3/3；当前e4a原生组件在Windows ARM64来宾兼容层运行；14张原图已看。 |

三个中文任务均精确20字、无ASCII空格，输入后观察核对再一次Enter，无输入重放。Mac测试代理输出cap为8192，沿第四轮已授权受控配置，相对最初4096确有变化；Windows两轮仍4096，个人默认未改。18项负例全部拒绝。31份已查看模型原图文件按SHA为17种内容，不能称31张不同画面。

Mac十二个原birth pins退净，held0/leasefree/journalnone、Host恢复、官方guard卸载及自然退出均真。Windows两轮544条只读查询均自然0，无unknown/pending／缓存／自动重试；两轮各九文件长度/SHA、fresh Task Ready0/action1和精确注销、设置恢复与官方卸载均通过。新有限pointer trace各18条无丢弃；其targetType标签unknown的命名前缀局限不承担身份授权，精确ID/PID/birth/几何仍分别核验。

Windows模型由Mac个人Harness通过标准paired桥操作远端Windows自有fixture，**不代表Windows本地Harness模型推理**。owner一次授权由独立测试驱动模拟，不称真人点击；没有搬运凭据或改变个人默认模型。Harness本地TCC与provider内部图像处理／wire不由本轮推导。通用转录说明只解释标点与软换行，不注入nonce或期望答案、不归一化文字，不保证任意模型100%完成。

旧四轮Mac失败和旧ARM f48失败保持原状态。旧HUMAN_INPUT_INTERRUPTED事件来源、silent pointer唯一原因仍未确定，新通过不倒推旧失败已修复；原恢复成功字段也不被泛化错误标签覆盖。

本轮逐项独立复核：

- Mac：review（证据位置：`独立复核/真实DeepSeek-Mac-最终两阶段-3a332a00-通过-20261025/独立复核.json`），SHA `e50934bd4715790d2b78a7cec93e97886ede118a8a392166ca886f261aec5b20`。
- ARM64：review（证据位置：`独立复核/真实DeepSeek-Windows-arm64-当前两阶段-254f5296-通过-20261025/独立复核.json`），SHA `a39142973e3e286732bc3fd886e2b96ccf58e2fd4aca04e9fd8a511129189c57`。
- x64：review（证据位置：`独立复核/真实DeepSeek-Windows-x64-当前两阶段-6d6545af-通过-20261025/独立复核.json`），SHA `11f67c81f586c1443577416d6cb74bf5312e2c865ca325ff610f1c9298de2c6c`。

总汇：真实模型九项汇总（证据位置：`报告/最终真实DeepSeek九项汇总-20261025/真实模型九项汇总.json`），SHA `e26ac79aace23bb6c0f598823fcf08c48ee79eaea942bbb5255880263fc7ff5e`。
<!-- CURRENT_MODEL_UNIT_END -->

## 明示的生命周期与仪器限额

| 层级 | 当前合同 |
| --- | --- |
| 输入释放 | Dispose成功才发exact-child inputReleased:true；只接受EOF后1500ms内一次true ACK。异常／false／迟到ACK不延长，未确认输入仍1500ms硬限。 |
| Windows电脑助手 | 输入确认后绝对总8000ms自然退出，另最多2000ms确认管道close；退出／关闭／资源结果均须通过。 |
| 浏览器资源 | WindowManager自然drain有界5000ms；错PID、未知初始化、仍活或输出失败不报成功，无kill兜底。 |
| 会话助手／Host | Session Windows6000ms、Mac1500ms；Windows Host整体正常EOF为12000ms；行解析器到close才关闭保留尾行。 |
| 清退前元数据 | 仅Host树、浏览器树两次cleanup-only查询各2→5秒，最多增加6秒，受原720秒wholeguest余量限制。普通tree/pin/listener/retired与reader EOF仍2秒。 |
| 完整正文 | 每次UIA Read1500ms、两个稳定帧及总35秒门不变。共享FD／128bit文件身份锁和每phase全量SHA；64KiB顺序CNG不跨Read缓存。 |

上述包含真实生产生命周期变更和独立取证吞吐修正，不能称“所有时限不变”或“原30秒cleanup父deadline不变”。报告后的独立清退30秒不是两次树查询的父deadline；Exit0、allpins退净与无强停等成功门均保留。

## 历史组件复用范围

既有真实DeepSeek九业务成功保留当轮独立绑定：Mac原630602/f5f为3/3、25请求／104 schema，ARM原876ac7与x64原97f381各3/3、24请求／98 schema。它们证明当时组件与配对路径，**不是当前a2b7/7170/baea三整包真实模型再次通过**。当前Host、agent及Windows生命周期已更新；Mac69a输入组件相同也不自动迁移整轮结论。三个原复核及原图索引列在项目外证据清单。

H5三端各7/7、H6双Windows各7/7，H2/H3/H4/ANN02原7/5/7/7、双架构微软拼音IME5各5/5与34HID、Windows52项及指针29项、manager11项、Windows→Mac reverse9均按各自归档／组件来源保留。它们不扩成当前新PE与Host逐项重跑。旧失败、unknown及not-run均保留原报告。

同组件长稳为Mac WK30分钟／5次恢复14门（20923帧，11.6229fps，P95 101ms）和Windows ARM64/x64各30分钟／5次恢复（12.5442／13.3087fps，P95 91／48ms）。capture-only不是物理HID延迟，也不扩为当前新PE长稳。实际Mac在ARM64机器运行universal包；Windows x64在Parallels Windows ARM64兼容层执行，未证明实体Intel/AMD Windows。

历史九业务独立回执（只作为历史组件）：

| 当轮组件 | 原独立复核 |
| --- | --- |
| Mac 原630602/f5f | review（证据位置：`独立复核/真实DeepSeek-Mac-当前f5f-47910222-20261025/独立复核.json`） · SHA `62e51a22c87b338a04ef422c2c9026b5572410c8837f8e0ef02c9699fb5b9fab` |
| Windows ARM64 原876ac7 | review（证据位置：`独立复核/Windows-arm64-当前预热模型876ac7-20261025/independent-review.json`） · SHA `0d75bb2ede1ba91eee053203712992efbe3d1d63cd9d47c649980e4e0cc12d78` |
| Windows x64 原97f381 | review（证据位置：`独立复核/Windows-x64-当前预热模型97f381-20261025/independent-review.json`） · SHA `8ba662f244dbdb33508754377ec2015549d242c3e14a399404188749736a35b6` |

## 来源、构建与完整回归

产品28路径完整单位已本地中文提交 **59ada5a595d43e1019eb1c9e2f6852e263b0d479**（分支codex/cross-platform-computer-use，未push），提交不改变归档字节。该提交时的wholeVisualAcceptancePassed=false保留；随后当前三端完整12通过由新回执证明。

第二轮direct suite实际 **2640/2640，206文件，fail/cancel/skip/todo均0**，执行前后783源稳定；165生产输入write:false重建三产物exact、0warning；8组类型检查全部exit0、日志0字节、783源稳定。原构建清单与回归清单只有明确四项test-infrastructure delta，165生产与30native/包字节未因此改变，旧首轮红日志保留。

回归永久目录：第二轮完整回归（证据位置：`报告/两阶段输入释放与窗口自然退出-最终回归-第二轮-20261025`）。suite SHA `0f190add5c46da8ad2a5de341ab50d7fa97897b2e15c6e8789ecdbcb1f889130`；165构建 `f11385b525d22b069c52699eed198533ef3296d047832f1dfd3917fb1ebb2b56`；8types `5db5e6e815566d2b0eeadb5f2e8991514ec74931afa5dcde23c780b11690e189`。

本轮报告是测试快照后的文档更新；交接须列出两报告与CHANGELOG的before/after映射，不声称最终783全树字节从未变化。README与包内guide未改；CHANGELOG只整理摘要并折叠保留原开发正文。产品165和30native未编辑，最终三路径均不在19成员包内。

## 证据索引与最终交付

| 当前证据 | 项目外独立回执 |
| --- | --- |
| Mac 完整12 | review（证据位置：`独立复核/Mac-a2b7f4-完整12项-dd7a002f-20261025/review.json`） · SHA `88098240fe20fbd7a240a60c2845322e42b0a0a7a5f8441afb2d94e997602bf2` |
| Mac 安装5 | review（证据位置：`独立复核/Mac当前a2b7f4官方安装5项-ce47cf78-20261025/review.json`） · SHA `66f720f08594aceff79b0e146b85deba10d9dc62d3def684c7aa9f3696b9d5e3` |
| ARM64 完整12 | review（证据位置：`报告/Windows-ARM64-当前两阶段完整12项独立复核-d8cca310/binding-and-timing-proof.json`） · SHA `b85997c9a7dce99b3c5b3fafd5aa1551ef856f60b833a582cb4802f0611a72e7` |
| ARM64 安装5 | review（证据位置：`报告/Windows-ARM64-新包安装5项-原终态离线重新评估-6ac0e4cd/review.json`） · SHA `f38bd388b5b54ecc79b3ddb2609b304ad8eeebee90595ba369da4fb1a931ece3` |
| x64 完整12 | review（证据位置：`报告/Windows-x64-当前两阶段完整12项独立复核-4b0ad237/binding-and-timing-proof.json`） · SHA `9ae9ec2a59cde4d0ed7769754a0f20a8673cb7d2fc95905f0128bbcc14bb1d62` |
| x64 安装5 | review（证据位置：`独立复核/Windows-x64-两阶段新包官方安装5项-33c3fcbf-20261025/review.json`） · SHA `eff7aeaf4ff308ebfbf88b1c9bcc950294d9608b604146b0860792adbcfae64d` |

当前成功图库：最终候选图库（证据位置：`成功截图/最终候选-20261025/index.html`），31组／410条记录／320种内容，本轮当前三包验收范围complete=true，历史组不扩为新整包重验。Mac39与ARM/x64各31原图分别按当前包标注，旧组保留历史标签；失败轮不会并入整轮成功组。

完整历史正文在项目外before副本按原字节保存；当前正文不沿用22/23日“仍待验”段落作为现状。原始日志、失败索引、frozen entry／FROZEN manifest及所有图片均保留项目外。Windows完整UIA三源不包含在公共repo，复现须相应永久frozen载体绑定，不能只给/tmp路径。Mac只读AX采样源码／已有编译与当前原图证据另有绑定，不修改产品。

本轮验收和最终环境恢复已完成，文档Git提交与测试后三路径映射以最终交付回执为准。PD pause-idle原on与原全屏状态已恢复，Mac唤醒租约正常释放、原两PID fresh absent，电源preferences未改。最终恢复0signals仅指本次恢复，不覆盖历史正常SIGTERM例外。

旧失败分层与历史来源SHA另见项目外证据清单（证据位置：`报告/当前两阶段三端视觉与模型报告草稿-20261025/evidence-index.json`）；本次更新前的报告全文也在该目录before/保存，旧failed原始报告未改。

最终三包57成员原字节核验：交付包核验（证据位置：`报告/最终安装包交付核验-08756763-4b2d-45e3-bf0c-fb1cc760fe71/final-package-verification.json`），SHA `3b9dc380a5afa6bc192ce01aa8c26659e07f83f9edced6fc717c5fc40cc5da40`。

最终环境：正常恢复回执（证据位置：`报告/最终环境恢复-20261025/final-restoration.json`），SHA `692e93b0daeb29bd68c657d107ed96412ba41040f48acc04c08389a7549c66ad`。
