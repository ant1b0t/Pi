import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_ENV_KEYS = ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] as const;
// This module intentionally configures undici at process scope.
// Use it only for provider transports that must share proxy routing with Pi's internal fetch/stream stack.

function loadUndiciSync(): typeof import("undici") | null {
  const req = createRequire(import.meta.url);
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    try {
      return req(req.resolve("undici", { paths: [dir] }));
    } catch {
      // walk up to repo root
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function getProxyEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = String(process.env[key] || "").trim();
    if (value) out[key] = value;
  }
  return out;
}

function appendNoProxyHosts(hosts: string[]): void {
  const normalizedHosts = hosts
    .map((host) => String(host || "").trim())
    .filter(Boolean);

  if (normalizedHosts.length === 0) return;

  const current = String(process.env.NO_PROXY || process.env.no_proxy || "").trim();
  const entries = current
    ? current.split(",").map((part) => part.trim()).filter(Boolean)
    : [];
  const merged = new Set(entries);

  for (const host of normalizedHosts) merged.add(host);

  if (merged.size > 0) {
    process.env.NO_PROXY = Array.from(merged).join(",");
  }
}

export function configureGlobalProxySupport(options?: {
  noProxyHosts?: string[];
}): Record<string, string> {
  appendNoProxyHosts(options?.noProxyHosts ?? []);

  const proxyEnv = getProxyEnv();
  const signature = JSON.stringify({ proxyEnv, noProxyHosts: options?.noProxyHosts ?? [] });
  const globalKey = "__pi_vs_cc_global_proxy_signature__";
  if ((globalThis as Record<string, unknown>)[globalKey] === signature) return proxyEnv;
  (globalThis as Record<string, unknown>)[globalKey] = signature;

  const undici = loadUndiciSync();
  if (!undici) {
    if (proxyEnv.ALL_PROXY || proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY) {
      console.warn("[Proxy] Proxy env is set but `undici` is missing. Run `bun install` in the Pi repo root.");
    }
    return proxyEnv;
  }

  const { EnvHttpProxyAgent, fetch: undiciFetch, setGlobalDispatcher } = undici;

  const allProxy = proxyEnv.ALL_PROXY;
  if (allProxy) {
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = allProxy;
    if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = allProxy;
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  (globalThis as Record<string, unknown>).fetch = (url: RequestInfo, opts?: RequestInit) =>
    undiciFetch(url, opts as Parameters<typeof undiciFetch>[1]);

  return getProxyEnv();
}

export async function withTemporaryDirectFetch<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  const undici = loadUndiciSync();
  if (!undici) {
    return await callback();
  }

  const { Agent, fetch: undiciFetch, getGlobalDispatcher, setGlobalDispatcher } = undici;
  const globalState = globalThis as Record<string, unknown>;
  const agentKey = "__pi_vs_cc_direct_agent__";
  const directAgent = (globalState[agentKey] ||= new Agent()) as InstanceType<typeof Agent>;

  const previousFetch = globalThis.fetch;
  const previousDispatcher = getGlobalDispatcher();

  // Assumes temporary direct mode is used by one active provider stream at a time.
  globalThis.fetch = (url: RequestInfo | URL, opts?: RequestInit) =>
    undiciFetch(url, { ...opts, dispatcher: directAgent } as Parameters<typeof undiciFetch>[1]);
  setGlobalDispatcher(directAgent);

  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
    setGlobalDispatcher(previousDispatcher);
  }
}
