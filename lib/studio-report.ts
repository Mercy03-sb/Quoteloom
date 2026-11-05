// Prebuilt AG Studio report states: the default dashboard, and one report per prompt starter.
// The starters never call a model: the chat adapter applies these states directly, so they work with zero quota.
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

/**
 * Panel state (AgPanelsState: `collapsed` and `width`, keyed by panel id). The canvas is the focus: Filters, Compose (`edit`) and
 * Data start collapsed and can be reopened from their toggles; the AI Assistant stays open but narrower than its 350 px default.
 */
export const DEFAULT_PANELS = { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true }, ai: { width: 300 } };

const report = (p: Page): AgReportState => ({ pages: [p], selectedPageId: p.id, panels: DEFAULT_PANELS }) as AgReportState;

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

/** Starter prompts. They load `state` locally and show `reply`: the model is never called for them, so they work with zero quota. */
export const PROMPT_STARTERS: PromptStarter[] = [
  {
    label: "Chart sales per day",
    prompt: "Chart sales per day.",
    reply: "Prebuilt report: sales per day (demo orders are included and labelled in the data).",
    state: report(page("sales", { sales: { w: widgets.sales, l: at(0, 0, 24, 18) } })),
  },
  {
    label: "Which agent searches most?",
    prompt: "Which agent searches most? Show it as a chart.",
    reply: "Prebuilt report: searches per agent, highest first by eye.",
    state: report(page("agents", { agents: { w: widgets.agents, l: at(0, 0, 24, 18) } })),
  },
  {
    label: "Show unmet demand",
    prompt: "Show unmet demand.",
    reply: "Prebuilt report: searches that found nothing, with similar items from other retailers where available.",
    state: report(page("unmet", { unmet: { w: widgets.unmet, l: at(0, 0, 24, 18) } })),
  },
  {
    label: "Dispute status",
    prompt: "Show disputes by status.",
    reply: "Prebuilt report: disputes by status.",
    state: report(page("disputes", { disputes: { w: widgets.disputes, l: at(0, 0, 24, 18) } })),
  },
];

/** The starter whose prompt matches this text exactly, if any. */
export function starterFor(text: string): PromptStarter | undefined {
  const t = text.trim();
  return PROMPT_STARTERS.find((s) => s.prompt === t);
}
