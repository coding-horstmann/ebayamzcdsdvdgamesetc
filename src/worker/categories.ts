import type { ProductType } from "../../lib/db";

export type ProductCategory = {
  type: ProductType;
  label: string;
  categoryId: number;
  finderMode: "root" | "include";
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getBsrTargetPerCategory(): number {
  return envInt("KEEPA_BSR_TARGET_PER_CATEGORY", 15000);
}

export function getProductCategories(): ProductCategory[] {
  return [
    {
      type: "BOARD_GAME",
      label: "Brettspiele",
      categoryId: envInt("KEEPA_BOARD_GAME_CATEGORY_ID", 360472031),
      finderMode: "include",
    },
    {
      type: "CD",
      label: "CDs",
      categoryId: envInt("KEEPA_CD_CATEGORY_ID", 255882),
      finderMode: "root",
    },
    {
      type: "DVD",
      label: "DVD/Blu-ray",
      categoryId: envInt("KEEPA_DVD_CATEGORY_ID", 284266),
      finderMode: "root",
    },
    {
      type: "GAME",
      label: "Games",
      categoryId: envInt("KEEPA_GAME_CATEGORY_ID", 300992),
      finderMode: "root",
    },
    {
      type: "FIGURE",
      label: "Figuren",
      categoryId: envInt("KEEPA_FIGURE_CATEGORY_ID", 27087992031),
      finderMode: "include",
    },
    {
      type: "PUZZLE",
      label: "Puzzles",
      categoryId: envInt("KEEPA_PUZZLE_CATEGORY_ID", 360541031),
      finderMode: "include",
    },
    {
      type: "VINYL",
      label: "Schallplatten",
      categoryId: envInt("KEEPA_VINYL_CATEGORY_ID", 255882),
      finderMode: "include",
    },
    {
      type: "MODEL_KIT",
      label: "Modellbau",
      categoryId: envInt("KEEPA_MODEL_KIT_CATEGORY_ID", 360488031),
      finderMode: "include",
    },
  ];
}

export function productTypeLabel(type: ProductType | null | undefined): string {
  const category = getProductCategories().find((item) => item.type === type);
  return category?.label ?? "Unbekannt";
}
