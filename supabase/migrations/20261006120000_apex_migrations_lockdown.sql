-- apex_migrations (created by the backend's migrate()) records which migrations ran. Like the ai_
-- tables it is the backend's alone: RLS on, closed to Supabase's anon/authenticated API roles.
-- (Found by Supabase's security advisor on the live project: it was readable and writable through
-- the public API.)
create table if not exists public.apex_migrations (name text primary key, applied_at timestamptz not null default now());
alter table public.apex_migrations enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.apex_migrations from %I', r);
    end if;
  end loop;
end $$;
