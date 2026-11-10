-- PorPeangStore: repair private Supabase Realtime authorization.
-- Safe to run more than once. Does not delete player, room, or save data.

CREATE OR REPLACE FUNCTION public.is_room_member_by_code(p_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.room_members AS m
    JOIN public.game_rooms AS r ON r.id = m.room_id
    WHERE r.room_code = p_code
      AND m.user_id = auth.uid()
      AND r.expires_at > now()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_room_member_by_code(text) TO authenticated;

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "room members can receive" ON realtime.messages;
CREATE POLICY "room members can receive"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.topic() LIKE 'room:%'
  AND public.is_room_member_by_code(substr(realtime.topic(), 6))
);

DROP POLICY IF EXISTS "room members can send" ON realtime.messages;
CREATE POLICY "room members can send"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.topic() LIKE 'room:%'
  AND public.is_room_member_by_code(substr(realtime.topic(), 6))
);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
