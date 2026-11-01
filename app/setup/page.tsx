import { SetupClient } from "@/components/setup/SetupClient";
import { Badge } from "@/components/ui";
import { getDb } from "@/lib/db";
import { MAX_SHOPS_PER_WORKSPACE } from "@/lib/shops";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up a shop" };

export default async function SetupPage() {
  const ws = await currentWorkspaceId();
  const shopCount = ws ? (getDb().prepare("SELECT COUNT(*) AS n FROM shops WHERE workspace_id = ?").get(ws) as { n: number }).n : 0;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Set up a shop</h1>
          <p>
            Paste a shop URL or upload a CSV. Quoteloom builds a draft catalog you can edit, then publishes it as a storefront with its own
            MCP endpoint for buyer agents.
          </p>
        </div>
        <Badge tone="warning" dot>Demo workspace resets on server restart</Badge>
      </div>
      <SetupClient shopCount={shopCount} maxShops={MAX_SHOPS_PER_WORKSPACE} />
    </div>
  );
}
