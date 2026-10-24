# H4 画面与网页元素批注

工作台“批注画面”入口冻结当前已授权目标的实际画面。用户可框选、画箭头、写文字，或在普通网页的主文档中点选真实 DOM 元素，然后显式发送到当前聊天。编辑时卸载该工作台的设备输入画面，控件与地址栏停用；绘图只改变本地 SVG/Canvas 草稿，不把鼠标、滚轮、键盘或输入法事件发送到被控应用。取消不会给模型发消息，也不改变模型当前选中的目标。

## 实际来源和失效

Host 为现有已授权的浏览器目标新建独立的 flattened CDP 只读会话，不启动或授权另一个浏览器。真实 frame/loader/history 身份、layout/visual viewport、文档 backend 身份，以及 Host 创建的 isolated world 中的 MutationObserver 与被动 scroll/resize 计数，共同生成不透明版本。监听器不改页面 DOM、样式或主文档 JavaScript，不接收模型代码。即使滚动后回到原处或同样外观的节点被替换，版本也会变化。

截图前后各核对一次真实版本，变化则拒绝这一张截图，不重拍来掩盖冲突。后续采样 frameId 不同但像素和版本完全一致时，只用来核验原始冻结画面；不会把新帧假称为旧帧。图像、chat/env/view/target/app/epoch、几何、DPI、原图宽高和 JPEG SHA 均不可变。编辑器每 500ms 只读复核，提交前再核验；导航、滚动、缩放、DOM、像素、窗口几何、权限或归属变化后草稿失效，不能复活旧坐标。

原生桌面使用真实现有工作台预览和窗口 epoch/几何/像素校验，不伪造浏览器 document/scroll 证明。主文档元素选择通过真实 DOM.getNodeForLocation、同一隔离世界的原生 Element 几何读取和仅该节点的 partial AX 名称完成。backendNodeId 与选中节点身份仅留在 Host 内；客户端只能收到不透明元素 ID、角色、名称、原图矩形。不会透传 AX.value 或整页 AX 正文。跨 frame 的元素及 pinch/偏移 visual viewport 暂时明确提示使用框选，不猜测坐标变换；区域截图仍受全部已捕获 frame 的版本约束。

## 当前聊天与提交

只注册 owner-only `qiuya-tools.annotations` 公共 RPC，不给模型提供截图核验或自报成功入口。每个请求核对实际 connection、peer、principal、当前聊天查询、request/lifetime/scope signal，并在 reader 和设备 await 前后复核。Body 最多 32KiB、读取 2 秒、操作 15 秒。更换成同 kind 的 owner 对象也无法读取旧 lease。最多 8 个编辑器、64MiB 临时图像缓存、每张 120 秒；原生和网页的撤权、停止、窗口替换都会使读取失败。

草稿只留内存，提交前不进入模型或磁盘。用户点击“发送到当前聊天”（或非输入法组合态 Ctrl/Cmd+Enter）后，先导出本地 PNG、校验 PNG SHA/IHDR 和当前源，再调用实际公开 `sessions.binding(sessionId)` 的同一个 `SessionBinding.session.beginSubmission()` 与 `session.prompt(text+image, 'queue', signal, requestId)`。不使用私有历史追加接口，不修改聊天输入框或模型配置。

单次处理最多 15 秒。prompt 发出前设 issued 围栏，未知 ACK、超时、关闭或断线均不重放。发出前取消仅撤销未发送的本地 echo；发出后不声称撤回。`accepted:true` 不等于已发送：只有同一真实事件源中新 seq 的 user/message、source.kind=user、完整 nonce 文本和持久 image attachment 引用吻合，才显示已发送。Host 可以正常规范化图片，不能谎称持久 attachment 字节与原始 PNG 一致。未见持久回执时保留未知并提示查看原聊天。

编辑器关闭、导航、安装失败或插件卸载会撤销自身能力，取消计时器，释放自己的监听器/object group/CDP 会话。等待中的 acquisition/read 也纳入退场等待；未知 cleanup 保留为失败，同一次 close 不重发命令。仅真实 execution-context 退场或精确所属浏览器进程已退出能证明 realm 消失，socket 断开本身不能当作已清理。

## 自动化与实际验收界线

当前 167 项自有回归覆盖不可变来源、真实 React/JSDOM 编辑、真实 isolated-world JavaScript 监听器、fake CDP 事件与协议、替换节点/滚动回原处、旧 owner/聊天/帧拒绝、迟到创建和读取退场、一次提交与持久回执、公开工作台入口和安装回滚。JSDOM 几何、CDP、Image/Canvas 与模型是明确测试替身，不是实际浏览器或像素视觉证明；没有启动 Host、浏览器、PD、模型或发送系统输入。与工作台、浏览器、验收记录联合回归 670 项通过。

常规 typecheck、`tsconfig.annotations.json`（真实公开 Session/Client SDK）与 `tsconfig.annotations-host.json`（真实 Host SDK）均使用 skipLibCheck=false 独立检查通过。三个生产入口仅 write:false，在项目外临时目录生成，不写正式 lib。新候选仍须实际 Harness/浏览器、Mac/Windows、真实 PNG 解码与模型接受图片的验收，不能继承单测作为完成证据。字体/间距/颜色的临时样式反馈 ANN-02 是后续增强，不在本次画面批注补丁中。
