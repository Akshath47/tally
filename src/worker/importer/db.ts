import { ImportError } from "./errors";

// Free tier: 50 D1 queries per invocation, and each statement inside batch() counts separately.
export const STATEMENT_BUDGET = 40;

/**
 * Thin D1 wrapper that counts every executed statement and refuses to run past the budget,
 * so a bug that issues per-row statements fails loudly instead of hitting the platform limit.
 */
export class CountingDb {
  private count = 0;

  constructor(
    private readonly d1: D1Database,
    private readonly budget = STATEMENT_BUDGET,
  ) {}

  get statements(): number {
    return this.count;
  }

  prepare(sql: string): D1PreparedStatement {
    return this.d1.prepare(sql);
  }

  async run(stmt: D1PreparedStatement) {
    this.spend(1);
    return stmt.run();
  }

  async first<T>(stmt: D1PreparedStatement) {
    this.spend(1);
    return stmt.first<T>();
  }

  async all<T>(stmt: D1PreparedStatement) {
    this.spend(1);
    return stmt.all<T>();
  }

  /** Atomic: D1 runs the whole batch in one transaction. */
  async batch<T = unknown>(stmts: D1PreparedStatement[]) {
    this.spend(stmts.length);
    return this.d1.batch<T>(stmts);
  }

  private spend(n: number) {
    if (this.count + n > this.budget) throw new ImportError("budget");
    this.count += n;
  }
}
