/**
 * The client layer: one live language-server session per configured entry, and
 * the document bookkeeping that makes protocol requests possible.
 *
 * The layering above `connection.js` adds three things the wire layer must not
 * know about:
 *
 *  - **Reuse.** A language server indexes a whole workspace on startup, so
 *    spawning one per call would make every tool call pay a full cold start.
 *    Servers are started once, lazily, and shared by all later calls.
 *  - **Documents.** LSP is document-oriented: a server only serves positions in
 *    a file it has been told about via `didOpen`, and only accepts those
 *    positions in the encoding it negotiated at `initialize`. The codec and the
 *    open-state are therefore bound to the connection, not to the call.
 *  - **Capabilities.** The `initialize` result decides which requests are even
 *    legal, so unsupported operations fail with a clear code instead of a
 *    protocol error from the server.
 *
 * @module dsh-tool-lsp/runner
 */
import { LspConnection } from './connection.js';
import { negotiatePositionEncoding, PositionCodec } from './translate.js';
import { LSP_ERROR, lspError } from './vocabulary.js';

/** Capabilities this client advertises, independent of any server. */
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    // Pull diagnostics: the client asks per document, which avoids waiting on a
    // push notification that may never arrive for a freshly opened file.
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    publishDiagnostics: { relatedInformation: true },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: false },
    codeAction: {
      dynamicRegistration: false,
      // Only the literal edits this client can apply itself are advertised.
      codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source'] } },
      isPreferredSupport: true,
      disabledSupport: true,
    },
    formatting: { dynamicRegistration: false },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    applyEdit: false,
    workspaceEdit: { documentChanges: true },
    symbol: { dynamicRegistration: false },
  },
  general: {
    positionEncodings: ['utf-16', 'utf-8', 'utf-32'],
  },
};

/** Requests that trigger a workspace-wide scan and therefore get a longer budget. */
const SLOW_METHODS = new Set([
  'textDocument/diagnostic',
  'workspace/symbol',
  'textDocument/rename',
  'textDocument/codeAction',
]);

/**
 * Answer one `workspace/configuration` request from the entry's `configuration`.
 *
 * The protocol wants ONE reply element per requested item, in order, so a server
 * that asks for `typescript` and `javascript` sections gets each section's value
 * instead of a blanket object it would misread. A section the entry does not
 * define, and a request carrying no section at all, both fall back to the whole
 * configured object — that is what makes a flat `configuration` block work for
 * servers that ask with a single unnamed item.
 *
 * @param configuration - the entry's resolved `configuration` value (`null` when unset).
 * @param params - the request's `{ items: [{ section?, scopeUri? }] }`.
 * @returns one answer per item, `null` where nothing is configured.
 */
function resolveConfiguration(configuration, params) {
  const items = Array.isArray(params?.items) ? params.items : [];
  if (configuration === null || configuration === undefined) return items.map(() => null);
  return items.map((item) => {
    const section = typeof item?.section === 'string' && item.section !== '' ? item.section : null;
    if (section === null) return configuration;
    let value = configuration;
    for (const part of section.split('.')) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      value = value[part];
    }
    return value === undefined ? null : value;
  });
}

/**
 * One document opened into one server.
 *
 * Holds the text the server was told about, so a later call can replay the
 * server's edits against the same basis without re-reading (and possibly racing)
 * the file on disk.
 */
class OpenDocument {
  /**
   * @param uri - the document's `file:` URI.
   * @param languageId - the LSP language id it was opened with.
   * @param version - the LSP document version.
   * @param text - the exact text sent to the server.
   * @param codec - the position codec built for this text.
   */
  constructor(uri, languageId, version, text, codec) {
    this.uri = uri;
    this.languageId = languageId;
    this.version = version;
    this.text = text;
    this.codec = codec;
    /** Diagnostics received through `publishDiagnostics`, when the server pushes. */
    this.published = undefined;
    /** Whether this document has ever produced a non-empty diagnostic list. */
    this.everReported = false;
  }

  /**
   * Convert a one-based model position into this server's wire encoding.
   * @param line - one-based line.
   * @param character - one-based UTF-16 column.
   * @param encoding - the server's negotiated encoding.
   * @returns the zero-based wire position.
   */
  toWire(line, character, encoding) {
    return this.codec.encode(toZeroBased(line, character), encoding);
  }

  /**
   * Convert a wire position back into the one-based model convention.
   * @param position - the zero-based wire position.
   * @param encoding - the server's negotiated encoding.
   * @returns the one-based UTF-16 position.
   */
  toModel(position, encoding) {
    const decoded = this.codec.decode(position, encoding);
    return { line: decoded.line + 1, character: decoded.character + 1 };
  }

