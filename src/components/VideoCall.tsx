import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import JoinRequestDialog from "./JoinRequestDialog";
import { useNavigate } from "react-router-dom";

interface VideoCallProps {
  roomId: string;
  isCameraOn: boolean;
  isMicOn: boolean;
  onConnectionChange: (connected: boolean) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
}

const VideoCall = ({ roomId, isCameraOn, isMicOn, onConnectionChange, onConnectionStateChange }: VideoCallProps) => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<any>(null);
  const isOrganizerRef = useRef(false);
  const isApprovedRef = useRef(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const [isRemoteConnected, setIsRemoteConnected] = useState(false);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [showJoinRequest, setShowJoinRequest] = useState(false);
  const [pendingJoinerId, setPendingJoinerId] = useState<string | null>(null);

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
  }, [toast]);

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
      console.log('⏳ Waiting for media stream...');
      return;
    }

    const setupWebRTC = async () => {
      const clientId = Math.random().toString(36).substring(7);
      console.log('🚀 Client ID:', clientId, 'Room:', roomId);
      
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
        iceCandidatePoolSize: 10,
      });
      peerConnectionRef.current = peerConnection;

      // Add local tracks
      localStreamRef.current?.getTracks().forEach(track => {
        console.log('➕ Adding local track:', track.kind);
        peerConnection.addTrack(track, localStreamRef.current!);
      });

      // Handle remote stream
      peerConnection.ontrack = (event) => {
        console.log('📹 Remote track received:', event.track.kind);
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setIsRemoteConnected(true);
          onConnectionChange(true);
          console.log('✅ Remote stream connected');
        }
      };

      peerConnection.onconnectionstatechange = () => {
        console.log('🔌 Connection state:', peerConnection.connectionState);
        onConnectionStateChange?.(peerConnection.connectionState);
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('❄️ ICE state:', peerConnection.iceConnectionState);
      };

      let hasCreatedOffer = false;
      let hasProcessedOffer = false;
      const pendingIceCandidates: RTCIceCandidate[] = [];
      let approvedJoinerId: string | null = null;

      const createOffer = async () => {
        if (hasCreatedOffer) {
          console.log('⏭️ Offer already created');
          return;
        }
        hasCreatedOffer = true;
        
        try {
          console.log('📞 Creating offer');
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
          });
          await peerConnection.setLocalDescription(offer);
          
          console.log('📤 Broadcasting offer');
          channel.send({
            type: 'broadcast',
            event: 'webrtc_offer',
            payload: { offer, from: clientId }
          });
        } catch (error) {
          console.error('❌ Error creating offer:', error);
          hasCreatedOffer = false;
        }
      };

      // ICE candidate handler
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('📤 Sending ICE candidate:', event.candidate.type);
          channel.send({
            type: 'broadcast',
            event: 'webrtc_candidate',
            payload: { candidate: event.candidate, from: clientId }
          });
        } else {
          console.log('✅ ICE gathering complete');
        }
      };

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
          console.log('👥 Participants:', participants.length);
          
          const sortedParticipants = participants.sort();
          const isFirst = sortedParticipants[0] === clientId;
          isOrganizerRef.current = isFirst;
          
          if (isFirst) {
            isApprovedRef.current = true;
            console.log('👑 ORGANIZER');
          } else {
            console.log('👤 JOINER');
          }
        })
        .on('presence', { event: 'join' }, ({ key }) => {
          console.log('👋 Participant joined:', key);
          
          if (isOrganizerRef.current && key !== clientId) {
            console.log('🔔 Organizer: showing approval dialog for joiner:', key);
            setPendingJoinerId(key);
            setShowJoinRequest(true);
          }
        })
        .on('broadcast', { event: 'join_approved' }, async ({ payload }) => {
          console.log('✅ Join approval broadcast received. Joiner ID:', payload.joinerId, 'My ID:', clientId, 'Am I organizer?', isOrganizerRef.current);
          
          if (payload.joinerId === clientId) {
            console.log('✅ I am the approved joiner, ready to receive offer');
            isApprovedRef.current = true;
            // Send ready signal back to organizer
            channel.send({
              type: 'broadcast',
              event: 'joiner_ready',
              payload: { joinerId: clientId }
            });
          }
        })
        .on('broadcast', { event: 'joiner_ready' }, async ({ payload }) => {
          console.log('✅ Joiner ready signal received. Joiner ID:', payload.joinerId, 'My ID:', clientId, 'Am I organizer?', isOrganizerRef.current);
          
          if (isOrganizerRef.current && payload.joinerId !== clientId) {
            console.log('👑 I am organizer, creating offer now after joiner confirmed ready');
            // Small delay to ensure joiner is subscribed to all events
            setTimeout(() => {
              createOffer();
            }, 500);
          }
        })
        .on('broadcast', { event: 'webrtc_offer' }, async ({ payload }) => {
          console.log('📨 Offer received. From:', payload.from, 'My ID:', clientId, 'Am I organizer?', isOrganizerRef.current, 'Approved?', isApprovedRef.current);
          
          if (payload.from === clientId) {
            console.log('⏭️ Skipping my own offer');
            return;
          }
          
          if (isOrganizerRef.current) {
            console.log('⏭️ Organizer does not process offers');
            return;
          }
          
          if (!isApprovedRef.current) {
            console.log('⏭️ Not approved yet, skipping offer');
            return;
          }
          
          if (hasProcessedOffer) {
            console.log('⏭️ Already processed an offer');
            return;
          }
          
          hasProcessedOffer = true;
          
          console.log('📨 Processing offer from organizer');
          try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
            console.log('✅ Remote description set from offer');
            
            // Add pending ICE candidates
            for (const candidate of pendingIceCandidates) {
              try {
                await peerConnection.addIceCandidate(candidate);
                console.log('✅ Added pending ICE candidate');
              } catch (e) {
                console.warn('⚠️ ICE candidate error:', e);
              }
            }
            pendingIceCandidates.length = 0;
            
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            console.log('✅ Answer created');
            
            console.log('📤 Sending answer to organizer');
            channel.send({
              type: 'broadcast',
              event: 'webrtc_answer',
              payload: { answer, from: clientId }
            });
          } catch (error) {
            console.error('❌ Offer processing error:', error);
            hasProcessedOffer = false;
          }
        })
        .on('broadcast', { event: 'webrtc_answer' }, async ({ payload }) => {
          console.log('📨 Answer received. From:', payload.from, 'My ID:', clientId, 'Am I organizer?', isOrganizerRef.current);
          
          if (payload.from === clientId) {
            console.log('⏭️ Skipping my own answer');
            return;
          }
          
          if (!isOrganizerRef.current) {
            console.log('⏭️ Joiner does not process answers');
            return;
          }
          
          console.log('📨 Organizer processing answer from joiner');
          try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
            console.log('✅ Answer processed, remote description set');
            
            // Add pending ICE candidates
            for (const candidate of pendingIceCandidates) {
              try {
                await peerConnection.addIceCandidate(candidate);
                console.log('✅ Added pending ICE candidate');
              } catch (e) {
                console.warn('⚠️ ICE candidate error:', e);
              }
            }
            pendingIceCandidates.length = 0;
            console.log('✅ Connection setup complete');
          } catch (error) {
            console.error('❌ Answer processing error:', error);
          }
        })
        .on('broadcast', { event: 'webrtc_candidate' }, async ({ payload }) => {
          if (payload.from === clientId) {
            return;
          }
          
          console.log('📨 ICE candidate received from:', payload.from, 'Type:', payload.candidate.type);
          
          try {
            const candidate = new RTCIceCandidate(payload.candidate);
            
            if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
              await peerConnection.addIceCandidate(candidate);
              console.log('✅ ICE candidate added immediately:', payload.candidate.type);
            } else {
              console.log('📦 Queueing ICE candidate (no remote description yet)');
              pendingIceCandidates.push(candidate);
            }
          } catch (e) {
            console.error('❌ ICE candidate error:', e, payload.candidate);
          }
        })
        .on('broadcast', { event: 'join_rejected' }, ({ payload }) => {
          if (payload.joinerId === clientId) {
            toast({
              title: "Подключение отклонено",
              description: "Организатор отклонил запрос",
              variant: "destructive",
            });
            setTimeout(() => navigate('/'), 2000);
          }
        })
        .subscribe(async (status) => {
          console.log('📡 Subscription status:', status);
          if (status === 'SUBSCRIBED') {
            channelRef.current = channel;
            console.log('✅ Channel subscribed, tracking presence...');
            await channel.track({ online_at: new Date().toISOString() });
            console.log('✅ Presence tracked');
          } else if (status === 'CHANNEL_ERROR') {
            console.error('❌ Channel error');
            toast({
              title: "Ошибка подключения",
              description: "Не удалось подключиться к каналу",
              variant: "destructive",
            });
          } else if (status === 'TIMED_OUT') {
            console.error('❌ Channel timed out');
            toast({
              title: "Превышено время ожидания",
              description: "Попробуйте перезагрузить страницу",
              variant: "destructive",
            });
          }
        });

      return () => {
        console.log('🧹 Cleanup');
        channel.unsubscribe();
        channelRef.current = null;
      };
    };

    setupWebRTC();
  }, [roomId, onConnectionChange, isMediaReady, navigate, toast]);

  const handleAcceptJoin = () => {
    setShowJoinRequest(false);
    
    if (channelRef.current && pendingJoinerId) {
      console.log('✅ Approving:', pendingJoinerId);
      channelRef.current.send({
        type: 'broadcast',
        event: 'join_approved',
        payload: { joinerId: pendingJoinerId }
      });
      
      toast({
        title: "Подключение разрешено",
        description: "Участник подключается",
      });
    }
    setPendingJoinerId(null);
  };

  const handleRejectJoin = () => {
    setShowJoinRequest(false);
    
    if (channelRef.current && pendingJoinerId) {
      console.log('❌ Rejecting:', pendingJoinerId);
      channelRef.current.send({
        type: 'broadcast',
        event: 'join_rejected',
        payload: { joinerId: pendingJoinerId }
      });
      
      toast({
        title: "Подключение отклонено",
        description: "Запрос отклонен",
      });
    }
    setPendingJoinerId(null);
  };

  return (
    <>
      <JoinRequestDialog
        open={showJoinRequest}
        onAccept={handleAcceptJoin}
        onReject={handleRejectJoin}
      />
      <div className="max-w-7xl mx-auto h-full grid grid-cols-1 md:grid-cols-2 gap-4">
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
            <p className="text-sm text-foreground">Собеседник</p>
          </div>
        </Card>

        <Card className="relative bg-secondary border-border overflow-hidden aspect-video">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm px-3 py-1 rounded-full">
            <p className="text-sm text-foreground">Вы</p>
          </div>
        </Card>
      </div>
    </>
  );
};

export default VideoCall;
