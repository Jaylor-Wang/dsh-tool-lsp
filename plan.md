# dsh-tool-lsp — 实施计划

一个自研的 DSH LSP 插件：通用可配置的语言服务器客户端，可被 dshmarket 热挂载，
默认不挂载、用时开关、不跨重启保留。

---

## 1. 目标与非目标

### 目标

| 项 | 要求 |
|---|---|
| 工具面 | 5 个：诊断、格式化、重命名、代码动作、符号 |
| 语言服务器 | 通用可配置，`servers` 默认为空，用户经补丁层 `config:` 提供 |
| 挂载语义 | **非 bundle 层包**，靠 dshmarket 热挂载；默认关、用时开、重启回到关闭 |
| 依赖 | 只用 `ctx.subprocess` + `ctx.fs`；不依赖官方的 `ctx.lsp` seam（本部署无 provider） |
| 写盘行为 | `lsp_format` / `lsp_rename` 直接写盘，走 fs write-intent 策略，冲突报错 |
| 定位 | **替代** `dsh-lsp-actions`（详见 §8）；工具名沿用 `lsp_*` |

### 非目标

- **不用 Rust 实现**。实测 `dsh-lsp-actions` 约 5400 行、25 模块，几乎全是 JSON-RPC
  编解码、位置编码协商、类型规范化——纯字符串/JSON 处理。真正的重活在语言服务器
  进程内（rust-analyzer / biome / ty / ruff 本身已是 Rust）。Rust 重写客户端层是
  不可测量的性能收益 + 双语言维护成本。
- 不做 `lsp_completion` / `lsp_signature` / `lsp_inlay_hints`：编辑器交互型，agent 场景价值低。
- 不做 IDE 集成后端（`lsp.actions.*` 编辑器协议）。
- 不做「写盘前 diff 预览」——已定：直接写。

---

## 2. 硬约束（实测得出，违反则功能不成立）

这些是 2026-09-15 用探针插件实测确认的，不是推测。

### 2.1 bundle patch 必须是纯 insert 行

`dshmarket` 的 `hotMount()` 会读取
`<profile>/node_modules/<包名>/cordis.patch.yml`，交给 `parseSimplePatch()`
（`dshmarket/lib/hot.js:146`）。该解析器只认三种行：

```yaml
- insert:
    - id: <row-id>
      name: <包名>
```

**遇到任何其它行（`config:` / `inject:` / 表达式）直接 `return null`**，市场回你
「bundle patch 含配置行/表达式，重启后生效」——而重启也不会挂，因为该包不在
`dsh.profile.bundles` 里。这是个死结。

因此：

- `inject` 只能写在 `index.js`：`export const inject = ['tools', 'fs', 'subprocess']`
- **所有配置项必须在 schema 里有默认值**（patch 里不能带 `config:`）
- 用户自定义配置走**补丁层**：`~/.dsh/profiles/<profile>/cordis.patch.yml` 里
  写 `- id: lsp / config: {...}`

### 2.2 模块缓存

同一路径重复挂载会命中 Node 的 ESM 模块缓存——**改了磁盘代码，进程内仍跑旧版本**。

实测证据（探针）：探针首次热挂载失败后修正了代码，重新 toggle 仍报同样的旧错误；
换成新路径（`dsh-hotmount-probe2`）立刻成功。

**bundle 层同样如此（阶段 6 复测）**：插件挂载后往
`profiles/web/node_modules/dsh-tool-lsp/lib/tools.js` 尾部注入一行语法错误，
再走市场 toggle 停用→启用——返回仍是 `ok: true`、`state: live`。
**挂载完全没有重新导入模块**，文件里的语法错误根本没人看见。

所以：**市场开关能即时改变"是否挂载"，但不能把磁盘上的新代码装进已运行的进程。**
开发期改了插件代码，必须重启一次（正常使用时不受影响——开关本身一直有效）。

对策见 §4.3。

### 2.3 开关的生效范围（阶段 6 实测，bundle 层）

| 操作 | 结果 |
|---|---|
| 市场点「启用」 | 即时生效，`state: live`、`restart: false` |
| 市场点「停用」 | 即时失效，`state: disabled`、`restart: false` |
| 手工编辑 `cordis.patch.yml` 的 `disabled` | **不生效**，市场仍报 `state: restart` |
| 重启 | 补丁层的 `disabled: true` 决定状态，跨重启保留 |
| 改了插件源码后 toggle | **不重新导入模块**，仍跑旧代码（见 §2.2） |

「不用重启」指的是**开关**这件事。改代码是另一回事，需要重启。

### 2.4 禁用会写补丁层

市场 toggle 在**停用**时会把 `- id: <row-id>` / `disabled: true` **无条件写入**
用户补丁层（`routes.js` 的 `patchGate = ok || !enabled`）。这是持久化契约，但意味着
实验/调试会往 `cordis.patch.yml` 留痕，清理时要一并检查。

---

## 3. 工具面设计

5 个工具，命名沿用 `lsp_` 前缀。

### 3.1 `lsp_diagnostics`

诊断指定文件。只读。

