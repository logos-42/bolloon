import * as fs from "fs";
import * as path from "path";

export function selectTier(tier: string): string {
  const validTiers = ["drop-in", "adapt", "mine"];
  if (!validTiers.includes(tier)) {
    return "drop-in";
  }
  return tier;
}