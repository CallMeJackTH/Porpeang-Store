-- ============================================================
-- ร้านเพียงพอ : Supabase schema (run once in SQL Editor)
-- ============================================================
create extension if not exists pgcrypto;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player',
  avatar_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- player_saves ----------
create table if not exists public.player_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  settings jsonb not null default '{}'::jsonb,
  money bigint not null default 0 check (money >= 0),
  wealth bigint not null default 0 check (wealth >= 0),
  day int not null default 1 check (day >= 1),
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- ---------- leaderboard ----------
create table if not exists public.leaderboard (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player',
  avatar_url text not null default '',
  money bigint not null default 0 check (money >= 0),
  wealth bigint not null default 0 check (wealth >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists leaderboard_wealth_idx on public.leaderboard (wealth desc, updated_at asc);

-- ---------- game_rooms ----------
create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists game_rooms_host_idx on public.game_rooms (host_id);
create index if not exists game_rooms_expires_idx on public.game_rooms (expires_at);

-- ---------- room_members ----------
create table if not exists public.room_members (
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Player',
  avatar_url text not null default '',
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);

-- ============================================================
-- helper functions (security definer, avoid RLS recursion)
-- ============================================================
create or replace function public.is_room_member(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members m where m.room_id = p_room and m.user_id = auth.uid());
$$;

create or replace function public.is_room_member_by_code(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_members m
    join public.game_rooms r on r.id = m.room_id
    where r.room_code = p_code and m.user_id = auth.uid() and r.expires_at > now()
  );
$$;

-- ============================================================
-- auto-create profile on first Google login
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email,'Player'),'@',1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles      enable row level security;
alter table public.player_saves  enable row level security;
alter table public.leaderboard   enable row level security;
alter table public.game_rooms    enable row level security;
alter table public.room_members  enable row level security;

-- profiles: everyone signed in can read names/avatars, only owner edits own row
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- player_saves: owner can READ only. All writes go through the server API (service role)
-- which validates money/wealth. Clients cannot insert/update/delete.
drop policy if exists saves_read_own on public.player_saves;
create policy saves_read_own on public.player_saves for select to authenticated using (auth.uid() = user_id);

-- leaderboard: public read, NO client writes (anti-cheat)
drop policy if exists leaderboard_read on public.leaderboard;
create policy leaderboard_read on public.leaderboard for select to anon, authenticated using (true);

-- rooms: only members can see their room; creation/join go through the server API
drop policy if exists rooms_read_member on public.game_rooms;
create policy rooms_read_member on public.game_rooms for select to authenticated using (public.is_room_member(id));

drop policy if exists members_read_same_room on public.room_members;
create policy members_read_same_room on public.room_members for select to authenticated using (public.is_room_member(room_id));

-- ============================================================
-- Realtime
-- ============================================================
-- Leaderboard live updates (postgres_changes)
do $$ begin
  begin alter publication supabase_realtime add table public.leaderboard; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end;
end $$;

-- Private broadcast/presence channels named  room:<CODE>  are only open to room members.
alter table realtime.messages enable row level security;

drop policy if exists "room members can receive" on realtime.messages;
create policy "room members can receive" on realtime.messages for select to authenticated
using ( realtime.topic() like 'room:%' and public.is_room_member_by_code(substr(realtime.topic(), 6)) );

drop policy if exists "room members can send" on realtime.messages;
create policy "room members can send" on realtime.messages for insert to authenticated
with check ( realtime.topic() like 'room:%' and public.is_room_member_by_code(substr(realtime.topic(), 6)) );

-- ============================================================
-- Hard revoke of direct writes for API roles (defence in depth)
-- ============================================================
revoke insert, update, delete on public.player_saves from anon, authenticated;
revoke insert, update, delete on public.leaderboard  from anon, authenticated;
revoke insert, update, delete on public.game_rooms   from anon, authenticated;
revoke insert, update, delete on public.room_members from anon, authenticated;
revoke insert, delete on public.profiles from anon, authenticated;
