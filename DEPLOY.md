# Deploying APEX AI

```
APEX app (iOS / Android / web)
   │  HTTPS  (EXPO_PUBLIC_APEX_AI_URL — an address, never a secret)
   ▼
APEX AI backend  (this repo: backend/, a Node container)
   │  TLS (DATABASE_URL, verified certificate)        │  HTTPS (OPENAI_API_KEY)
   ▼                                                  ▼
Supabase / Postgres                              OpenAI Responses API
```

The athlete's training data stays on the device; the backend stores only install identities,
hashed refresh tokens, action proposals/results and rate-limit counters (`supabase/migrations`).

## 0. Production: Supabase (database + Edge Function)

Production is the Supabase project **`apex-ai`** (ref `gbknsjfbtdfvazhhrtsn`, region `ap-south-1`,
org "Apex Fitness App"). The backend runs there as the Edge Function **`apex-ai`**:

```
https://gbknsjfbtdfvazhhrtsn.supabase.co/functions/v1/apex-ai      ← EXPO_PUBLIC_APEX_AI_URL
  /healthz  /readyz  /ai/auth/*  /ai/chat  /ai/actions/:id/confirm|cancel
```

`backend/edge.ts` serves the exact same routes, auth, rate limits, persistent actions and readiness
as the Node server (`http.ts` `serve()` is shared); only the runtime differs (Deno).

| Setting | Where it comes from |
| --- | --- |
| `APEX_ENV=production`, `DATABASE_SSL=require` | fixed in `edge.ts` (cannot be overridden) |
| `DATABASE_URL` | Supabase's built-in `SUPABASE_DB_URL` (TLS required, certificate verified; any `sslmode` stripped) |
| `APEX_AUTH_SECRET` | Supabase **Vault** secret `apex_auth_secret`, generated inside the database (below) — nobody ever sees it |
| `OPENAI_API_KEY` | **Edge Function secret** (Dashboard → Edge Functions → Secrets) — set by the owner |
| `APEX_AI_MODEL` | Edge Function secret, optional (default `gpt-5-mini`) |
| `APEX_AI_CORS_ORIGINS` / `APEX_AI_REGISTRATION` | defaults `none` / `open`; override with Edge Function secrets |

The function is deployed with `verify_jwt = false` because it authenticates every AI request
itself (APEX access tokens); `/healthz` and `/readyz` are public by design and reveal only check
names.

**Deploy / redeploy**

1. `npm run ai:build:edge` → `supabase/functions/apex-ai/index.js` (generated; openai/pg are pinned
   `npm:` imports; migrations embedded). Commit and push it.
2. Deploy the function `apex-ai` with this one-file entry (`index.ts`), pinned to that commit:
   `import 'https://raw.githubusercontent.com/darshchandran/ApexFitnessApp/<commit>/supabase/functions/apex-ai/index.js';`
   (Supabase CLI: `supabase functions deploy apex-ai --no-verify-jwt` with the same entry; or the
   Supabase MCP `deploy_edge_function`.) Supabase bundles the import at deploy time.
3. On first start the function applies pending migrations (advisory lock, `apex_migrations`).
4. Check `GET …/apex-ai/readyz` → 200, then run the live smoke test (§6).

**One-time setup (already done for `apex-ai`)** — the token-signing secret, generated in the database:

```sql
select vault.create_secret(encode(extensions.gen_random_bytes(48), 'base64'), 'apex_auth_secret',
  'Signs APEX AI access tokens. Generated in-database; never displayed.')
where not exists (select 1 from vault.secrets where name = 'apex_auth_secret');
```

Rotating it (`vault.update_secret`) signs every device out of its current access token; devices
refresh automatically. Logs: Dashboard → Edge Functions → apex-ai → Logs (one JSON line per event).

The sections below describe the same backend as a Node container for any other host.

## 1. Backend environment (server only — never `EXPO_PUBLIC_`)

| Variable | Production value | Notes |
| --- | --- | --- |
| `APEX_ENV` | `production` | Required, no default. Production refuses to start unless every row below is valid. |
| `OPENAI_API_KEY` | your OpenAI key (`sk-…`) | Server only. |
| `APEX_AI_MODEL` | e.g. a current GPT model id | Also optional `APEX_FAST_MODEL`, `APEX_DEEP_MODEL` (fall back to `APEX_AI_MODEL`). |
| `APEX_AUTH_SECRET` | ≥ 32 random characters | Signs 15-minute access tokens. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `DATABASE_URL` | `postgres://…` (no `sslmode=`) | Supabase: the **Supavisor session pooler** (`…pooler.supabase.com:5432`, user `postgres.<project-ref>`) suits a long-running server; the transaction pooler (`:6543`) also works with this backend. |
| `DATABASE_SSL` | `require` | Certificate is verified. |
| `DATABASE_CA_CERT` | Supabase CA (PEM text with `\n`, or a file path) | Needed if the connection fails with a certificate error: Supabase Dashboard → Database → SSL configuration → download the certificate. |
| `APEX_AI_CORS_ORIGINS` | `https://<web app origin>` or `none` | Exact origins, comma-separated, https only, never `*`. Native apps need none. |
| `APEX_AI_REGISTRATION` | `open` | See "Registration policy". |
| `APEX_TRUST_PROXY` | `1` only behind a proxy that appends the client address to `X-Forwarded-For` | Most container hosts (Cloud Run, Fly, Render, Railway) do. Leave unset otherwise. |
| `PORT` / `HOST` | set by the host / `0.0.0.0` (set in the Dockerfile) | |

