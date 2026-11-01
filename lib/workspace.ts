// Anonymous workspaces: a random id in an httpOnly cookie. No login, no accounts.
// Shops a visitor creates belong to their workspace; the demo shop (workspace_id NULL) is visible to everyone.
import { randomBytes } from "node:crypto";
import type { Shop } from "./catalog";
import type { DB } from "./db";

export const WORKSPACE_COOKIE = "ql_ws";
const ID_RE = /^ws_[a-f0-9]{32}$/;
const MAX_AGE_SEC = 60 * 60 * 24 * 30;

type Headers = { get(name: string): string | null };

export function newWorkspaceId(): string {
  return `ws_${randomBytes(16).toString("hex")}`;
}

export function isWorkspaceId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Workspace id carried by a request, or null if absent or malformed. Creates nothing. */
export function workspaceIdFrom(headers: Headers): string | null {
  const v = readCookie(headers.get("cookie"), WORKSPACE_COOKIE);
  return isWorkspaceId(v) ? v : null;
}

export function workspaceCookie(id: string, secure: boolean): string {
  return `${WORKSPACE_COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export type ResolvedWorkspace = { id: string; setCookie: string | null };

/**
 * For route handlers: the caller's workspace, created (and a cookie issued) if they have none.
 * A well-formed id we have never seen is accepted and registered, so a server restart does not lock anyone out.
 */
export function resolveWorkspace(db: DB, headers: Headers, secure = process.env.NODE_ENV === "production"): ResolvedWorkspace {
  const existing = workspaceIdFrom(headers);
  const id = existing ?? newWorkspaceId();
  db.prepare("INSERT OR IGNORE INTO workspaces (id) VALUES (?)").run(id);
  return { id, setCookie: existing ? null : workspaceCookie(id, secure) };
}

/** Attach the workspace cookie (if newly issued) to a response. */
export function withWorkspaceCookie(res: Response, ws: ResolvedWorkspace): Response {
  if (ws.setCookie) res.headers.append("set-cookie", ws.setCookie);
  return res;
}

/** Shops this workspace may use: its own (newest first), then the shared demo shop. */
export function visibleShops(db: DB, workspaceId: string | null): Shop[] {
  return db
    .prepare(
      `SELECT id, slug, name, source_url FROM shops
        WHERE workspace_id IS NULL OR workspace_id = ?
        ORDER BY (workspace_id IS NULL) ASC, id DESC`,
    )
    .all(workspaceId ?? "") as Shop[];
}

/** A shop by slug, only if this workspace may see it. */
export function findVisibleShop(db: DB, workspaceId: string | null, slug: string): Shop | undefined {
  return visibleShops(db, workspaceId).find((s) => s.slug === slug);
}
