# 小预览的当前会话边界

H5 的首轮实际 SDK/UI 验收在第 5 项失败：打开网页诊断右栏后，聊天区域缩到 x280…792，而原 300×180 小预览仍按整个窗口保持 x1084…1384，盖住右栏“停止并清空”。原失败报告保留；此改动的实机结论待新包复验。

Workbench 和旧 native Inline 现在共用不含 Host、frame 或设备能力的 `inline-bounds.ts`。它沿当前预览 anchor 找最近的官方主会话 `data-phase=hero|active|settling` 根，并以该根内部唯一的 `[data-conversation-content][data-conversation-session]` 精确聊天身份作布局归属证据。布局域为这个根的实际矩形与 viewport 的交集，不依赖 SDK 哈希 CSS 类。识别到另一聊天或歧义内容时隐藏预览；只有缺少可识别官方根的自定义扩展布局才沿用原 viewport 兼容行为。

保留 300×180 矩形、画面 cover、边界阴影、hover 控件、正常拖动与键盘移动。正常有空间时不缩放框；窄或短 pane 按当前矩形设置 maxWidth/maxHeight，防止越过会话边界。布局变化只更新坐标和尺寸上限，不发送观察、授权、control 或 humanAct。

ResizeObserver 同时观察该会话根、card 和 anchor，侧栏/分栏缩放无需 window.resize。有限布局 MutationObserver 观察根附近与祖先的 class/style、内容身份与结构变化，配合 capture scroll 覆盖根宽高不变但位置平移的情况；读取当前几何后仅在坐标或上限确实变化时更新 React 状态。卸载会断开全部观察者和事件，已排队的迟到 callback 也不可再更新。

原 `clampInlinePreviewPosition` 导出仍保留，用于明确只有 viewport 的既有调用者；Workbench 不再为了这一个纯函数依赖整个旧 Inline UI 模块。

离线新增纯 DOM/几何反例和真实 React 测试：两种原 UI 在原实现中均复现缩窄/平移 4 项失败；修复后覆盖官方三阶段、viewport 交集、未知自定义布局、外聊/重复/嵌套归属拒绝、极小区域、观察者退租、无 window.resize 的重夹紧、外聊隐藏和身份恢复，以及正常键盘/拖动不越界、零 device control。JSDOM 几何替身不等于真实浏览器视觉验收；由 root 独占新候选完成同原 H5 7 项实测。
