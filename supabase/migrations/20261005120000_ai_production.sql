-- APEX AI: device identities, refresh tokens, persistent action proposals, rate-limit counters.
-- Idempotent: safe to apply repeatedly (IF NOT EXISTS everywhere). Nothing here stores
-- conversation text or athlete profile data; an executed action keeps only its result
-- (the records it created) so a retry can be answered without running it twice.

create table if not exists public.ai_identities (
  id text primary key,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.ai_refresh_tokens (
  token_hash text primary key,              -- sha-256 of the token; the token itself is never stored
  identity_id text not null references public.ai_identities (id) on delete cascade,
  family_id text not null,                  -- one login lineage; reuse of a rotated token revokes it
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists ai_refresh_tokens_family_idx on public.ai_refresh_tokens (family_id);
create index if not exists ai_refresh_tokens_expires_idx on public.ai_refresh_tokens (expires_at);

create table if not exists public.ai_actions (
  id uuid primary key,
  identity_id text not null,                -- the authenticated athlete who was shown the proposal
  conversation_id text not null,
  type text not null,
  arguments jsonb not null,
  arguments_hash text not null,
  basis text,                               -- fingerprint of the plan the proposal was based on
  summary text not null,
  preview jsonb not null,
  status text not null check (status in ('pending', 'confirmed', 'executed', 'cancelled', 'expired', 'failed')),
  claim_id text,                            -- the confirm request currently executing it
  result text,                              -- the one result (exact JSON) every confirm of this action returns
  created_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null,
  confirmed_at timestamptz,
  executed_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists ai_actions_identity_idx on public.ai_actions (identity_id, created_at desc);
create index if not exists ai_actions_created_idx on public.ai_actions (created_at);

create table if not exists public.ai_rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null,
  primary key (key, window_start)
);
create index if not exists ai_rate_limits_window_idx on public.ai_rate_limits (window_start);

-- Only the AI backend (server credentials) may touch these tables. On Supabase, RLS with no
-- policies keeps them closed to the anon/authenticated API roles; revoke them as well.
alter table public.ai_identities enable row level security;
alter table public.ai_refresh_tokens enable row level security;
alter table public.ai_actions enable row level security;
alter table public.ai_rate_limits enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.ai_identities, public.ai_refresh_tokens, public.ai_actions, public.ai_rate_limits from %I', r);
    end if;
  end loop;
end $$;
