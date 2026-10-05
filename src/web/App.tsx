import { useImportWatcher } from "./components/ImportWatcher";
import { PushedScreen } from "./components/Screen";
import { TabBar } from "./components/TabBar";
import { usePathname } from "./router";
import { backOf, parseRoute, tabOf, type Route } from "./routes";
import { Accounts } from "./screens/Accounts";
import { Budget } from "./screens/Budget";
import { Categories, Rules } from "./screens/Categories";
import { Home } from "./screens/Home";
import { NewAccount } from "./screens/NewAccount";
import { ToSort } from "./screens/ToSort";
import { Transactions } from "./screens/Transactions";

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
    case "newAccount":
      return <NewAccount back={backOf(route)} accountId={route.accountId} />;
    case "accounts":
      return <Accounts back={backOf(route)} />;
    case "notFound":
      return (
        <PushedScreen back={backOf(route)} title="Page not found">
          <p className="mx-5 mt-2 text-muted">There's nothing at this address.</p>
        </PushedScreen>
      );
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
