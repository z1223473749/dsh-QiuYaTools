// src/features/computer-use/remote.ts
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

// src/features/computer-use/contract.ts
var ComputerError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ComputerError";
  }
};
function computerError(error) {
  return error instanceof ComputerError ? { code: error.code, message: error.message } : { code: "COMPUTER_FAILED", message: error instanceof Error ? error.message : "\u7535\u8111\u64CD\u63A7\u5931\u8D25" };
}
function requireIdentity(value, label = "id") {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) throw new ComputerError("INVALID_REQUEST", `${label} \u65E0\u6548`);
  return value;
}
function parseComputerAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComputerError("INVALID_ACTION", "\u64CD\u4F5C\u5FC5\u987B\u662F\u5BF9\u8C61");
  const input = value;
  const fields = /* @__PURE__ */ new Set(["kind", "x", "y", "toX", "toY", "text", "key", "deltaX", "deltaY", "button", "url", "selector"]);
  if (Object.keys(input).some((key) => !fields.has(key))) throw new ComputerError("INVALID_ACTION", "\u64CD\u4F5C\u5305\u542B\u4E0D\u652F\u6301\u7684\u53C2\u6570");
  if (!["click", "move", "drag", "scroll", "type", "key", "navigate", "openTab", "closeTab", "selectorClick", "selectorType"].includes(String(input.kind))) throw new ComputerError("INVALID_ACTION", "\u4E0D\u652F\u6301\u7684\u64CD\u4F5C");
  for (const field of ["x", "y", "toX", "toY", "deltaX", "deltaY"]) if (input[field] !== void 0 && (typeof input[field] !== "number" || !Number.isFinite(input[field]) || Math.abs(input[field]) > 1e6)) throw new ComputerError("INVALID_ACTION", `${field} \u65E0\u6548`);
  if (input.button !== void 0 && !["left", "right", "middle"].includes(String(input.button))) throw new ComputerError("INVALID_ACTION", "\u9F20\u6807\u6309\u952E\u65E0\u6548");
  if (["click", "move", "drag", "scroll"].includes(String(input.kind)) && (input.x === void 0 || input.y === void 0)) throw new ComputerError("INVALID_ACTION", "\u64CD\u4F5C\u9700\u8981 x \u548C y");
  if (input.kind === "drag" && (input.toX === void 0 || input.toY === void 0)) throw new ComputerError("INVALID_ACTION", "\u62D6\u52A8\u9700\u8981\u7EC8\u70B9");
  if (input.kind === "scroll" && input.deltaX === void 0 && input.deltaY === void 0) throw new ComputerError("INVALID_ACTION", "\u6EDA\u52A8\u9700\u8981\u8DDD\u79BB");
  if (["type", "selectorType"].includes(String(input.kind)) && (typeof input.text !== "string" || input.text.length > 1e5 || input.text.includes("\0"))) throw new ComputerError("INVALID_ACTION", "\u8F93\u5165\u6587\u672C\u65E0\u6548");
  if (input.kind === "key" && (typeof input.key !== "string" || input.key.length === 0 || input.key.length > 128 || /[\x00-\x1f\x7f]/u.test(input.key))) throw new ComputerError("INVALID_ACTION", "\u6309\u952E\u65E0\u6548");
  if (["navigate", "openTab"].includes(String(input.kind))) {
    if (typeof input.url !== "string" || input.url.length > 8192) throw new ComputerError("INVALID_ACTION", "\u9875\u9762\u5730\u5740\u65E0\u6548");
    try {
      const url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new ComputerError("INVALID_ACTION", "\u9875\u9762\u5730\u5740\u5FC5\u987B\u662F\u65E0\u5D4C\u5165\u51ED\u636E\u7684 HTTP \u6216 HTTPS \u5730\u5740");
    }
  }
  if (["selectorClick", "selectorType"].includes(String(input.kind)) && (typeof input.selector !== "string" || !input.selector || input.selector.length > 2048 || /[\x00-\x1f\x7f]/u.test(input.selector))) throw new ComputerError("INVALID_SELECTOR", "CSS \u9009\u62E9\u5668\u65E0\u6548");
  if (input.selector !== void 0 && !["selectorClick", "selectorType"].includes(String(input.kind))) throw new ComputerError("INVALID_ACTION", "\u8BF7\u4F7F\u7528\u6D4F\u89C8\u5668\u4E13\u7528\u7684\u9009\u62E9\u5668\u64CD\u4F5C");
  if (input.url !== void 0 && !["navigate", "openTab"].includes(String(input.kind))) throw new ComputerError("INVALID_ACTION", "\u9875\u9762\u5730\u5740\u53EA\u9002\u7528\u4E8E\u5BFC\u822A\u6216\u65B0\u6807\u7B7E\u9875");
  return { ...input };
}

