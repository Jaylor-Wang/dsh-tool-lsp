/**
 * A JSON-RPC endpoint over one language server process.
 *
 * Owns id allocation, the pending-request table, notification dispatch, and the
 * close boundary. It is protocol-only: it knows nothing about LSP capabilities,
 * routing, or documents — those live above it so this layer can be tested
 * against a trivial echo server.
 *
 * @module dsh-tool-lsp/connection
 */
import { MessageDecoder, encodeMessage } from './framing.js';
import { JSONRPC_ERROR, JSONRPC_VERSION, LSP_ERROR, lspError } from './vocabulary.js';

/** Convert an unknown throwable to an Error. */
function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * One language server connection.
 *
 * Lifecycle: constructed around an already-spawned handle, then {@link initialize}
 * performs the LSP handshake. {@link shutdown} is the graceful path; the plugin's
 * effect disposer calls it so a hot-unmount reclaims the child process.
 */
export class LspConnection {
  /** Monotonic JSON-RPC request id. Ids are per-connection, so they never collide across servers. */
  #nextId = 1;

  /** Requests awaiting a response, keyed by id. */
  #pending = new Map();

  /** Handlers for server→client notifications, in registration order. */
  #notificationHandlers = new Set();

  /** Answerer for server→client requests; `null` means answer with MethodNotFound. */
  #onServerRequest = null;

  /** Set once the transport has failed or closed; every later request rejects with it. */
  #closeReason = undefined;

  /** True between an explicit {@link shutdown} and the child's close. */
  #shuttingDown = false;

  #closed;

  /**
   * @param spec - how to launch the server.
   * @param spawner - the subprocess seam's `spawn`.
   * @param onServerRequest - answers a server→client request; throw to send an error response.
   */
  constructor(spec, spawner, onServerRequest = null) {
    this.spec = spec;
    this.#onServerRequest = onServerRequest;
    this.decoder = new MessageDecoder(spec.maxMessageBytes);

    this.handle = spawner({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      env: spec.env,
    });

    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      throw new Error('dsh-tool-lsp: subprocess implementation dropped a piped protocol stream');
    }
    this.stdin = this.handle.stdin;