```js
parameters: {
  file_path: { type: 'string', required: true, description: '要诊断的源文件，工作区相对路径或绝对路径。' },
}
```

返回：severity / 零基 range / message / source，上限 `maxDiagnostics`。

### 3.2 `lsp_format`

格式化整个文件或选区，**直接写盘**，返回应用的 diff。

```js
parameters: {
  file_path: { type: 'string', required: true },
  range: { type: 'object', description: '可选。一基 UTF-16 行/列选区；省略则整个文件。' },
}
```

走 fs write-intent 策略：文件自上次读取后被外部改动 → 报冲突失败。

### 3.3 `lsp_rename`

重命名光标处符号，应用工作区范围的编辑，**直接写盘**，返回 diff。

```js
parameters: {
  file_path: { type: 'string', required: true },
  line: { type: 'integer', required: true, description: '一基行号。' },
  character: { type: 'integer', required: true, description: '一基 UTF-16 列号。' },
  new_name: { type: 'string', required: true },
}
```

### 3.4 `lsp_code_action`

对 range（或首个诊断）请求代码动作。**只报告，不应用**——edit/command 一并返回，
由模型自行用 `edit`/`write` 应用。

```js
parameters: {
  file_path: { type: 'string', required: true },
  range: { type: 'object', description: '可选。省略时取首个已报告诊断的位置。' },
}
```

### 3.5 `lsp_symbols`

文档或工作区符号。

```js
parameters: {
  file_path: { type: 'string', required: true, description: '省略 query 时返回该文件的文档符号。' },
  query: { type: 'string', description: '可选。提供时执行工作区符号搜索。' },
}
```

### 3.6 统一约定

- **位置坐标两种制式**：工具入参/返回用**一基 UTF-16**（编辑器/光标惯例）；
  内部 LSP 协议用**零基 + 协商后的 encoding**（`negotiatePositionEncoding`）。
  转换集中在 `translate.js`，不要在工具层散落加减一。
- **错误码**：无匹配服务器、服务器未启动、超时、冲突各有稳定错误码，
  参照 `dsh-lsp-actions` 的 `LSP_ACTION_UNAVAILABLE` 模式（`vocabulary.js`）。

---

## 4. 架构

### 4.1 目录结构

```
E:\Github\dsh-tool-lsp\
  package.json
  cordis.patch.yml        # 纯 insert，见 §2.1
  index.js                # 入口：inject / Config / apply
  lib/
    servers.js            # LspServerEntry schema + resolveServers + 文件路由
    connection.js         # 单个语言服务器的 stdio JSON-RPC 连接与生命周期
    framing.js            # Content-Length 帧编解码
    translate.js          # LSP 类型规范化 + 位置编码
    client.js             # 按需拉起/复用连接，disposeAll
    runner.js             # 动作执行 + 超时 + 错误分类
    tools.js              # 5 个 defineTool 注册
    render.js             # 工具输出的模型可见渲染
    project.js            # projectMarkers 最近祖先查找
    vocabulary.js         # 错误码与常量
  README.md
  README.zh.md
  LICENSE
```

包名：`dsh-tool-lsp`（npm 上待确认可用性）。

### 4.2 入口形状

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-tool-lsp';
export const inject = ['tools', 'fs', 'subprocess'];
export const Config = z.object({
  servers: z.dict(LspServerEntry).default({}),
  maxDiagnostics: z.number().default(200),
  maxSymbols: z.number().default(100),
  maxCodeActions: z.number().default(50),
  maxResultChars: z.number().default(16000),
  maxDocumentBytes: z.number().default(8 * 1024 * 1024),
  timeoutMs: z.number().default(60000),
});

export async function apply(ctx, config) {
  // 1. resolveServers(ctx, config.servers) —— 解析每个 command，缺失则 fail loud
  // 2. 建 client
  // 3. ctx.effect(() => { registerTools(); return () => client.disposeAll(); })
}
```

**要点**：

- `apply` 必须是 `async`（需要 `ctx.subprocess.resolveExecutable`）
- **先解析全部可执行文件再注册任何工具**——一个坏 command 不能让部分工具先publish
- 所有注册放进 `ctx.effect`，返回的 disposer 里 `disposeAll()` 回收语言服务器进程。
  这是热卸载能干净生效的前提（`dsh-lsp-actions` 已验证该模式：注释明确写
  "effect-scoped, so disposal unregisters the tools and tears down every live server"）

### 4.3 模块缓存规避

`apply` 内不做特殊处理；开发期该问题由**改完重启**解决（§2.2 实测：重新挂载不会
重新导入模块，只有新路径/新包名才会）。发布版不需要此机制——用户装机后不会频繁
改插件源码。

### 4.4 配置示例（补丁层）

```yaml
- id: lsp
  config:
    servers:
      vtsls:
        command: vtsls
        args: ["--stdio"]
        extensionToLanguage:
          ".ts": typescript
          ".tsx": typescriptreact
          ".js": javascript
        projectMarkers: ["package.json", "tsconfig.json"]
      rust:
        command: rust-analyzer
        extensionToLanguage:
          ".rs": rust
        projectMarkers: ["Cargo.toml"]
      biome:
        command: biome
        args: ["lsp-proxy"]
        extensionToLanguage:
          ".json": json
          ".css": css
        projectMarkers: ["biome.json"]
