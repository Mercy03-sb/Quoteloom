// Daily budget for Gemini model calls (free tier: a few hundred a day per model, shared by the Agent playground, shop setup and Studio).
// Counts real HTTP calls to Gemini, including the ones made by fallback models. In memory, one process, disposable like lib/ratelimit.ts:
// a restart forgives the count, but Google's own quota still applies and a 429 puts the model to rest (lib/llm.ts).
// Studio may use only STUDIO_SHARE of the daily total, so the playground and shop setup always keep a reserve.
type Env = Record<string, string | undefined>;

export type CallSource = "studio" | "app";
export const DEFAULT_DAILY_BUDGET = 400;
export const STUDIO_SHARE = 0.6;

type Day = { day: string; total: number; studio: number };
const g = globalThis as unknown as { __quoteloomBudget?: Day };

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10); // UTC day

function today(now: number): Day {
  const d = g.__quoteloomBudget;
  if (d && d.day === dayOf(now)) return d;
  return (g.__quoteloomBudget = { day: dayOf(now), total: 0, studio: 0 });
}

/** GEMINI_DAILY_BUDGET (a positive whole number), else 400. */
export function dailyBudget(env: Env = process.env): number {
  const n = Number.parseInt(env.GEMINI_DAILY_BUDGET?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET;
}
/** The most model calls Studio may make in a day. */
export function studioBudget(env: Env = process.env): number {
  return Math.max(1, Math.floor(dailyBudget(env) * STUDIO_SHARE));
}

/** May one more call to Gemini be made now? Studio is held to its share; everything is held to the total. */
export function canCall(source: CallSource, env: Env = process.env, now = Date.now()): boolean {
  const d = today(now);
  if (d.total >= dailyBudget(env)) return false;
  return source !== "studio" || d.studio < studioBudget(env);
}

/** Count one HTTP call to Gemini (successful or not). */
export function recordCall(source: CallSource, now = Date.now()): void {
  const d = today(now);
  d.total += 1;
  if (source === "studio") d.studio += 1;
}

/** Counts only, for logs and tests. */
export function budgetUsed(now = Date.now()): { total: number; studio: number } {
  const { total, studio } = today(now);
  return { total, studio };
}

export function resetBudget(): void {
  g.__quoteloomBudget = undefined;
}
