import { generateTurn, geminiKey } from "@/lib/llm";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { failureToError, MAX_BODY_BYTES, StudioAiRequest, toGeminiBody, toStudioResponse } from "@/lib/studio-ai";
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

  const turn = await generateTurn({ body: toGeminiBody(parsed.data) });
  if (!turn.ok) {
    const e = failureToError(turn);
    return fail(e.status, e.code, e.message);
  }
  return Response.json(toStudioResponse(turn), { headers: noStore });
}
