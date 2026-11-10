-- Fix private Realtime channel authorization for the live PorPeangStore schema.
-- The live game_rooms table uses room_code (not code).
CREATE OR REPLACE FUNCTION public.is_room_member_by_code(p_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.room_members m
    JOIN public.game_rooms r ON r.id = m.room_id
    WHERE r.room_code = p_code
      AND m.user_id = auth.uid()
      AND r.expires_at > now()
  );
$$;

-- Ensure room membership changes are available to the Realtime publication.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
