-- ============================================================
-- ร้านเพียงพอ : private Realtime access for room channels  room:<CODE>
-- Run AFTER schema.sql + migration_001 … migration_005 (it needs game_rooms.room_code and room_members).
-- Idempotent. Creates/replaces 2 helper functions and 2 Realtime policies only.
-- It does NOT create tables, touch data, or change the auth trigger (the previous version of this file did).
-- ============================================================

-- true when the signed-in user belongs to room p_room
create or replace function public.is_room_member(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members m where m.room_id = p_room and m.user_id = auth.uid());
$$;

-- true when the signed-in user is a member of the (unexpired) room with code p_code
create or replace function public.is_room_member_by_code(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_members m
    join public.game_rooms r on r.id = m.room_id
    where r.room_code = p_code and m.user_id = auth.uid() and r.expires_at > now()
  );
$$;

-- live leaderboard / member list updates
do $$ begin
  begin alter publication supabase_realtime add table public.leaderboard;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end;
end $$;

-- Private broadcast/presence channels named room:<CODE> are only open to room members.
alter table realtime.messages enable row level security;

drop policy if exists "room members can receive" on realtime.messages;
create policy "room members can receive" on realtime.messages for select to authenticated
using ( realtime.topic() like 'room:%' and public.is_room_member_by_code(substr(realtime.topic(), 6)) );

drop policy if exists "room members can send" on realtime.messages;
create policy "room members can send" on realtime.messages for insert to authenticated
with check ( realtime.topic() like 'room:%' and public.is_room_member_by_code(substr(realtime.topic(), 6)) );
