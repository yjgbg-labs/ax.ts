import type { Page } from "./page";

const WIKILINK_RE = /\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]/g;

export interface Link {
  target: string;        // slug or alias as written
  display?: string;      // optional display text after |
}

export function extractLinks(text: string): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    out.push({ target: m[1].trim(), display: m[2]?.trim() });
  }
  return out;
}

export interface LinkGraph {
  // Resolved slug -> set of slugs it links to
  forward: Map<string, Set<string>>;
  // Resolved slug -> set of slugs that link to it
  backward: Map<string, Set<string>>;
  // Unresolved targets (broken links): slug -> set of targets it tried to reach
  broken: Map<string, Set<string>>;
  // All known slugs (including aliases mapped to canonical)
  aliasMap: Map<string, string>;  // alias -> canonical slug
}

export function buildGraph(pages: Page[]): LinkGraph {
  const aliasMap = new Map<string, string>();
  for (const p of pages) {
    const slug = p.frontmatter.slug;
    aliasMap.set(slug, slug);
    for (const a of p.frontmatter.aliases ?? []) aliasMap.set(a, slug);
  }

  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  const broken = new Map<string, Set<string>>();

  for (const p of pages) {
    const from = p.frontmatter.slug;
    const fwd = new Set<string>();
    forward.set(from, fwd);
    for (const link of extractLinks(p.body)) {
      const resolved = aliasMap.get(link.target);
      if (resolved) {
        fwd.add(resolved);
        if (!backward.has(resolved)) backward.set(resolved, new Set());
        backward.get(resolved)!.add(from);
      } else {
        if (!broken.has(from)) broken.set(from, new Set());
        broken.get(from)!.add(link.target);
      }
    }
  }

  return { forward, backward, broken, aliasMap };
}

export function backlinksOf(graph: LinkGraph, slug: string): string[] {
  const canonical = graph.aliasMap.get(slug) ?? slug;
  return [...(graph.backward.get(canonical) ?? [])].sort();
}

export function orphanPages(pages: Page[], graph: LinkGraph): Page[] {
  return pages.filter((p) => {
    if (p.frontmatter.type === "source" || p.frontmatter.type === "overview") return false;
    const inbound = graph.backward.get(p.frontmatter.slug);
    return !inbound || inbound.size === 0;
  });
}

export interface GraphExport {
  nodes: { id: string; title: string; type: string; tags: string[] }[];
  edges: { from: string; to: string }[];
}

export function exportGraph(pages: Page[], graph: LinkGraph, opts?: { from?: string; depth?: number }): GraphExport {
  const byslug = new Map(pages.map((p) => [p.frontmatter.slug, p]));
  let nodeSet: Set<string>;

  if (opts?.from) {
    const start = graph.aliasMap.get(opts.from) ?? opts.from;
    nodeSet = new Set([start]);
    const depth = opts.depth ?? 1;
    let frontier = new Set([start]);
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>();
      for (const n of frontier) {
        for (const t of graph.forward.get(n) ?? []) if (!nodeSet.has(t)) next.add(t);
        for (const t of graph.backward.get(n) ?? []) if (!nodeSet.has(t)) next.add(t);
      }
      for (const n of next) nodeSet.add(n);
      frontier = next;
    }
  } else {
    nodeSet = new Set(byslug.keys());
  }

  const nodes = [...nodeSet].map((slug) => {
    const p = byslug.get(slug);
    return {
      id: slug,
      title: p?.frontmatter.title ?? slug,
      type: p?.frontmatter.type ?? "unknown",
      tags: p?.frontmatter.tags ?? [],
    };
  });

  const edges: { from: string; to: string }[] = [];
  for (const from of nodeSet) {
    for (const to of graph.forward.get(from) ?? []) {
      if (nodeSet.has(to)) edges.push({ from, to });
    }
  }
  return { nodes, edges };
}

export function graphToDot(g: GraphExport): string {
  const lines = ["digraph wiki {", '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  for (const n of g.nodes) lines.push(`  "${n.id}" [label="${n.title.replace(/"/g, '\\"')}"];`);
  for (const e of g.edges) lines.push(`  "${e.from}" -> "${e.to}";`);
  lines.push("}");
  return lines.join("\n");
}