```

`LspServerEntry` 字段（参照 `dsh-lsp-actions/lib/servers.js:20`）：

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `command` | ✅ | — | 可执行文件名，经 `subprocess.resolveExecutable` 解析 |
| `extensionToLanguage` | ✅ | — | 扩展名 → LSP languageId |
| `fileGlobs` | | `[]` | 路径 glob 规则，优先级最高 |
| `projectMarkers` | | `[]` | 项目配置文件名，按最近祖先路由 |
| `args` | | `[]` | 启动参数 |
| `env` | | `{}` | 额外环境变量 |
| `initializationOptions` | | `null` | 透传给 initialize |
| `configuration` | | `null` | workspace/configuration 响应 |
| `formattingOptions` | | `null` | 格式化选项覆盖 |
| `maxMessageBytes` / `maxStderrBytes` | | 内部常量 | 缓冲上限 |
| `killGraceMs` / `shutdownTimeoutMs` | | 内部常量 | 进程回收 |
| `diagnosticsSettleMs` / `diagnosticsDebounceMs` / `idleTimeoutMs` | | 内部常量 | 诊断时序与空闲回收 |

**文件路由优先级**（`servers.js` 的 `routeFile`）：`fileGlobs` → 最近 `projectMarkers` →
`extensionToLanguage`。每一轮都按配置顺序。project marker **不会**扩大服务器的文件类型
范围，只在已经映射该扩展名的条目之间做选择。

---

## 5. 实施阶段

每阶段结束都有可验证的产出，不要跳步。

### 阶段 0：骨架与发布通路（先打通分发）✅ 已完成

1. ✅ 建 `package.json` / `cordis.patch.yml` / `index.js`
2. ✅ npm 名 `dsh-tool-lsp` 可用（`npm view` 返回 404）
3. ✅ 本地 `file:` 安装 → 市场 toggle → 热挂载成功
4. ✅ 清理探针痕迹（补丁层残留行、`.dsh-market/state.json`、`hot-*.yml`）

**验收结果**（2026-09-15 实测）：

| 检查 | 结果 |
|---|---|
| `parseSimplePatch()` 解析 patch | `[{"id":"lsp","name":"dsh-tool-lsp"}]` — 可热挂载 |
| 市场 toggle 启用 | `ok: true`，`activation.state = "live"`，`hot: true` |
| 工具进入会话目录 | `lsp_probe` 调用成功，返回 `servers configured: 0` |
| 市场 toggle 停用 | `ok: true`，工具立刻 `unknown tool` |
| `dsh web --dump-config` | 无 `dsh-tool-lsp` 条目（确认非 bundle 层） |
| Config 默认值 | 全部生效（`servers: {}` 等 7 项） |

**实测补充发现**：

1. **市场靠 `dsh.bundle` 声明识别包**，包不必在 `dsh.profile.bundles` 里。
   `activation.reasons` 会显示 `已热加载(bundle patch)`，而 `bundle: false, hot: true`。
2. **停用会往补丁层写两行**（一次 `disabled: false`、一次 `disabled: true`），
   且格式紧凑无空行。调试后应清理——保留 `disabled: true` 单行即可让重启保持关闭，
   但会把它变成「补丁层管理的行」，与「非 bundle 层热挂载」的语义不同。
   本项目选择**不保留**，让重启自然回到关闭。
3. **`apply` 可以同步**（本阶段探针就是同步的）。阶段 1 起改为 `async`
   （需要 `ctx.subprocess.resolveExecutable`）。

### 阶段 1：协议基础 ✅ 已完成

`lib/framing.js` + `lib/connection.js` + `lib/vocabulary.js`。

**产出**：

| 模块 | 内容 |
|---|---|
| `framing.js` | `encodeMessage()` + `MessageDecoder`：Content-Length 帧、增量解码、有界头窗口、超长/畸形帧致命 |
| `connection.js` | `LspConnection`：id 分配、pending 请求表、通知分发、服务器→客户端请求应答、关闭边界、优雅 shutdown |
| `vocabulary.js` | `LSP_ERROR` 错误码、JSON-RPC 错误码映射、`DEFAULTS` 限制、`lspError()` 构造器 |

**验收结果**：`npm test` → **16/16 通过**（约 1.0s）。

测试用真实子进程（`test/fake-server.mjs`）而非 mock 流，覆盖：

- framing：编码长度按 UTF-8 字节计、分块重组、单块多消息、超长拒绝、缺 header 拒绝、非 JSON 拒绝
- connection：initialize 往返、请求路由、`METHOD_NOT_FOUND` → `LSP_UNSUPPORTED`、
  通知分发、服务器→客户端请求应答、shutdown 关闭子进程、关闭后请求拒绝、
  死进程报错带 stderr、并发请求独立结算

**开发期修掉的三个真实 bug**（均由测试发现，非推测）：

1. **正常关闭被误判为失败** —— close 回调无条件设 `#closeReason`，导致
   `shutdown()` 后 `failed === true`。修法：引入 `#shuttingDown` 意图标志，
   只有「未被要求就消失」才归类为崩溃。
