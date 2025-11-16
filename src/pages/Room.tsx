import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Video, VideoOff, Mic, MicOff, PhoneOff, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import VideoCall from "@/components/VideoCall";

const Room = () => {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isConnected, setIsConnected] = useState(false);

  const copyRoomLink = () => {
    const link = `${window.location.origin}/room/${roomId}`;
    navigator.clipboard.writeText(link);
    toast({
      title: "Ссылка скопирована!",
      description: "Поделитесь ей для присоединения к встрече",
    });
  };

  const handleLeave = () => {
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-xl font-semibold text-foreground">Видеозвонок</h1>
              <p className="text-sm text-muted-foreground">ID комнаты: {roomId}</p>
            </div>
            {isConnected && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-full">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                  Подключен
                </span>
              </div>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={copyRoomLink}
            className="gap-2"
          >
            <Copy className="w-4 h-4" />
            Скопировать ссылку
          </Button>
        </div>
      </header>

      {/* Video Area */}
      <div className="flex-1 p-6">
        <VideoCall
          roomId={roomId!}
          isCameraOn={isCameraOn}
          isMicOn={isMicOn}
          onConnectionChange={setIsConnected}
        />
      </div>

      {/* Controls */}
      <div className="border-t border-border px-6 py-6 bg-card">
        <div className="max-w-7xl mx-auto flex items-center justify-center gap-4">
          <Button
            variant={isMicOn ? "secondary" : "destructive"}
            size="lg"
            onClick={() => setIsMicOn(!isMicOn)}
            className="w-14 h-14 rounded-full"
          >
            {isMicOn ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
          </Button>
          
          <Button
            variant={isCameraOn ? "secondary" : "destructive"}
            size="lg"
            onClick={() => setIsCameraOn(!isCameraOn)}
            className="w-14 h-14 rounded-full"
          >
            {isCameraOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
          </Button>
          
          <Button
            variant="destructive"
            size="lg"
            onClick={handleLeave}
            className="w-14 h-14 rounded-full"
          >
            <PhoneOff className="w-6 h-6" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Room;
