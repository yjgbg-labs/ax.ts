#!/usr/bin/env bun
//
// MCP HTTP reverse proxy with infinite exponential backoff.
//
// CC's built-in HTTP MCP client gives up after 5 reconnect attempts. This proxy
// sits between CC and a remote MCP server: CC always sees a healthy localhost
// endpoint, and we retry upstream failures (connect errors, 5xx) with backoff
// until they succeed.
//
// Streaming responses (SSE) are forwarded as-is once headers arrive; retries
// only happen *before* any bytes have been sent downstream — replaying a
// half-streamed JSON-RPC response would corrupt the protocol.

const PORT = 4142;

const UPSTREAMS: Record<string, string> = {
  "/tavily":
    "https://mcp.tavily.com/mcp/?tavilyApiKey=REDACTED_TAVILY_KEY",
};

const MAX_RETRIES = 30;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pickUpstream(pathname: string): { upstream: URL; subpath: string } | null {
  for (const [prefix, target] of Object.entries(UPSTREAMS)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return { upstream: new URL(target), subpath: pathname.slice(prefix.length) };
    }
  }
  return null;
}

function redactUrl(u: URL): string {
  const copy = new URL(u.toString());
  for (const k of [...copy.searchParams.keys()]) copy.searchParams.set(k, "***");
  return copy.toString();
}

async function forward(req: Request, upstream: URL, subpath: string): Promise<Response> {
  const reqUrl = new URL(req.url);
  const target = new URL(upstream.toString());
  if (subpath) target.pathname = target.pathname.replace(/\/$/, "") + subpath;
  for (const [k, v] of reqUrl.searchParams) target.searchParams.set(k, v);

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const upstreamRes = await fetch(target, { method: req.method, headers, body });
      if (upstreamRes.status >= 500 && upstreamRes.status < 600) {
        lastErr = new Error(`upstream ${upstreamRes.status}`);
        await upstreamRes.body?.cancel().catch(() => {});
      } else {
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: upstreamRes.headers,
        });
      }
    } catch (e) {
      lastErr = e;
    }
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    console.error(
      `[mcp-proxy] ${req.method} ${reqUrl.pathname} attempt ${attempt + 1}/${MAX_RETRIES} failed (${lastErr}), retry in ${delay}ms`,
    );
    await sleep(delay);
  }
  return new Response(`upstream unavailable after ${MAX_RETRIES} attempts: ${lastErr}`, {
    status: 502,
  });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    const route = pickUpstream(url.pathname);
    if (!route) return new Response("no upstream for " + url.pathname + "\n", { status: 404 });
    return forward(req, route.upstream, route.subpath);
  },
});

console.log(`[mcp-proxy] listening on http://127.0.0.1:${PORT}`);
for (const [prefix, raw] of Object.entries(UPSTREAMS)) {
  console.log(`[mcp-proxy]   ${prefix}  ->  ${redactUrl(new URL(raw))}`);
}