  /**
   * A converter from the server's encoding into zero-based UTF-16 positions.
   *
   * This is what the payload normalizers take: they translate encodings and
   * leave the coordinate base alone, and the renderers apply the one-based
   * conversion at the end. Handing them {@link toModel} instead would shift
   * every position by one.
   *
   * @param encoding - the server's negotiated encoding.
   * @returns a position converter.
   */
  decoder(encoding) {
    return (position) => this.codec.decode(position, encoding);
  }
}

/** Convert a one-based pair to zero-based, clamping non-positive input to 0. */
function toZeroBased(line, character) {
  return { line: Math.max(Math.trunc(line) - 1, 0), character: Math.max(Math.trunc(character) - 1, 0) };
}

/**
 * Normalize a `file:` URI into a comparable key.
 *
 * Servers echo document URIs back in their own canonical form rather than the
 * exact string they were sent: vtsls reports `file:///c%3A/...` for a document
 * opened as `file:///C:/...`, lowercasing the drive letter and percent-encoding
 * the colon. Comparing raw strings therefore fails to match a notification to
 * its document, and the diagnostics are silently dropped — measured, not
 * assumed. Decoding the path and case-folding the drive letter makes the two
 * forms agree while leaving the rest of the path untouched, since a
 * case-sensitive filesystem may distinguish it.
 *
 * @param uri - the URI, possibly in a server's canonical form.
 * @returns a comparison key.
 */
export function normalizeUri(uri) {
  if (typeof uri !== 'string') return '';
  try {
    const url = new URL(uri);
    const path = decodeURIComponent(url.pathname);
    const folded = /^\/[A-Za-z]:/.test(path) ? `/${path[1].toLowerCase()}${path.slice(2)}` : path;
    return `${url.protocol}//${url.host.toLowerCase()}${folded}`;
  } catch {
    return uri;
  }
}

/**
 * A live session with one configured language server.
 *
 * The session owns the connection, the capability record, and the open-document
 * table. It is created on first use and torn down by the plugin's disposer.
 */
export class LspSession {
  /** Open documents by `file:` URI. */
  #documents = new Map();

  /** In-flight diagnostics requests, so a burst of callers shares one round trip. */
  #diagnosticWaits = new Map();

  #startPromise = undefined;

  /**
   * @param spec - the resolved launch spec (command, args, cwd, limits).
   * @param spawner - the subprocess seam's `spawn`.
   * @param rootUri - the workspace root as a `file:` URI.
   * @param timeoutMs - the default per-request budget.
   */
  constructor(spec, spawner, rootUri, timeoutMs) {
    this.spec = spec;
    this.spawner = spawner;
    this.rootUri = rootUri;
    this.timeoutMs = timeoutMs;
    this.connection = undefined;
    this.capabilities = {};
    this.encoding = 'utf-16';
    this.serverInfo = undefined;
  }

  /** Whether the underlying process is still usable. */
  get alive() {
    return this.connection !== undefined && !this.connection.failed;
  }

