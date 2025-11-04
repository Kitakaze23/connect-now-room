import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Video, Users, Shield } from "lucide-react";
import { nanoid } from "nanoid";

const Index = () => {
  const navigate = useNavigate();

  const createMeeting = () => {
    const roomId = nanoid(10);
    navigate(`/room/${roomId}`);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-primary/10" />
        
        <div className="relative max-w-7xl mx-auto px-6 py-24 sm:py-32">
          <div className="text-center">
            <h1 className="text-5xl sm:text-7xl font-bold text-foreground mb-6 animate-fade-in">
              Видеозвонки
              <span className="block text-primary mt-2">просто и быстро</span>
            </h1>
            <p className="text-xl text-muted-foreground mb-12 max-w-2xl mx-auto">
              Создайте встречу за секунду. Без регистрации и установки приложений.
            </p>
            
            <Button
              onClick={createMeeting}
              size="lg"
              className="h-14 px-8 text-lg font-semibold bg-primary hover:bg-primary/90 shadow-lg hover:shadow-[0_0_40px_rgba(14,165,233,0.4)] transition-all duration-300"
            >
              <Video className="w-6 h-6 mr-2" />
              Создать встречу
            </Button>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div className="max-w-7xl mx-auto px-6 py-24">
        <div className="grid md:grid-cols-3 gap-8">
          <div className="bg-card border border-border rounded-2xl p-8 hover:shadow-lg transition-all duration-300">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
              <Video className="w-6 h-6 text-primary" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-3">
              HD видео и звук
            </h3>
            <p className="text-muted-foreground">
              Кристально чистое качество видео и звука благодаря технологии WebRTC
            </p>
          </div>

          <div className="bg-card border border-border rounded-2xl p-8 hover:shadow-lg transition-all duration-300">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-3">
              Просто поделитесь ссылкой
            </h3>
            <p className="text-muted-foreground">
              Создайте встречу и отправьте ссылку. Без регистрации и паролей
            </p>
          </div>

          <div className="bg-card border border-border rounded-2xl p-8 hover:shadow-lg transition-all duration-300">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
              <Shield className="w-6 h-6 text-primary" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-3">
              Безопасно и приватно
            </h3>
            <p className="text-muted-foreground">
              Прямое соединение между участниками. Ваши данные защищены
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="max-w-7xl mx-auto px-6 text-center text-muted-foreground">
          <p>© 2025 VideoMeet. Создано Basil</p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
