# dsh-tool-lsp

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的 LSP 工具面：把真实语言服务器
的诊断、格式化、重命名、代码动作和符号导航，变成模型可直接调用的 5 个工具。

## 工具

| 工具 | 作用 | 会写盘 |
|---|---|---|
| `lsp_diagnostics` | 文件诊断（合并 pull 与 push 两条通道） | 否 |
| `lsp_format` | 整文件 / 范围格式化 | **是** |
| `lsp_rename` | 语义级重命名，可跨文件 | **是** |
| `lsp_code_action` | 语言服务器给出的修复建议 | **是**（应用所选动作时） |
| `lsp_symbols` | 文件大纲 / 工作区符号搜索 | 否 |

写盘走 Harness 的文件系统观测策略：文件在本次读取之后被外部改过，会以
`LSP_WRITE_CONFLICT` 失败，而不是静默覆盖。

## 安装

```bash
dsh plugin --profile web add dsh-tool-lsp
```

装完在 dshmarket 里启用。**插件默认关闭**——用时点一下开关，即时生效，不需要重启。开关不跨重启保留：重启后回到关闭。

## 配置

语言服务器表写在**用户 profile 的补丁层**（`$DSH_HOME/profiles/<name>/cordis.patch.yml`），
不能写在插件包内：包内的 `cordis.patch.yml` 必须保持纯 `insert` 行，否则 dshmarket
无法热挂载/卸载本插件。

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
          ".jsx": javascriptreact
        projectMarkers: ["package.json", "tsconfig.json"]
        configuration:                 # workspace/configuration 的应答
          typescript:
            preferences:
              includePackageJsonAutoImports: "on"

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

# 开关必须另起一行：同 id 的多行会按键合并，但合成一行会被市场开关破坏
- id: lsp
  disabled: true
```

### 服务器条目字段

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `command` | ✅ | — | 可执行文件名，挂载时按 PATH 解析；写错会当场报错 |
| `extensionToLanguage` | ✅ | — | 扩展名 → LSP languageId |
| `fileGlobs` | | `[]` | 路径 glob，优先级最高 |
| `projectMarkers` | | `[]` | 项目标记文件名，用于同扩展名多服务器分流 |
| `args` | | `[]` | 启动参数 |
| `env` | | `{}` | 追加的环境变量 |
| `initializationOptions` | | `null` | `initialize` 的 `initializationOptions` |
| `configuration` | | `null` | `workspace/configuration` 的应答，按 section 分段返回 |
| `formattingOptions` | | `null` | 覆盖全局格式化选项（`tabSize` / `insertSpaces`） |

### 分流规则

按顺序匹配，命中即停：

1. `fileGlobs`
2. `projectMarkers` —— 文件最近祖先目录中的标记文件；只在已映射该扩展名的条目间挑选
3. `extensionToLanguage` —— 按配置顺序取第一个

### 顶层选项

`maxDiagnostics`（200）、`maxSymbols`（100）、`maxCodeActions`（50）、
`maxResultChars`（16000）、`maxDiffLines`（60）、`maxDocumentBytes`（8 MiB）、
`timeoutMs`（60000）。

## 位置约定

工具参数里的 `line` / `character` 是 **1-based UTF-16**，与编辑器一致。
与服务器之间的 0-based 及 `utf-8` / `utf-32` 编码转换由插件内部完成，模型不需要关心。

## 前置条件

语言服务器本身要装在 PATH 上，插件不代为安装：

`vtsls`、`biome`、`rust-analyzer`、`ty`、`ruff` 等，或任何实现了 LSP 的服务器。

## 已知限制

- `biome` 与 `ruff` 不实现 `textDocument/documentSymbol`，对它们调用 `lsp_symbols`
  会返回 `LSP_UNSUPPORTED`。它们只服务诊断与格式化。
- 冷启动的服务器（如 `rust-analyzer`）首次拉取诊断可能为空（索引未完成），
  插件会退避重试；超过上限就返回已拿到的结果。

## 开发

```bash
npm test                 # 121 项单元测试，含假服务器协议覆盖
npm run verify:servers   # 用真实语言服务器跑通补丁层里配置的每一台
```

`verify:servers` 会读取 profile 补丁层里的 `servers:` 表，逐个启动真实服务器并
按其自报能力发一次真实请求。用法：`node test/verify-servers.mjs [profileDir]`。

**改完插件源码要重启一次进程**：市场开关能即时改变「是否挂载」，但不会把磁盘上的
新代码装进已运行的进程（ESM 模块缓存，实测确认）。

## License

MIT
