import { Link } from "../router";

// Placeholder until the Budget settings step.

export function Budget() {
  return (
    <header className="flex items-center justify-between pt-safe pr-3 pl-5">
      <h1 className="text-title">Budget</h1>
      <Link href="/categories" className="inline-flex min-h-11 items-center px-1 text-accent-fg">
        Categories
      </Link>
    </header>
  );
}
