import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import JoinRequestDialog from "./JoinRequestDialog";
import { useNavigate } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  onCallDurationChange?: (duration: number) => void;
}

const VideoCall = ({ roomId, isCameraOn, isMicOn, onConnectionChange, onConnectionStateChange, onCallDurationChange }: VideoCallProps) => {
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
  const [showTimeWarning, setShowTimeWarning] = useState(false);
  const [maxCallDuration, setMaxCallDuration] = useState(1800); // 30 минут в секундах
  const retryCountRef = useRef(0);
  const maxRetries = 3;
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);
  const warningShownRef = useRef(false);

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
      
      // Reset timer on connection
      setCallDuration(0);
      warningShownRef.current = false;
      
      callTimerRef.current = setInterval(() => {
        setCallDuration(prev => {
          const newDuration = prev + 1;
          
          // Show warning 5 minutes before end
          const timeRemaining = maxCallDuration - newDuration;
          if (timeRemaining === 300 && !warningShownRef.current) {
            console.log('⚠️ 5 minutes remaining');
            setShowTimeWarning(true);
            warningShownRef.current = true;
          }
          
          // Auto-disconnect after max duration
          if (newDuration >= maxCallDuration) {
            console.log('⏱️ Max call duration reached');
            toast({
              title: "Время звонка истекло",
              description: "Максимальная продолжительность звонка истекла",
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
  }, [connectionStatus, navigate, toast, maxCallDuration]);

  // Notify parent component of call duration changes
  useEffect(() => {
    if (onCallDurationChange) {
      onCallDurationChange(callDuration);
    }
  }, [callDuration, onCallDurationChange]);

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
          // Multiple STUN servers for better NAT traversal
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
          
          // Primary TURN servers (Metered)
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
          
          // Backup TURN servers (Numb)
          {
            urls: "turn:numb.viagenie.ca",
            username: "webrtc@live.com",
            credential: "muazkh",
          },
          {
            urls: "turn:numb.viagenie.ca:3478?transport=tcp",
            username: "webrtc@live.com",
            credential: "muazkh",
          },
          
          // Additional backup TURN servers
          {
            urls: "turn:relay.metered.ca:80",
            username: "85d76e46be6d5e65d6e85ba1",
            credential: "tXUXVrMT8Rbr1w0N",
          },
          {
            urls: "turn:relay.metered.ca:443",
            username: "85d76e46be6d5e65d6e85ba1",
            credential: "tXUXVrMT8Rbr1w0N",
          },
        ],
        // Increased pool size for faster connection establishment
        iceCandidatePoolSize: 20,
        // Try all connection types (direct P2P and relay through TURN)
        iceTransportPolicy: 'all',
        // Bundle all media on single connection for better NAT traversal
        bundlePolicy: 'max-bundle',
        // Multiplex RTP and RTCP on single port for better firewall traversal
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
        const state = peerConnection.connectionState;
        console.log('🔌 Connection state:', state);
        
        if (state === 'connected') {
          setConnectionStatus('connected');
          retryCountRef.current = 0;
        } else if (state === 'connecting') {
          setConnectionStatus('connecting');
        } else if (state === 'disconnected') {
          setConnectionStatus('disconnected');
          setIsRemoteConnected(false);
          // Attempt reconnection only if not already at max retries
          if (retryCountRef.current < maxRetries && isOrganizerRef.current) {
            retryCountRef.current++;
            console.log(`🔄 Attempting reconnection (${retryCountRef.current}/${maxRetries})`);
            
            setTimeout(() => {
              if (peerConnection.signalingState !== 'closed') {
                console.log('🔄 Creating new offer for reconnection');
                createOffer();
              }
            }, 2000 * retryCountRef.current);
          }
        } else if (state === 'failed') {
          setConnectionStatus('failed');
          setIsRemoteConnected(false);
          
          if (retryCountRef.current < maxRetries && isOrganizerRef.current) {
            retryCountRef.current++;
            console.log(`🔄 Connection failed, attempting recovery (${retryCountRef.current}/${maxRetries})`);
            
            setTimeout(() => {
              if (peerConnection.signalingState !== 'closed') {
                console.log('🔄 Restarting ICE and creating new offer');
                peerConnection.restartIce();
                createOffer();
              }
            }, 1000);
          } else {
            toast({
              title: "Ошибка подключения",
              description: "Не удалось установить соединение. Попробуйте перезагрузить страницу.",
              variant: "destructive",
            });
          }
        } else if (state === 'closed') {
          console.log('🔌 Connection closed');
          setConnectionStatus('disconnected');
          setIsRemoteConnected(false);
        }
        
        if (state) {
          onConnectionStateChange?.(state);
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        const iceState = peerConnection.iceConnectionState;
        console.log('❄️ ICE state:', iceState);
        
        if (iceState === 'checking') {
          setConnectionStatus('connecting');
        } else if (iceState === 'connected' || iceState === 'completed') {
          setConnectionStatus('connected');
          retryCountRef.current = 0;
          console.log('✅ ICE connection established successfully');
        } else if (iceState === 'failed') {
          console.log('❌ ICE connection failed');
          setConnectionStatus('failed');
          setIsRemoteConnected(false);
          
          if (retryCountRef.current < maxRetries && isOrganizerRef.current) {
            retryCountRef.current++;
            console.log(`🔄 ICE failed, attempting restart (${retryCountRef.current}/${maxRetries})`);
            
            setTimeout(() => {
              if (peerConnection.signalingState !== 'closed') {
                peerConnection.restartIce();
                createOffer();
              }
            }, 1000);
          }
        } else if (iceState === 'disconnected') {
          console.log('⚠️ ICE disconnected');
          setIsRemoteConnected(false);
          setConnectionStatus('disconnected');
        } else if (iceState === 'closed') {
          console.log('❄️ ICE connection closed');
          setIsRemoteConnected(false);
        }
      };

      let hasCreatedOffer = false;
      let hasProcessedOffer = false;
      const pendingIceCandidates: RTCIceCandidate[] = [];
      let localIceCandidates: RTCIceCandidate[] = [];
      let iceGatheringComplete = false;
      let pendingOffer: any = null;
      let offerSent = false;
      let answerSent = false;

      const createOffer = async () => {
        if (hasCreatedOffer) {
          console.log('⏭️ Offer already created');
          return;
        }
        hasCreatedOffer = true;
        setConnectionStatus('signaling');
        
        try {
          console.log('📞 Creating offer');
          
          // Reset ICE candidates collection
          localIceCandidates = [];
          iceGatheringComplete = false;
          
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: retryCountRef.current > 0,
          });
          await peerConnection.setLocalDescription(offer);
          
          // Wait for ICE gathering to complete or timeout after 3 seconds
          console.log('⏳ Waiting for ICE gathering...');
          await Promise.race([
            new Promise<void>((resolve) => {
              if (iceGatheringComplete) {
                resolve();
              } else {
                const checkInterval = setInterval(() => {
                  if (iceGatheringComplete) {
                    clearInterval(checkInterval);
                    resolve();
                  }
                }, 100);
              }
            }),
            new Promise<void>((resolve) => setTimeout(resolve, 3000))
          ]);
          
          console.log(`📤 Broadcasting offer with ${localIceCandidates.length} ICE candidates`);
          offerSent = true;
          channel.send({
            type: 'broadcast',
            event: 'webrtc_offer',
            payload: { 
              offer: {
                type: offer.type,
                sdp: offer.sdp
              },
              candidates: localIceCandidates.map(c => c.toJSON()),
              from: clientId 
            }
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

      // ICE candidate handler - collect and send candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('📦 ICE candidate gathered:', event.candidate.type);
          localIceCandidates.push(event.candidate);
          
          // Send additional candidates after offer/answer is sent
          if (offerSent || answerSent) {
            console.log('📤 Sending additional ICE candidate');
            channel.send({
              type: 'broadcast',
              event: 'ice_candidate',
              payload: {
                candidate: event.candidate.toJSON(),
                from: clientId
              }
            });
          }
        } else {
          console.log('✅ ICE gathering complete');
          iceGatheringComplete = true;
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
            console.log('👤 JOINER - waiting for approval');
            // Joiner should show that they're requesting approval
            if (participants.length > 1) {
              setConnectionStatus('requesting_approval');
            }
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
            setConnectionStatus('signaling');
            
            toast({
              title: "Подключение одобрено",
              description: "Установка соединения...",
            });
            
            // Process buffered offer if it exists
            if (pendingOffer) {
              console.log('📦 Processing buffered offer');
              const bufferedOffer = pendingOffer;
              pendingOffer = null;
              
              // Process the offer immediately
              setTimeout(async () => {
                if (!hasProcessedOffer) {
                  hasProcessedOffer = true;
                  setConnectionStatus('signaling');
                  
                  try {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(bufferedOffer.offer));
                    console.log('✅ Remote description set from buffered offer');
                    
                    // Add ICE candidates from offer
                    if (bufferedOffer.candidates && bufferedOffer.candidates.length > 0) {
                      console.log(`📦 Adding ${bufferedOffer.candidates.length} ICE candidates from buffered offer`);
                      for (const candidate of bufferedOffer.candidates) {
                        try {
                          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                          console.log('✅ Added ICE candidate:', candidate.type);
                        } catch (e) {
                          console.warn('⚠️ ICE candidate error:', e);
                        }
                      }
                    }
                    
                    setConnectionStatus('connecting');
                    
                    // Reset for answer
                    localIceCandidates = [];
                    iceGatheringComplete = false;
                    
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    console.log('✅ Answer created from buffered offer');
                    
                    // Wait for ICE gathering
                    console.log('⏳ Waiting for ICE gathering...');
                    await Promise.race([
                      new Promise<void>((resolve) => {
                        if (iceGatheringComplete) {
                          resolve();
                        } else {
                          const checkInterval = setInterval(() => {
                            if (iceGatheringComplete) {
                              clearInterval(checkInterval);
                              resolve();
                            }
                          }, 100);
                        }
                      }),
                      new Promise<void>((resolve) => setTimeout(resolve, 3000))
                    ]);
                    
                    console.log(`📤 Sending answer with ${localIceCandidates.length} ICE candidates`);
                    answerSent = true;
                    channel.send({
                      type: 'broadcast',
                      event: 'webrtc_answer',
                      payload: { 
                        answer: {
                          type: answer.type,
                          sdp: answer.sdp
                        },
                        candidates: localIceCandidates.map(c => c.toJSON()),
                        from: clientId 
                      }
                    });
                  } catch (error) {
                    console.error('❌ Buffered offer processing error:', error);
                    hasProcessedOffer = false;
                    setConnectionStatus('failed');
                  }
                }
              }, 100);
            } else {
              // Send ready signal back to organizer
              await channel.send({
                type: 'broadcast',
                event: 'joiner_ready',
                payload: { joinerId: clientId }
              });
            }
          }
        })
        .on('broadcast', { event: 'join_rejected' }, ({ payload }) => {
          console.log('❌ Join rejected. Joiner ID:', payload.joinerId, 'My ID:', clientId);
          
          if (payload.joinerId === clientId) {
            console.log('❌ My join was rejected');
            toast({
              title: "Подключение отклонено",
              description: "Организатор отклонил ваш запрос на подключение",
              variant: "destructive",
            });
            navigate('/');
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
          
          // If not approved yet, save the offer for later
          if (!isApprovedRef.current) {
            console.log('📦 Not approved yet, buffering offer');
            pendingOffer = payload;
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
            
            // Add ICE candidates from offer
            if (payload.candidates && payload.candidates.length > 0) {
              console.log(`📦 Adding ${payload.candidates.length} ICE candidates from offer`);
              for (const candidate of payload.candidates) {
                try {
                  await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                  console.log('✅ Added ICE candidate:', candidate.type);
                } catch (e) {
                  console.warn('⚠️ ICE candidate error:', e);
                }
              }
            }
            
            setConnectionStatus('connecting');
            
            // Reset for answer
            localIceCandidates = [];
            iceGatheringComplete = false;
            
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            console.log('✅ Answer created');
            
            // Wait for ICE gathering
            console.log('⏳ Waiting for ICE gathering...');
            await Promise.race([
              new Promise<void>((resolve) => {
                if (iceGatheringComplete) {
                  resolve();
                } else {
                  const checkInterval = setInterval(() => {
                    if (iceGatheringComplete) {
                      clearInterval(checkInterval);
                      resolve();
                    }
                  }, 100);
                }
              }),
              new Promise<void>((resolve) => setTimeout(resolve, 3000))
            ]);
            
            console.log(`📤 Sending answer with ${localIceCandidates.length} ICE candidates`);
            answerSent = true;
            channel.send({
              type: 'broadcast',
              event: 'webrtc_answer',
              payload: { 
                answer: {
                  type: answer.type,
                  sdp: answer.sdp
                },
                candidates: localIceCandidates.map(c => c.toJSON()),
                from: clientId 
              }
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
            
            // Add ICE candidates from answer
            if (payload.candidates && payload.candidates.length > 0) {
              console.log(`📦 Adding ${payload.candidates.length} ICE candidates from answer`);
              for (const candidate of payload.candidates) {
                try {
                  await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                  console.log('✅ Added ICE candidate:', candidate.type);
                } catch (e) {
                  console.warn('⚠️ ICE candidate error:', e);
                }
              }
            }
            
            console.log('✅ Connection setup complete');
          } catch (error) {
            console.error('❌ Answer processing error:', error);
            setConnectionStatus('failed');
          }
        })
        .on('broadcast', { event: 'ice_candidate' }, async ({ payload }) => {
          if (payload.from === clientId) {
            return;
          }
          
          console.log('📥 Received additional ICE candidate');
          
          try {
            // Buffer if remote description not set yet
            if (!peerConnection.remoteDescription) {
              console.log('⏸️ Buffering ICE candidate (no remote description)');
              pendingIceCandidates.push(new RTCIceCandidate(payload.candidate));
              return;
            }
            
            await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
            console.log('✅ Additional ICE candidate added');
          } catch (error) {
            console.error('❌ Error adding ICE candidate:', error);
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
        if (callTimerRef.current) {
          clearInterval(callTimerRef.current);
        }
        if (peerConnectionRef.current) {
          peerConnectionRef.current.close();
          peerConnectionRef.current = null;
        }
        if (channelRef.current) {
          channelRef.current.unsubscribe();
          channelRef.current = null;
        }
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(track => track.stop());
          localStreamRef.current = null;
        }
      };
    };

    setupWebRTC();
  }, [roomId, onConnectionChange, onConnectionStateChange, isMediaReady, navigate, toast]);

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

  // Handle extending call time
  const handleExtendTime = () => {
    setMaxCallDuration(prev => prev + 1800); // Add 30 more minutes
    setShowTimeWarning(false);
    warningShownRef.current = false;
    toast({
      title: "Время продлено",
      description: "Добавлено 30 минут к звонку",
    });
  };

  return (
    <>
      <AlertDialog open={showTimeWarning} onOpenChange={setShowTimeWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Звонок скоро завершится</AlertDialogTitle>
            <AlertDialogDescription>
              До окончания звонка осталось 5 минут. Хотите продлить время на 30 минут?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Продолжить без продления</AlertDialogCancel>
            <AlertDialogAction onClick={handleExtendTime}>
              Продлить на 30 минут
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          {userDisconnected && (
            <div className="absolute inset-0 bg-black flex items-center justify-center">
              <p className="text-white text-xl font-medium">Собеседник покинул встречу</p>
            </div>
          )}
          {!userDisconnected && (
            <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm px-3 py-1 rounded-full">
              <p className="text-sm text-foreground">Собеседник</p>
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
