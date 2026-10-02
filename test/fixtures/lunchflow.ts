// Synthetic Lunch Flow payloads and a scriptable fake fetch. No real bank data.

export type FakeTxn = {
  id: string | null;
  accountId: number;
  amount: number;
  currency: string;
  date: string;
  merchant: string;
  description: string;
  isPending: boolean;
};

export function txn(accountId: number, id: string | null, overrides: Partial<FakeTxn> = {}): FakeTxn {
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

export type WorldAccount = { id: number; name: string; institution: string; currency: string };

// Revolut's name is IBAN-shaped, like the real API's, to check it never becomes the label.
export const REVOLUT: WorldAccount = { id: 1, name: "GB29NWBK60161331926819", institution: "Revolut", currency: "GBP" };
export const AMEX: WorldAccount = { id: 2, name: "Synthetic Rewards Card", institution: "Test Amex", currency: "GBP" };

/**
 * A mutable fake Lunch Flow: tests change `txns` and the `*Reply` overrides between runs.
 * Transactions are filtered by from/to and include_pending like the real endpoint.
 */
export function world(accounts: WorldAccount[]) {
  const state = {
    txns: {} as Record<number, FakeTxn[]>,
    accountsReply: undefined as Reply | undefined,
    txnReply: {} as Record<number, Reply | undefined>,
    balanceReply: {} as Record<number, Reply | undefined>,
  };
  const routes: Record<string, Reply | Reply[] | ((url: URL) => Reply)> = {
    "/accounts": () =>
      state.accountsReply ?? {
        body: {
          accounts: accounts.map((a) => accountJson(a.id, { name: a.name, institution_name: a.institution })),
          total: accounts.length,
        },
      },
  };
  for (const a of accounts) {
    routes[`/accounts/${a.id}/balance`] = () =>
      state.balanceReply[a.id] ?? { body: { balance: { amount: 100.5, currency: a.currency } } };
    routes[`/accounts/${a.id}/transactions`] = (url) => {
      if (state.txnReply[a.id]) return state.txnReply[a.id]!;
      const { from = "0000-00-00", to = "9999-99-99", include_pending } = Object.fromEntries(url.searchParams);
      const rows = (state.txns[a.id] ?? []).filter(
        (t) => t.date >= from && t.date <= to && (include_pending === "true" || !t.isPending),
      );
      return { body: { transactions: rows, total: rows.length } };
    };
  }
  const f = fakeFetch(routes);
  return Object.assign(state, { fetch: f.fetch, calls: f.calls });
}
