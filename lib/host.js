/**
 * Small host-side helpers shared by the routing and client layers: abort
 * propagation and `file:` URI arithmetic over the filesystem seam's path space.
 *
 * @module dsh-tool-lsp/host
 */

/**
 * Re-throw the caller's abort reason when the signal has fired.
 *
 * Every awaited step is guarded so cancellation surfaces as the caller's own
 * reason rather than as an unrelated downstream error.
 *
 * @param signal - the caller's signal, when one was supplied.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

/**
 * Decode a `file:` URI's percent escapes without case-folding.
 *
 * Slicing a relative path off a root must stay byte-exact, so folding is applied
 * only where identity is compared (see {@link relativeUnderRootUri}).
 *
 * @param uri - the file URI.
 * @returns the decoded path portion.
 * @throws when the URI is not a `file:` URL.
 */
export function decodeFileUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== 'file:') throw new Error(`not a file uri: ${uri}`);
  // `decodeURIComponent` restores spaces and non-ASCII that `URL` percent-encoded.
  return decodeURIComponent(url.pathname);
}

/**
 * The path of `uri` relative to `rootUri`, or `undefined` when it lies outside.
 *
 * Comparison is case-folded on Windows (where paths are case-insensitive) while
 * the returned slice stays exact, so a marker probe reaches the real file.
 *
 * @param rootUri - the workspace root as a `file:` URI.
 * @param uri - the target as a `file:` URI.
 * @returns the relative path (`'.'` for the root itself), or `undefined` when outside.
 */
export function relativeUnderRootUri(rootUri, uri) {
  const root = decodeFileUri(rootUri);
  const decoded = decodeFileUri(uri);
  const identity = (candidate) => (process.platform === 'win32' ? candidate.toLowerCase() : candidate);
  if (identity(decoded) === identity(root)) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!identity(decoded).startsWith(identity(prefix))) return undefined;
  return decoded.slice(prefix.length);
}

/** Whether a thrown value is an abort, for classifying it apart from a real failure. */
export function isAbortError(error, signal) {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}
