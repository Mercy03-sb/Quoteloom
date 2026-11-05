import { ChatClient } from "@/components/chat/ChatClient";
import { Badge, EmptyState } from "@/components/ui";
import { ShopSwitcher } from "@/components/shell/ShopSwitcher";
import { loadActiveShop } from "@/lib/shop-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent playground" };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const { shop: wanted } = await searchParams;
  const data = loadActiveShop(await currentWorkspaceId(), wanted);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agent playground</h1>
          <p>
            This is a built-in test agent. Any MCP-capable agent can use this shop through its MCP URL. Each tool call is shown, with
            the signed quote the shop commits to.
          </p>
        </div>
        {data && (
          <div className="row">
            <Badge tone="accent">{data.shop.name}</Badge>
            <ShopSwitcher shops={data.shops} active={data.shop.slug} />
          </div>
        )}
      </div>
      {data ? (
        <ChatClient key={data.shop.slug} shopSlug={data.shop.slug} />
      ) : (
        <EmptyState title="No shop yet">
          Run <code>npm run seed</code> to restore the demo shop.
        </EmptyState>
      )}
    </div>
  );
}
