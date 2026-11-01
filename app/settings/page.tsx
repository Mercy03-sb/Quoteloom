import { RulesEditor } from "@/components/settings/RulesEditor";
import { ShopSwitcher } from "@/components/shell/ShopSwitcher";
import { Card, EmptyState } from "@/components/ui";
import { parseRules } from "@/lib/policy";
import { loadActiveShop } from "@/lib/shop-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shop settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const { shop: wanted } = await searchParams;
  const data = loadActiveShop(await currentWorkspaceId(), wanted);
  const row = data
    ? (data.db.prepare("SELECT rules_json, workspace_id FROM shops WHERE id = ?").get(data.shop.id) as { rules_json: string; workspace_id: string | null })
    : null;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Shop settings</h1>
          <p>The rules the seller agent must follow. Code applies them to every offer; an AI model may only word the reply.</p>
        </div>
        {data && <ShopSwitcher shops={data.shops} active={data.shop.slug} />}
      </div>
      {data && row ? (
        <div className="stack-lg">
          {row.workspace_id === null && (
            <div className="notice" data-tone="warning">
              {data.shop.name} is the shared demo shop, so its rules are read-only. Publish your own shop on the Set up page to edit rules.
            </div>
          )}
          <Card title="Negotiation rules">
            <RulesEditor key={data.shop.slug} slug={data.shop.slug} initial={parseRules(row.rules_json)} readOnly={row.workspace_id === null} />
          </Card>
        </div>
      ) : (
        <EmptyState title="No shop yet">
          Run <code>npm run seed</code> to restore the demo shop.
        </EmptyState>
      )}
    </div>
  );
}
