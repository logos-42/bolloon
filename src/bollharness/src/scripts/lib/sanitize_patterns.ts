export const SANITIZE_PATTERNS = [
  { pattern: /api[_-]?key["\s:=]+["'][a-zA-Z0-9]{20,}["']/gi, replacement: "***REDACTED***" },
  { pattern: /password["\s:=]+["'][^"']{8,}["']/gi, replacement: "***REDACTED***" },
  { pattern: /secret["\s:=]+["'][a-zA-Z0-9]{16,}["']/gi, replacement: "***REDACTED***" },
];

export function sanitize(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SANITIZE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}