// src/features/computer-use/native.ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
function computerCompanionPath(platform = process.platform, architecture = process.arch, base = new URL("./", import.meta.url)) {
  if (platform === "darwin") return fileURLToPath(new URL("./QiuYaTools Computer.app/Contents/MacOS/qiuya-computer", base));
  if (platform === "win32" && ["arm64", "x64"].includes(architecture)) return fileURLToPath(new URL(`./native/win32-${architecture}/qiuya-windows.exe`, base));
  throw new ComputerError("PLATFORM_UNSUPPORTED", "\u6B64\u7CFB\u7EDF\u6682\u65E0\u7535\u8111\u64CD\u63A7\u6267\u884C\u5668");
}
function ownedInputs(message) {
  if (!Array.isArray(message.keys) || message.keys.length > 256 || !message.keys.every((key) => Number.isSafeInteger(key) && key >= 0 && key <= 255)) return;
  if (!Array.isArray(message.mouseButtons) || message.mouseButtons.length > 3 || !message.mouseButtons.every((button) => ["left", "right", "middle"].includes(button))) return;
  if (message.unicodeUnits !== void 0 && (!Array.isArray(message.unicodeUnits) || message.unicodeUnits.length > 1024 || !message.unicodeUnits.every((unit) => Number.isSafeInteger(unit) && unit >= 0 && unit <= 65535))) return;
  if (message.ownerId !== void 0 && (typeof message.ownerId !== "string" || !/^[a-f0-9]{32}$/iu.test(message.ownerId))) return;
  return {
    keys: [...message.keys],
    mouseButtons: [...message.mouseButtons],
    ...message.unicodeUnits === void 0 ? {} : { unicodeUnits: [...message.unicodeUnits] },
    ...message.ownerId === void 0 ? {} : { ownerId: message.ownerId }
  };
}
var NativeCompanionDriver = class {
  constructor(options = {}) {
    this.options = options;
  }
  child;
  pending = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  buffer = "";
  disposed = false;
  nextRequestId = 0;
  protocol;
  retiring = Promise.resolve();
  held = { keys: [], mouseButtons: [] };
  static defaultPath = computerCompanionPath;
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  fail(error, child = this.child) {
    if (child && this.child !== child) return;
    const held = this.held;
    this.held = { keys: [], mouseButtons: [] };
    this.child = void 0;
    this.buffer = "";
    this.protocol = void 0;
    if (child) {
      this.retiring = this.retire(child, held);
      void this.retiring.catch(() => {
      });
    }
    for (const entry of this.pending.values()) {
      entry.clean();
      entry.reject(error);
    }
    this.pending.clear();
    this.emit({ event: "disconnected" });
  }
  async retire(child, held) {
    if (child.exitCode === null && child.signalCode === null && child.pid) await new Promise((resolve, reject) => {
      let deadline;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        deadline = setTimeout(() => reject(new ComputerError("NATIVE_CLEANUP_FAILED", "\u6267\u884C\u5668\u672A\u786E\u8BA4\u9000\u51FA\uFF0C\u5DF2\u963B\u6B62\u65B0\u7684\u7535\u8111\u8F93\u5165\u3002")), 2e3);
        deadline.unref();
      }, 1500);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(deadline);
        resolve();
      });
      child.stdin.end();
    });
    const args = this.options.releaseInputArgs ?? (process.platform === "win32" ? ["--release-input"] : void 0);
    if (!args || !held.keys.length && !held.mouseButtons.length && !held.unicodeUnits?.length) return;
    await new Promise((resolve, reject) => {
      const cleanup = spawn(this.options.executable ?? computerCompanionPath(), args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      const timer = setTimeout(() => {
        cleanup.kill();
        reject(new ComputerError("NATIVE_CLEANUP_FAILED", "\u6545\u969C\u540E\u7684\u6309\u952E\u6E05\u7406\u8D85\u65F6\uFF0C\u5DF2\u963B\u6B62\u65B0\u7684\u7535\u8111\u8F93\u5165\u3002"));
      }, 2e3);
      timer.unref();
      cleanup.once("error", () => {
        clearTimeout(timer);
        reject(new ComputerError("NATIVE_CLEANUP_FAILED", "\u65E0\u6CD5\u542F\u52A8\u6309\u952E\u6E05\u7406\uFF0C\u5DF2\u963B\u6B62\u65B0\u7684\u7535\u8111\u8F93\u5165\u3002"));
      });
      cleanup.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new ComputerError("NATIVE_CLEANUP_FAILED", "\u6309\u952E\u6E05\u7406\u5931\u8D25\uFF0C\u5DF2\u963B\u6B62\u65B0\u7684\u7535\u8111\u8F93\u5165\u3002"));
      });
      cleanup.stdin.on("error", () => {
      });
      cleanup.stdin.end(JSON.stringify(held) + "\n");
    });
  }
  start() {
    if (this.disposed) throw new ComputerError("DISPOSED", "\u7535\u8111\u64CD\u63A7\u6267\u884C\u5668\u5DF2\u505C\u7528");
    if (this.child) return this.child;
    const executable = this.options.executable ?? computerCompanionPath();
    const args = this.options.args ?? (process.platform === "win32" ? ["--computer"] : []);
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } });
    this.child = child;
    child.stdin.on("error", (error) => this.fail(new ComputerError("NATIVE_PIPE_FAILED", error.message), child));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > (this.options.maxMessageBytes ?? 48 * 1024 * 1024)) {
        this.fail(new ComputerError("NATIVE_MESSAGE_LIMIT", "\u6267\u884C\u5668\u54CD\u5E94\u8D85\u51FA\u9650\u5236"), child);
        child.kill();
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(new ComputerError("NATIVE_PROTOCOL", "\u6267\u884C\u5668\u8FD4\u56DE\u4E86\u65E0\u6548 JSON"), child);
          child.kill();
          return;
        }
        if (!message || typeof message !== "object") continue;
        if (typeof message.event === "string") {
          if (message.event === "inputHeld") {
            const held = ownedInputs(message);
            if (held) this.held = held;
          } else this.emit(message);
          continue;
        }
        if (typeof message.requestId !== "number" || !Number.isSafeInteger(message.requestId)) continue;
        const entry = this.pending.get(message.requestId);
        if (!entry) continue;
        this.pending.delete(message.requestId);
        entry.clean();
        if (message.ok === true) entry.resolve(message.result);
        else {
          const error = message.error;
          entry.reject(new ComputerError(typeof error?.code === "string" ? error.code : "NATIVE_FAILED", typeof error?.message === "string" ? error.message : typeof message.error === "string" ? message.error : "\u539F\u751F\u64CD\u4F5C\u5931\u8D25"));
        }
      }
    });
    child.stderr.resume();
    child.once("error", (error) => this.fail(new ComputerError("NATIVE_UNAVAILABLE", error.message), child));
    child.once("close", () => this.fail(new ComputerError("NATIVE_EXITED", "\u539F\u751F\u6267\u884C\u5668\u5DF2\u9000\u51FA"), child));
    return child;
  }
  async rpc(op, payload = {}, signal) {
    await this.retiring;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.size >= 128) return Promise.reject(new ComputerError("QUEUE_FULL", "\u6267\u884C\u5668\u8BF7\u6C42\u8FC7\u591A"));
    let child;
    try {
      child = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const requestId = ++this.nextRequestId;
      const timer = setTimeout(() => {
        this.fail(new ComputerError("NATIVE_TIMEOUT", "\u539F\u751F\u64CD\u4F5C\u8D85\u65F6\uFF0C\u6267\u884C\u5668\u5DF2\u505C\u6B62"), child);
      }, this.options.timeoutMs ?? 2e4);
      const abort = () => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        entry.clean();
        reject(signal?.reason ?? new ComputerError("ABORTED", "\u64CD\u4F5C\u5DF2\u53D6\u6D88"));
      };
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(requestId, { resolve: (value) => resolve(value), reject, clean });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.write(`${JSON.stringify({ requestId, op, ...payload })}
`, (error) => {
        if (error) this.fail(new ComputerError("NATIVE_PIPE_FAILED", error.message), child);
      });
    });
  }
  compatible() {
    if (this.disposed) return Promise.reject(new ComputerError("DISPOSED", "\u7535\u8111\u64CD\u63A7\u6267\u884C\u5668\u5DF2\u505C\u7528"));
    if (!this.protocol) this.protocol = this.rpc("status").then((status) => {
      if (status?.protocolVersion !== 1) throw new ComputerError("NATIVE_PROTOCOL_VERSION", "\u6267\u884C\u5668\u534F\u8BAE\u7248\u672C\u4E0D\u5339\u914D\uFF0C\u8BF7\u91CD\u65B0\u5B89\u88C5\u5BF9\u5E94\u7248\u672C\u7684\u63D2\u4EF6\u3002");
      return status;
    });
    return this.protocol;
  }
  async checked(op, payload = {}, signal) {
    signal?.throwIfAborted();
    await this.compatible();
    signal?.throwIfAborted();
    return this.rpc(op, payload, signal);
  }
  async status(signal) {
    try {
      signal?.throwIfAborted();
      await this.compatible();
      return await this.rpc("status", {}, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { available: false, platform: process.platform, message: error instanceof Error ? error.message : "\u6267\u884C\u5668\u4E0D\u53EF\u7528" };
    }
  }
  async targets(signal) {
    const result = await this.checked("targets", {}, signal);
    const targets = Array.isArray(result) ? result : result?.targets;
    if (!Array.isArray(targets)) throw new ComputerError("NATIVE_PROTOCOL", "\u6267\u884C\u5668\u8FD4\u56DE\u7684\u7A97\u53E3\u5217\u8868\u65E0\u6548");
    return targets;
  }
  observe(targetId, signal) {
    return this.checked("observe", { targetId }, signal);
  }
  preview(targetId, signal) {
    return this.checked("observe", { targetId, preview: true }, signal);
  }
  lease(epoch, signal) {
    return this.checked("lease", { epoch }, signal);
  }
  release(epoch, signal) {
    return this.rpc("release", { epoch }, signal);
  }
  act(epoch, targetId, action, signal) {
    return this.checked("act", { epoch, targetId, action }, signal);
  }
  openPreview(url, title, sessionId, signal) {
    return this.checked("openPreview", { url, title, sessionId }, signal);
  }
  closePreview(signal) {
    return this.checked("closePreview", {}, signal);
  }
  async dispose() {
    if (this.disposed) {
      await this.retiring;
      return;
    }
    this.disposed = true;
    this.fail(new ComputerError("DISPOSED", "\u7535\u8111\u64CD\u63A7\u6267\u884C\u5668\u5DF2\u505C\u7528"));
    this.listeners.clear();
    await this.retiring;
  }
};

