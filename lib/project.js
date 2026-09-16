/**
 * Project-config detection for routing: which configured marker file (if any)
 * governs a source file.
 *
 * The walk starts at the file's own directory and climbs toward the workspace
 * root, so one extension can be served by different language servers in sibling
 * projects — a `deno.json` project next to a `package.json` project — with no
 * hard-coded path rule. Only the nearest ancestor holding a *configured* marker
 * claims the file, and the workspace root is the hard upper bound, so a marker
 * outside the workspace can never route into it.
 *
 * @module dsh-tool-lsp/project
 */
import { relativeUnderRootUri, throwIfAborted } from './host.js';

/**
 * Every project marker some server entry declares, deduplicated in config order.
 * @param servers - the resolved servers.
 * @returns the marker file names to probe, in the order entries declare them.
 */
export function configuredProjectMarkers(servers) {
  const markers = [];
  for (const server of servers) {
    for (const marker of server.entry.projectMarkers) {
      if (!markers.includes(marker)) markers.push(marker);
    }
  }
  return markers;
}

/**
 * Find the marker file governing one source file.
 *
 * The nearest ancestor directory wins, the file's own directory is checked
 * first and the workspace root last, and markers are scanned in the given order
 * inside each directory. A file outside the workspace has no project context,
 * and no filesystem call is made when no entry declares a marker at all.
 *
 * @param fs - the filesystem seam.
 * @param markers - configured marker file names, from {@link configuredProjectMarkers}.
 * @param filePath - the source file, relative to `workspaceRoot` or absolute.
 * @param workspaceRoot - the workspace root; the walk's upper bound.
 * @param signal - optional cancellation.
 * @returns the governing marker file name, or `undefined` when none applies.
 */
export async function findProjectMarker(fs, markers, filePath, workspaceRoot, signal) {
  if (markers.length === 0 || filePath.trim() === '') return undefined;
  throwIfAborted(signal);

  let workspace;
  let file;
  try {
    workspace = await fs.resolve(workspaceRoot, signal === undefined ? {} : { signal });
    file = await fs.resolve(filePath, {
      cwd: fs.processPath(workspace),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // An unresolvable path has no project context; the glob/extension route
    // still applies, so this is a hint miss rather than a failure.
    throwIfAborted(signal);
    return undefined;
  }

  // Relativizing through file URLs keeps the walk in the backend's path space
  // and bounds it: `undefined` means the file lies outside the workspace (no
  // configured project may claim it), and `.` means the path IS the workspace
  // root, which has no directory of its own.
  const relative = relativeUnderRootUri(fs.fileUrl(workspace), fs.fileUrl(file));
  if (relative === undefined) return undefined;

  const segments = relative === '.' ? [] : relative.split('/');
  const directories = [];
  // Ancestor directories, nearest first: `a/b/c.ts` probes `a/b`, then `a`, then `''`.
  for (let length = segments.length - 1; length >= 0; length -= 1) {
    directories.push(segments.slice(0, length).join('/'));
  }
  if (directories.length === 0) directories.push('');

  for (const directory of directories) {
    for (const marker of markers) {
      const probe = directory === '' ? marker : `${directory}/${marker}`;
      if (await markerPresent(fs, probe, workspaceRoot, signal)) return marker;
    }
  }
  return undefined;
}

/**
 * Whether one marker file name exists inside a workspace-relative directory.
 *
 * An unreadable or refused probe counts as absent: routing is a hint, and a
 * directory that cannot be inspected must not fail the action — the extension
 * default still serves the call.
 *
 * @param fs - the filesystem seam.
 * @param path - the workspace-relative marker path.
 * @param cwd - the workspace root the relative path resolves against.
 * @param signal - optional cancellation.
 * @returns true when a marker file (not a directory) is present.
 */
async function markerPresent(fs, path, cwd, signal) {
  throwIfAborted(signal);
  try {
    const info = await fs.lstat(path, { cwd }, signal);
    return info !== undefined && info.type !== 'directory';
  } catch {
    throwIfAborted(signal);
    return false;
  }
}
