import { ChatClient } from "@/components/chat/ChatClient";
import { Badge, EmptyState } from "@/components/ui";
import { loadPrimaryShop } from "@/lib/shop-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Buyer chat" };

export default function ChatPage() {
  const data = loadPrimaryShop();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Buyer chat</h1>
          <p>
            A built-in buyer agent that shops through the same MCP tools an outside agent would use. Each tool call is shown, with
            the signed quote the shop commits to.
          </p>
        </div>
        {data && <Badge tone="accent">{data.shop.name}</Badge>}
      </div>
      {data ? (
        <ChatClient />
      ) : (
        <EmptyState title="No shop yet">
          Run <code>npm run seed</code> to restore the demo shop.
        </EmptyState>
      )}
    </div>
  );
}
