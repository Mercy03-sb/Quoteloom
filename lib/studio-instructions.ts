// The analyst agent's instructions: the data schema, the open page's widgets and a short usage note, so it can act on turn 1
// without spending a turn on view_schema / view_page. Pure functions over the shapes of AgStudioApi.getAiContext() and getState().
import { MAX_TURNS_PER_PROMPT } from "./studio-limits";

type Field = { fieldId: string; name?: string; dataType?: string; roles?: readonly string[]; aggregations?: readonly string[] };
type Table = { id: string; name?: string; fields: readonly Field[] };
type Widget = { type?: string; dataMapping?: unknown };
type Page = { id?: string; widgets?: Record<string, Widget | undefined> };

export function schemaText(tables: readonly Table[]): string {
  return tables
    .map((t) => `- ${t.id}: ${t.fields.map((f) => `${f.fieldId} (${[f.dataType, f.roles?.join("/")].filter(Boolean).join(", ")})`).join(", ")}`)
    .join("\n");
}

export function pageText(state: { pages?: readonly Page[]; selectedPageId?: string } | undefined): string {
  const page = state?.pages?.find((p) => p.id === state.selectedPageId) ?? state?.pages?.[0];
  const entries = Object.entries(page?.widgets ?? {});
  if (!page || entries.length === 0) return "The current page is empty.";
  return `Current page "${page.id}" has ${entries.length} widget(s):\n${entries.map(([id, w]) => `- ${id}: ${w?.type ?? "?"} ${JSON.stringify(w?.dataMapping ?? {})}`).join("\n")}`;
}

export function analystInstructions(tables: readonly Table[], state: Parameters<typeof pageText>[0]): string {
  return (
    "You build and change dashboards over the Quoteloom tables. Everything you need is below, so act right away; do not look up the schema or the page.\n\n" +
    `Tables and fields (reference a field as table.field, e.g. orders.amount):\n${schemaText(tables)}\n\n${pageText(state)}\n\n` +
    "Usage: to chart something, call add_widget with a widget type and a dataMapping on these fields (for example a line chart with orders.date as the category and orders.amount summed as the value); " +
    "you do not need to run a query first. Use execute_query only to answer a question about numbers in text. Call every tool you need in one step, then reply in one or two sentences. " +
    `You have at most ${MAX_TURNS_PER_PROMPT} steps, and the last one has no tools.`
  );
}