  /**
   * Start the server and complete the LSP handshake, once.
   *
   * Concurrent callers await the same promise: two tools firing on a cold
   * workspace must not spawn two servers.
   *
   * @param signal - optional cancellation.
   * @returns the connection.
   * @throws a classified error when the server cannot be started.
   */
  async start(signal) {
    if (this.#startPromise === undefined) {
      this.#startPromise = this.#doStart(signal);
      // A failed start must not be cached: a later call should retry rather than
      // inherit a stale rejection forever.
      this.#startPromise.catch(() => {
        this.#startPromise = undefined;
      });
    }
    return this.#startPromise;
  }

  async #doStart(signal) {
    let connection;
    try {
      connection = new LspConnection(
        this.spec,
        this.spawner,
        // Most servers ask for workspace configuration at startup. This one
        // answers from the entry's own `configuration`; a server that blocks on
        // the reply would otherwise be handed `[]`, which is not just empty but
        // shape-invalid (the protocol wants one element per requested item).
        (method, params) =>
          method === 'workspace/configuration' ? resolveConfiguration(this.spec.configuration, params) : null,
      );
    } catch (error) {
      throw lspError(
        LSP_ERROR.SERVER_FAILED,
        `cannot start language server "${this.spec.command}" for "${this.spec.serverId}": ${asMessage(error)}`,
      );
    }

    this.connection = connection;
    // Record push diagnostics: a server that reports a problem only through this
    // notification would otherwise leave the diagnostics tool reporting none.
    // The handler receives every notification, so it filters on the method.
    connection.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return;
      const document = this.#documents.get(normalizeUri(params?.uri));
      if (document !== undefined) document.published = params?.diagnostics ?? [];
    });

    try {
      const result = await withTimeout(
        connection.initialize(
          {
            processId: process.pid,
            clientInfo: { name: 'dsh-tool-lsp' },
            rootUri: this.rootUri,
            capabilities: CLIENT_CAPABILITIES,
            initializationOptions: this.spec.initializationOptions ?? null,
            workspaceFolders: this.rootUri === null ? null : [{ uri: this.rootUri, name: 'workspace' }],
          },
          signal,
        ),
        this.timeoutMs,
        this.spec,
        'initialize',
      );
      this.capabilities = result?.capabilities ?? {};
      this.serverInfo = result?.serverInfo;
      // The negotiated encoding governs EVERY position this session exchanges;
      // reading it once here is what lets the rest of the code stay unaware.
      this.encoding = negotiatePositionEncoding(result?.capabilities?.positionEncoding);
    } catch (error) {
      // Leave no half-initialised process behind.
      await connection.shutdown().catch(() => {});
      this.connection = undefined;
      throw classify(error, this.spec, 'initialize');
    }
    return connection;
  }

  /**
   * Whether the server advertised a capability.
   * @param path - a dotted path into the capability object, e.g. `renameProvider`.
   * @returns the capability value, or `undefined`.
   */
  capability(path) {
    let node = this.capabilities;
    for (const segment of path.split('.')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[segment];
    }
    return node;
  }

  /**
   * Open a document (or refresh it when the text changed) before a request.
   *
   * A document already open with identical text is left alone: re-opening would
   * needlessly invalidate the server's analysis.
   *
   * @param uri - the document's `file:` URI.
   * @param languageId - the LSP language id.
   * @param text - the document text.
   * @returns the open document record.
   */
  async openDocument(uri, languageId, text) {
    const connection = await this.#require();
    const existing = this.#documents.get(normalizeUri(uri));
    if (existing !== undefined && existing.text === text) return existing;

    if (existing === undefined) {
      const document = new OpenDocument(uri, languageId, 1, text, new PositionCodec(text));
      this.#documents.set(normalizeUri(uri), document);
      await connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: document.version, text },
      });
      return document;
    }
    // A different text is a full replacement; `didChange` carries the whole
    // document rather than a diff, which is always legal and never desyncs.
    existing.version += 1;
    existing.text = text;
    existing.codec = new PositionCodec(text);
    existing.languageId = languageId;
    await connection.notify('textDocument/didChange', {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    });
    return existing;
  }

  /** The open document for a URI, when one exists. */
  document(uri) {
    return this.#documents.get(normalizeUri(uri));
  }

  /**
   * Give a document a bounded window for a push diagnostic to arrive.
   *
   * Servers that report by push send `publishDiagnostics` asynchronously after
   * `didOpen`, and may send an **empty** list first while analysis is still
   * running: vtsls announces zero diagnostics and then the real one a moment
   * later. Waiting only for the first notification would therefore stop at the
   * empty one, which is exactly the false negative this exists to prevent.
   *
   * @param uri - the document's `file:` URI.
   * @param ms - how long to wait.
   * @param signal - caller cancellation.
   * @returns true when a non-empty push arrived within the window.
   */
  async settlePublished(uri, ms, signal) {
    const document = this.#documents.get(normalizeUri(uri));
    if (document === undefined) return false;
    const deadline = Date.now() + ms;
    while (document.published === undefined || document.published.length === 0) {
      if (Date.now() >= deadline) return false;
      const before = document.published;
      await delay(50, signal).catch(() => {});
      if (document.published === before && Date.now() >= deadline) return false;
    }
    return true;
  }

  /**
   * Forget a document, telling the server to drop it.
   *
   * Used after a write: the file on disk is now newer than what the server was
   * told, and the next call re-opens it from the fresh bytes.
   * @param uri - the document's `file:` URI.
   */
  async closeDocument(uri) {
    const document = this.#documents.get(normalizeUri(uri));
    if (document === undefined) return;
    this.#documents.delete(normalizeUri(uri));
    if (this.connection !== undefined && !this.connection.failed) {
      await this.connection.notify('textDocument/didClose', { textDocument: { uri } }).catch(() => {});
    }
  }

  /** Require a live connection, starting one if needed. */
  async #require() {
    if (this.connection !== undefined && !this.connection.failed) return this.connection;
    return this.start(undefined);
  }

  /**
   * Issue one request, with the session's timeout applied.
   *
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @param signal - caller cancellation.
   * @param timeoutMs - an override budget (slow workspace-wide requests).
   * @returns the server's result.
   */
  async request(method, params, signal, timeoutMs) {
    const connection = await this.#require();
    const budget = timeoutMs ?? (SLOW_METHODS.has(method) ? this.timeoutMs * 2 : this.timeoutMs);
    try {
      return await withTimeout(connection.request(method, params, signal), budget, this.spec, method);
    } catch (error) {
      throw classify(error, this.spec, method);
    }
  }

  /**
   * Pull diagnostics for one open document, retrying while the server says it
   * has no answer yet.
   *
   * rust-analyzer is not ready the instant a document opens, and it reports that
   * two different ways: `ServerCancelled` plus `data.retriggerRequest` (the
   * protocol's own "ask again"), or simply an **empty list** while its index is
   * still warming. Both are treated as "not ready yet" and retried, because
   * reporting no diagnostics for a file that has one is a false negative — far
   * worse than an error.
   *
   * The empty-list retry only applies until the document has reported something:
   * a genuinely clean file must not pay the wait on every call.
   *
   * @param uri - the document's `file:` URI.
   * @param signal - caller cancellation.
   * @param attempts - how many times to retry a not-ready answer.
   * @returns `{ result }` or `{ unsupported: true }`.
   */
  async pullDiagnostics(uri, signal, attempts = 6) {
    if (this.capability('diagnosticProvider') === undefined) return { unsupported: true };
    const document = this.#documents.get(normalizeUri(uri));
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let result;
      try {
        result = await this.request('textDocument/diagnostic', { textDocument: { uri } }, signal);
      } catch (error) {
        // A server may advertise `diagnosticProvider` and still not implement
        // the request — vtsls does exactly that. That is not a failure of the
        // call: the push channel carries its diagnostics, so report the pull as
        // unavailable and let the caller merge what was pushed.
        if (error?.code === LSP_ERROR.UNSUPPORTED) return { unsupported: true };
        if (error?.code !== LSP_ERROR.REQUEST_CANCELLED) throw error;
        lastError = error;
        // A short, increasing pause: the server is indexing and will answer once
        // the workspace is scanned. This is the only place the plugin waits on
        // the server's own schedule rather than the caller's.
        await delay(150 * (attempt + 1), signal);
        continue;
      }

      const items = result?.items ?? [];
      if (items.length > 0) {
        if (document !== undefined) document.everReported = true;
        return { result };
      }
      // An empty answer from a document that has never reported anything is
      // indistinguishable from "still warming", so it is retried; once the
      // document has been seen to report, empty means genuinely clean.
      if (document === undefined || document.everReported === true || attempt === attempts - 1) {
        return { result };
      }
      // Back off far enough for a cold language server to finish indexing a
      // workspace; the total is bounded by `attempts`.
      await delay(500 * (attempt + 1), signal);
    }
    throw lastError;
  }

  /**
   * Close documents, shut the server down, and wait for the process to end.
   *
   * Idempotent, and safe on a session that never started.
   */
  async dispose() {
    const connection = this.connection;
    this.connection = undefined;
    this.#documents.clear();
    if (connection === undefined) return;
    await withTimeout(connection.shutdown(), this.spec.shutdownTimeoutMs, this.spec, 'shutdown').catch(() => {});
  }
}

