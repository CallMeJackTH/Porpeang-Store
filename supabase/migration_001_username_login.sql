-- ============================================================
-- ร้านเพียงพอ : Migration 001 — Username Login (แทน Google Login)
-- รันได้หลายครั้งโดยไม่เสียหาย (idempotent) · ไม่ลบ/แก้ตารางเดิม · ไม่แตะข้อมูลผู้เล่น
-- รันหลัง schema.sql (หรือรันบนฐานข้อมูลเดิมที่มีข้อมูลอยู่แล้วได้เลย)
-- ============================================================
create extension if not exists pgcrypto;

-- ---------- players : ชื่อผู้เล่น (Player ID = id = JWT sub ที่ระบบสร้างตอนสมัคร) ----------
create table if not exists public.players (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  username_lower text not null,
  is_legacy boolean not null default false,   -- true = ผู้เล่นเดิมที่เคยเข้าด้วย Google
  claimed boolean not null default true,      -- legacy ที่ยังไม่ตั้งรหัสผ่าน = false
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  constraint players_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint players_username_lower_match check (username_lower = lower(username))
);
create unique index if not exists players_username_lower_key on public.players (username_lower);

-- ---------- รหัสย้ายข้อมูลเดิม (แอดมินออกให้ผู้เล่น legacy ที่ไม่มี session เก่าเหลือ) ----------
create table if not exists public.player_claims (
  code_hash text primary key,                 -- เก็บเฉพาะ SHA-256 ของรหัส
  player_id uuid not null references public.players(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- Migrate ผู้เล่นเดิม: คง id เดิมทุกตาราง (saves/leaderboard/rooms ไม่ต้องย้ายข้อมูล) ----------
do $$
declare r record; base text; cand text;
begin
  for r in
    select u.id, coalesce(pr.display_name, split_part(coalesce(u.email,''),'@',1), '') as nm
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    where not exists (select 1 from public.players x where x.id = u.id)
      and ( exists (select 1 from public.player_saves s where s.user_id = u.id)
         or exists (select 1 from public.leaderboard  l where l.user_id = u.id) )
  loop
    base := left(regexp_replace(coalesce(r.nm,''), '[^A-Za-z0-9_]', '', 'g'), 11);
    if length(base) < 1 then base := 'player'; end if;
    cand := base || '_' || substr(replace(r.id::text,'-',''), 1, 8);
    begin
      insert into public.players (id, username, username_lower, is_legacy, claimed)
      values (r.id, cand, lower(cand), true, false);
    exception when unique_violation then
      cand := 'p' || substr(replace(r.id::text,'-',''), 1, 19);
      insert into public.players (id, username, username_lower, is_legacy, claimed)
      values (r.id, cand, lower(cand), true, false);
    end;
  end loop;
end $$;

-- ---------- Trigger: ไม่อ่านข้อมูล Google อีกต่อไป ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'username',''), 'Player'), '')
  on conflict (id) do nothing;
  return new;
end $$;

-- ---------- RLS ----------
alter table public.players       enable row level security;
alter table public.player_claims enable row level security;

drop policy if exists players_read on public.players;
create policy players_read on public.players for select to authenticated using (true);

-- เขียนได้ผ่านเซิร์ฟเวอร์ (service role) เท่านั้น
revoke insert, update, delete on public.players from anon, authenticated;
revoke all on public.player_claims from anon, authenticated;

-- ---------- ฟังก์ชันสำหรับแอดมิน: ออกรหัสย้ายข้อมูลให้ผู้เล่นเดิม ----------
create or replace function public.admin_issue_claim(p_username text, p_hours int default 72)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_code text;
begin
  select id into v_id from public.players
   where username_lower = lower(p_username) and is_legacy and not claimed;
  if v_id is null then raise exception 'legacy player not found or already claimed'; end if;
  v_code := upper(encode(gen_random_bytes(5), 'hex'));           -- 10 ตัวอักษร
  insert into public.player_claims (code_hash, player_id, expires_at)
  values (encode(digest(v_code, 'sha256'), 'hex'), v_id, now() + make_interval(hours => p_hours));
  return v_code;
end $$;
revoke all on function public.admin_issue_claim(text, int) from public, anon, authenticated;

-- ดูรายชื่อผู้เล่นเดิมที่ยังไม่ย้าย:
--   select p.username, u.email from public.players p join auth.users u on u.id = p.id where p.is_legacy and not p.claimed;
-- ออกรหัสย้ายข้อมูล:
--   select public.admin_issue_claim('Somchai_a1b2c3');
