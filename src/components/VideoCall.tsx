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
      let myRole: 'caller' | 'callee' | 'waiting' = 'waiting';

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
          
          if (participants.length < 2) {
            console.log('⏳ Waiting for second participant...');
            myRole = 'waiting';
            return;
          }
          
          // First participant (by clientId order) becomes the caller
          const sortedParticipants = participants.sort();
          const isCaller = sortedParticipants[0] === clientId;
          myRole = isCaller ? 'caller' : 'callee';
          
          console.log('🎯 My Role:', myRole, '| Participants:', sortedParticipants);
          
          // If we're the caller and haven't sent offer yet, create and send it
          if (isCaller && !isOfferSent) {
            console.log('📞 Creating offer as CALLER');
            isOfferSent = true;
            
            // Small delay to ensure both peers are ready
            setTimeout(async () => {
              try {
                const offer = await peerConnection.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: true,
                });
                await peerConnection.setLocalDescription(offer);
                
                console.log('📤 Sending offer to room');
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
            }, 1000);
          } else {
            console.log('👂 Ready to receive offer as CALLEE');
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

            console.log('📥 Received signaling message:', message.type, 'from:', message.data?.clientId);
            
            try {
              if (message.type === "offer" && myRole === 'callee') {
                console.log('📨 Processing offer as CALLEE');
                const offerDesc = new RTCSessionDescription(message.data.offer);
                await peerConnection.setRemoteDescription(offerDesc);
                console.log('✅ Remote description set (offer)');
                
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                console.log('✅ Local description set (answer)');
                
                console.log('📤 Sending answer to CALLER');
                await supabase
                  .from("signaling")
                  .insert([{
                    room_id: roomId,
                    type: "answer",
                    data: { answer, clientId } as any,
                  }]);
              } else if (message.type === "answer" && myRole === 'caller') {
                console.log('📨 Processing answer as CALLER');
                const answerDesc = new RTCSessionDescription(message.data.answer);
                await peerConnection.setRemoteDescription(answerDesc);
                console.log('✅ Remote description set (answer) - Connection should establish now');
              } else if (message.type === "candidate" && message.data?.candidate) {
                console.log('📨 Processing ICE candidate');
                try {
                  await peerConnection.addIceCandidate(new RTCIceCandidate(message.data.candidate));
                  console.log('✅ ICE candidate added');
                } catch (e) {
                  console.warn('⚠️ Error adding ICE candidate (might be ok):', e);
                }
              } else {
                console.log('⏭️ Skipping message - wrong role or type:', { type: message.type, myRole });
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
