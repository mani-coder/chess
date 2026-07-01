import { ChessGame } from "@/components/ChessGame";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 lg:block lg:p-0">
      <ChessGame />
    </main>
  );
}
