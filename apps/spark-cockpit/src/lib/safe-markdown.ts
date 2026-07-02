export type SafeMarkdownBlock =
  | { type: "heading"; depth: 1 | 2 | 3; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string | null; code: string }
  | { type: "quote"; lines: string[] };

export function parseSafeMarkdown(source: string): SafeMarkdownBlock[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: SafeMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([^`]*)$/u);
    if (fence) {
      const language = (fence[1] ?? "").trim() || null;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) {
      blocks.push({
        type: "heading",
        depth: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const unordered = listItem(line, false);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = listItem(lines[index] ?? "", false);
        if (!item) break;
        items.push(item);
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const ordered = listItem(line, true);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = listItem(lines[index] ?? "", true);
        if (!item) break;
        items.push(item);
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = (lines[index] ?? "").trim().match(/^>\s?(.*)$/u);
        if (!quote) break;
        quoteLines.push(quote[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", lines: trimEmptyEdges(quoteLines) });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (!candidate.trim() || startsBlock(candidate)) break;
      paragraphLines.push(candidate.trimEnd());
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: trimEmptyEdges(paragraphLines) });
  }

  return blocks;
}

function startsBlock(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^```/u.test(trimmed) ||
    /^#{1,3}\s+/u.test(trimmed) ||
    Boolean(listItem(line, false)) ||
    Boolean(listItem(line, true)) ||
    trimmed.startsWith(">")
  );
}

function listItem(line: string, ordered: boolean): string | null {
  const match = ordered ? line.match(/^\s*\d+[.)]\s+(.+)$/u) : line.match(/^\s*[-*]\s+(.+)$/u);
  return match ? match[1]!.trim() : null;
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}
