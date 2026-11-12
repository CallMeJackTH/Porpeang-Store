-- ============================================================
-- PorPeangStore : Migration 004 — ไม่ให้โลกร่วม (room_states) หายเมื่อห้องหมดอายุ
-- Idempotent. รันใน Supabase SQL Editor ได้หลายครั้ง ไม่ลบข้อมูล
-- ============================================================

-- 1) ต่ออายุห้องที่กำลังเล่นอยู่ตอนนี้ (ไม่งั้นโค้ดเก่าจะลบห้อง + ฟาร์มร่วมทิ้งเมื่อครบ 24 ชม.)
update public.game_rooms
   set expires_at = now() + interval '30 days'
 where status = 'playing';

-- 2) ห้องที่สร้างใหม่ให้อายุ 30 วันเป็นค่าเริ่มต้น
alter table public.game_rooms
  alter column expires_at set default (now() + interval '30 days');

-- 3) ตรวจผล
select room_code, status, expires_at,
       (select count(*) from public.room_members m where m.room_id = r.id) as members
  from public.game_rooms r
 order by created_at desc;
