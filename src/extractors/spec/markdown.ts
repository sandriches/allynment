import { unified } from "unified";
import remarkParse from "remark-parse";
import { toString } from "mdast-util-to-string";
import type { Root, RootContent, Heading } from "mdast";

/** One heading-delimited section of a spec document. */
export interface SpecChunk {
  file: string;
  /** Heading path from the document root to this section, e.g. ["Orders API", "Orders", "Order status"]. */
  headingPath: string[];
  /** 1-based line of the heading (or 1 for a preamble with no heading). */
  lineStart: number;
  /** 1-based line of the last line in this section. */
  lineEnd: number;
  /** 1-based line of the first non-blank body line. Equals lineEnd + 1 when the body is empty. */
  bodyLineStart: number;
  /** Body text of the section, excluding the heading line. Empty for heading-only sections. */
  body: string;
}

/**
 * Split a Markdown document into heading-delimited chunks with line ranges.
 * Deterministic. A section ends where the next heading of any depth begins,
 * so nested headings produce separate chunks with longer heading paths.
 */
export function chunkMarkdown(markdown: string, file: string): SpecChunk[] {
  const tree = unified().use(remarkParse).parse(markdown) as Root;
  const lines = markdown.split("\n");
  const totalLines = lines.length;

  const chunks: SpecChunk[] = [];
  const stack: { depth: number; text: string }[] = [];

  let current: { headingPath: string[]; lineStart: number; bodyStart: number } | null = null;

  const flush = (endLine: number) => {
    if (!current) return;
    const bodyLines = lines.slice(current.bodyStart - 1, endLine);
    let leading = 0;
    while (leading < bodyLines.length && (bodyLines[leading] ?? "").trim() === "") leading++;
    const body = bodyLines.join("\n").trim();
    chunks.push({
      file,
      headingPath: current.headingPath,
      lineStart: current.lineStart,
      lineEnd: endLine,
      bodyLineStart: body === "" ? endLine + 1 : current.bodyStart + leading,
      body,
    });
    current = null;
  };

  for (const node of tree.children as RootContent[]) {
    const start = node.position?.start.line ?? 1;
    const end = node.position?.end.line ?? start;

    if (node.type === "heading") {
      flush(start - 1);
      const heading = node as Heading;
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= heading.depth) stack.pop();
      stack.push({ depth: heading.depth, text: toString(heading).trim() });
      current = {
        headingPath: stack.map((s) => s.text),
        lineStart: start,
        bodyStart: end + 1,
      };
    } else if (!current) {
      // Preamble before the first heading.
      current = { headingPath: [], lineStart: start, bodyStart: start };
    }
  }

  flush(totalLines);

  // Trim trailing blank lines from lineEnd so ranges are tight.
  for (const c of chunks) {
    while (c.lineEnd > c.lineStart && (lines[c.lineEnd - 1] ?? "").trim() === "") c.lineEnd--;
    if (c.body === "") c.bodyLineStart = c.lineEnd + 1;
  }

  return chunks;
}

/** Render a chunk body with 1-based absolute line numbers, for prompts that need to cite lines. */
export function numberedBody(chunk: SpecChunk): string {
  return chunk.body
    .split("\n")
    .map((l, i) => `${String(chunk.bodyLineStart + i).padStart(4)} | ${l}`)
    .join("\n");
}
