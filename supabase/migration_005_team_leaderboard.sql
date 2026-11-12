-- ============================================================
-- PorPeangStore : Migration 005 — อันดับทีม (1 ห้อง = 1 ทีม)
-- Idempotent. ไม่ลบข้อมูล. รันหลัง migration_004
-- ============================================================
alter table public.game_rooms add column if not exists team_wealth bigint not null default 0;
alter table public.game_rooms add column if not exists team_money  bigint not null default 0;
alter table public.game_rooms add column if not exists team_day    int    not null default 1;
create index if not exists game_rooms_team_wealth_idx on public.game_rooms (team_wealth desc);

-- เติมคะแนนให้ห้องที่เล่นอยู่แล้ว (สูตรเดียวกับ api/_lib/gamestate.js: เงินสด + สต็อกตามราคาทุน + แม่ไก่ x50)
update public.game_rooms r
   set team_money  = greatest(0, coalesce((rs.state->>'m')::numeric, 0))::bigint,
       team_day    = greatest(1, coalesce((rs.state->>'d')::int, 1)),
       team_wealth = round(
         coalesce((rs.state->>'m')::numeric, 0)
         + coalesce((rs.state->>'hens')::numeric, 0) * 50
         + (select coalesce(sum(coalesce((rs.state->'st'->>v.k)::numeric, 0) * v.c), 0)
              from (values ('ma',5),('fi',18),('sa',20),('su',20),('eg',4),('ri',100),('wa',5),('vg',8),
                           ('yo',8),('ju',9),('sd',10),('cf',12),('sn',14),('bd',18),('ic',15),('ch',12)) as v(k,c))
       )::bigint
  from public.room_states rs
 where rs.room_id = r.id;

-- ตรวจผล
select room_code, status, team_wealth, team_money, team_day from public.game_rooms order by team_wealth desc;
