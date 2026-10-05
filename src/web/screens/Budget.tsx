import { TabScreen } from "../components/Screen";
import { Link } from "../router";

// Placeholder until the Budget settings step.

export function Budget() {
  return (
    <TabScreen
      title="Budget"
      action={
        <Link href="/categories" className="inline-flex min-h-11 items-center px-1 text-accent-fg">
          Categories
        </Link>
      }
    />
  );
}