Never set `OPENAI_BASE_URL` in production (refused). `npm run ai:token` refuses to run outside
development and production servers reject its `dev1` tokens.

## 2. Database (Supabase)

1. Create the project (or use the existing one). Nothing here touches other tables.
2. Apply the schema — either is fine, both are idempotent:
   - `DATABASE_URL=… DATABASE_SSL=require npm run ai:migrate`, or
   - `supabase db push --db-url "$DATABASE_URL"` (same files in `supabase/migrations`).
3. The server also applies pending migrations at start, under an advisory lock, **before it
   listens**: if a migration fails the process exits and the host keeps the previous release.
4. Check in the SQL editor: `select relname, relrowsecurity from pg_class where relname like 'ai\_%';`
   → four tables, RLS on (closed to the `anon`/`authenticated` API roles; the backend's
   server connection owns the tables).

## 3. Build and deploy the backend

Any container host behind HTTPS works; no host is assumed.

```bash
docker build -t apex-ai .                       # multi-stage: compiles backend/ → node backend/server.js
# push the image to your host and set the environment from section 1 as secrets
```

Without Docker: `npm ci && npm run ai:build`, then deploy `build/server/` and run
`npm install --omit=dev && node backend/server.js` there (runtime dependencies: `openai`, `pg`).

Health checks for the host:

- `GET /healthz` → `200 {"status":"ok"}` — the process is alive (liveness).
- `GET /readyz` → `200` when the database is reachable, the schema current, auth configured and
  (production) the model configured; otherwise `503` naming the failing check — never a value.

## 4. Mobile and web clients

```bash
EXPO_PUBLIC_APEX_AI_URL=https://<your-backend> npm run export:production   # web + Android export, then a bundle scan
```

- The script refuses non-https or local addresses and fails if the bundle contains a secret,
  an OpenAI endpoint, database or token-signing code, the dev token tool, or a local AI address —
  or if the production address is missing from it.
- Production builds ignore any address that isn't `https://` on a public host (APEX AI is then
  simply off in that build). Development builds without the variable can enter a server.
- Store builds (EAS): set `EXPO_PUBLIC_APEX_AI_URL` in the production build profile's `env`.
  expo-secure-store is a native module, so native builds need a rebuild.

## 5. Identity and registration policy

- **Production:** each app install registers its own identity (`POST /ai/auth/register`). This is
  install-level identity, **not a user account**: it proves "the same install as before", not who
  the person is. Access tokens last 15 minutes; refresh tokens rotate on every use, are stored
  hashed, live in the device's secure storage, and a reused one revokes its whole lineage.
- **Initial policy: `APEX_AI_REGISTRATION=open`** — closing it would lock out every new install
  because there is no account system to provision them. Abuse is bounded by 10 registrations per
  client address per hour and 500 per hour service-wide, plus per-install chat/action limits.
  Set `closed` to stop new installs immediately (existing ones keep working).
- **Development:** the same flow against a local server; `npm run ai:token` makes `dev1` tokens
  for curl that only a development server accepts.

## 6. Live validation (after every production deploy)

For Supabase the backend URL is `https://gbknsjfbtdfvazhhrtsn.supabase.co/functions/v1/apex-ai`; a
restart is a redeploy of the function (§0).

```bash
npm run ai:smoke -- --url https://<your-backend>                       # health, real OpenAI answers, actions, isolation, failures, rate limits
npm run ai:smoke -- --url https://<your-backend> --phase restart-before
#   … restart / redeploy the backend …
npm run ai:smoke -- --url https://<your-backend> --phase restart-after
#   optional: --slow (action expiry, +5 min)  --registration-limit (registers until 429)
```

It uses synthetic athletes built with APEX's own seed (no real data), throwaway install
identities that it revokes at the end, prints PASS/FAIL per check plus the request ids to find in
the server logs, and prints an optional SQL statement to delete its test identities.

Logs are one JSON line per event (`ai.request`, `ai.tool`, `ai.action`, `ai.auth`, `ai.error`,
`ai.model_error`) with `rid`, status, latency, model, tool and action type — never tokens, keys,
passwords, message text, profile data or action arguments.

## 7. Known limitations

- Install-level identity, not accounts (see §5). Web sign-in lasts for the browser session.
- Conversation context (a few recent turns) is kept in each server's memory by design — with
  several instances a conversation can lose earlier context, never data.
- Rate limits use fixed windows (a burst at a window boundary can briefly reach twice the limit).
