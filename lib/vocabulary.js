/**
 * Stable vocabulary for the plugin: error codes the model can act on, and the
 * protocol constants shared across modules.
 *
 * Error codes are part of the tool surface contract — the model branches on
 * them, so they must not drift with internal refactors.
 *
 * @module dsh-tool-lsp/vocabulary
 */

/**
 * Codes surfaced through tool failures. Each names a *cause the caller can act
 * on*, never an internal detail: `NO_SERVER` means "configure one",
 * `SERVER_FAILED` means "the command is wrong or the server died", and so on.
 */
export const LSP_ERROR = {
  /** No configured server claims this file (routing found no match). */
  NO_SERVER: 'LSP_NO_SERVER',
  /** The configured command could not be resolved as an executable. */
  COMMAND_NOT_FOUND: 'LSP_COMMAND_NOT_FOUND',
  /** The server process ended or the transport failed. */
  SERVER_FAILED: 'LSP_SERVER_FAILED',
  /** The request exceeded the configured timeout. */
  TIMEOUT: 'LSP_TIMEOUT',
  /** The server answered with a JSON-RPC error response. */
  SERVER_ERROR: 'LSP_SERVER_ERROR',
  /** The server has no result yet and expects a retry (LSP `RequestCancelled`). */
  REQUEST_CANCELLED: 'LSP_REQUEST_CANCELLED',
  /** The server does not implement the requested capability. */
  UNSUPPORTED: 'LSP_UNSUPPORTED',
  /** The file changed on disk since it was read; refusing to overwrite. */
  WRITE_CONFLICT: 'LSP_WRITE_CONFLICT',
};

/** LSP `ErrorCodes` values this plugin distinguishes. */
export const JSONRPC_ERROR = {
  METHOD_NOT_FOUND: -32601,
  SERVER_NOT_INITIALIZED: -32002,
  REQUEST_FAILED: -32803,
  CONTENT_MODIFIED: -32801,
  REQUEST_CANCELLED: -32800,
  /**
   * LSP 3.17 `ServerCancelled`: the server had no answer ready (typically still
   * indexing) and the client should retry. rust-analyzer answers
   * `textDocument/diagnostic` with this plus `data.retriggerRequest: true`
   * until its workspace index is warm — measured, not inferred.
   */
  SERVER_CANCELLED: -32802,
};

/** JSON-RPC protocol version string for every outbound message. */
export const JSONRPC_VERSION = '2.0';

/** Defaults for per-connection limits. */
export const DEFAULTS = {
  /** Largest single framed message accepted from a server. */
  MAX_MESSAGE_BYTES: 16 * 1024 * 1024,
  /** Retained stderr tail per server, for diagnostics on failure. */
  MAX_STDERR_BYTES: 64 * 1024 * 1024,
  /** Grace period handed to the subprocess provider when terminating. */
  KILL_GRACE_MS: 5000,
  /** How long `shutdown` may take before the process is force-terminated. */
  SHUTDOWN_TIMEOUT_MS: 5000,
};

/**
 * Build a failure the tool layer can classify.
 *
 * @param code - one of {@link LSP_ERROR}.
 * @param message - human-readable detail, shown to the model.
 * @returns an Error carrying `code`, typed for the tool layer.
 */
export function lspError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
