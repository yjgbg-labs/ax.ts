import { readdir } from "fs/promises";
import { resolve, basename, relative } from "path";
import { homedir } from "os";

export const WIKI_DIR = process.env.WIKI_DIR ?? resolve(homedir(), "wiki");
export const WIKI_PAGES_DIR = resolve(WIKI_DIR, "wiki");
export const RAW_DIR = resolve(WIKI_DIR, "raw");
export const INDEX_FILE = resolve(WIKI_DIR, "index.md");
export const LOG_FILE = resolve(WIKI_DIR, "log.md");
export const SCHEMA_FILE = resolve(WIKI_DIR, "CLAUDE.md");

export type PageType = "entity" | "concept" | "source" | "overview";

export interface Frontmatter {
  slug: string;
  title: string;
  type: PageType;
  tags?: string[];
  created?: string;
  updated?: string;
  sources?: string[];
  aliases?: string[];
  source_kind?: "conversation" | "article" | "paper" | "repo";
  source_path?: string;
  source_date?: string;
  source_url?: string;
  [key: string]: unknown;
}

export interface Page {
  path: string;
  rel: string;
  frontmatter: Frontmatter;
  body: string;
}

// ── Frontmatter parsing (minimal YAML subset: scalars + flow arrays) ──────────

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFlowArray(s: string): unknown[] {
  const inner = s.trim().slice(1, -1).trim();
  if (!inner) return [];
  // Naive split — fine for our schema (no nested arrays, no commas inside strings)
  return inner.split(",").map((x) => parseScalar(x));
}

export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } | null {
  const m = text.match(FM_RE);
  if (!m) return null;
  const [, yaml, body] = m;
  const fm: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) fm[key] = parseFlowArray(val);
    else fm[key] = parseScalar(val);
  }
  return { fm: fm as Frontmatter, body };
}

function stringifyScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    if (/[:#\[\]&*!|>'"%@`,]/.test(v) || v !== v.trim()) return JSON.stringify(v);
    return v;
  }
  return String(v);
}

function stringifyArray(arr: unknown[]): string {
  return "[" + arr.map(stringifyScalar).join(", ") + "]";
}

export function stringifyFrontmatter(fm: Frontmatter, body: string): string {
  const lines: string[] = ["---"];
  const order = [
    "slug", "title", "type", "tags", "aliases",
    "created", "updated", "sources",
    "source_kind", "source_path", "source_date", "source_url",
  ];
  const seen = new Set<string>();
  const emit = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) lines.push(`${k}: ${stringifyArray(v)}`);
    else lines.push(`${k}: ${stringifyScalar(v)}`);
  };
  for (const k of order) {
    if (k in fm) { emit(k, fm[k]); seen.add(k); }
  }
  for (const k of Object.keys(fm)) {
    if (!seen.has(k)) emit(k, fm[k]);
  }
  lines.push("---", "");
  return lines.join("\n") + body.replace(/^\n+/, "");
}

// ── Page loading ──────────────────────────────────────────────────────────────

export async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  }
  await walk(root);
  return out;
}

export async function loadPage(path: string): Promise<Page | null> {
  const text = await Bun.file(path).text();
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const fm = parsed.fm;
  if (!fm.slug) fm.slug = basename(path, ".md");
  if (!fm.title) fm.title = fm.slug;
  return { path, rel: relative(WIKI_DIR, path), frontmatter: fm, body: parsed.body };
}

export async function loadAllPages(): Promise<Page[]> {
  const files = await walkMarkdown(WIKI_PAGES_DIR);
  const pages: Page[] = [];
  for (const f of files) {
    const p = await loadPage(f);
    if (p) pages.push(p);
  }
  return pages;
}

export async function findBySlug(slug: string): Promise<Page[]> {
  const pages = await loadAllPages();
  return pages.filter((p) => p.frontmatter.slug === slug || (p.frontmatter.aliases ?? []).includes(slug));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
