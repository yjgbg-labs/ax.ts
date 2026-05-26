import type { Page } from "./page";
import type { LinkGraph } from "./links";
import { orphanPages } from "./links";

export interface LintReport {
  brokenLinks: { from: string; targets: string[] }[];
  orphans: string[];
  missingFrontmatter: string[];   // rel paths
  slugMismatch: { rel: string; slug: string }[];  // slug != filename
  missingPages: { slug: string; referencedBy: string[] }[];  // referenced but no page
}

export function lint(pages: Page[], graph: LinkGraph, allMdFiles: string[], pageFiles: Set<string>): LintReport {
  const brokenLinks = [...graph.broken.entries()]
    .map(([from, targets]) => ({ from, targets: [...targets].sort() }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const orphans = orphanPages(pages, graph).map((p) => p.frontmatter.slug).sort();

  const missingFrontmatter: string[] = [];
  for (const f of allMdFiles) {
    if (!pageFiles.has(f)) missingFrontmatter.push(f);
  }

  const slugMismatch: { rel: string; slug: string }[] = [];
  for (const p of pages) {
    const filename = p.path.split("/").pop()!.replace(/\.md$/, "");
    if (filename !== p.frontmatter.slug) slugMismatch.push({ rel: p.rel, slug: p.frontmatter.slug });
  }

  // Aggregate missing pages: broken target -> all pages that reference it
  const refMap = new Map<string, Set<string>>();
  for (const { from, targets } of brokenLinks) {
    for (const t of targets) {
      if (!refMap.has(t)) refMap.set(t, new Set());
      refMap.get(t)!.add(from);
    }
  }
  const missingPages = [...refMap.entries()]
    .map(([slug, refs]) => ({ slug, referencedBy: [...refs].sort() }))
    .sort((a, b) => b.referencedBy.length - a.referencedBy.length);

  return { brokenLinks, orphans, missingFrontmatter, slugMismatch, missingPages };
}

export function formatReport(r: LintReport): string {
  const out: string[] = [];
  const section = (title: string, items: unknown[]) => {
    out.push(`\n\x1b[1m${title}\x1b[0m (${items.length})`);
  };

  section("Broken links", r.brokenLinks);
  for (const { from, targets } of r.brokenLinks) {
    out.push(`  ${from} → ${targets.join(", ")}`);
  }

  section("Missing pages (referenced but not created)", r.missingPages);
  for (const { slug, referencedBy } of r.missingPages) {
    out.push(`  [[${slug}]]  referenced by ${referencedBy.length}: ${referencedBy.slice(0, 5).join(", ")}${referencedBy.length > 5 ? "..." : ""}`);
  }

  section("Orphan pages (no inbound links)", r.orphans);
  for (const s of r.orphans) out.push(`  ${s}`);

  section("Files without frontmatter", r.missingFrontmatter);
  for (const f of r.missingFrontmatter) out.push(`  ${f}`);

  section("Slug ≠ filename", r.slugMismatch);
  for (const { rel, slug } of r.slugMismatch) out.push(`  ${rel}  (slug: ${slug})`);

  return out.join("\n");
}