2. **测试夹具**：假服务器收到客户端应答后未回原请求，导致 `server/ask` 挂起。
3. **shutdown 自锁死** —— 给 `request()` 加「正在关闭则拒绝」的守卫后，
   `shutdown()` 自己的握手请求被该守卫拒绝，进程永不退出。修法：拆出私有
   `#send()`（无守卫）供 `shutdown` 使用，公开 `request()` 保留守卫。

**技术决策**：保持纯 JS（无 `as const` 等 TS 语法、无构建步骤），与
`dsh-tool-ast-grep` 技术栈一致。`node --test` 在 Windows 下需传**显式文件路径**
（`--test test/` 会被当作模块名解析失败），已固化为 `npm test`。

### 阶段 2：服务器解析与路由 ✅ 已完成

`lib/servers.js` + `lib/project.js` + `lib/host.js`。

**产出**：

| 模块 | 内容 |
|---|---|
| `servers.js` | `LspServerEntry` / `Config` schema、`resolveServers()`、`routeFile()` 三级路由、`globToRegExp()`、`finalExtension()`、`validateServerEntry()`、`normalizeEntry()` |
| `project.js` | `configuredProjectMarkers()`、`findProjectMarker()` 最近祖先查找 |
| `host.js` | `throwIfAborted()`、`decodeFileUri()`、`relativeUnderRootUri()`、`isAbortError()` |

**验收结果**：`npm test` → **42/42 通过**（阶段 1 + 阶段 2，约 1.0s）。

关键用例：

- **三级优先级**：glob > project marker > extension，逐级验证
- **marker 不得扩大文件类型范围**（最关键的反例）：`Cargo.toml` 项目里的
  `.ts` 文件必须仍走 TS 服务器，不能因为 marker 命中就发给 Rust 服务器
- **容器退出边界**：文件在工作区外 → 无项目上下文；无配置 marker → 零文件系统调用（短路）
- **目录不冒充 marker**：名为 `deno.json` 的**目录**不算项目标记
- **Windows 分隔符归一**：`generated\deep\a.ts` 能匹配 `generated/**/*.ts`
- **load 期 fail loud**：缺失 command → `LSP_COMMAND_NOT_FOUND`；畸形 glob → load 期抛错（不是路由期）

**开发期修掉的一个真实缺陷**：

`validateServerEntry` 要求 `maxMessageBytes` 等为正整数，但**裸对象传入时这些字段是
`undefined`**——于是「畸形 glob」的测试先撞上「maxMessageBytes 必须是正整数」，
错误信息与调用方的真实问题无关。修法：新增 `normalizeEntry()`，在
`resolveServers` 里先把 schema 默认值填齐再校验，使校验针对「服务器实际运行的
配置」而非「调用方碰巧传的那部分」。这同时修好了程序化挂载（测试、
`dsh-tool-ast-grep` 式的直接 `apply`）的可用性。

**开发环境补充**：源目录需自建 `node_modules/@deepseek-ai/{schemastery,dsh-tools}`
软链才能跑测试（这两个包只在 profile 的 node_modules 里）。软链**不随包发布**。

### 阶段 3：翻译层 ✅ 已完成

`lib/translate.js`。

**产出**：

| 组 | 内容 |
|---|---|
| 位置编码 | `negotiatePositionEncoding()`、`PositionCodec`（encode/decode，查表 + 二分） |
| 坐标约定 | `toWirePosition()`（一基→零基）、`toModelPosition()`（零基→一基）、`isWirePosition()` |
| 诊断 | `normalizeDiagnostics()`：severity 数字→标签、接受数组与 `{items}` 两种形态 |
| 符号 | `normalizeSymbols()`：`DocumentSymbol`（层级，带 depth）与 `SymbolInformation`（扁平）两种形态 |
| 代码动作 | `normalizeCodeActions()`、`decodeWorkspaceEdit()`、`decodeTextEdits()` |
| 其他 | `uriToPath()`、`symbolKindLabel()`、`toRange()` |

**验收结果**：`npm test` → **77/77 通过**（三个阶段，约 1.1s）。

**真实语言服务器端到端验证**（不只是单测）：用真实 **rust-analyzer 1.98.1** 跑通完整链路——

```
initialize → didOpen → textDocument/documentSymbol → textDocument/diagnostic → shutdown
```

结果：`serverInfo: rust-analyzer 1.98.1`、`negotiated encoding: utf-16`、
符号 `main`（function，1:1）、**诊断精确命中埋入的类型错误**：

```
error 1:17–1:33  "expected i32, found &'static str"
```

`shutdown` 后 `exitCode: 0`（优雅关闭，进程回收正常）。

**关键发现（实测，非推测）：`ServerCancelled` = -32802，不是 -32800**

首次真实跑 rust-analyzer 时，`textDocument/diagnostic` 被拒为「server cancelled the
request」，而我的实现把它归类为 `LSP_SERVER_ERROR`（即「服务器坏了」）。抓原始
JSON-RPC 响应后发现真实错误码：

