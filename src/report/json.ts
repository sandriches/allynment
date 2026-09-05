import type { Report } from "../types/index.js";

/**
 * Stable JSON rendering. Object keys are emitted in sorted order and arrays keep the order the
 * pipeline produced (claims by source line, facts and undocumented by id, verdicts in claim order),
 * so two runs on identical inputs produce byte-identical output apart from `generatedAt`.
 */
export function renderJson(report: Report): string {
  return JSON.stringify(sortKeys(report), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
