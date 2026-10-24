# Windows 真实视觉验收的异步只读身份批次

旧测试桥每次 status 同步启动两次身份 PowerShell，并在自然授权前再同步读取桌面。实际 x64 中约 4.3–4.5 秒占满原 control 5 秒门，阻塞 Node 处理原生 targets 回调。这里仅修改验收载体，生产插件和原生输入协议不变。

每个检查单独生成 requestId/nonce，异步排队运行一份 PowerShell 批次。批次内两份原身份脚本和可选原 Desktop 审计逐字保留；不得缓存/合并或忽略 leaseFree=false。串行只读批次也避免两次 FileShare.None 探测互相制造锁占用。每个设备动作前仍等完整 fresh 检查，unknown 后拒绝新读与输入，不发送信号、不重试未知查询。

17 个纯 Node 测试覆盖原算法兼容、request/nonce、两实际子进程的异步队列、主循环回调、无重叠锁探测、迟到自然退出仍 unknown、排队请求不在 unknown 后派发、输出上限和自然非零退出。测试无需 Windows/PD/GUI/Host/模型。

2026-10-25 主代理已在 Windows x64 兼容运行的独立零 GUI/零输入 smoke 实测：5 个 fresh 样本均在原 5 秒内，两个并发请求中第二个含排队 3.382 秒，两个自有子进程自然退出，原 10 pins 全退，两 Task 精确自然 Ready0 注销。原 a669 失败不改写；该证据只证明读取桥，不等于真实模型三任务通过。完整真实模型、逐功能视觉、安装恢复须另有本轮回执。

后续 ARM64 `80327956` 的三项真实业务与整个载体退出流程通过；严格零工具错误门另有一次已恢复的 act 错误，整轮仍 failed。参见 `windows-real-model-final-evidence-batch.md`，不得将读取桥修复当作所有验收完成。
