-- ============================================================
-- PorPeangStore : Migration 003 — shared world state for rooms
-- Idempotent. Run once in the Supabase SQL Editor (already applied to the live project).
-- Used by api/room.js actions: start / state / sync
-- ============================================================
create table if not exists public.room_states (
  room_id uuid primary key references public.game_rooms(id) on delete cascade,
  state jsonb not null,
  version bigint not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.room_states enable row level security;
revoke all on public.room_states from anon, authenticated;
grant select, insert, update, delete on public.room_states to service_role;
