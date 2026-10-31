// Runtime mode detection. With zero env vars everything runs in simulation.

export type PaypalMode = "sim" | "sandbox";
export type LlmMode = "gemini" | "fallback";

type Env = Record<string, string | undefined>;

export function paypalMode(env: Env = process.env): PaypalMode {
  const hasCreds = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  if (!hasCreds) return "sim";
  return env.PAYPAL_MODE === "sim" ? "sim" : "sandbox";
}

export function llmMode(env: Env = process.env): LlmMode {
  return env.GEMINI_API_KEY ? "gemini" : "fallback";
}

export function databasePath(env: Env = process.env): string {
  return env.DATABASE_PATH || "data/quoteloom.db";
}
