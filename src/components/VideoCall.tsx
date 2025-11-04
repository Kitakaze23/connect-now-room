import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface VideoCallProps {
  roomId: string;
  isCameraOn: boolean;
  isMicOn: boolean;
  onConnectionChange: (connected: boolean) => void;
}

const VideoCall = ({ roomId, isCameraOn, isMicOn, onConnectionChange }: VideoCallProps) => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const { toast } = useToast();
  const [isRemoteConnected, setIsRemoteConnected] = useState(false);

  // Initialize media stream
  useEffect(() => {
    const initMediaStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (error) {
        console.error("Error accessing media devices:", error);
        toast({
          title: "Ошибка доступа к камере",
          description: "Не удалось получить доступ к камере или микрофону",
          variant: "destructive",
        });
      }
    };

    initMediaStream();

    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  // Control camera
  useEffect(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = isCameraOn;
      }
    }
  }, [isCameraOn]);

  // Control microphone
  useEffect(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = isMicOn;
      }
    }
  }, [isMicOn]);

  // WebRTC setup with Supabase Realtime for signaling
  useEffect(() => {
    if (!localStreamRef.current) return;

    const setupWebRTC = async () => {
      // Generate a unique client ID for this session
      const clientId = Math.random().toString(36).substring(7);
      console.log('Client ID:', clientId);
      
      // Determine if this client should be the caller (initiator)
      // Use a deterministic way: first client alphabetically becomes caller
      const isCaller = clientId > 'mmmmmm'; // roughly 50% chance

      console.log('Role:', isCaller ? 'Caller' : 'Callee');

      // Create peer connection
      const configuration = {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      };
      
      const peerConnection = new RTCPeerConnection(configuration);
      peerConnectionRef.current = peerConnection;

      // Add local stream tracks
      localStreamRef.current?.getTracks().forEach(track => {
        console.log('Adding local track:', track.kind);
        peerConnection.addTrack(track, localStreamRef.current!);
      });

      // Handle remote stream
      peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setIsRemoteConnected(true);
          onConnectionChange(true);
          console.log('Remote stream connected');
        }
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
          console.log('Sending ICE candidate');
          await supabase
            .from("signaling")
            .insert([{
              room_id: roomId,
              type: "candidate",
              data: { candidate: event.candidate, clientId } as any,
            }]);
        }
      };

      // Subscribe to signaling messages
      const channel = supabase
        .channel(`room:${roomId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "signaling",
            filter: `room_id=eq.${roomId}`,
          },
          async (payload) => {
            const message = payload.new;
            
            // Ignore our own messages
            if (message.data?.clientId === clientId) {
              console.log('Ignoring own message');
              return;
            }

            console.log('Received signaling message:', message.type);
            
            try {
              if (message.type === "offer") {
                console.log('Processing offer');
                await peerConnection.setRemoteDescription(new RTCSessionDescription(message.data.offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                
                console.log('Sending answer');
                await supabase
                  .from("signaling")
                  .insert([{
                    room_id: roomId,
                    type: "answer",
                    data: { answer, clientId } as any,
                  }]);
              } else if (message.type === "answer") {
                console.log('Processing answer');
                await peerConnection.setRemoteDescription(new RTCSessionDescription(message.data.answer));
              } else if (message.type === "candidate" && message.data?.candidate) {
                console.log('Processing ICE candidate');
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.data.candidate));
              }
            } catch (error) {
              console.error('Error processing signaling message:', error);
            }
          }
        )
        .subscribe();

      console.log('Subscribed to signaling channel');

      // Caller creates and sends offer
      if (isCaller) {
        // Wait a bit for the other peer to join
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('Creating offer');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        console.log('Sending offer');
        await supabase
          .from("signaling")
          .insert([{
            room_id: roomId,
            type: "offer",
            data: { offer, clientId } as any,
          }]);
      }

      return () => {
        console.log('Cleaning up WebRTC');
        channel.unsubscribe();
      };
    };

    setupWebRTC();
  }, [roomId, onConnectionChange]);

  return (
    <div className="max-w-7xl mx-auto h-full grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Remote Video */}
      <Card className="relative bg-secondary border-border overflow-hidden aspect-video">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-cover"
        />
        {!isRemoteConnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-secondary">
            <p className="text-muted-foreground">Ожидание подключения...</p>
          </div>
        )}
        <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm px-3 py-1 rounded-full">
          <p className="text-sm text-foreground">Удаленный участник</p>
        </div>
      </Card>

      {/* Local Video */}
      <Card className="relative bg-secondary border-border overflow-hidden aspect-video">
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover scale-x-[-1]"
        />
        {!isCameraOn && (
          <div className="absolute inset-0 flex items-center justify-center bg-secondary">
            <p className="text-muted-foreground">Камера выключена</p>
          </div>
        )}
        <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm px-3 py-1 rounded-full">
          <p className="text-sm text-foreground">Вы</p>
        </div>
      </Card>
    </div>
  );
};

export default VideoCall;