/** Await a delay, rejecting early when the caller aborts. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a promise against the request budget.
 *
 * @param promise - the work to bound.
 * @param ms - the budget in milliseconds.
 * @param spec - the launch spec, for the server id in the message.
 * @param method - the method being attempted, for the message.
 * @returns the promise's value.
 * @throws a classified `TIMEOUT` error.
 */
function withTimeout(promise, ms, spec, method) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(lspError(LSP_ERROR.TIMEOUT, `${spec.serverId} did not answer ${method} within ${ms}ms`));
    }, ms);
    // A pending timer must never hold the process open.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Map any thrown value onto the plugin's stable error vocabulary.
 *
 * Errors this plugin already classified pass through untouched; the rest are
 * inspected for the transport's own signals so a caller sees "the server died"
 * rather than an opaque socket error.
 *
 * @param error - the thrown value.
 * @param spec - the launch spec.
 * @param method - the method that failed.
 * @returns an error carrying a `code`.
 */
export function classify(error, spec, method) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code.startsWith('LSP_')) {
    return error;
  }
  const message = asMessage(error);
  // The subprocess seam reports a missing binary as a spawn rejection.
  if (/\bENOENT\b|not found|cannot find/i.test(message)) {
    return lspError(
      LSP_ERROR.COMMAND_NOT_FOUND,
      `cannot run "${spec.command}" for "${spec.serverId}": ${message}`,
    );
  }
  if (error?.name === 'AbortError') return error;
  if (/exited|EPIPE|closed|shutting down/i.test(message)) {
    return lspError(
      LSP_ERROR.SERVER_FAILED,
      `${spec.serverId} stopped while handling ${method}: ${message}`,
    );
  }
  return lspError(LSP_ERROR.SERVER_ERROR, `${spec.serverId} failed ${method}: ${message}`);
}

/** Convert an unknown throwable to a message string. */
function asMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
