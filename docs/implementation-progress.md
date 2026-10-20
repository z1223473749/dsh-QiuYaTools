# 双平台适配与电脑操控实施记录

本文件为 2026-10-21 的证据快照。分支 `codex/cross-platform-computer-use`，版本 `0.6.0-beta.1`。已完成步骤分别使用中文 Git 提交；没有 push、Release 或 npm publish。生产源码冻结于 `3c924d0`，发布编译产物与资产回执绑定 `3c6e865`，后续测试和报告不改变安装包。

详细结果见 [测试报告](computer-use-test-report.md)，范围与原始门槛见 [开发计划](windows-and-computer-use-development-plan.md)。`passed` 只覆盖该行列明环境；`failed`、`blocked`、`not-run` 均不计为完成。基础交互已有实际可安装包，整体尚未通过“全部功能跨平台、完全复刻”的验收。

## 阶段进度

| 阶段 | 状态 | 已取得证据与剩余门槛 |
| --- | --- | --- |
| P0 基线与环境 | passed | 初始基线393项；最终Mac完整check 517/517。Windows实际Node22.23.3全量517项中513 passed、4个Mac-only skipped、0 failed，旧归档fixture与文件交换35项均纳入 |
| P1 原有功能Windows适配 | blocked（完整矩阵） | 平台资产、PE/架构/协议、原生分窗已实现。最终Windows真实Harness12/12；Mac历史解锁时10/10；微软拼音硬件输入5/5。全部DPI、窗口恢复、OS剪贴板、盘符/UNC、AltGr/死键等未完整验收 |
| P2 会话与输入控制核心 | passed | 类型化协议、授权、会话隔离、互斥、epoch、去重、取消/暂停/接管/继续、几何校验、失败撤权/释放/迟到连接等回归纳入517项；过期自动pause不能停止新任务 |
| P3 主Agent与图像 | blocked（真实模型） | 双端实际SDK工具、附件与adapter运输通过；Mac实际3次带图请求/4图片块，Windows最终Host亦有带图与native动作。确定性provider不证明视觉推理；当前缺少已证实可用的图像模型 |
| P4A Mac原生执行器 | blocked | ARM64历史原生11项、通用构建/自测通过；新guard只读/互斥/转移/空租约崩溃恢复4项通过。真实按住后崩溃恢复未完成，最新桌面锁屏；Intel与最低系统未实测 |
| P4B Windows原生执行器 | passed（列明范围） | PD Windows11 ARM64最终helper 52/52、实际Node隐藏启动5/5；真正按住后mouse-up 30次P95 21.7592ms/最大24.1073ms；截图8项含14项子进程故障及20不同动画帧。x64 helper在ARM来宾转译下完整52+隐藏5通过，仍不是原生x64硬件 |
| P5 悬浮实时预览 | blocked（Mac完整验收） | Chromium生产前端17/17；Windows最终包真实WebView2手动预览/四按钮及中文输入通过。位图资源、旧手势、迟到解码与自动暂停竞态已修复。最终Windows renderer30分钟尚在运行；Mac长稳failed后被锁屏阻塞，新canvas的WKWebView需解锁重验 |
| P6 独立环境 | blocked（反向实机） | Mac→Windows最终原生15/15，配对/撤权/心跳通过。手动文件交换35项、真实NTFS10/10、实际Host UI 8MiB上传/下载与同名拒绝通过，文件分支native调用为0。Windows→Mac因Mac锁屏未发送输入，不用回环替代第二目标 |
| P7 浏览器通道 | passed | Mac Chrome与Windows Edge各10项实际浏览器检查；独立持久profile、显式CDP、站点许可、导航/标签页、Agent注册及失败释放回归。没有随包日常profile浏览器扩展，真实视觉推理由P3另验 |
| P8 安装与更新 | passed（本地测试包范围） | 最终Mac包e528ed96…与Windows ARM64包ab9d9b12…各官方管理器安装/升级保留设置/坏包恢复/回滚/重装5/5。三包严格版本/协议/架构/hash/大小及隔离Host加载通过。CI未远程执行，正式签名、公证、公开发布not-run |
| P9 完整验收 | failed / blocked | 历史失败保留；Mac长稳failed，后续Mac输入、反向目标与真实模型blocked。Windows最终长稳完成前不计passed；不能报告整体完成 |
| P10 Excel与锁屏扩展 | not-run，未实现 | 专用Excel加载项、macOS锁屏操控需独立实现和对应Office/系统会话环境；普通点击不替代专用扩展 |

