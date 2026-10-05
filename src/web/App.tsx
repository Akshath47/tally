import { TabBar } from "./components/TabBar";
import { usePathname } from "./router";
import { backOf, parseRoute, tabOf, type Route } from "./routes";
import { Accounts } from "./screens/Accounts";
import { Budget } from "./screens/Budget";
import { Home } from "./screens/Home";
import { Placeholder } from "./screens/Placeholder";
import { Transactions } from "./screens/Transactions";

function Screen({ route }: { route: Route }) {
  const back = backOf(route);
  switch (route.screen) {
    case "home":
      return <Home />;
    case "transactions":
      return <Transactions />;
    case "budget":
      return <Budget />;
    case "accounts":
      return <Accounts back={back} />;
    case "toSort":
      return <Placeholder back={back} title="To sort" />;
    case "categories":
      return <Placeholder back={back} title="Categories" />;
    case "rules":
      return <Placeholder back={back} title="Merchant rules" />;
    case "newAccount":
      return <Placeholder back={back} title="New account found" />;
    case "notFound":
      return <Placeholder back={back} title="Page not found" />;
  }
}

/** Tab screens sit above the fixed tab bar; pushed screens have a back link and no tab bar. */
export function App() {
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
