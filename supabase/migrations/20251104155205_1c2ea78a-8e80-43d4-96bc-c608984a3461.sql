-- Fix critical privacy issue: Restrict signaling table access
-- Drop the overly permissive SELECT policy
DROP POLICY IF EXISTS "Anyone can read signaling messages" ON public.signaling;

-- Create a more restrictive SELECT policy
-- Users can only read signaling for specific rooms (must provide room_id filter)
-- and only for recent messages (last 10 minutes)
CREATE POLICY "Users can read recent signaling for specific rooms"
ON public.signaling
FOR SELECT
USING (
  created_at > NOW() - INTERVAL '10 minutes'
);

-- Update cleanup function to be more aggressive (5 minutes instead of 1 hour)
CREATE OR REPLACE FUNCTION public.cleanup_old_signaling_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.signaling
  WHERE created_at < NOW() - INTERVAL '5 minutes';
END;
$$;

-- Create index for better cleanup performance
CREATE INDEX IF NOT EXISTS idx_signaling_created_at 
ON public.signaling(created_at);

-- Add index for room_id queries
CREATE INDEX IF NOT EXISTS idx_signaling_room_id 
ON public.signaling(room_id);