## 主要修复及其依据

- 授权写入串行化并遵循最新意图；撤权立即停止输入，不等待磁盘写入；失败写入不会复活授权。
- 独立跟踪真实native lease epoch，保留失败释放与不确定获取；切换/卸载使用generation和取消信号，迟到连接不能重装执行器，退役失败在切换前重试。
- 双端桌面互斥、输入记录与guardian按owner隔离；Windows检查SendInput释放，保留Unicode scan unit；Mac真实持有输入后的恢复仍待解锁验证。
- 浏览器在down前记录释放义务，只有CDP确认up才清除；不确定释放阻止新租约，附着用户浏览器不强关进程掩盖失败。
- Windows截图隔离到无输入权的持久child；超时/协议损坏须确认退出，才允许一次只读重试；输入不重放。watchdog绑定PID及出生时间，避免遗留或PID复用。
- Windows隐藏启动恢复实际窗口显示；浮层按实际指针路径避让并持续可见，无安全位置在mouse-down前拒绝；hook消息线程与清理线程分离，实际mouse-up由约1秒降至P95约21.76ms。
- 图片绘制从每帧data URL改为ImageBitmap→复用canvas→finally close；旧周期解码/手势清除；自动pause携带expectedEpoch，不能误停新周期。真实Chromium17项包含23次bitmap创建/关闭及真实坏JPEG。
- 手动文件交换默认关闭，专用真实目录、8MiB/文件、SHA256、原子不覆盖、事务预算与到期清理。目录进程独占按系统明确确认的死PID回收；不确定状态不删除已发布文件，不向模型开放路径读写。
- 发布校验原生版本、协议、架构与hash；Windows分架构产包，未提高64MiB压缩上限。三个最终资产及各native组件SHA见delivery-manifest。

## 长稳结果与当前阻塞

1. Windows最终30分钟源画面→Edge renderer正在收尾，使用生产源码3c924d0、最终helper0eb1fb6a…和精确输入hash，门槛没有放宽。结果完成后写入测试报告；短测通过不能替代完整运行。
2. 历史Windows renderer完整30分钟画面指标通过但资源failed：既有PID复用误归属，也有真实自有进程超限。统计修复和图片/Blob对照后，采用位图释放修复；保留所有失败报告。旧native采集组件30分钟passed不是最终renderer全量证明。
3. Mac完整30分钟旧报告failed，显示器熄灭同秒源时钟冻结；fixture仅增加生命周期内防显示器闲置休眠和draw遥测，没有更改全局电源或登录。最新screenLocked=true、前台loginwindow，权限true不等于可输入。解锁后须重验Mac长稳、新WKWebView接管、真实持有输入后的guardian和Windows→Mac目标。
4. 真实视觉模型固定任务blocked。当前deepseek-flash配置及另一本机/v1/models 503不构成可用视觉推理证据。
5. 另需原生Intel Mac/Windows x64硬件、旧系统、全部DPI/物理多屏、AltGr/死键和完整路径矩阵。P10专用扩展及浏览器日常profile扩展仍未实现。

## 本地交付

- `artifacts/dsh-qiuya-tools-darwin-universal.tgz`：721,180字节，SHA256 `e528ed9663494d34fd133778ac4ec14442bb6528ba29a659dc6744f0b3d3c679`。
- `artifacts/dsh-qiuya-tools-win32-arm64.tgz`：62,725,509字节，SHA256 `ab9d9b12c2757b0ee717c2f091e75d11669724df1bd9bbd46de93f47287c3f20`；PD来宾使用此包。
- `artifacts/dsh-qiuya-tools-win32-x64.tgz`：66,978,296字节，SHA256 `54f25c87ed911ed91b293646c19da2b08dee518003dc514969c739308af176e7`。

均为未正式签名/公证的Harness插件tgz，本次没有公开发布。`dsh-qiuya-tools.tgz`仅为Mac通用包别名。正式运行前提和命令见[使用指南](computer-use-guide.md)。主要证据在`artifacts/computer-use/`、`artifacts/harness-e2e/`、`artifacts/install-e2e/`；历史候选另存`artifacts/pre-memory-candidate/`，不得把旧包测试误记到新SHA。
