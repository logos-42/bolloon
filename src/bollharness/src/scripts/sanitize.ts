import * as fs from "fs";
import * as path from "path";

export function sanitize(text: string): string {
  return text
    .replace(/api[_-]?key["\s:=]+["'][a-zA-Z0-9]{20,}["']/gi, "***REDACTED***")
    .replace(/password["\s:=]+["'][^"']{8,}["']/gi, "***REDACTED***")
    .replace(/secret["\s:=]+["'][a-zA-Z0-9]{16,}["']/gi, "***REDACTED***");
}