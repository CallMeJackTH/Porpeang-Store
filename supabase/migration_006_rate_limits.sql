-- ============================================================
-- PorPeangStore : Migration 006 — DB-backed rate limits + earning budgets
-- Idempotent (safe to re-run). Creates 2 new tables and 2 functions. Does NOT touch any existing table or data.
-- Run in the Supabase SQL Editor AFTER migration_005. The API works without it (it falls back to
-- per-instance memory), but the limits are only reliable across all serverless instances once this is applied.
-- ============================================================

-- request counters: one row per key, reset when the window expires
create table if not exists public.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int not null default 0
);

-- token buckets for earnings: one row per key (save:<user id> / room:<room id>)
create table if not exists public.budgets (
  key        text primary key,
  tokens     double precision not null,
  updated_at timestamptz not null default now()
);

alter table public.rate_limits enable row level security;
alter table public.budgets     enable row level security;
revoke all on public.rate_limits from anon, authenticated;
revoke all on public.budgets     from anon, authenticated;
grant select, insert, update, delete on public.rate_limits to service_role;
grant select, insert, update, delete on public.budgets     to service_role;

-- Counts one hit for p_key. Returns true while the caller is within p_max hits per p_window_seconds.
create or replace function public.rl_hit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits int;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds)
                            then now() else r.window_start end,
        hits         = case when r.window_start < now() - make_interval(secs => p_window_seconds)
                            then 1 else r.hits + 1 end
  returning hits into v_hits;

  -- light housekeeping (about 1 call in 200)
  if random() < 0.005 then
    delete from public.rate_limits where window_start < now() - interval '2 days';
    delete from public.budgets     where updated_at   < now() - interval '35 days';
  end if;

  return v_hits <= p_max;
end $$;

-- Token bucket: refills p_rate tokens per second up to p_cap (a new key starts full).
-- Takes up to p_amount tokens and returns how many were granted (0..p_amount).
create or replace function public.take_budget(p_key text, p_amount bigint, p_rate double precision, p_cap double precision)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tokens double precision;
  v_grant  bigint;
begin
  if p_amount is null or p_amount <= 0 then
    return 0;
  end if;

  insert into public.budgets (key, tokens, updated_at)
  values (p_key, p_cap, now())
  on conflict (key) do nothing;

  select least(p_cap, b.tokens + p_rate * greatest(0, extract(epoch from (clock_timestamp() - b.updated_at))))
    into v_tokens
    from public.budgets b
   where b.key = p_key
     for update;

  v_grant := least(p_amount, floor(v_tokens))::bigint;

  update public.budgets
     set tokens = v_tokens - v_grant,
         updated_at = clock_timestamp()
   where key = p_key;

  return v_grant;
end $$;

-- Only the server (service role) may call these.
revoke all on function public.rl_hit(text, int, int) from public, anon, authenticated;
revoke all on function public.take_budget(text, bigint, double precision, double precision) from public, anon, authenticated;
grant execute on function public.rl_hit(text, int, int) to service_role;
grant execute on function public.take_budget(text, bigint, double precision, double precision) to service_role;

-- Reload PostgREST's schema cache so the API can see the new functions immediately.
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- OPTIONAL self-check (read-only effect: the test rows are rolled back). Expected output is in the comments.
-- ------------------------------------------------------------
-- begin;
--   select public.rl_hit('selftest', 2, 60);   -- true
--   select public.rl_hit('selftest', 2, 60);   -- true
--   select public.rl_hit('selftest', 2, 60);   -- false
--   select public.take_budget('selftest', 1000, 10, 1500);  -- 1000
--   select public.take_budget('selftest', 1000, 10, 1500);  -- about 500 (bucket nearly empty)
-- rollback;
