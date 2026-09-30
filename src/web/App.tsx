import { useQuery } from "@tanstack/react-query";

async function fetchHealth(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });

  const status = health.isPending ? "checking…" : health.isError ? `error (${health.error.message})` : "ok";

  return (
    <main className="mx-auto max-w-md p-4 font-sans">
      <h1 className="text-xl font-semibold">Tally</h1>
      <p className="mt-2 text-sm text-gray-600">API: {status}</p>
    </main>
  );
}
