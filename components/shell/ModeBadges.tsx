import { llmMode, paypalMode } from "@/lib/config";
import { Badge } from "@/components/ui";

/** Always-visible run state so nobody mistakes the demo for production. */
export function ModeBadges() {
  const paypal = paypalMode();
  const llm = llmMode();
  return (
    <div className="row" aria-label="Run mode">
      {paypal === "sim" ? (
        <span title="No PayPal credentials: orders are simulated and nothing leaves this server.">
          <Badge tone="warning" dot>Simulation mode</Badge>
        </span>
      ) : (
        <span title="Real PayPal sandbox orders. No real money.">
          <Badge tone="success" dot>Live sandbox</Badge>
        </span>
      )}
      <span title={llm === "gemini" ? "Gemini drafts text; code sets every price." : "Deterministic text fallback; no LLM key set."}>
        <Badge>{llm === "gemini" ? "LLM: Gemini" : "LLM: fallback"}</Badge>
      </span>
    </div>
  );
}
