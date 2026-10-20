import { floorDiv } from "../analytics/math";
import { formatMoney, formatPounds, formatShortDate, monthName, ordinal } from "../display";

/** An overspend: whole pounds, or pence under £1 so a small one never reads "£0 over". */
const overBy = (minor: number) => (minor < 100 ? formatMoney(minor, "GBP") : formatPounds(minor));
import { addMonths } from "../importer/dates";
import type { Insight } from "./rules";

// What each insight says (docs/insights-ui-brief.md), shared by the Insights tab and the weekly
// email so they never disagree. Pure: names come from the caller. Budget figures are whole
// pounds; a single charge shows pence, as transactions do everywhere.

export type Names = { category: (id: number | null) => string; account: (id: number) => string };
export type Words = { headline: string; detail: string };

const gbp = (minor: number) => formatMoney(minor, "GBP");

export function insightWords(item: Insight, names: Names, today: string): Words {
  const byToday = `by the ${ordinal(Number(today.slice(8, 10)))}`;
  switch (item.type) {
    case "stale_account":
      return { headline: `${names.account(item.accountId)} hasn't updated for ${item.staleDays} days`, detail: "Recent spending may be missing." };
    case "pace": {
      const spent = formatPounds(item.spentMinor);
      const limit = formatPounds(item.allocatedMinor);
      if (item.state === "over") {
        const over = overBy(item.spentMinor - item.allocatedMinor);
        return item.categoryId === null
          ? { headline: `${over} over this month's budget`, detail: `${spent} of ${limit}` }
          : { headline: `${names.category(item.categoryId)} is ${over} over`, detail: `${spent} of ${limit} this month` };
      }
      const over = overBy(item.projectedMinor - item.allocatedMinor);
      return item.categoryId === null
        ? { headline: `On course to end the month ${over} over`, detail: `${spent} ${byToday}, ${limit} budget` }
        : { headline: `${names.category(item.categoryId)} is on course to end ${over} over`, detail: `${spent} ${byToday}, ${limit} allocated` };
    }
    case "unusual_category":
      return {
        headline: `${names.category(item.categoryId)} is running high`,
        detail: `${formatPounds(item.spentMinor)} so far, usually about ${formatPounds(item.baselineMinor)} ${byToday}`,
      };
    case "large_charge": {
      const pending = item.isPending ? "Pending · " : "";
      const headline = `${gbp(item.spentMinor)} at ${item.name}`;
      if (item.merchantAverageMinor === null) return { headline, detail: `${pending}New merchant · ${formatShortDate(item.countedDate, today)}` };
      // Rounded to the nearest whole multiple: floor((2 × spent + average) ÷ (2 × average)).
      const times = floorDiv(2 * item.spentMinor + item.merchantAverageMinor, 2 * item.merchantAverageMinor);
      return { headline, detail: `${pending}About ${times}× your usual ${gbp(item.merchantAverageMinor)} there` };
    }
    case "month_change":
      return {
        headline: `${names.category(item.categoryId)} ${item.changeMinor > 0 ? "up" : "down"} ${formatPounds(Math.abs(item.changeMinor))} in ${monthName(item.month)}`,
        detail: `${formatPounds(item.spentMinor)}, from ${formatPounds(item.previousSpentMinor)} in ${monthName(addMonths(item.month, -1))}`,
      };
  }
}
