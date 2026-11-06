// Per-prompt accounting for the Studio assistant route. One user prompt may take at most MAX_TURNS_PER_PROMPT model turns
// (the browser agent also stops there, via maxTurns); the last allowed turn is made without tools so the answer ends in text.
// Counts only: nothing the user typed or the model said is stored or logged.
import { randomBytes } from "node:crypto";

import { MAX_TURNS_PER_PROMPT } from "./studio-limits";

export { MAX_TURNS_PER_PROMPT };
const MAX_STATES = 2000;

export type PromptState = { id: string; turns: number; httpCalls: number; inputTokens: number; outputTokens: number; startedAt: number };
const g = globalThis as unknown as { __quoteloomPrompts?: Map<string, PromptState> };
const states = (): Map<string, PromptState> => (g.__quoteloomPrompts ??= new Map());

/** A request starts a new prompt when its last conversation item is the user's message (not a tool result being sent back). */
export function startsNewPrompt(input: readonly Record<string, unknown>[]): boolean {
  const last = input[input.length - 1];
  return Boolean(last && last.type === "message" && last.role === "user");
}

/** Begin a prompt for `key` (workspace id, else IP). */
export function beginPrompt(key: string, now = Date.now()): PromptState {
  const m = states();
  if (m.size >= MAX_STATES) m.delete(m.keys().next().value as string);
  const s: PromptState = { id: randomBytes(3).toString("hex"), turns: 0, httpCalls: 0, inputTokens: 0, outputTokens: 0, startedAt: now };
  m.set(key, s);
  return s;
}

/** The running prompt for `key`, if it may still take a turn. */
export function continuePrompt(key: string): PromptState | undefined {
  const s = states().get(key);
  return s && s.turns < MAX_TURNS_PER_PROMPT ? s : undefined;
}

/** The last turn of a prompt: the model must answer in text. */
export const isLastTurn = (s: PromptState): boolean => s.turns + 1 >= MAX_TURNS_PER_PROMPT;

/** Record one finished turn and return the log line (counts only). */
export function recordTurn(s: PromptState, t: { httpCalls: number; inputTokens: number; outputTokens: number; model?: string; done: boolean }): string {
  s.turns += 1;
  s.httpCalls += t.httpCalls;
  s.inputTokens += t.inputTokens;
  s.outputTokens += t.outputTokens;
  const base = `[studio-ai] prompt=${s.id} turn=${s.turns}/${MAX_TURNS_PER_PROMPT} http_calls=${t.httpCalls} input_tokens=${t.inputTokens}${t.model ? ` model=${t.model}` : ""}`;
  return t.done ? `${base} | prompt total: model_turns=${s.turns} http_calls=${s.httpCalls} input_tokens=${s.inputTokens} output_tokens=${s.outputTokens}` : base;
}

export function resetPrompts(): void {
  states().clear();
}

const label = (name: string) => name.replace(/_/g, " ");

/**
 * What to tell the reader when a prompt ran out of steps: what the agent did (from the tool calls in the conversation) and that
 * the rest is left. Counts and tool names only; nothing the user typed.
 */
export function capMessage(input: readonly Record<string, unknown>[], max = MAX_TURNS_PER_PROMPT): string {
  const names = input.filter((i) => i.type === "function_call").map((i) => String(i.name ?? ""));
  const widgets = names.filter((n) => n === "add_widget").length;
  const others = [...new Set(names.filter((n) => n && n !== "add_widget"))].map(label);
  const did: string[] = [];
  if (widgets) did.push(`added ${widgets} widget${widgets === 1 ? "" : "s"}`);
  if (others.length) did.push(`used ${others.join(", ")}`);
  const done = did.length ? `I ${did.join(" and ")}` : "I didn't get to change the dashboard";
  return `${done}, but didn't finish within ${max} steps (the free quota is limited). Ask me to continue.`;
}

/** Added to the last turn's request: the model has no tools left and must say what is done and what is not. */
export const LAST_TURN_NOTE =
  "\n\nThis is your last step and you have no tools now. Reply in one or two sentences: say what you already did and, if something is left, what it is and that the user can ask you to continue.";