```json
{ "code": -32802, "message": "server cancelled the request",
  "data": { "retriggerRequest": true } }
```

这是 **LSP 3.17 的 `ServerCancelled`**，语义是「结果还没准备好，请重试」——
rust-analyzer 在索引完成前会持续返回它。我原先只实现了 -32800
（`RequestCancelled`），两者是不同的码。

修正内容：

1. `vocabulary.js` 新增 `JSONRPC_ERROR.SERVER_CANCELLED = -32802`
2. `vocabulary.js` 新增 `LSP_ERROR.REQUEST_CANCELLED`（可重试语义，区别于 `SERVER_FAILED`）
3. `connection.js` 把 -32802 与 -32800 一并映射为可重试错误，并在消息里标注
   `(server asks for a retry)`（读 `data.retriggerRequest`）

**这个 bug 只有对真实服务器才能发现**——假服务器不会自发返回 -32802。修正后
重试 4 次即拿到诊断。

**测试覆盖的位置编码要点**（文本刻意选取三种编码互不相同的样本）：

- ASCII：三种编码一致（对照）
- CJK/拉丁重音：UTF-8 ≠ UTF-16
- emoji（astral）：UTF-16 宽 2、UTF-8 宽 4、UTF-32 宽 1
- 拆开代理对的非法偏移 → 映射到码点起始，不产生垃圾
- **偏移按行计算**（跨行的多字节字符不得泄漏到下一行）
- 三种编码下的 encode/decode 往返稳定

### 阶段 4：工具与执行 ✅ 已完成

`runner.js` + `executor.js` + `render.js` + `tools.js`：5 个工具注册、会话复用、超时、
错误分类、写盘冲突检测。

**测试**：`test/stage4.test.mjs` 33 项；全量 **113/113 通过**（约 5.6s）。

**验收**：真实 rust-analyzer 1.98.1 与 vtsls 均跑通 diagnostics / format / symbols /
rename / code_action。

#### 真实服务器暴露的三个 bug（假服务器测不出来）

这三个都是"客户端与假服务器共享同一误解"的典型，只有接真实服务器才现形：

1. **推送诊断从未被记录**。`connection.onNotification` 的 handler 签名是
   `(method, params)`，我写成了 `(params) => ...`，拿到的是方法名字符串，
   `params?.uri` 恒为 `undefined`。→ 推送通道整体失效。

2. **URI 规范化不匹配**。vtsls 回传的 URI 是 `file:///c%3A/...`（小写盘符 +
   百分号编码冒号），而发出的是 `file:///C:/...`。裸字符串比较不相等，推送被丢弃。
   修法：`normalizeUri()` 解码路径并折叠盘符大小写后再比较。
   → 修复后 TypeScript 诊断从「no diagnostics」变为正确报出 2322。

3. **能力声明与实现不一致**。vtsls 声明 `diagnosticProvider` 却对
   `textDocument/diagnostic` 回 `METHOD_NOT_FOUND`。原实现把 `LSP_UNSUPPORTED`
   当失败抛出，push 回退路径被绕过。修法：`UNSUPPORTED` 一律降级为
   `{ unsupported: true }`，交由调用方合并 push。

#### 一个协议语义发现：pull 与 push 不是二选一

rust-analyzer 的 pull 只返回 check-on-save 诊断，`unused_variables` 这类 lint
**只走 push**。反之 vtsls 完全不实现 pull。因此两个通道必须**合并**（按
range+message+severity+code 去重），任何"优先 pull、失败才 push"的策略都会漏报。
漏报比报错更危险——它让模型相信一个坏文件是好的。

#### 冷启动空结果的正确处理

rust-analyzer 索引未完成时会**返回空列表**（不是 `ServerCancelled`）。这与"文件确实
干净"无法从单次响应区分。策略：文档**首次**返回非空前，对空结果做退避重试
（500ms 递增，上限 6 次），一旦报过结果就不再等待。实测冷启动首次查询 4.3s 拿到
诊断，其后 0.0s。

---

### 阶段 5：文档与发布

README（中英）、LICENSE、`npm publish`（**不动 git**，除非另行要求）。

---

## 6. 验证清单

- [x] `parseSimplePatch()` 对该包 patch 返回 `[{id, name}]` 而非 `null`（保持可热挂载）
- [x] `dsh --profile web --dump-config` 中 `lsp` 行携带迁移后的 servers 配置
- [x] 该行默认 `disabled: true`，且 `dsh-lsp-actions` 同为停用（无重名 `lsp_*`）
- [x] 市场 toggle 启用 → `state: live`、`hot: true`、**`restart: false`**
- [x] 市场 toggle 停用 → `state: disabled`、**`restart: false`**
- [x] 5 个服务器对真实请求全部应答（`npm run verify:servers`）
- [x] 写盘类工具对「外部改动过的文件」报冲突而非静默覆盖（`LSP_WRITE_CONFLICT`，stage4 单测）
- [x] 五个工具在真实 rust-analyzer 与 vtsls 上跑通（stage4 端到端）
- [x] pull/push 诊断合并，避免"漏报"假阴性
- [x] `configuration` / `formattingOptions` 真正抵达服务器（stage4 新增 6 项单测）
- [ ] 重启后市场卡片显示「已停用」且工具表无 lsp 工具
  （合成层已三次核对为 `disabled: true`；`--dump-config` 与启动共用同一套
  `applyEntryPatches`，但**真实重启未跑过**，故不勾选）
