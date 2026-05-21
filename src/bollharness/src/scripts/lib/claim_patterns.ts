export const CLAIM_PATTERNS = [
  /test[s]?\s+(pass|run|complete[ds]?)/gi,
  /all\s+test[s]?\s+(pass|run)/gi,
  /fix(?:ed|es)?\s+the?\s+(bug|issue|problem)/gi,
  /complete[ds]?/gi,
  /done/gi,
];

export function hasUnverifiedClaim(text: string): boolean {
  return CLAIM_PATTERNS.some(pattern => pattern.test(text));
}