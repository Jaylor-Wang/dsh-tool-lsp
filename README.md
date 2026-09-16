# dsh-tool-lsp

An LSP tool surface for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): real
language-server diagnostics, formatting, rename, code actions and symbol navigation,
exposed as five tools the model can call directly.

## Tools

| Tool | What it does | Writes to disk |
|---|---|---|
| `lsp_diagnostics` | File diagnostics, merging the pull and push channels | no |
| `lsp_format` | Whole-file or range formatting | **yes** |
| `lsp_rename` | Semantic rename, across files when the server says so | **yes** |
| `lsp_code_action` | Fixes the language server is willing to apply | **yes** (when an action is applied) |
| `lsp_symbols` | Document outline / workspace symbol search | no |

Writes go through the Harness filesystem observation policy: a file changed by someone
else since this call read it fails with `LSP_WRITE_CONFLICT` rather than being
silently overwritten.

## Install

```bash
dsh plugin --profile web add dsh-tool-lsp
```

Enable it from dshmarket. **The plugin is off by default** — click the switch when you
want it, and it takes effect immediately with no restart. The enabled state does not
survive a restart.

## Configuration

The language-server table lives in the **user profile's patch layer**
(`$DSH_HOME/profiles/<name>/cordis.patch.yml`), never in the plugin package: the
package's own `cordis.patch.yml` has to stay plain `insert` rows, or dshmarket cannot
hot-mount or hot-unmount this plugin.

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
        configuration:                 # the answer to workspace/configuration
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

# The switch needs its own row: same-id rows merge key by key, and folding them
# into one row breaks the market's toggle
- id: lsp
  disabled: true
```

### Server entry fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `command` | ✅ | — | Executable name, resolved on PATH at mount; a typo fails there, not on first call |
| `extensionToLanguage` | ✅ | — | Extension → LSP language id |
| `fileGlobs` | | `[]` | Path globs, highest routing priority |
| `projectMarkers` | | `[]` | Project file names, used to split one extension across servers |
| `args` | | `[]` | Launch arguments |
| `env` | | `{}` | Extra environment entries |
| `initializationOptions` | | `null` | `initializationOptions` sent with `initialize` |
| `configuration` | | `null` | Answer to `workspace/configuration`, resolved per requested section |
| `formattingOptions` | | `null` | Overrides the global formatting options (`tabSize` / `insertSpaces`) |

### Routing

Matched in order, first hit wins:

1. `fileGlobs`
2. `projectMarkers` — the marker file in the file's nearest ancestor; only chooses among
   entries that already map the extension
3. `extensionToLanguage` — first match in configuration order

### Top-level options

`maxDiagnostics` (200), `maxSymbols` (100), `maxCodeActions` (50), `maxResultChars`
(16000), `maxDiffLines` (60), `maxDocumentBytes` (8 MiB), `timeoutMs` (60000).

## Positions

Tool arguments take **1-based UTF-16** `line` / `character`, matching editors. The
0-based wire form and the `utf-8` / `utf-32` encodings some servers negotiate are
converted internally — the model never has to think about it.

## Requirements

The language servers themselves must be on PATH; this plugin does not install them.
`vtsls`, `biome`, `rust-analyzer`, `ty`, `ruff`, or any other LSP server.

## Known limitations

- `biome` and `ruff` do not implement `textDocument/documentSymbol`, so `lsp_symbols`
  returns `LSP_UNSUPPORTED` for them. They serve diagnostics and formatting only.
- A cold server (`rust-analyzer` is the usual example) may answer a first diagnostic
  pull with nothing at all while it indexes. The plugin retries with backoff and, once
  out of attempts, reports what it has.

## Development

```bash
npm test                 # 121 unit tests, including protocol coverage over a fake server
npm run verify:servers   # every server configured in the patch layer, over real requests
```

`verify:servers` reads the `servers:` table out of the profile patch, starts each real
server, and issues one request per advertised capability. Usage:
`node test/verify-servers.mjs [profileDir]`.

**Restart the process after changing plugin source.** The market switch changes whether
the plugin is mounted, immediately — but it does not load new code from disk into a
running process (ESM module cache, confirmed by measurement).

## License

MIT