    this.#closed = new Promise((resolve) => {
      const close = () => {
        // A clean shutdown is not a failure: `#shuttingDown` marks the intent, so
        // the close boundary only classifies as failure when the server went away
        // without being asked (crash, protocol error, spawn rejection).
        if (this.#closeReason === undefined && !this.#shuttingDown) {
          this.#closeReason = new Error(this.exitMessage());
        }
        this.#failAll(this.#closeReason ?? new Error(this.exitMessage()));
        resolve();
      };
      // A spawn-level failure never produces a close event, so the rejection
      // itself is the close boundary.
      this.handle.done.then(close, (error) => {
        this.#fail(asError(error));
        close();
      });
    });

    // A broken stdin surfaces as an EPIPE on the next write, not at spawn time.
    this.stdin.on('error', (error) => {
      this.#fail(asError(error));
    });
    this.handle.stdout.on('data', (chunk) => {
      this.#onStdout(chunk);
    });
  }

  /** Resolves when the transport has closed, for either reason. */
  get closed() {
    return this.#closed;
  }

  /** The retained stderr tail, for diagnosing a server that failed at load. */
  get stderrTail() {
    return this.handle.collected?.stderr?.readFrom(0).text ?? '';
  }

  /** Whether the transport has failed, even if the close event has not arrived yet. */
  get failed() {
    return this.#closeReason !== undefined;
  }

  /** The reason the transport closed, or `undefined` while it is live. */
  get closeReason() {
    return this.#closeReason;
  }

  /**
   * Observe an inbound server→client notification.
   * @param handler - invoked synchronously per notification, in registration order.
   * @returns an unsubscribe function.
   */
  onNotification(handler) {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  /**
   * Send a request and await its result.
   *
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @param signal - optional caller cancellation.
   * @returns the response `result`.
   * @throws on an error response, a write failure, close, or abort.
   */
  request(method, params, signal) {
    // A closed (or closing) transport rejects immediately. `#shuttingDown` covers
    // the window between an explicit shutdown and the child's close event, during
    // which `#closeReason` is still unset but no request can be answered.
    if (this.#closeReason !== undefined) return Promise.reject(this.#closeReason);
    if (this.#shuttingDown) return Promise.reject(new Error(`${this.spec.serverId} is shutting down`));
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return this.#send(method, params, signal);
  }

  /**
   * Issue a request without the lifecycle guards.
   *
   * Used by {@link request} (which applies the guards) and by {@link shutdown}
   * (whose handshake must run while the transport is already flagged as closing).
   */
  #send(method, params, signal) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      if (this.#closeReason !== undefined) {
        reject(this.#closeReason);
        return;
      }
      this.#pending.set(id, { resolve, reject, signal, method });
      void this.#write({ jsonrpc: JSONRPC_VERSION, id, method, params }).catch(() => {
        // The close/failure path rejects this pending entry; swallowing here only
        // prevents an unhandled rejection from the write itself.
      });
    });
    // A caller that stops awaiting (an aborted query) would otherwise surface as
    // an unhandled rejection when the connection closes.
    promise.catch(() => {});
    return promise;
  }

  /**
   * Send a notification (no response expected).
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   */
  async notify(method, params) {
    await this.#write({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  /**
   * Perform the LSP handshake: `initialize` request, then the `initialized`
   * notification.
   *
   * @param params - the `InitializeParams` payload (rootUri, capabilities, ...).
   * @param signal - optional cancellation.
   * @returns the server's `InitializeResult`.
   */
  async initialize(params, signal) {
    const result = await this.request('initialize', params, signal);
    await this.notify('initialized', {});
    return result;
  }

  /**
   * Graceful shutdown: `shutdown` request, `exit` notification, then wait for
   * the child to close. Force-termination is the subprocess provider's job once
   * the grace period expires.
   *
   * Safe to call more than once, and safe on an already-failed transport.
   */
  async shutdown() {
    if (this.#closeReason !== undefined || this.#shuttingDown) return;
    // Set the flag first so no NEW caller-issued request slips in behind the
    // handshake, then perform the handshake through the private path — a public
    // `request` here would be rejected by the guard this very flag raises.
    this.#shuttingDown = true;
    try {
      const result = this.#send('shutdown', null);
      await result;
      await this.#write({ jsonrpc: JSONRPC_VERSION, method: 'exit', params: null });
    } catch {
      // A server that died or refused `shutdown` still closes; the provider's
      // grace escalation handles a process that ignores `exit`.
    }
  }

  /** Fail the transport and reject every pending request. */
  #fail(error) {
    if (this.#closeReason !== undefined) return;
    this.#closeReason = error;
    this.#failAll(error);
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) entry.reject(error);
    this.#pending.clear();
  }

  /** A message describing how the process ended, for close-time errors. */
  exitMessage() {
    const code = this.handle.exitCode;
    const stderr = this.stderrTail.trim();
    const suffix = stderr === '' ? '' : `\n--- stderr ---\n${stderr}`;
    return `language server "${this.spec.command}" exited (code ${String(code)})${suffix}`;
  }

  async #write(message) {
    if (this.#closeReason !== undefined) throw this.#closeReason;
    const bytes = encodeMessage(message);
    // `write` is callback-based; awaiting the drain keeps a slow server from
    // buffering requests without bound.
    await new Promise((resolve, reject) => {
      this.stdin.write(bytes, (error) => {
        if (error === undefined || error === null) resolve();
        else reject(asError(error));
      });
    });
  }

  #onStdout(chunk) {
    let messages;
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      // Framing is unrecoverable: the stream position is lost, so fail the whole
      // connection rather than emit garbage.
      this.#fail(asError(error));
      return;
    }
    for (const message of messages) this.#dispatch(message);
  }

  #dispatch(message) {
    if (message === null || typeof message !== 'object') return;

    // A response: settle the matching pending entry.
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.#pending.get(message.id);
      if (entry === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(this.#serverError(entry.method, message.error));
        return;
      }
      entry.resolve(message.result);
      return;
    }

    // A server→client request: must be answered or the server may block.
    if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
      void this.#answerRequest(message);
      return;
    }

    // A notification.
    if (typeof message.method === 'string') {
      for (const handler of this.#notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch {
          // One broken observer must not stop the dispatch loop.
        }
      }
    }
  }

  async #answerRequest(message) {
    const reply = (payload) => {
      void this.#write({ jsonrpc: JSONRPC_VERSION, id: message.id, ...payload }).catch(() => {});
    };
    if (this.#onServerRequest === null) {
      reply({ error: { code: JSONRPC_ERROR.METHOD_NOT_FOUND, message: `unsupported request ${message.method}` } });
      return;
    }
    try {
      const result = await this.#onServerRequest(message.method, message.params);
      reply({ result: result ?? null });
    } catch (error) {
      reply({ error: { code: JSONRPC_ERROR.REQUEST_FAILED, message: asError(error).message } });
    }
  }

  /** Map a JSON-RPC error response onto a classified plugin error. */
  #serverError(method, error) {
    const code = typeof error?.code === 'number' ? error.code : undefined;
    const detail = typeof error?.message === 'string' ? error.message : JSON.stringify(error);
    if (code === JSONRPC_ERROR.METHOD_NOT_FOUND) {
      return lspError(LSP_ERROR.UNSUPPORTED, `${this.spec.serverId} does not implement ${method}: ${detail}`);
    }
    if (code === JSONRPC_ERROR.CONTENT_MODIFIED) {
      return lspError(LSP_ERROR.WRITE_CONFLICT, `${this.spec.serverId} rejected ${method} as a conflict: ${detail}`);
    }
    if (code === JSONRPC_ERROR.REQUEST_CANCELLED || code === JSONRPC_ERROR.SERVER_CANCELLED) {
      // Distinct from a real failure: rust-analyzer answers pull-diagnostics with
      // `ServerCancelled` (-32802) plus `data.retriggerRequest` while it is still
      // indexing, and expects the client to retry. Callers treat it as "not ready
      // yet" rather than reporting a broken server.
      const retrigger = error?.data?.retriggerRequest === true ? ' (server asks for a retry)' : '';
      return lspError(
        LSP_ERROR.REQUEST_CANCELLED,
        `${this.spec.serverId} has no result for ${method} yet${retrigger}: ${detail}`,
      );
    }
    return lspError(LSP_ERROR.SERVER_ERROR, `${this.spec.serverId} failed ${method}: ${detail}`);
  }
}
