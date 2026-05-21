export interface Finding {
  severity: "P0" | "P1" | "P2";
  message: string;
  file: string;
  line?: number;
  blocking: boolean;
  category: string;
  problem_class: string;
  required_skills: string[];
  required_reads: string[];
}

export function createFinding(params: {
  severity: "P0" | "P1" | "P2";
  message: string;
  file: string;
  line?: number;
  blocking?: boolean;
  category?: string;
  problem_class?: string;
  required_skills?: string[];
  required_reads?: string[];
}): Finding {
  return {
    severity: params.severity,
    message: params.message,
    file: params.file,
    line: params.line,
    blocking: params.blocking ?? false,
    category: params.category ?? "general",
    problem_class: params.problem_class ?? "unknown",
    required_skills: params.required_skills ?? [],
    required_reads: params.required_reads ?? [],
  };
}