- [ ] 语言服务器进程在停用后被回收（`tasklist` / `ps` 确认无残留）
  （`dispose()` 幂等性有单测；运行中应用这次没有真正调用过工具，
  因此没有已 spawn 的服务器可供回收，未做进程核对）

---

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 位置编码协商错误 | 诊断/重命名定位偏移 | 阶段 3 单测覆盖三种 encoding |
| 语言服务器启动慢/挂死 | 工具调用超时 | `timeoutMs` + 空闲回收 + 明确的超时错误码 |
| 热挂载模块缓存 | 开发期改了不生效 | §2.3 的三条对策 |
| 写盘冲突判断失误 | 覆盖用户改动 | 严格走 fs write-intent，冲突即失败 |
| npm 包名被占 | 无法发布 | 阶段 0 先查 |
| 与 `dsh-lsp-actions` 同时挂载 | 工具名冲突（都注册 `lsp_*`） | 见 §9：替代关系与切换顺序 |
| **只信 pull 诊断** | **漏报**，让模型以为坏文件是好的 | 合并 push；push 为空时给有界等待窗口（阶段 4） |
| **URI 规范化差异** | 服务器回传的 URI 与发出的不匹配，推送被丢弃 | `normalizeUri()` 折叠盘符大小写并解码（阶段 4） |
| **服务器声明能力却未实现** | 请求报错而非回退到推送 | `LSP_UNSUPPORTED` 降级为 `unsupported`（阶段 4） |

---

## 8. 与 dsh-lsp-actions 的关系：替代

**已定：`dsh-tool-lsp` 替代 `dsh-lsp-actions`。** 因此：

- 工具名继续用 `lsp_*` 前缀，**不改名**
- 两者**不能同时挂载**——工具名会撞车
- 项目上线后，`dsh-lsp-actions` 应停用（或从 `dsh.profile.bundles` 移除）

### 8.1 切换顺序（重要）

替代不是「装上新的就行」，两个插件的挂载形态若不同，切换顺序会影响可用性：

| 插件 | 挂载层 | 开关方式 | 重启后 |
|---|---|---|---|
| `dsh-lsp-actions`（旧） | bundle 层 | `setEntryDisabled` | 保持上次状态 |
| `dsh-tool-lsp`（新） | bundle 层（已注册） | `setEntryDisabled` | 保持上次状态 |

切换流程：

1. **先在市场停用 `dsh-lsp-actions`**（写入补丁层 `- id: lsp-actions / disabled: true`）
2. 把 5 个服务器配置迁到 `- id: lsp`
3. 默认停用：补丁层写 `- id: lsp / disabled: true`
4. 用时在市场点「启用」——**即时生效，无需重启**

**顺序不能反**：若新的已启用而旧的还活着，两者同时注册 `lsp_*` 工具，市场 toggle
很可能直接报冲突，或出现同名工具互相覆盖（取决于注册表的重复注册策略）。

#### 为什么新插件必须是 bundle 层（实测推翻过原设计）

最初的方案是「非 bundle + 热挂载」，**那是错的**，因为两条事实叠加后配置无处安放：

1. `dshmarket/lib/hot.js` 的 `hotMount()` 写出的条目 id 是 **`mkt-<原id>`**，name 是
   解析后的绝对 `file://` URL：
   ```yaml
   - id: 'mkt-lsp'
     name: 'file:///C:/Users/29507/.dsh/profiles/web/node_modules/dsh-tool-lsp/index.js'
   ```
   于是补丁层里写 `- id: lsp / config: {...}` **永远匹配不到**这个条目，配置是死代码。
2. 包内 `cordis.patch.yml` 又必须保持纯 insert（§2.1），不能携带 `config:`。

两者一夹，配置没有任何可达路径。注册进 `dsh.profile.bundles` 后，bundle 层插入了
真正的 `lsp` 行，补丁层的 `config:` 与 `disabled:` 才落到它身上；市场对 bundle
插件走 `themes.setEntryDisabled()` → `entry.update({disabled})`，同样是即时生效。

**另一个实测反差**：手工编辑 `cordis.patch.yml` 把 `disabled: true` 改成 `false`，
运行中的应用**不会**因此挂载它——市场的 `/dsh-market/installed` 会报
`state: "restart"`（"已进入 profile bundle 层但本次未能热挂载"）。只有走市场
toggle 那条 `entry.update()` 路径才即时生效。所以「用时开」要在市场里点。

### 8.2 工具面取舍依据

切到 `dsh-tool-lsp` 后，以下 4 项能力**不提供**。这不是遗漏，是依据下述标准
逐项判定的结果。

