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

interface JoinRequestDialogProps {
  open: boolean;
  onAccept: () => void;
  onReject: () => void;
}

const JoinRequestDialog = ({ open, onAccept, onReject }: JoinRequestDialogProps) => {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Запрос на подключение</AlertDialogTitle>
          <AlertDialogDescription>
            Участник хочет присоединиться к видеозвонку. Разрешить подключение?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onReject}>Отклонить</AlertDialogCancel>
          <AlertDialogAction onClick={onAccept}>Разрешить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default JoinRequestDialog;