// src/features/computer-use/remote.ts
var COMPUTER_AGENT_VERSION = 1;
var COMPUTER_AGENT_PATH = "/v1/computer";
var REQUEST_LIMIT = 512 * 1024;
var RESPONSE_LIMIT = 48 * 1024 * 1024;
var operations = /* @__PURE__ */ new Set(["status", "targets", "observe", "lease", "release", "act", "heartbeat"]);
function pairToken(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 512 || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ComputerError("INVALID_PAIR_TOKEN", "\u914D\u5BF9\u4EE4\u724C\u5FC5\u987B\u81F3\u5C11 32 \u5B57\u7B26\u4E14\u4E0D\u5305\u542B\u7A7A\u767D");
  return value;
}
function epochNumber(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ComputerError("INVALID_EPOCH", "\u63A7\u5236\u5468\u671F\u65E0\u6548");
  return value;
}
function privateAddress(host) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function computerAgentEndpoint(value, allowInsecurePrivateNetwork = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ComputerError("INVALID_ENDPOINT", "\u7535\u8111\u4EE3\u7406\u5730\u5740\u65E0\u6548");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && !loopback && !(allowInsecurePrivateNetwork && privateAddress(host))) throw new ComputerError("UNSAFE_ENDPOINT", "\u8BF7\u4F7F\u7528 HTTPS\u3001\u56DE\u73AF\u96A7\u9053\u6216\u660E\u786E\u5141\u8BB8\u7684\u79C1\u6709\u7F51\u7EDC\u914D\u5BF9\u5730\u5740");
  if (url.pathname === "/") url.pathname = COMPUTER_AGENT_PATH;
  return url.href;
}
async function readResponse(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ComputerError("REMOTE_RESPONSE_LIMIT", "\u8FDC\u7AEF\u54CD\u5E94\u8D85\u8FC7\u9650\u5236");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ComputerError("REMOTE_PROTOCOL", "\u8FDC\u7AEF\u54CD\u5E94\u4E3A\u7A7A");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new ComputerError("REMOTE_RESPONSE_LIMIT", "\u8FDC\u7AEF\u54CD\u5E94\u8D85\u8FC7\u9650\u5236");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ComputerError("REMOTE_PROTOCOL", "\u8FDC\u7AEF\u6CA1\u6709\u8FD4\u56DE\u6709\u6548 JSON");
    }
  } finally {
    reader.releaseLock();
  }
}
var RemoteComputerDriver = class {
  constructor(options) {
    this.options = options;
    this.endpoint = computerAgentEndpoint(options.endpoint, options.allowInsecurePrivateNetwork);
    this.token = pairToken(options.token);
    this.deviceId = `remote:${createHash("sha256").update(this.endpoint).update("\0").update(this.token).digest("hex").slice(0, 24)}`;
    this.clientId = requireIdentity(options.clientId ?? randomUUID(), "\u914D\u5BF9\u5BA2\u6237\u7AEF");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  endpoint;
  clientId;
  deviceId;
  token;
  fetcher;
  listeners = /* @__PURE__ */ new Set();
  pending = /* @__PURE__ */ new Set();
  timer;
  activeEpoch;
  ownedEpochs = /* @__PURE__ */ new Set();
  issuedEpoch = 0;
  disposed = false;
  disposing;
  requestId = 0;
  heartbeating = false;
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  async rpc(op, payload = {}, signal, cleanup = false) {
    if (this.disposed && !cleanup) throw new ComputerError("DISPOSED", "\u72EC\u7ACB\u7535\u8111\u8FDE\u63A5\u5DF2\u5173\u95ED");
    signal?.throwIfAborted();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new ComputerError("REMOTE_TIMEOUT", "\u8FDC\u7AEF\u64CD\u4F5C\u8D85\u65F6")), this.options.timeoutMs ?? 2e4);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.pending.add(controller);
    const requestId = ++this.requestId;
    try {
      if (signal?.aborted) abort();
      const response = await this.fetcher(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` }, body: JSON.stringify({ version: COMPUTER_AGENT_VERSION, clientId: this.clientId, requestId, op, payload }), signal: controller.signal, redirect: "error" });
      const value = await readResponse(response, this.options.maxResponseBytes ?? RESPONSE_LIMIT);
      if (value?.version !== COMPUTER_AGENT_VERSION) throw new ComputerError("VERSION_MISMATCH", "\u8FDC\u7AEF\u7535\u8111\u4EE3\u7406\u534F\u8BAE\u7248\u672C\u4E0D\u517C\u5BB9");
      if (!response.ok || value.ok !== true) throw new ComputerError(typeof value.error?.code === "string" ? value.error.code : "REMOTE_FAILED", typeof value.error?.message === "string" ? value.error.message : "\u8FDC\u7AEF\u64CD\u4F5C\u5931\u8D25");
      if (value.requestId !== requestId) throw new ComputerError("REMOTE_PROTOCOL", "\u8FDC\u7AEF\u54CD\u5E94\u8EAB\u4EFD\u4E0D\u5339\u914D");
      return value.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
    }
  }
  startHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.heartbeating || this.activeEpoch === void 0 || this.disposed) return;
      this.heartbeating = true;
      const epoch = this.activeEpoch;
      void this.rpc("heartbeat", { epoch }).catch((error) => {
        if (this.activeEpoch !== epoch || this.disposed) return;
        if (this.timer) clearInterval(this.timer);
        this.timer = void 0;
        this.activeEpoch = void 0;
        this.emit({ event: error instanceof ComputerError && error.code === "HUMAN_INPUT" ? "humanInput" : "disconnected" });
      }).finally(() => {
        this.heartbeating = false;
      });
    }, this.options.heartbeatMs ?? 1e3);
    this.timer.unref?.();
  }
  status(signal) {
    return this.rpc("status", {}, signal);
  }
  async targets(signal) {
    const targets = await this.rpc("targets", {}, signal);
    if (!Array.isArray(targets)) throw new ComputerError("REMOTE_PROTOCOL", "\u8FDC\u7AEF\u76EE\u6807\u5217\u8868\u65E0\u6548");
    return targets.map((target) => ({ ...target, appId: `${this.deviceId}:${target.appId}` }));
  }
  observe(targetId, signal) {
    return this.rpc("observe", { targetId }, signal);
  }
  preview(targetId, signal) {
    return this.rpc("observe", { targetId, preview: true }, signal);
  }
  async lease(epoch, signal) {
    if (this.disposed) throw new ComputerError("DISPOSED", "\u72EC\u7ACB\u7535\u8111\u8FDE\u63A5\u5DF2\u5173\u95ED");
    epochNumber(epoch);
    if (epoch <= this.issuedEpoch) throw new ComputerError("STALE_EPOCH", "\u8FDC\u7AEF\u63A7\u5236\u5468\u671F\u5FC5\u987B\u9012\u589E");
    this.issuedEpoch = epoch;
    this.ownedEpochs.add(epoch);
    const result = await this.rpc("lease", { epoch }, signal);
    if (this.disposed || this.issuedEpoch !== epoch) {
      if (!this.disposed) await this.release(epoch).catch(() => {
      });
      throw new ComputerError("CONTROL_CHANGED", "\u8FDC\u7AEF\u79DF\u7EA6\u5DF2\u88AB\u66F4\u65B0\u7684\u63A7\u5236\u5468\u671F\u66FF\u4EE3");
    }
    for (const previous of this.ownedEpochs) if (previous < epoch) this.ownedEpochs.delete(previous);
    this.activeEpoch = epoch;
    this.startHeartbeat();
    return result;
  }
  async release(epoch, signal) {
    epochNumber(epoch);
    if (this.activeEpoch === epoch) {
      if (this.timer) clearInterval(this.timer);
      this.timer = void 0;
    }
    const result = await this.rpc("release", { epoch }, signal);
    this.ownedEpochs.delete(epoch);
    if (this.activeEpoch === epoch) this.activeEpoch = void 0;
    return result;
  }
  act(epoch, targetId, action, signal) {
    return this.rpc("act", { epoch: epochNumber(epoch), targetId, action: parseComputerAction(action) }, signal);
  }
  async openPreview(_url, _title, _sessionId) {
    throw new ComputerError("LOCAL_PREVIEW_REQUIRED", "\u72EC\u7ACB\u7535\u8111\u9884\u89C8\u5E94\u5728\u672C\u673A\u7A97\u53E3\u663E\u793A");
  }
  async closePreview() {
    return void 0;
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
    this.activeEpoch = void 0;
    for (const controller of this.pending) controller.abort(new ComputerError("DISPOSED", "\u72EC\u7ACB\u7535\u8111\u8FDE\u63A5\u5DF2\u5173\u95ED"));
    this.disposing = (async () => {
      const results = await Promise.allSettled([...this.ownedEpochs].map(async (epoch) => {
        await this.rpc("release", { epoch }, AbortSignal.timeout(2e3), true);
        this.ownedEpochs.delete(epoch);
      }));
      this.listeners.clear();
      const failure = results.find((result) => result.status === "rejected");
      if (failure) {
        this.disposing = void 0;
        throw failure.reason;
      }
    })();
    return this.disposing;
  }
};
function authorized(header, token) {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7)), expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readRequest(request, maxBytes) {
  if (Number(request.headers["content-length"]) > maxBytes) throw new ComputerError("REQUEST_LIMIT", "\u8BF7\u6C42\u8D85\u8FC7\u9650\u5236");
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > maxBytes) throw new ComputerError("REQUEST_LIMIT", "\u8BF7\u6C42\u8D85\u8FC7\u9650\u5236");
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ComputerError("INVALID_REQUEST", "\u8BF7\u6C42\u5FC5\u987B\u662F JSON");
  }
}
async function createComputerAgentServer(driver, options) {
  let token = pairToken(options.token), active, nextNativeEpoch = 0, closing = false;
  let pairingGeneration = 0;
  const clients = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Set();
  const pendingReleases = /* @__PURE__ */ new Map(), releasing = /* @__PURE__ */ new Map();
  let leaseTail = Promise.resolve();
  const interruptions = /* @__PURE__ */ new Map();
  const leaseTimeout = options.leaseTimeoutMs ?? 5e3;
  if (!Number.isFinite(leaseTimeout) || leaseTimeout < 100 || leaseTimeout > 6e4) throw new ComputerError("INVALID_TIMEOUT", "\u79DF\u7EA6\u8D85\u65F6\u5FC5\u987B\u4ECB\u4E8E 100 \u548C 60000 \u6BEB\u79D2");
  const releaseLease = (lease) => {
    const previous = releasing.get(lease.nativeEpoch);
    if (previous) return previous;
    lease.controller?.abort(new ComputerError("CONTROL_CHANGED", "\u8FDC\u7AEF\u79DF\u7EA6\u5DF2\u64A4\u9500"));
    const acquisition = lease.acquisition;
    const cleanup = (async () => {
      await driver.release(lease.nativeEpoch);
      if (acquisition) {
        await Promise.allSettled([acquisition]);
        await driver.release(lease.nativeEpoch);
      }
      pendingReleases.delete(lease.nativeEpoch);
    })();
    releasing.set(lease.nativeEpoch, cleanup);
    void cleanup.then(() => releasing.delete(lease.nativeEpoch), () => releasing.delete(lease.nativeEpoch));
    return cleanup;
  };
  const drainReleases = async () => {
    for (const lease of pendingReleases.values()) await releaseLease(lease);
  };
  const revokeLease = async () => {
    const lease = active;
    active = void 0;
    if (lease) pendingReleases.set(lease.nativeEpoch, lease);
    await drainReleases();
  };
  const unsubscribe = driver.subscribe?.((event) => {
    const lease = active;
    if (!lease || !["humanInput", "previewClosed", "disconnected"].includes(event.event)) return;
    interruptions.set(lease.clientId, { epoch: lease.epoch, code: event.event === "disconnected" ? "DISCONNECTED" : "HUMAN_INPUT" });
    void revokeLease().catch(() => {
    });
  });
  const leaseFor = (clientId, epoch) => {
    const interruption = interruptions.get(clientId);
    if (interruption?.epoch === epoch) throw new ComputerError(interruption.code, interruption.code === "HUMAN_INPUT" ? "\u72EC\u7ACB\u7535\u8111\u5DF2\u7531\u672C\u5730\u7528\u6237\u6682\u505C" : "\u72EC\u7ACB\u7535\u8111\u6267\u884C\u5668\u5DF2\u65AD\u5F00");
    if (!active || active.clientId !== clientId || active.epoch !== epoch || Date.now() - active.lastSeen > leaseTimeout) throw new ComputerError("CONTROL_CHANGED", "\u8FDC\u7AEF\u8F93\u5165\u79DF\u7EA6\u65E0\u6548\u6216\u5DF2\u8FC7\u671F");
    return active;
  };
  const reply = (response, status, requestId, body) => {
    let bytes = Buffer.from(JSON.stringify({ version: COMPUTER_AGENT_VERSION, requestId: typeof requestId === "number" ? requestId : null, ...body }));
    if (bytes.length > (options.maxResponseBytes ?? RESPONSE_LIMIT)) {
      status = 413;
      bytes = Buffer.from(JSON.stringify({ version: COMPUTER_AGENT_VERSION, requestId, ok: false, error: { code: "RESPONSE_LIMIT", message: "\u54CD\u5E94\u8D85\u8FC7\u9650\u5236" } }));
    }
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": bytes.length });
    response.end(bytes);
  };
  const server = createServer(async (request, response) => {
    let requestId, controller;
    try {
      if (closing || request.method !== "POST" || request.url !== COMPUTER_AGENT_PATH) {
        reply(response, 404, null, { ok: false, error: { code: "NOT_FOUND", message: "\u65E0\u6B64\u5165\u53E3" } });
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        reply(response, 401, null, { ok: false, error: { code: "PAIR_UNAUTHORIZED", message: "\u914D\u5BF9\u65E0\u6548\u6216\u5DF2\u64A4\u9500" } });
        return;
      }
      if (request.headers.origin) throw new ComputerError("ORIGIN_DENIED", "\u4E0D\u63A5\u53D7\u7F51\u9875\u6765\u6E90\u8BF7\u6C42");
      const generation = pairingGeneration;
      const input = await readRequest(request, options.maxRequestBytes ?? REQUEST_LIMIT);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ComputerError("INVALID_REQUEST", "\u8BF7\u6C42\u65E0\u6548");
      requestId = input.requestId;
      if (input.version !== COMPUTER_AGENT_VERSION) throw new ComputerError("VERSION_MISMATCH", "\u7535\u8111\u4EE3\u7406\u534F\u8BAE\u7248\u672C\u4E0D\u517C\u5BB9");
      if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId < 1) throw new ComputerError("INVALID_REQUEST", "\u8BF7\u6C42\u6807\u8BC6\u65E0\u6548");
      const clientId = requireIdentity(input.clientId, "\u5BA2\u6237\u7AEF"), op = String(input.op);
      if (!operations.has(op)) throw new ComputerError("OP_NOT_ALLOWED", "\u4E0D\u5141\u8BB8\u7684\u4EE3\u7406\u64CD\u4F5C");
      const payload = input.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ComputerError("INVALID_REQUEST", "\u64CD\u4F5C\u53C2\u6570\u65E0\u6548");
      if (generation !== pairingGeneration || !authorized(request.headers.authorization, token)) throw new ComputerError("PAIR_UNAUTHORIZED", "\u914D\u5BF9\u5DF2\u64A4\u9500");
      controller = new AbortController();
      pending.add(controller);
      if (pending.size > 128) throw new ComputerError("QUEUE_FULL", "\u4EE3\u7406\u8BF7\u6C42\u8FC7\u591A");
      const cancel = () => {
        if (!response.writableEnded) controller?.abort(new ComputerError("ABORTED", "\u8FDE\u63A5\u5DF2\u4E2D\u65AD"));
      };
      response.once("close", cancel);
      let result;
      if (op === "status") result = { ...await driver.status(controller.signal), protocolVersion: COMPUTER_AGENT_VERSION, leaseTimeoutMs: leaseTimeout, cleanupPending: pendingReleases.size > 0 };
      else if (op === "targets") result = await driver.targets(controller.signal);
      else if (op === "observe") result = payload.preview === true && driver.preview ? await driver.preview(requireIdentity(payload.targetId, "\u76EE\u6807"), controller.signal) : await driver.observe(requireIdentity(payload.targetId, "\u76EE\u6807"), controller.signal);
      else {
        const epoch = epochNumber(payload.epoch);
        if (op === "lease") {
          const operationController = controller;
          const acquiring = leaseTail.catch(() => {
          }).then(async () => {
            operationController.signal.throwIfAborted();
            if (closing || generation !== pairingGeneration) throw new ComputerError("PAIR_UNAUTHORIZED", "\u914D\u5BF9\u5DF2\u64A4\u9500");
            if (active && active.clientId !== clientId) throw new ComputerError("DEVICE_BUSY", "\u72EC\u7ACB\u7535\u8111\u5DF2\u88AB\u53E6\u4E00\u4E2A\u5BA2\u6237\u7AEF\u63A7\u5236");
            if ((clients.get(clientId) ?? 0) >= epoch) throw new ComputerError("STALE_EPOCH", "\u63A7\u5236\u5468\u671F\u5FC5\u987B\u9012\u589E");
            if (!clients.has(clientId) && clients.size >= 128) throw new ComputerError("CLIENT_LIMIT", "\u914D\u5BF9\u5BA2\u6237\u7AEF\u6570\u91CF\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u8BF7\u91CD\u65B0\u914D\u5BF9");
            if (active) await revokeLease();
            else await drainReleases();
            operationController.signal.throwIfAborted();
            if (closing || generation !== pairingGeneration) throw new ComputerError("PAIR_UNAUTHORIZED", "\u914D\u5BF9\u5DF2\u64A4\u9500");
            clients.set(clientId, epoch);
            interruptions.delete(clientId);
            const candidate = { clientId, epoch, nativeEpoch: ++nextNativeEpoch, lastSeen: Date.now(), controller: operationController };
            active = candidate;
            candidate.acquisition = Promise.resolve().then(() => driver.lease(candidate.nativeEpoch, operationController.signal));
            try {
              await candidate.acquisition;
              candidate.acquisition = void 0;
              candidate.controller = void 0;
              if (active !== candidate || generation !== pairingGeneration || operationController.signal.aborted) throw new ComputerError("CONTROL_CHANGED", "\u5EFA\u7ACB\u79DF\u7EA6\u65F6\u63A7\u5236\u6743\u5DF2\u53D8\u5316");
              return { epoch, leaseTimeoutMs: leaseTimeout };
            } catch (error) {
              if (active === candidate) active = void 0;
              pendingReleases.set(candidate.nativeEpoch, candidate);
              await releaseLease(candidate).catch(() => {
              });
              throw error;
            }
          });
          leaseTail = acquiring.catch(() => {
          });
          result = await acquiring;
        } else if (op === "release") {
          if (active?.clientId === clientId && active.epoch === epoch) await revokeLease();
          else for (const lease of pendingReleases.values()) if (lease.clientId === clientId && lease.epoch === epoch) await releaseLease(lease);
          result = { released: true };
        } else {
          const lease = leaseFor(clientId, epoch);
          if (op === "heartbeat") {
            lease.lastSeen = Date.now();
            result = { epoch };
          } else {
            const targetId = requireIdentity(payload.targetId, "\u76EE\u6807"), action = parseComputerAction(payload.action);
            const aborted = () => {
              if (active === lease) void revokeLease().catch(() => {
              });
            };
            controller.signal.addEventListener("abort", aborted, { once: true });
            try {
              result = await driver.act(lease.nativeEpoch, targetId, action, controller.signal);
              if (active !== lease) throw new ComputerError("CONTROL_CHANGED", "\u6267\u884C\u671F\u95F4\u63A7\u5236\u6743\u5DF2\u53D8\u5316");
            } finally {
              controller.signal.removeEventListener("abort", aborted);
            }
          }
        }
      }
      controller.signal.throwIfAborted();
      if (generation !== pairingGeneration) throw new ComputerError("PAIR_UNAUTHORIZED", "\u914D\u5BF9\u5DF2\u64A4\u9500");
      reply(response, 200, requestId, { ok: true, result });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) reply(response, error instanceof ComputerError && error.code === "REQUEST_LIMIT" ? 413 : 400, requestId, { ok: false, error: computerError(error) });
    } finally {
      if (controller) pending.delete(controller);
    }
  });
  server.headersTimeout = 1e4;
  server.requestTimeout = 25e3;
  server.maxHeadersCount = 32;
  const watchdog = setInterval(() => {
    if (active && Date.now() - active.lastSeen > leaseTimeout) void revokeLease().catch(() => {
    });
    else if (pendingReleases.size) void drainReleases().catch(() => {
    });
  }, Math.min(1e3, Math.max(25, leaseTimeout / 4)));
  watchdog.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new ComputerError("LISTEN_FAILED", "\u65E0\u6CD5\u53D6\u5F97\u4EE3\u7406\u76D1\u542C\u5730\u5740");
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    server,
    endpoint: `http://${host}:${address.port}${COMPUTER_AGENT_PATH}`,
    async revoke(newToken) {
      token = newToken === void 0 ? void 0 : pairToken(newToken);
      pairingGeneration++;
      clients.clear();
      interruptions.clear();
      for (const controller of pending) controller.abort(new ComputerError("PAIR_UNAUTHORIZED", "\u914D\u5BF9\u5DF2\u64A4\u9500"));
      await revokeLease();
    },
    async close() {
      if (closing) {
        await drainReleases();
        return;
      }
      closing = true;
      unsubscribe?.();
      clearInterval(watchdog);
      token = void 0;
      pairingGeneration++;
      for (const controller of pending) controller.abort();
      let failure;
      try {
        await revokeLease();
      } catch (error) {
        failure = error;
        if (driver.dispose) try {
          await driver.dispose();
          pendingReleases.clear();
          failure = void 0;
        } catch (retirementError) {
          failure = retirementError;
        }
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve()));
      }
      if (failure) throw failure;
    }
  };
}
export {
  COMPUTER_AGENT_PATH,
  COMPUTER_AGENT_VERSION,
  NativeCompanionDriver,
  RemoteComputerDriver,
  computerAgentEndpoint,
  createComputerAgentServer
};
