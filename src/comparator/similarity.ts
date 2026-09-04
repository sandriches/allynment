/**
 * Local, deterministic string similarity used as the fuzzy pass in retrieval.
 * Anthropic has no embeddings endpoint, so rather than add a second provider this uses
 * character trigrams with cosine similarity. It catches casing, plurals and small spelling
 * variations ("customers" vs "customer", "OrderStatuses" vs "OrderStatus") but not synonyms.
 * Swap in a hosted embedder behind the same interface if synonyms turn out to matter.
 */

export interface Similarity {
  /** Similarity in [0, 1] between two identifier-like strings. */
  score(a: string, b: string): number;
}

export function trigrams(s: string): Map<string, number> {
  const padded = `  ${s.toLowerCase()} `;
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w !== undefined) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export class TrigramSimilarity implements Similarity {
  private readonly memo = new Map<string, Map<string, number>>();

  private vec(s: string): Map<string, number> {
    let v = this.memo.get(s);
    if (!v) {
      v = trigrams(s);
      this.memo.set(s, v);
    }
    return v;
  }

  score(a: string, b: string): number {
    if (a === b) return 1;
    return cosine(this.vec(a), this.vec(b));
  }
}
