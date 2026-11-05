# AG Studio notes (Milestone 5b)

Sources: ag-grid.com/studio/react/ (ai-quickstart, ai-direct-llm-runner, ai-custom-agents, ai-chat-ui, installation,
licence-install, loading-data, state, enterprise-licence), the AG Studio 3 blog post, and the shipped `.d.ts` files in
`node_modules/ag-studio` (version 3.1.0), which settle what the pages leave open. Docs checked 2026-11-06.

## Packages
- `ag-studio-react@3.1.0` and `ag-studio@3.1.0` (versions must be identical).
- They depend on `ag-grid-react`/`ag-grid-enterprise` `~36.3.0`, `ag-charts-enterprise` `~14.3.0`, `ag-stack` `~36.3.0`.
  The repo's `ag-grid-community`/`ag-grid-react` were bumped from 36.2 to 36.3 so there is one copy (npm ls shows all deduped).
- Peer deps: React 17 to 19 (we are on 19). Next.js is not mentioned in the docs; every example starts with `"use client"`,
  so Studio is loaded with `next/dynamic` and `ssr: false`.
- `ag-grid-enterprise` and `ag-charts-enterprise` arrive transitively. No account is needed to install them.

## Licence
- Preferred: `<AgStudioProvider licenseKey="...">`. Older: `AgStudioLicenseManager.setLicenseKey(key)` (from `ag-studio`).
- Supplying it from `NEXT_PUBLIC_AG_GRID_LICENSE_KEY` is fine: Next inlines `NEXT_PUBLIC_*` at **build** time, so the variable must exist
  when `next build` runs (Render builds with its dashboard env vars). It ends up in the browser bundle, as it does for any client-side licence.
  Never commit it.
- One key covers AG Studio and its built-in grid and charts widgets. AG Grid Enterprise or Charts Enterprise used *outside* Studio
  needs its own licence (enterprise-licence page). We use only Community outside Studio, so one key is enough.
- The key types are CORE, PRO, PRO-AI. The AI chat needs a key that includes AI (quickstart: "A licence error in the console: the key does not include AI").
  Checked locally with `AgStudioLicenseManager.getLicenseDetails` (marked `@internal`, so used only as a guard with a try/catch): the trial key is valid, type
  STUDIO-PRO-AI, `isTrial`, expires **20 December 2026**. That is the day before the "must work on Dec 21" rule, so `/studio` checks the key
  at runtime and falls back to AG Grid Community when it is missing, invalid, wrong type or expired.
- The docs do not say what Studio does when unlicensed or expired (the trial page only says a licence removes the watermark and console warnings).
  We do not rely on it: our own check decides.

## Data
- `<AgStudio data={...}>` takes `{ sources: [...] }`. Async source: `{ id, dataShape: 'row', getData(tableId, fieldIds, options), tables: [{ id, fields }] }`,
  `getData` returns `{ data: rows[] }`. `getData` must not query the engine.
- Fields: `{ id, name?, format, hide? }`; formats include `textFormat`, `integerFormat`, `decimalFormat`, `currencyFormat`, `dateFormat`.
- Field references in widgets are `"<tableId>.<fieldId>"`, with optional `aggregation` (`sum | avg | min | max | count | countd | first | last`).
- Reload async data with `api.reload()`.

## Report state
- `initialState` (read once): `{ pages: [{ id, widgets: { [id]: { type, dataMapping } }, widgetLayout: { [id]: { xTrack, yTrack, xSpan, ySpan } } }], selectedPageId, panels? }`.
- Widget types used: `grid` (`dataMapping.cols`), `line-chart`, `column-chart-grouped`, `bar-chart-grouped`, `donut-chart`
  (`dataMapping.categoryKey` + `valueKey`; cartesian charts also take `legendKey`).
- `api.getState()` / `api.setState(fullState)` (full object, not a patch; immutable). Events: `stateUpdated`, `studioPreDestroyed`.
- State is in memory only; the docs show no save-to-storage helper.

## Agent Framework (AI)
- Enabled by registering `AgStudioAiModule` (`<AgStudioProvider modules={[AgStudioAiModule]}>`) and passing `ai={({ api }) => createAiHarness(api, { adapter, promptStarters, models })}`.
- `AgLlmAdapter` is an in-browser object with one method, `executeTurn(request, { signal }) => { stream, complete }`, returned **synchronously**.
  `request`: `{ input: AgAiConversationItem[], instructions, tools: AgAiToolSchema[], toolChoice, responseFormat, model? }`.
  `complete` resolves to `{ id, createdAt, status, output: AgAiOutputItem[], error?: {code,message}, incompleteDetails?, usage?, model? }`.
  A failed turn is reported on `complete` through `status: 'failed'` and `error`, not on the stream.
- The docs do **not** define an HTTP format between the browser and a backend ("the adapter contract is unchanged, only the URL differs").
  We define our own: `POST /api/studio/ai` with the JSON of `AgLlmRequest`, answering with the JSON of `AgLlmResponse`. The browser adapter
  replays that response as stream events (`TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK`). No SSE: simpler, and the route has a short timeout anyway.
- Item shapes (from the `.d.ts`): input message `{ id, kind: 'input', type: 'message', role: 'user'|'system', content: [{type:'text', text}], status }`;
  output message `{ id, kind: 'output', type: 'message', role: 'assistant', content: [{type:'text', text, annotations: []}], status }`;
  tool call `{ id, kind: 'output', type: 'function_call', callId, name, arguments (JSON string), status }`;
  tool result `{ type: 'function_call_output', callId, output (string), status }`.
- The adapter does not execute tools. Studio runs them in the browser against the open report, which is why the assistant can only act through
  Studio's own tools. The server route forwards only `kind: 'client'` tool schemas to Gemini (no provider-hosted tools).
- Built-in agents: lead, data, page, planning, widget. `createAiHarness(api, { adapter, promptStarters, models })` uses them all.
- Prompt starters: `{ label, prompt }[]`. They show only until the first message. They are plain prompts that go to the model, so they cannot
  load a canned report by themselves (see "Without Gemini" below).
- Docs examples point at an AG Grid hosted endpoint (`ai-api.ag-grid.com`). We do not use it.

## Without Gemini
The chat panel is always an LLM chat; the framework has no "canned reply" hook except a custom adapter. Chosen approach: our adapter calls the route; when
the route says Gemini is unavailable (no key, rate limited, overloaded, timeout) the adapter returns a completed turn whose text says so plainly, and for
the starter prompts it matches (exact text) it answers with a short message and applies a prebuilt report state through `api.setState`, so the demo works
without a model. See `lib/studio-report.ts` and `components/studio/adapter.ts`.
