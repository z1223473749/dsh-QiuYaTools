# Windows 多会话原生验收载体

这是隔离的测试载体，覆盖默认 ComputerEnvironmentManager / ScheduledComputerDriver / NativeCompanionDriver 和真实 WebView2。生产代码、原生二进制及用户的 Harness 配置不由本载体修改。使用者应显式提供两个候选包、官方固定 Node ZIP 和新的项目外输出目录。没有隐式历史临时目录或旧包兜底。

## 证据范围

本单元已对当前 Windows ARM64 和 x64 候选分别实际完成原11检查点：两会话 ready、并行观察、FIFO、原1Down/1Up、生产 helper grant/release/ticket关联、逐动作释放、原生弹窗、A停靠不打断B拖动、同owner held前后真实物理帧中的专属指针、单独关闭A保留B、停止双方释放输入。两个架构均在 Parallels 同一 Windows 来宾实测；x64是该来宾的兼容执行，不等同物理 x64 PC。

初始条件是独立命名的 `owned-foreground-credit-before-business`：当前自有 fixture B在确认held0、leasefree、无journal、精确PID/birth/path/SHA/交互桌面与两native身份后，仅向同一次运行的自有A发出一次精确前台资格，A正常Activate一次，再独立确认A真正前台和所有物理序列未改变，之后才开始原11业务。该阶段没有SendInput、鼠标/键盘伪造、业务action或session.start。它不能写成真人CUA标题栏点击、自动取得任意应用前台、或已安装Harness owner鉴权证明。旧严格CUA初始失败仍应保留在外部报告中。

真实物理帧只发起一次prlctl capture。完整PNG header/IEND发布与稳定的原FD先于原held-after门；同一捕获客户端必须自然0后才允许完整读取、解码和自有蓝底crop像素分类。不会用缓存预览、窗口capture或人工合成替代。完整桌面原帧在分类后删除，报告只保留自有crop与字节SHA。

observer错误仍是失败。本单元仅为错误加上有界operation/context/phase/PID/wait/HRESULT/系统错误码，不记录异常原文、输入内容或任意路径，最多16条，溢出单独计数；不会吞掉未知PID、重试输入、忽略清退或调高预算。双架构本轮未复现旧ARM observer异常，不宣称已经修复旧错误。

5个原始子进程通过原handle及精确证书自然退出。若仅Node自身的唯一launcher console暂待，保留内层 `pending-outer-retirement` 和 `delivery-verdict.passed=false`，必须由Node自然0、独立后置observer held0/free/无journal、同PID/birth/path/SHA的console已退场、两owned Task Ready0并精确注销共同收口。不可把pending、null或失败改为0。

## 可复现准备

安装项目锁定依赖后创建项目外JSON配置：

```json
{
  "repository": "/绝对路径/当前生产源码",
  "candidates": {"arm64": "/包目录/arm64.tgz", "x64": "/包目录/x64.tgz"},
  "nodeZips": {"arm64": "/官方Node目录/arm64.zip", "x64": "/官方Node目录/x64.zip"}
}
```

```sh
node scripts/prepare-windows-multitask-acceptance.mjs --prepare --input-config /项目外/config.json --out /项目外/全新准备目录
node /项目外/全新准备目录/entry.mjs --arch arm64 --plan
```

prepare先实际读取全部相对导入、fixture、observer与锁定依赖中的PNG helper，缺任一项即本地拒绝；随后write:false编译16文件生产运行时闭包、核官方Node ZIP与两包的原生PE架构/SHA并冻结。生成的正式入口及所有文件/生产源/载体源均有字节绑定。`--plan`不访问PD、不编译C#、不创建Host或HTTP listener。明确选择独占PD时段后，实际运行入口才接受 `--run --root-approved --arch arm64|x64 --vm <UUID> --host <来宾可达地址> --out <全新项目外证据目录>`；该动作会启动来宾fixture和实际输入，应由调度实际验收的主执行者运行。

## 本地回归

```sh
node --test tests/windows-multitask-runner.test.mjs tests/windows-multitask-observer-diagnostics.test.mjs tests/windows-multitask-owned-startup.test.mjs tests/windows-multitask-carrier-closure.test.mjs
```

90个纯测试通过，其中保留原19个公共门，新增startup拒绝向量、真实惰性Node JSONL子进程自然EOF、0网络导入/正式冻结入口canary和实际文件系统缺依赖检查。测试不编译Swift/C#，不触碰GUI、PD、模型或系统输入。受审原11业务区、清退判据和C#精确handle门有独立golden片段SHA；生产源码不作test-only替换。完整实际原图和原始报告留项目外，不进入Git。
