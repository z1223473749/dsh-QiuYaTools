# 当前网页的有限诊断（H5）

用户可以在会话里要求“检查这个页面为什么失败”。主 Agent 先用现有网站授权和工作台选择当前网页，再通过 `qiuya_browser_diagnostics_request` 请求独立的开发者诊断许可。网站访问许可不隐含该许可；本次允许只覆盖捕获的 root Agent、真实 service/environment、tab、origin 和 epoch，最多 120 秒。工具不接受聊天关联、授权 bool、任意脚本、日志正文开关或最终验收状态。

允许后，在同一 BrowserSession 的连接上新建独立 flattened CDP session，为该 session 启用 Page、Runtime、Network。它不会创建另一个浏览器，不改变 H4/原页面控制 session 的域状态，不发送业务输入。启用期间的历史 Runtime 消息不收录；延迟的旧 Runtime timestamp、旧 request wallTime 也不会成为当前诊断。导航、执行上下文清空、连接关闭或授权漂移会停止订阅。关闭只解绑并 detach 自己的 CDP session，不关闭用户网页。detach 回复未知时立即停止事件收集，但保留该订阅 pin 并显示清理未确认，不自动重放 detach；结束整个浏览器连接才清除这项 pin。此失败不阻止既有业务输入释放，不能把订阅停止冒称浏览器或输入退场已确认。

默认记录完全为 metadata-only：console 的级别、参数类型和数量；未捕获异常的有限错误类别；同源网络请求的固定方法、HTTP 状态、有限失败枚举、耗时和路径 SHA-256 的 16 位摘要。控制台原始字符串/对象/堆栈、URL query/fragment/userinfo、原始路径、请求头、Cookie、token、请求/响应正文都不进入日志。跨源请求不收录；丢弃数明确显示。此次不提供任意模型 evaluate、请求重放、DOM/CSS 修改或完整 DevTools。

每个采集会话最多 128 项和 32 KiB，最多 128 个进行中的请求；全局最多 16 个待授权、32 个保留会话，每个 Agent 的工具调用去重最多 128 项。停止、撤销或功能关闭不重放任何业务输入；owner 撤销/身份漂移清空已保留摘要。记录只保存在当前 Host 内存，不持久归档浏览器活动；重启后不自动恢复采集。

H1 的 Host-only 同步关联索引只发布最后提交且仍活跃的检查点。每次 CAS 前删除旧投影，CAS 成功并通过原身份围栏后才发布新投影；每条诊断事件用真实当前 Agent/environment/target/epoch 查当时 open attempt。无可确认的唯一检查点时不附会步骤。模型无法提供 run/check/attempt ID，也不能把诊断日志作为独立 passed 证据。此索引不写存储、不改 H1 verdict、不替代图片或业务校验器。

聊天里只在等待许可时显示允许本次/拒绝卡，采集时显示小入口。详细摘要使用公开 sidebar tab/resource/slot；支持错误/网络筛选、丢弃数、停止并清空。header 状态只传计数，不周期传全量日志；详情只读当前选中的一个采集会话。隐藏页签与功能关闭不轮询，不逐帧添加附件。Owner HTTP 请求的结束与独立采集许可生命周期分别处理，保留 exact connection Service / peer / principal 及公开 SessionQuery scope 围栏。

精确暂存快照的714项相关回归（零跳过）、普通类型检查与实际公开SDK的Host严格检查通过；三入口生产构建和Mac universal、Windows ARM64／x64归档校验通过，保留原64 MiB安装限制。离线验证覆盖真实Cordis ToolRuntime、HostConnectionService、Request streaming、React/JSDOM、H1文件存储及受控CDP传输。完整客户端SDK检查仍有既存外部声明缺口，不记为通过。

Mac实际Harness七项闭环通过：网站允许不代替独立诊断许可；真实浏览器事件产生有限console、TypeError与HTTP 200／404元数据；拒绝不订阅；页面导航停止；owner停止清空；网站撤销停止；五聊天目标与检查点隔离。无业务校验器的H1仍为inconclusive，诊断不制造passed。五个自有Agent空闲、队列及工作台环境归零，Chrome与Host正常退出，零OS输入。此轮使用确定性SDK适配器，不能计为真实DeepSeek或Windows视觉成功；HTTP 503、连接失败及慢请求的实际双端覆盖继续单列。

实际窄聊天复验暴露的小预览越界已修正：按当前会话容器与视口交集限制位置，并响应分栏及容器平移；保持300×180满幅、悬停控件与独立浮窗。诊断许可卡始终完整显示在预览上方；未知授权结果的错误不会被后续成功轮询清除。最终授权卡、诊断摘要与撤销状态三张截图均经肉眼复核，保存在项目外。验收证据位于`/Users/qiuya/QiuYaTools-验收/2026-10-22/报告/H5-网页诊断与会话预览-20261024/`，成功截图位于同根目录的`成功截图/Mac-H5-网页诊断与会话预览-20261024/`。最终候选Mac SHA-256为`267f76709c648d120d2cd53d5e92d6286a2656e841aa19b416dcd71a87676231`；Windows包仅完成构建校验，未继承本轮Mac结果。真实模型仍沿用原每任务12轮／180秒，不重放未知动作。

CDP 参考为官方 [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)、[Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) 和 [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) 协议。H4 负责只读元素与画面批注，H5 此阶段只完成 DBG-01/DBG-02 的有限诊断，DBG-03 的进一步 CSS/性能分析没有虚构为已交付。
