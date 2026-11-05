import { generateTurn, geminiKey } from "@/lib/llm";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { canCall } from "@/lib/budget";
import { failureToError, MAX_BODY_BYTES, RESTING_MESSAGE, StudioAiRequest, toGeminiBody, toStudioResponse } from "@/lib/studio-ai";
import { beginPrompt, continuePrompt, isLastTurn, MAX_TURNS_PER_PROMPT, recordTurn, startsNewPrompt } from "@/lib/studio-prompts";
import { workspaceIdFrom } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: noStore });

/** Is the model configured? A boolean only: the key never leaves the server. */
export async function GET(): Promise<Response> {
  return Response.json({ available: Boolean(geminiKey()) }, { headers: noStore });
}

/**
 * Endpoint for the AG Studio agent adapter. Takes the Agent Framework request, asks Gemini (lib/llm.ts, GEMINI_MODEL) and answers with the
 * AgLlmResponse shape. The model can only propose calls to Studio's own tools; Studio runs them in the browser on the open report.
 * Limited per workspace and per IP, with a body size cap and an output token cap.
 */
export async function POST(req: Request): Promise<Response> {
  const limited = limitResponse(limiter().check("studio_ai", { workspace: workspaceIdFrom(req.headers), ip: clientIp(req.headers) }));
  if (limited) return limited;

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(413, "too_large", "That conversation is too large for the assistant. Start a new chat.");
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return fail(413, "too_large", "That conversation is too large for the assistant. Start a new chat.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(400, "bad_request", "The request was not valid JSON.");
  }
  const parsed = StudioAiRequest.safeParse(json);
  if (!parsed.success) return fail(400, "bad_request", "The request was not a valid agent request.");

  if (!geminiKey()) {
    const e = failureToError({ ok: false, reason: "no_key" });
    return fail(e.status, e.code, e.message); // no key: nothing is counted against the limits
  }

  // One user prompt = at most MAX_TURNS_PER_PROMPT model turns. A new prompt is checked against the per-workspace, per-IP and daily
  // limits; if any is used up Gemini is not called at all.
  const who = workspaceIdFrom(req.headers) ?? clientIp(req.headers);
  let prompt;
  if (startsNewPrompt(parsed.data.input)) {
    const quota = limiter().check("studio_prompt", { workspace: workspaceIdFrom(req.headers), ip: clientIp(req.headers) });
    if (!quota.ok || !canCall("studio")) return fail(429, "ai_resting", RESTING_MESSAGE);
    prompt = beginPrompt(who);
  } else {
    prompt = continuePrompt(who);
    if (!prompt) return fail(429, "ai_turn_cap", `I stopped after ${MAX_TURNS_PER_PROMPT} steps to save the free quota. Ask again to continue.`);
    if (!canCall("studio")) return fail(429, "ai_resting", RESTING_MESSAGE);
  }

  // On the last allowed turn the model gets no choice of tools, so the prompt ends with a text answer.
  const body = toGeminiBody(isLastTurn(prompt) ? { ...parsed.data, toolChoice: "none" } : parsed.data);
  const turn = await generateTurn({ body, source: "studio" });
  if (!turn.ok) {
    console.warn(recordTurn(prompt, { httpCalls: turn.attempts ?? 0, inputTokens: 0, outputTokens: 0, done: true }) + " (failed)");
    const e = failureToError(turn);
    return fail(e.status, e.code, e.message);
  }
  const done = !turn.parts.some((p) => p.functionCall) || isLastTurn(prompt);
  console.info(recordTurn(prompt, { httpCalls: turn.attempts, inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, model: turn.model, done }));
  return Response.json(toStudioResponse(turn), { headers: noStore });
}
