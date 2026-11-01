// Server-component side of workspaces: read the cookie. Pages cannot set cookies, so a visitor with
// no cookie simply sees the demo shop until their first API call (ingest, publish, chat) issues one.
import { cookies } from "next/headers";
import { isWorkspaceId, WORKSPACE_COOKIE } from "./workspace";

export async function currentWorkspaceId(): Promise<string | null> {
  const v = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  return isWorkspaceId(v) ? v : null;
}
