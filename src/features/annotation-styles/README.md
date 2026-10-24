# ANN02 临时字体、间距和颜色反馈

在工作台冻结画面中通过“网页元素”选取一个真实元素后，“样式反馈”可读取这个元素当前的字体、字号、字重、行距、字距、文字/背景颜色和四边内边距。Host 在已存在的只读 isolated world 中执行固定的原生 `getComputedStyle` getter；不接收客户端 selector、CSS、JavaScript 或 backendNodeId。读取前后都核对 exact backend 元素、文档/导航/滚动/viewport 版本与原始截图像素、几何、权限、owner、chat/env/view/target/epoch。

结果仅含11个限定属性和原始 capture/opaque element 身份。owner-only 原有批注 RPC 新增 `styles`，仍使用15秒操作、2秒/32KiB body、120秒 capture TTL、8 leases、64MiB临时图像上限。未选取的元素、复制的旧ID、被释放的capture、迟到owner/scope替换、导航或像素变化均不能返回基线。桌面窗口不伪造 CSS 支持。

编辑面板只改变插件内的本地文字样例；不修改目标网页的 DOM、CSS、布局、输入或源码。原网页属性显示在每个字段下；本地字体默认使用系统字体，用户可比较系统/衬线/等宽预设。可编辑范围为字号8–72、字重100–900、行距0.8–2.4、字距−2–8px、内边距0–64px和限定颜色。样例是纯文本，不克隆目标DOM或加载网页资源。

“加入本次批注”只加入本地草稿，0模型调用、0消息、0设备动作。建议与原来的元素标记绑定，撤销该元素也会移除建议；最多8个当前元素建议。原H4最终“发送到当前聊天”才通过公开 SessionBinding 发送图片和明确写着“尚未修改页面或源码”的属性前后对照。最终核验仍包含元素opaqueID，accepted不冒充durable，未知请求不重放。取消本地样式或整个批注都不会自动提交。

当前测试包括实际React/JSDOM编辑、本地样例/外部DOM不变、固定getter在真实JSDOM realm执行、fakeCDP协议与延迟变更、真实 buffered Host Request→client RPC联合闭环、旧owner/lease/element、撤销/取消和最终草稿说明。布局、CDP、trusted事件和模型替身不代表实际浏览器/设备视觉通过；root仍需新候选和原生Harness实际验收。本补丁只完成离线代码、测试、类型与write:false构建，不发布也不产生个人页面截图。
