// Display labels for dispute reasons (client-safe: no server imports).
export const DISPUTE_LABELS: Record<string, string> = {
  UNAUTHORISED: "Buyer says they did not agree to this charge",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Item not as described",
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  OTHER: "Other",
};
