-- ============================================================
-- PorPeangStore : Migration 002 — align game_rooms / room_members with api/room.js
-- Idempotent. Never deletes rows or drops columns. Existing rooms keep working.
-- Run AFTER migration_001, BEFORE fix_room_realtime.sql.
-- ============================================================

-- game_rooms: columns used by api/room.js
alter table public.game_rooms add column if not exists room_code   text;
alter table public.game_rooms add column if not exists owner_id    uuid references auth.users(id) on delete cascade;
alter table public.game_rooms add column if not exists max_players int  not null default 4;
alter table public.game_rooms add column if not exists status      text not null default 'waiting';

-- Backfill from the legacy column names (only if they exist in this database)
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='game_rooms' and column_name='code') then
    execute 'update public.game_rooms set room_code = code where room_code is null';
    execute 'alter table public.game_rooms alter column code drop not null';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='game_rooms' and column_name='host_id') then
    execute 'update public.game_rooms set owner_id = host_id where owner_id is null';
    execute 'alter table public.game_rooms alter column host_id drop not null';
  end if;
end $$;

-- Rows that could not be backfilled are unusable (no code / no owner) and already expired in practice;
-- they are left untouched. New rows always carry both values.
create unique index if not exists game_rooms_room_code_key on public.game_rooms (room_code);
create index if not exists game_rooms_owner_idx on public.game_rooms (owner_id);

do $$
begin
  alter table public.game_rooms
    add constraint game_rooms_room_code_format check (room_code is null or room_code ~ '^[A-Z0-9]{6}$') not valid;
exception when duplicate_object then null;
end $$;

-- room_members: presence timestamp written by api/room.js
alter table public.room_members add column if not exists last_seen timestamptz not null default now();

-- RLS + direct-write revokes (same as schema.sql; safe to repeat)
alter table public.game_rooms   enable row level security;
alter table public.room_members enable row level security;
revoke insert, update, delete on public.game_rooms   from anon, authenticated;
revoke insert, update, delete on public.room_members from anon, authenticated;
