# APEX

Athlete training app — basketball, gym, plyometrics. **Plan → Train → Log → Adapt → Progress.**
The user owns the program; Apex executes it and adapts each day to recent load. Local-first, works offline.

## Run

```bash
npm install
npx expo start          # press a (Android), i (iOS) or w (web)
npm test                # domain + service tests (jest-expo)
npm run typecheck
npm run lint
```

Regenerate brand assets (icon, splash, favicon, SVG lockups) after changing the mark:

```bash
python scripts/make_brand.py   # needs Pillow + numpy
```

## Architecture

```
src/app/        Expo Router screens (UI only)
src/ui/         design tokens + reusable components (ApexCard, Stepper, RestTimer, TemplateCard, …)
src/services/   application layer: state, actions, persistence calls (apex.ts), React hook (useApex.ts)
src/domain/     pure TypeScript — no React, fully unit-tested
src/data/       persistence: AsyncStorage-shaped KeyValueStore; one JSON doc per small collection,
                one key per session + an index (a set log rewrites one small record)
```

Key domain modules:

| Module | Responsibility |
| --- | --- |
| `config.ts` | **Every** weight and threshold (`APEX_CONFIG`): load per session, windows, baselines, strain bands, adaptation, plyo contact targets, weekly set targets |
| `seed.ts` | The user's program verbatim (6 gym + 7 plyo templates, PPL × Upper/Lower week, Push V1/V2 rotation) |
| `areas.ts` | Body areas (quads … elastic, chest … triceps, trunk, sprint/jump/cod/explosive); exercise → areas; default exercise priority |
| `load.ts` | Per-session load split across areas (basketball, gym, plyo) and a 28-day daily series |
| `strain.ts` | Recent training context: windows (today/24h/3/7/14/28 d), baseline, acute vs usual week, trend, per-area strain |
| `volume.ts` | Weekly working sets per muscle group vs targets (under / in range / high) |
| `adaptation.ts` | Deterministic, area-specific decisions → `normal / reduced / heavily_reduced / alternative / deferred` with a full decision record and plain-language reasons |
| `insights.ts` | A few observations computed only from stored sessions |
| `generate.ts` | Template + decision → dated instance. Template is never written |
| `progression.ts` | Double progression with an explanation string |
| `records.ts` / `history.ts` | e1RM, PR detection, previous performance, weekly sets per muscle |
| `schedule.ts` | Day resolution, rotations (pointer advances on completion), week projection |

Generator pipeline: template → schedule → recent context → load → recovery → muscle volume → adaptation decision → generated workout → athlete's choice (ADAPT / KEEP PLAN / alternative / recovery day) → instance. Strain per area = today's load + load above the athlete's normal day over the last 4 days + this week above their usual week; recovery scales how much changes but never decides alone. Exercise cuts follow priority (primary protected, optional first), cost, redundancy and weekly volume.

Three separate concepts are stored: **template** (user's program) → **prescription** (`instance.exercises[].prescribed`, with original `templateSets`) → **actual** (`sets` / `logs`).

Training load is an internal management metric in arbitrary units, not a clinical measurement.

Reliability rules (enforced in `services/apex.ts`, covered by `services/__tests__/hardening.test.ts`):
completed sessions are read-only; identical taps within 1.5 s are one action (sets, practices, finish);
invalid numbers are rejected; the rest timer is stored on the session (wall-clock based); unreadable
saved data is backed up under `apex:v1:corrupt:*` and reset instead of crashing; a failed write shows
a retry banner and the next write rewrites everything.

## AI backend (Phase 5A)

A separate server — the app never contains the OpenAI key and doesn't call it yet.

```bash
cp .env.example .env    # OPENAI_API_KEY, APEX_AI_MODEL (+ optional APEX_FAST_MODEL / APEX_DEEP_MODEL), APEX_AUTH_SECRET
npm run ai:server       # POST http://127.0.0.1:8787/ai/chat, /ai/actions/:id/confirm|cancel
```

```
backend/server.ts      node:http → handleChat
backend/ai/handler.ts  auth (signed bearer token) → rate limit → validation → AIService
backend/ai/service.ts  OpenAI Responses API loop (store: false), tool-round/call caps, deadline, safe errors, text-only conversation memory
backend/ai/tools.ts    12 read-only tools + propose_log_basketball (drafts a confirmable action, executes nothing)
backend/ai/data.ts     the device's own data, sent with the request, checked like stored data, frozen, never kept
backend/ai/schemas.ts  strict tool schemas, request/response contract, action-confirmation contract, error codes
backend/ai/prompts.ts  versioned instructions
```

Actions (`backend/ai/actions.ts`): the model can only *propose* (`log_basketball`, `adapt_today_workout`; other contracts defined but disabled). `POST /ai/actions/:id/confirm` runs the stored proposal once through the app's own service on a copy of the device's data and returns `ActionChanges`, which the app stores with `apex.applyActionChanges()` (idempotent by record id); `POST /ai/actions/:id/cancel` cancels. Proposals are bound to the athlete and expire after 5 minutes. **Known limitation:** pending and executed actions live in server memory — a restart drops them (a stale confirm gets 404 and can't execute); use a shared store before running more than one server.

Tools call the existing services/domain (`todayOverview`, `progressOverview`, logbook, volume…) — no training logic is duplicated, and APEX's engine stays authoritative. Request: `{ conversation_id?, message, mode?, context?: { today, athlete_data } }`; response: `{ conversation_id, message, model, prompt_version, tools_used, action_required }`.

## Not in this phase

Progress photos, lb units, cloud sync (persistence is behind `KeyValueStore` so a sync layer can wrap it), drag-to-reorder (↑/↓ buttons instead).
