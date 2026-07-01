import { ChessGame } from "@/components/ChessGame";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center py-6">
      <ChessGame />
    </main>
  );
}
