import { useImportWatcher } from "./components/ImportWatcher";
import { TabBar } from "./components/TabBar";
import { usePathname } from "./router";
import { backOf, parseRoute, tabOf, type Route } from "./routes";
import { Accounts } from "./screens/Accounts";
import { Budget } from "./screens/Budget";
import { Categories, Rules } from "./screens/Categories";
import { Home } from "./screens/Home";
import { Placeholder } from "./screens/Placeholder";
import { ToSort } from "./screens/ToSort";
import { Transactions } from "./screens/Transactions";

// Screens whose design isn't built yet.
const PLACEHOLDER_TITLES: Partial<Record<Route["screen"], string>> = {
  newAccount: "New account found",
  notFound: "Page not found",
};

function Screen({ route }: { route: Route }) {
  switch (route.screen) {
    case "home":
      return <Home />;
    case "transactions":
      return <Transactions />;
    case "budget":
      return <Budget />;
    case "toSort":
      return <ToSort back={backOf(route)} />;
    case "categories":
      return <Categories back={backOf(route)} />;
    case "rules":
      return <Rules back={backOf(route)} />;
    case "accounts":
      return <Accounts back={backOf(route)} />;
    default:
      return <Placeholder back={backOf(route)} title={PLACEHOLDER_TITLES[route.screen]!} />;
  }
}

/** Tab screens sit above the fixed tab bar; pushed screens have a back link and no tab bar. */
export function App() {
  useImportWatcher();
  const route = parseRoute(usePathname());
  const tab = tabOf(route);
  return (
    <>
      <main className={`mx-auto max-w-lg ${tab ? "pb-tabbar-clear" : "pb-safe"}`}>
        <Screen route={route} />
      </main>
      {tab && <TabBar active={tab} />}
    </>
  );
}
