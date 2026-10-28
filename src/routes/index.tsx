import { createFileRoute } from "@tanstack/react-router";
import { DeskView } from "@/components/desk/desk-view";
import { getDesk } from "@/lib/market/get-desk";

export const Route = createFileRoute("/")({
  loader: () => getDesk({ data: { fresh: false } }),
  pendingComponent: DeskPending,
  component: Home,
});

function Home() {
  const desk = Route.useLoaderData();
  return <DeskView initial={desk} />;
}

function DeskPending() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10">
      <div className="mb-6 h-0.5 w-16 bg-brass" />
      <p className="text-xs font-medium tracking-widest text-brass uppercase">Market check</p>
      <h1 className="mt-1 font-serif text-4xl text-fg">The Whole Market</h1>
      <p className="mt-3 text-sm text-muted">Loading prices, company weights, and how many stocks are joining the move…</p>
    </main>
  );
}