#### 判定标准

一个 LSP 能力值得做成工具，需要同时满足两条：

1. **无近似替代** —— 用现有工具（`read` / `grep` / `lsp_symbols` / `tool-bash` 跑编译器）
   拼不出同等质量的信息
2. **不需要精确光标位置** —— 否则模型必须先 `read` 定位、再数出「第几行第几列」
   （UTF-16 列号、中文注释、tab 缩进都会让计数出错），这个成本往往高于收益

补充的第三条来自部署约束：系统提示的工具表是稀缺资源，预设 persona 明确要求
「ultra-lean daily coding agent」。每个工具都要占预算。

#### 逐项判定

| 能力 | 无替代？ | 不需位置？ | 结论 | 依据 |
|---|---|---|---|---|
| `lsp_completion` | ❌ | ❌ | **砍** | 模型整块写代码，不逐字符敲；要知道某处能写什么，`read` 源码/类型定义更直接。价值高度依赖「有光标」前提 |
| `lsp_signature` | ❌ | ❌ | **砍** | 见下方专节 |
| `lsp_inlay_hints` | ❌ | ❌ | **砍** | 见下方专节 |
| 编辑器后端（`lsp.actions.*`） | ❌ | — | **砍** | 见下方专节 |

#### 关于 `lsp_signature`：为什么不是「symbols + read 能替换」

**严格说不能完全替换**，两者信息不同：

| 能力 | `lsp_symbols` + `read` | `lsp_signature` |
|---|---|---|
| 有哪些方法 | ✅ | ❌（需先有位置） |
| 参数列表 | ✅ 读声明 | ✅ |
| 文档 | ✅ doc comment | ✅ |
| **泛型实例化类型** | ❌ 要自己做类型推导 | ✅ 返回使用处的实例化类型 |
| **重载消解** | ❌ 拿到全部重载，自己判断 | ✅ `activeSignature` 已消解 |
| `activeParameter` | — | ✅ 但 agent 没有光标，无用 |

差异是真的（声明处的 `Option<T>` vs 使用处的 `Option<u8>`）。**但砍掉的理由是成本侧**：
它要求精确行列位置，而「数行列」极易出错、成本高于它省下的类型推导。而且
`activeParameter` 这类返回值是纯编辑器语义。

同类信息还有更可行动的获取途径：**用 `tool-bash` 跑编译器**（`cargo check` / `tsc`）
得到的是「哪里错了、为什么错」，比「类型是什么」更贴近 agent 的查询—行动循环。

#### 关于 `lsp_inlay_hints`：为什么「读代码看不到类型」不成立

inlay hints 的价值场景是「读代码时不知道推断出的类型」。但：

- **写代码时**：类型不对会直接进 `lsp_diagnostics`，不需要 hints
- **读代码时**：真正需要类型显式化的时刻，通常是准备改这段代码——那时
  `cargo check` / `tsc` 的反馈更完整，且**指出问题**而非仅陈述类型
- inlay hints 是**视觉辅助**：在 IDE 里把类型渲染成灰色小字，减少人眼扫代码时的一次跳转。
  **agent 没有「扫视」这个动作**——模型需要显式文本，而 hints 恰恰是把隐式信息
  渲染成视觉提示，这个中间层对模型是多余的
- 它还是**范围查询**：要覆盖一个文件需逐行调用或传大 range，比 signature 更麻烦

与 `activeParameter` 同类：为「有光标、有眼睛」的交互形态设计，不是为 agent 设计。

**将来若确需类型信息**，更可能正确的做法是在 `lsp_diagnostics` 输出里增强
（附带相关类型），而不是新增一个需要数行列的独立工具。

#### 关于编辑器后端协议：只服务 IDE

`editor/server.js` 实现 `lsp.actions.list` / `lsp.actions.run` / `lsp.events` 的
**JSON-RPC stdio 服务**，供外部编辑器（如 VS Code 扩展）把 DSH 当 LSP 后端调用。

两条硬证据说明它对 dsh 自身无用：

1. 源码注释明确写「为专用无头组合（dedicated headless composition）」
2. **stdout 被协议帧独占**，所以 `editor.enabled` 默认 `false`——Web/CLI 组合绝不能占用 stdout

#### 保留的 5 项：共同点是「无替代」

| 工具 | 保留理由 |
|---|---|
| `lsp_diagnostics` | 无替代；且只需文件名，不需要位置 |
| `lsp_format` | 无替代（格式化规则复杂，非文本替换可及） |
| `lsp_rename` | 无替代——语义级重命名；用 `grep` 替换会误伤同名符号 |
| `lsp_code_action` | 无替代——返回**语言服务器验证过的修复**，不是模型猜测 |
| `lsp_symbols` | 无替代——语义级结构导航，非文本 `grep` |

被砍的 4 项与保留的 5 项的分界线很清楚：**是否为 agent 的「查询—行动」循环设计，
以及是否存在语义级的不可替代能力**。

### 8.3 现有配置可直接复用

