import FilterPanel, { type Filters } from "./components/FilterPanel";
import ProductTable from "./components/ProductTable";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = {
  minProfit?: string;
  minRoi?: string;
  maxBsr?: string;
  minSales?: string;
  productType?: string;
  buyingOption?: string;
  sortBy?: string;
};

const sortOptions = ["best_roi", "best_profit", "bsr", "checked"] as const;
const productTypes = ["all", "BOARD_GAME", "CD", "DVD", "GAME", "FIGURE"] as const;

function parseSortBy(value: string | undefined): Filters["sortBy"] {
  return sortOptions.includes(value as Filters["sortBy"])
    ? (value as Filters["sortBy"])
    : "best_roi";
}

function parseProductType(value: string | undefined): Filters["productType"] {
  return productTypes.includes(value as Filters["productType"])
    ? (value as Filters["productType"])
    : "all";
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  const filters: Filters = {
    minProfit: Number(searchParams.minProfit ?? 5),
    minRoi: Number(searchParams.minRoi ?? 50),
    maxBsr: Number(searchParams.maxBsr ?? 500000),
    minSales: Number(searchParams.minSales ?? 0),
    productType: parseProductType(searchParams.productType),
    buyingOption:
      searchParams.buyingOption === "fixed" || searchParams.buyingOption === "auction"
        ? searchParams.buyingOption
        : "all",
    sortBy: parseSortBy(searchParams.sortBy),
  };

  return (
    <div className="space-y-6">
      <FilterPanel initial={filters} />
      <ProductTable filters={filters} />
    </div>
  );
}
