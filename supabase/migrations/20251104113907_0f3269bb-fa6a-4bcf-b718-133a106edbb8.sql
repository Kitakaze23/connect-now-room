-- Create signaling table for WebRTC signaling
CREATE TABLE public.signaling (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.signaling ENABLE ROW LEVEL SECURITY;

-- Create policies for signaling
-- Users can read all messages in any room (needed for WebRTC signaling)
CREATE POLICY "Anyone can read signaling messages"
ON public.signaling
FOR SELECT
USING (true);

-- Users can insert signaling messages
CREATE POLICY "Anyone can insert signaling messages"
ON public.signaling
FOR INSERT
WITH CHECK (true);

-- Add index for faster room_id queries
CREATE INDEX idx_signaling_room_id ON public.signaling(room_id);

-- Add index for created_at to efficiently clean up old messages
CREATE INDEX idx_signaling_created_at ON public.signaling(created_at);

-- Function to clean up old signaling messages (older than 1 hour)
CREATE OR REPLACE FUNCTION public.cleanup_old_signaling_messages()
RETURNS void AS $$
BEGIN
  DELETE FROM public.signaling
  WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;