补丁层里 `- id: lsp-actions / config: { servers: {...} }` 那 5 个服务器的配置
（vtsls / biome / rust-analyzer / ty / ruff）**字段与 `LspServerEntry` 一致**，
改一下 `id` 即可迁移：

```yaml
- id: lsp                # 新：配置迁移过来
  config:
    servers:
      # ……原样粘贴 5 个服务器条目……

- id: lsp-actions        # 旧：停用
  disabled: true
```

**注意**：

- 新插件的行 id 是 `lsp`（由它自己的 patch 决定），不是 `lsp-actions`。
  迁移时必须用新 id，否则配置不生效。
- `config` 和 `disabled` 要放在**两行**里（两行同 id 会按键合并）。不能写成一行，
  因为市场的 `enableRow` 用正则删除 `- id: X` + `disabled: true` 两行，若后面还跟着
  `config:` 就会留下悬空的 YAML 块。

#### 迁移时暴露并修掉的两个空转字段

配置里用到的 `configuration`（vtsls 的 `maxTsServerMemory` / `includePackageJsonAutoImports`）
和 `formattingOptions` 在迁移前**是空转的**——schema 里声明并校验了，但没接到底层：

- `index.js` 的 `sessionFor()` 没把 `configuration` 传给 `LspSession`
- `runner.js` 对 `workspace/configuration` 请求一律硬编码回 `[]`

两个都已在阶段 6 修好（见 §9），并补了定向测试。`[]` 还有个额外问题：协议要求
每个 item 回一个元素，`[]` 对多 item 请求是**形状非法**的。

---

## 9. 实施阶段（续）

### 阶段 6：切换与验收 ✅ 已完成

**1. 迁移与开关**

| 项 | 状态 |
|---|---|
| `dsh-tool-lsp` 注册进 `dsh.profile.bundles` | ✅ |
| 5 个服务器配置迁到 `- id: lsp` | ✅ 逐字段（`--dump-config` 核对） |
| `dsh-lsp-actions` 保持停用 | ✅ `- id: lsp-actions / disabled: true` |
| 默认停用（补丁层 `- id: lsp / disabled: true`） | ✅ 跨重启保留 |
| 无 `lsp_*` 重名工具 | ✅ 合成树里 `lsp` 仅一行，旧插件停用 |

**2. 运行中开关（实测市场 `/dsh-market/toggle`，即用户在 GUI 点的同一条路径）**

```
启用 → {"live":["dsh-tool-lsp"],"activation":{"state":"live","hot":true},"restart":false}
停用 → {"live":[],"activation":{"state":"disabled"},"restart":false}
```

两个方向都即时生效、`restart: false`。挂载成功本身还顺带证明 `resolveServers()`
对 5 个命令**全部解析成功**——任一失败会在 `apply()` 抛出、条目挂不上。

**3. 真实语言服务器验收**（`test/verify-servers.mjs`，直接读补丁层的 servers 表）

```
PASS  vtsls    vtsls          encoding=utf-16 symbols=2 formatEdits=0   (802ms)
PASS  biome    biome          encoding=utf-8  formatEdits=n/a            (359ms)
PASS  rust     rust-analyzer  encoding=utf-8  diagnostic=0 symbols=1     (7760ms)
PASS  ty       ty             encoding=utf-8  diagnostic=1 symbols=1     (207ms)
PASS  ruff     ruff           encoding=utf-8  diagnostic=1 formatEdits=n/a (174ms)

5/5 servers answered.
```

脚本复刻了 DSH 的 `resolveExecutable` 规则（bare name 只按 PATHEXT 匹配），
并**按各服务器自报的能力选探针**——不是所有服务器都实现 `documentSymbol`。

**4. 期间修掉的两个缺陷**

- `configuration` 空转（见 §8.3）：`index.js` 未传、`runner.js` 硬编码回 `[]`。
  新增 `resolveConfiguration()`：按 `params.items` 逐项回元素、支持点号分段路径、
  无 section 的 item 回整个配置对象。
- `formattingOptions` 空转：`tools.js` 只用了插件全局默认。改为
  `opened.server.entry.formattingOptions ?? ctx.formattingOptions`，为此给
  `openForCall()` 的返回值补了 `server`。

测试：单元测试 113 → **119 通过**（新增 4 项配置 + 2 项格式化选项）。

**5. 遗留观察**

- `biome` 与 `ruff` **不实现** `textDocument/documentSymbol`（分别报
  `Method not found` 与 `Unknown request`）。它们只服务诊断/格式化，因此对这两个
  服务器 `lsp_symbols` 会返回 `LSP_UNSUPPORTED`——这是正确行为（工具已做能力检查），
  不是缺陷。
- `rust-analyzer` 冷启动首次 pull 诊断可能回空（索引未完成），插件已有退避重试；
  实测 7.7s 内完成。

---

## 10. 待定问题

1. 是否需要 `lsp_diagnostics` 支持跨文件/工作区聚合诊断？
2. 是否需要在工具输出里附带可点击的文件位置格式（对齐 `present` 约定）？
3. §8.2 列出的 4 项能力（补全/签名/inlay/编辑器后端）是否确实不需要？
   若有必需项，工具面要扩到 6–8 个。
