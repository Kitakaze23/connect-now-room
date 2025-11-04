-- Fix function search path security warning
CREATE OR REPLACE FUNCTION public.cleanup_old_signaling_messages()
RETURNS void AS $$
BEGIN
  DELETE FROM public.signaling
  WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;