import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import JoinRequestDialog from "./JoinRequestDialog";
import { useNavigate } from "react-router-dom";

type ConnectionStatus = 
  | "initializing"
  | "waiting_for_participant"
  | "requesting_approval"
  | "signaling"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

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
  const [userDisconnected, setUserDisconnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("initializing");
  const [callDuration, setCallDuration] = useState(0);
  const retryCountRef = useRef(0);
  const maxRetries = 3;
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);
  const maxCallDuration = 1800; // 30 минут в секундах

  // Initialize media stream
  useEffect(() => {
    console.log('🎥 Initializing media stream...');
    setConnectionStatus("initializing");
    
    const initMediaStream = async () => {
      try {
        const constraints = {
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: "user"
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000
          }
        };

        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          console.warn('⚠️ Failed with ideal constraints, trying basic...', error);
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
        }
        
        console.log('✅ Media stream obtained');
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          try {
            await localVideoRef.current.play();
          } catch (playError) {
            console.warn('⚠️ Local video autoplay prevented:', playError);
          }
        }
        setIsMediaReady(true);
        setConnectionStatus("waiting_for_participant");
      } catch (error) {
        console.error("❌ Error accessing media devices:", error);
        setConnectionStatus("failed");
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

  // Call timer - starts when connected
  useEffect(() => {
    if (connectionStatus === 'connected') {
      console.log('⏱️ Starting call timer');
      setCallDuration(0);
      
      callTimerRef.current = setInterval(() => {
        setCallDuration(prev => {
          const newDuration = prev + 1;
          
          // Auto-disconnect after max duration
          if (newDuration >= maxCallDuration) {
            console.log('⏱️ Max call duration reached');
            toast({
              title: "Время звонка истекло",
              description: "Максимальная продолжительность звонка 30 минут",
            });
            navigate('/');
            return prev;
          }
          
          return newDuration;
        });
      }, 1000);
    } else {
      // Stop timer when not connected
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
    }

    return () => {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
    };
  }, [connectionStatus, navigate, toast]);

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
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
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
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
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
          
          // Explicitly play remote video for Android compatibility
          const playRemoteVideo = async () => {
            try {
              // Small delay to ensure stream is ready
              await new Promise(resolve => setTimeout(resolve, 100));
              if (remoteVideoRef.current) {
                await remoteVideoRef.current.play();
                console.log('✅ Remote video playing');
              }
            } catch (playError) {
              console.warn('⚠️ Remote video autoplay prevented, will retry on user interaction:', playError);
              // Add click handler to play on user interaction
              const playOnInteraction = async () => {
                try {
                  await remoteVideoRef.current?.play();
                  document.removeEventListener('click', playOnInteraction);
                  document.removeEventListener('touchstart', playOnInteraction);
                } catch (e) {
                  console.error('Failed to play on interaction:', e);
                }
              };
              document.addEventListener('click', playOnInteraction, { once: true });
              document.addEventListener('touchstart', playOnInteraction, { once: true });
            }
          };
          
          playRemoteVideo();
          setIsRemoteConnected(true);
          onConnectionChange(true);
          console.log('✅ Remote stream connected');
        }
      };

      peerConnection.onconnectionstatechange = () => {
        console.log('🔌 Connection state:', peerConnection.connectionState);
        const state = peerConnection.connectionState;
        
        if (state === 'connected') {
          setConnectionStatus('connected');
          retryCountRef.current = 0;
        } else if (state === 'connecting') {
          setConnectionStatus('connecting');
        } else if (state === 'disconnected') {
          setConnectionStatus('disconnected');
          // Attempt reconnection
          if (retryCountRef.current < maxRetries) {
            console.log(`🔄 Attempting reconnection (${retryCountRef.current + 1}/${maxRetries})`);
            retryCountRef.current++;
            setTimeout(() => {
              if (isOrganizerRef.current && peerConnection.signalingState === 'stable') {
                createOffer();
              }
            }, 2000 * retryCountRef.current);
          }
        } else if (state === 'failed') {
          setConnectionStatus('failed');
          toast({
            title: "Ошибка подключения",
            description: "Не удалось установить соединение. Попробуйте перезагрузить страницу.",
            variant: "destructive",
          });
        }
        
        onConnectionStateChange?.(state);
      };

      peerConnection.oniceconnectionstatechange = () => {
        const iceState = peerConnection.iceConnectionState;
        console.log('❄️ ICE state:', iceState);
        
        if (iceState === 'checking') {
          setConnectionStatus('connecting');
        } else if (iceState === 'connected' || iceState === 'completed') {
          setConnectionStatus('connected');
        } else if (iceState === 'failed') {
          console.log('❌ ICE connection failed, attempting restart');
          peerConnection.restartIce();
        }
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
        setConnectionStatus('signaling');
        
        try {
          console.log('📞 Creating offer');
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: retryCountRef.current > 0,
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
          setConnectionStatus('failed');
          
          // Retry with exponential backoff
          if (retryCountRef.current < maxRetries) {
            const delay = 1000 * Math.pow(2, retryCountRef.current);
            console.log(`🔄 Retrying offer in ${delay}ms`);
            setTimeout(() => {
              hasCreatedOffer = false;
              createOffer();
            }, delay);
            retryCountRef.current++;
          }
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
            broadcast: {
              ack: true,
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
          
          if (key !== clientId) {
            setUserDisconnected(false);
            setIsRemoteConnected(false);
            setConnectionStatus('waiting_for_participant');
          }
          
          if (isOrganizerRef.current && key !== clientId) {
            console.log('🔔 Organizer: showing approval dialog for joiner:', key);
            setConnectionStatus('requesting_approval');
            setPendingJoinerId(key);
            setShowJoinRequest(true);
          }
        })
        .on('presence', { event: 'leave' }, ({ key }) => {
          console.log('👋 Participant left:', key);
          
          if (key !== clientId) {
            setUserDisconnected(true);
            toast({
              title: "Пользователь покинул встречу",
              description: "Собеседник отключился",
            });
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
          setConnectionStatus('signaling');
          
          console.log('📨 Processing offer from organizer');
          try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
            console.log('✅ Remote description set from offer');
            
            // Add pending ICE candidates in order
            console.log(`📦 Processing ${pendingIceCandidates.length} pending ICE candidates`);
            for (const candidate of pendingIceCandidates) {
              try {
                await peerConnection.addIceCandidate(candidate);
                console.log('✅ Added pending ICE candidate:', candidate.type);
              } catch (e) {
                console.warn('⚠️ ICE candidate error:', e);
              }
            }
            pendingIceCandidates.length = 0;
            
            setConnectionStatus('connecting');
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
            setConnectionStatus('failed');
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
          setConnectionStatus('connecting');
          
          try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
            console.log('✅ Answer processed, remote description set');
            
            // Add pending ICE candidates in order
            console.log(`📦 Processing ${pendingIceCandidates.length} pending ICE candidates`);
            for (const candidate of pendingIceCandidates) {
              try {
                await peerConnection.addIceCandidate(candidate);
                console.log('✅ Added pending ICE candidate:', candidate.type);
              } catch (e) {
                console.warn('⚠️ ICE candidate error:', e);
              }
            }
            pendingIceCandidates.length = 0;
            console.log('✅ Connection setup complete');
          } catch (error) {
            console.error('❌ Answer processing error:', error);
            setConnectionStatus('failed');
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
            setConnectionStatus('waiting_for_participant');
          } else if (status === 'CHANNEL_ERROR') {
            console.error('❌ Channel error');
            setConnectionStatus('failed');
            toast({
              title: "Ошибка подключения",
              description: "Не удалось подключиться к каналу",
              variant: "destructive",
            });
          } else if (status === 'TIMED_OUT') {
            console.error('❌ Channel timed out');
            setConnectionStatus('failed');
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

  // Format call duration as MM:SS
  const formatCallDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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
            muted={false}
            className="w-full h-full object-cover"
          />
          {userDisconnected ? (
            <div className="absolute inset-0 flex items-center justify-center bg-secondary">
              <p className="text-muted-foreground">Пользователь покинул встречу</p>
            </div>
          ) : !isRemoteConnected ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-secondary gap-3">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-muted-foreground font-medium">
                  {connectionStatus === 'initializing' && 'Инициализация...'}
                  {connectionStatus === 'waiting_for_participant' && 'Ожидание участника...'}
                  {connectionStatus === 'requesting_approval' && 'Запрос на подключение...'}
                  {connectionStatus === 'signaling' && 'Обмен сигналами...'}
                  {connectionStatus === 'connecting' && 'Установка соединения...'}
                  {connectionStatus === 'disconnected' && 'Переподключение...'}
                  {connectionStatus === 'failed' && 'Ошибка подключения'}
                </p>
                {connectionStatus === 'waiting_for_participant' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Поделитесь ссылкой на комнату
                  </p>
                )}
                {retryCountRef.current > 0 && connectionStatus === 'disconnected' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Попытка {retryCountRef.current} из {maxRetries}
                  </p>
                )}
              </div>
            </div>
          ) : null}
          {userDisconnected ? (
            <div className="absolute inset-0 bg-black flex items-center justify-center">
              <p className="text-white text-xl font-medium">Собеседник покинул встречу</p>
            </div>
          ) : (
            <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm px-3 py-1 rounded-full">
              <p className="text-sm text-foreground">Собеседник</p>
            </div>
          )}
          {connectionStatus === 'connected' && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background/90 backdrop-blur-sm px-4 py-2 rounded-full shadow-lg">
              <p className="text-lg font-semibold text-foreground tabular-nums">
                {formatCallDuration(callDuration)}
              </p>
            </div>
          )}
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
