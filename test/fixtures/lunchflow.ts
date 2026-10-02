// Synthetic Lunch Flow payloads and a scriptable fake fetch. No real bank data.

export type FakeTxn = {
  id: string;
  accountId: number;
  amount: number;
  currency: string;
  date: string;
  merchant: string;
  description: string;
  isPending: boolean;
};

export function txn(accountId: number, id: string, overrides: Partial<FakeTxn> = {}): FakeTxn {
  return {
    id,
    accountId,
    amount: -12.3,
    currency: "GBP",
    date: "2026-10-01",
    merchant: "Synthetic Cafe",
    description: "",
    isPending: false,
    ...overrides,
  };
}

export function accountJson(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    connection_id: 500 + id,
    name: "Synthetic Card",
    institution_name: "Test Bank",
    institution_logo: "https://example.test/logo.png",
    provider: "gocardless",
    status: "ACTIVE",
    ...overrides,
  };
}

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error };

/**
 * A fetch that answers from a route table keyed by "METHOD path" (query string ignored).
 * A route can be a single reply, a function of the URL, or a list consumed one per call
 * (the last entry repeats).
 */
export function fakeFetch(routes: Record<string, Reply | Reply[] | ((url: URL) => Reply)>) {
  const calls: { path: string; query: URLSearchParams; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ path: url.pathname, query: url.searchParams, headers: new Headers(init?.headers) });
    const route = routes[url.pathname.replace(/^\/api\/v1/, "")];
    if (!route) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
    const seen = calls.filter((c) => c.path === url.pathname).length;
    const reply = typeof route === "function" ? route(url) : Array.isArray(route) ? route[Math.min(seen, route.length) - 1]! : route;
    if (reply.throws) throw reply.throws;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  };
  return { fetch: fetchImpl, calls };
}
