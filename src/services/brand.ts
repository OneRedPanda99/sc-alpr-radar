import type { Brand } from "@/types";

/**
 * OSM tagging for ALPRs is inconsistent (manufacturer, brand, operator,
 * description all get used). Normalize whatever string we find into a small,
 * stable set of brands for filtering and coloring.
 */
export function normalizeBrand(raw?: string | null): Brand {
  if (!raw) return "Other";
  const s = raw.toLowerCase();
  if (s.includes("flock")) return "Flock Safety";
  if (s.includes("motorola") || s.includes("vigilant")) return "Motorola";
  if (s.includes("genetec") || s.includes("autovu")) return "Genetec";
  if (s.includes("leonardo") || s.includes("elsag")) return "Leonardo";
  if (s.includes("neology")) return "Neology";
  return "Other";
}

export const BRAND_COLORS: Record<Brand, string> = {
  "Flock Safety": "#ff3b3b",
  Motorola: "#ff9f1c",
  Genetec: "#2ec4b6",
  Leonardo: "#9b5de5",
  Neology: "#4895ef",
  Other: "#c0c0c0",
};
