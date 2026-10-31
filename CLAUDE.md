# CLAUDE.md

Read SPEC.md first. It is the source of truth.

## Rules
- Free only. No paid services, no new SaaS dependencies. Ask before adding any dependency that needs an account.
- App must always run with zero env vars (simulation mode). Never make a feature require a key to start.
- Never commit secrets. Use `.env.local`; keep `.env.example` current.
- Money and price decisions are made by deterministic code (`lib/policy.ts`, `lib/quote.ts`). The LLM only drafts text or proposes; it never sets a final price.
- Do not call the Anthropic API from the app. Runtime AI goes through `lib/llm.ts` (Gemini, then fallback).
- Sandbox only. Fake data only.
- Keep it one deployable service. No workers, no external DB.
- TypeScript strict. Small files. Add a test for each rule in `lib/policy.ts` and `lib/quote.ts`.
- Work one milestone at a time. After each milestone: run the tests, update README, commit.

- Sponsor tools (AG Studio, Channel3, Bryntum) are optional at runtime: every one needs a working fallback and must never block app start. Licence keys come from env only, never from the repo.
- Use the APIMatic Context Plugin for PayPal when writing `lib/paypal.ts`, and say so in the commit message.
- Everything must still work on Dec 21, 2026. Before adding any trial or credit-based service, check when it expires.

## Commands (create these)
- `npm run dev`   start locally (sim mode by default)
- `npm run seed`  reset DB to the demo state
- `npm test`      unit tests
- `npm run build` production build

## Usage discipline (Claude Pro limits)
- Plan briefly, then implement. Avoid re-reading large files. Prefer targeted edits.
- Start each work session by reading SPEC.md and the current milestone only.
