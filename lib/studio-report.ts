// Prebuilt AG Studio report states: the default dashboard, and one report per prompt starter.
// The starters work without a model: when Gemini is unavailable they apply these states directly.
import type { AgReportState } from "ag-studio";

type Page = NonNullable<AgReportState["pages"]>[number];
type Widget = NonNullable<NonNullable<Page["widgets"]>[string]>;

const widgets: Record<"sales" | "agents" | "unmet" | "disputes", Widget> = {
  sales: { type: "line-chart", dataMapping: { categoryKey: [{ id: "orders.date" }], valueKey: [{ id: "orders.amount", aggregation: "sum" }] } },
  agents: { type: "column-chart-grouped", dataMapping: { categoryKey: [{ id: "searches.agent_id" }], valueKey: [{ id: "searches.query", aggregation: "count" }] } },
  unmet: {
    type: "grid",
    dataMapping: {
      cols: [{ id: "unmet_demand.query" }, { id: "unmet_demand.searches" }, { id: "unmet_demand.zero_results" }, { id: "unmet_demand.suggestions" }, { id: "unmet_demand.data_origin" }],
    },
  },
  disputes: { type: "donut-chart", dataMapping: { categoryKey: [{ id: "disputes.status" }], valueKey: [{ id: "disputes.dispute_id", aggregation: "count" }] } },
};

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan = 14) => ({ xTrack, yTrack, xSpan, ySpan });

const page = (id: string, parts: Record<string, { w: Widget; l: ReturnType<typeof at> }>): Page =>
  ({
    id,
    widgets: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.w])),
    widgetLayout: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.l])),
  }) as Page;

const report = (p: Page): AgReportState => ({ pages: [p], selectedPageId: p.id, panels: { filters: { collapsed: true } } }) as AgReportState;

/** Sales over time, searches per agent, unmet demand grid, dispute status: the page is never empty. */
export const DEFAULT_REPORT: AgReportState = report(
  page("overview", {
    sales: { w: widgets.sales, l: at(0, 0, 12) },
    agents: { w: widgets.agents, l: at(12, 0, 12) },
    unmet: { w: widgets.unmet, l: at(0, 14, 16) },
    disputes: { w: widgets.disputes, l: at(16, 14, 8) },
  }),
);

export type PromptStarter = { label: string; prompt: string; reply: string; state: AgReportState };

/** Starter prompts. `reply` and `state` are used only when the model is unavailable. */
export const PROMPT_STARTERS: PromptStarter[] = [
  {
    label: "Chart sales per day",
    prompt: "Chart sales per day.",
    reply: "Showing a prebuilt report instead: sales per day (demo orders are included and labelled in the data).",
    state: report(page("sales", { sales: { w: widgets.sales, l: at(0, 0, 24, 18) } })),
  },
  {
    label: "Which agent searches most?",
    prompt: "Which agent searches most? Show it as a chart.",
    reply: "Showing a prebuilt report instead: searches per agent, highest first by eye.",
    state: report(page("agents", { agents: { w: widgets.agents, l: at(0, 0, 24, 18) } })),
  },
  {
    label: "Show unmet demand",
    prompt: "Show unmet demand.",
    reply: "Showing a prebuilt report instead: searches that found nothing, with similar items from other retailers where available.",
    state: report(page("unmet", { unmet: { w: widgets.unmet, l: at(0, 0, 24, 18) } })),
  },
  {
    label: "Dispute status",
    prompt: "Show disputes by status.",
    reply: "Showing a prebuilt report instead: disputes by status.",
    state: report(page("disputes", { disputes: { w: widgets.disputes, l: at(0, 0, 24, 18) } })),
  },
];

/** The starter whose prompt matches this text exactly, if any. */
export function starterFor(text: string): PromptStarter | undefined {
  const t = text.trim();
  return PROMPT_STARTERS.find((s) => s.prompt === t);
}
