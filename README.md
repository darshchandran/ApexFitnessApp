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

## AI backend

A separate server (`backend/`) — the app never contains the OpenAI key or any server secret.

```bash
cp .env.example .env    # APEX_ENV=development, APEX_AUTH_SECRET (+ OPENAI_API_KEY, APEX_AI_MODEL to enable chat)
npm run ai:server       # http://127.0.0.1:8787 — a local Postgres (PGlite) in .data/ai-db unless DATABASE_URL is set
npm run ai:migrate      # apply supabase/migrations to DATABASE_URL (the server also applies them on start)
npm run ai:token -- dev_athlete 1   # DEVELOPMENT ONLY: a dev1 token for curl; refused by production servers
```

```
backend/server.ts       config (production guards) → Postgres → migrations → HTTP
backend/http.ts         node:http adapter: exact-origin CORS, observed client address
backend/ai/handler.ts   routes: /ai/auth/register|refresh|revoke, /ai/chat, /ai/actions/:id/confirm|cancel; request ids
backend/ai/auth.ts      per-install athlete identity: 15-min access tokens, rotating refresh tokens (hashed, reuse revokes)
backend/ai/store.ts     persistent actions (exactly-once via conditional UPDATEs) and per-athlete rate limits, in Postgres
backend/ai/service.ts   OpenAI Responses API loop (store: false), tool-round/call caps, deadline, safe errors
backend/ai/tools.ts     12 read-only tools + propose tools for enabled actions (nothing executes from the model)
backend/ai/actions.ts   action contracts; preview/execution through the app's own service on a private copy
backend/db/             pg driver, migrator; local.ts / test-postgres.mjs = PGlite for development and tests only
supabase/migrations/    the schema (RLS on, closed to Supabase's anon/authenticated roles)
```

**Identity.** APEX has no account system yet, so each install registers its own athlete identity (`POST /ai/auth/register`): the refresh token is stored in the device's secure storage (Keychain/Keystore via expo-secure-store; session-only on web), the access token lives in memory for 15 minutes, and the athlete is always the `sub` of a verified token — never a request field. Registration is rate-limited per address and in total, and can be closed with `APEX_AI_REGISTRATION=closed`. When APEX gets real accounts, their tokens replace registration.

**Actions.** The model can only *propose* (`log_basketball`, `adapt_today_workout`; other contracts are defined but disabled). Proposals are stored in Postgres, bound to the athlete, and expire after 5 minutes. `POST /ai/actions/:id/confirm` claims the action in the database (exactly one request can), runs the stored proposal once through the app's own service, records the result, and every later confirm — on any instance, after any restart — gets that same result. The app stores it with `apex.applyActionChanges()` (idempotent by record id).

**In the app:** APEX AI (chat icon in the Home header). Production builds set `EXPO_PUBLIC_APEX_AI_URL` (an address, not a secret); development builds without it can enter a server address. Nobody types a token. The web build's origin must be listed in `APEX_AI_CORS_ORIGINS`.

**Production checklist:** `APEX_ENV=production`, a real `OPENAI_API_KEY`, `APEX_AI_MODEL`, a random `APEX_AUTH_SECRET`, `DATABASE_URL` (Supabase: the server/service connection, `DATABASE_SSL=require`), `APEX_AI_CORS_ORIGINS` (https origins or `none`), `APEX_AI_REGISTRATION`, and `APEX_TRUST_PROXY=1` only behind a proxy that sets X-Forwarded-For. Build the app with `EXPO_PUBLIC_APEX_AI_URL=https://…`.

Conversation memory (a few recent text turns) is kept in each server's memory on purpose — no conversation text is stored; with several instances a conversation may lose earlier context, never data.

## Not in this phase

Progress photos, lb units, cloud sync (persistence is behind `KeyValueStore` so a sync layer can wrap it), drag-to-reorder (↑/↓ buttons instead).
