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
  const [isMediaReady, setIsMediaReady] = useState(false);

  // Initialize media stream
  useEffect(() => {
    console.log('🎥 Initializing media stream...');
    const initMediaStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        
        console.log('✅ Media stream obtained');
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        setIsMediaReady(true);
      } catch (error) {
        console.error("❌ Error accessing media devices:", error);
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
    if (!isMediaReady || !localStreamRef.current) {
      console.log('⏳ Waiting for media stream...', { isMediaReady, hasStream: !!localStreamRef.current });
      return;
    }

    const setupWebRTC = async () => {
      const clientId = Math.random().toString(36).substring(7);
      console.log('🚀 Client ID:', clientId, 'Room:', roomId);
      
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
        console.log('➕ Adding local track:', track.kind);
        peerConnection.addTrack(track, localStreamRef.current!);
      });

      // Handle remote stream
      peerConnection.ontrack = (event) => {
        console.log('📹 Received remote track:', event.track.kind);
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setIsRemoteConnected(true);
          onConnectionChange(true);
          console.log('✅ Remote stream connected');
        }
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = () => {
        console.log('🔌 Connection state:', peerConnection.connectionState);
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('❄️ ICE connection state:', peerConnection.iceConnectionState);
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
          console.log('📤 Sending ICE candidate');
          await supabase
            .from("signaling")
            .insert([{
              room_id: roomId,
              type: "candidate",
              data: { candidate: event.candidate, clientId } as any,
            }]);
        } else {
          console.log('✅ All ICE candidates sent');
        }
      };

      let isOfferSent = false;
      const processedMessages = new Set<string>();

      // Subscribe to signaling channel
      const channel = supabase
        .channel(`room:${roomId}`, {
          config: {
            presence: {
              key: clientId,
            },
          },
        })
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState();
          const participants = Object.keys(state);
          console.log('👥 Participants in room:', participants.length, participants);
          
          // First participant (by clientId order) becomes the caller
          const sortedParticipants = participants.sort();
          const isCaller = sortedParticipants[0] === clientId && sortedParticipants.length > 1;
          
          console.log('🎯 Role:', isCaller ? 'CALLER' : 'CALLEE');
          
          // If we're the caller and haven't sent offer yet, create and send it
          if (isCaller && !isOfferSent && sortedParticipants.length === 2) {
            console.log('📞 Creating offer as caller');
            isOfferSent = true;
            
            setTimeout(async () => {
              try {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                
                console.log('📤 Sending offer');
                await supabase
                  .from("signaling")
                  .insert([{
                    room_id: roomId,
                    type: "offer",
                    data: { offer, clientId } as any,
                  }]);
              } catch (error) {
                console.error('❌ Error creating offer:', error);
              }
            }, 500);
          }
        })
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
            const messageId = message.id;
            
            // Ignore our own messages
            if (message.data?.clientId === clientId) {
              console.log('⏭️ Ignoring own message:', message.type);
              return;
            }

            // Prevent duplicate processing
            if (processedMessages.has(messageId)) {
              console.log('⏭️ Already processed message:', messageId);
              return;
            }
            processedMessages.add(messageId);

            console.log('📥 Received signaling message:', message.type);
            
            try {
              if (message.type === "offer") {
                console.log('📨 Processing offer');
                const offerDesc = new RTCSessionDescription(message.data.offer);
                await peerConnection.setRemoteDescription(offerDesc);
                
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                
                console.log('📤 Sending answer');
                await supabase
                  .from("signaling")
                  .insert([{
                    room_id: roomId,
                    type: "answer",
                    data: { answer, clientId } as any,
                  }]);
              } else if (message.type === "answer") {
                console.log('📨 Processing answer');
                const answerDesc = new RTCSessionDescription(message.data.answer);
                await peerConnection.setRemoteDescription(answerDesc);
              } else if (message.type === "candidate" && message.data?.candidate) {
                console.log('📨 Processing ICE candidate');
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.data.candidate));
              }
            } catch (error) {
              console.error('❌ Error processing signaling message:', error);
            }
          }
        )
        .subscribe(async (status) => {
          console.log('📡 Subscription status:', status);
          if (status === 'SUBSCRIBED') {
            await channel.track({ online_at: new Date().toISOString() });
            console.log('✅ Subscribed and tracking presence');
          }
        });

      return () => {
        console.log('🧹 Cleaning up WebRTC');
        channel.unsubscribe();
      };
    };

    setupWebRTC();
  }, [roomId, onConnectionChange, isMediaReady]);

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
