/**
 * Shared workspace authorization for WebSocket log/event streams.
 *
 * Log-stream sockets (`/ws/workflow-runs/:id/logs`, `/ws/persistent-agents/:id/events`,
 * `/ws/pr-reviews/:id/logs`, ...) authenticate the caller but must ALSO confirm
 * the resolved resource belongs to the caller's workspace before streaming any
 * output — otherwise a client could tail another tenant's agent logs live.
 */

/** Minimal WebSocket surface — avoids depending on @types/ws. */
interface WsSocket {
  close(code?: number, reason?: string): void;
}

/** WebSocket close code used for a cross-workspace access denial. */
export const WS_CLOSE_FORBIDDEN = 4403;

/**
 * Assert that the socket's user and the resolved resource share a workspace.
 *
 * Workspaces are null-normalized before comparison, so:
 *  - a `null` user workspace (auth-disabled synthetic dev user) matches a
 *    `null` resource workspace (local dev resources) and passes, and
 *  - a scoped user (`workspace A`) is denied access to a resource in
 *    `workspace B` or to a legacy null-workspace resource.
 *
 * On mismatch the socket is closed with code 4403 and `false` is returned;
 * callers should stop and release the connection. Returns `true` when access
 * is allowed.
 */
export function assertWorkspace(
  socket: WsSocket,
  userWorkspaceId: string | null | undefined,
  resourceWorkspaceId: string | null | undefined,
): boolean {
  const user = userWorkspaceId ?? null;
  const resource = resourceWorkspaceId ?? null;
  if (user !== resource) {
    socket.close(WS_CLOSE_FORBIDDEN, "Access denied");
    return false;
  }
  return true;
}
