import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-addressed JSON cache on disk. Callers compute the key (a content hash) so that
 * identical inputs are never re-sent to the model. Used for extracted claims and comparator verdicts.
 */
export class JsonFileCache {
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  get<T>(key: string): T | undefined {
    const p = this.pathFor(key);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  }

  set(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(key), JSON.stringify(value, null, 2) + "\n");
  }
}

/** A cache that never hits. Used with --no-cache. */
export class NoopCache extends JsonFileCache {
  constructor() {
    super("");
  }
  override get<T>(): T | undefined {
    return undefined;
  }
  override set(): void {}
}
