import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_ENV_KEYS = ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] as const;

type ProxyEnv = Record<string, string>;

type CachedDispatcherState = {
  direct?: unknown;
  proxy: Map<string, unknown>;
};

export type ProxyTransportMode = "proxy" | "direct";

export interface ScopedTransport {
  fetch: typeof globalThis.fetch;
  proxyEnv: ProxyEnv;
  effectiveNoProxy: string;
  dispatcherKind: "global-fetch" | "Agent" | "EnvHttpProxyAgent";
  usingUndici: boolean;
}

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

function getEnvValue(keys: string[]): string {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function getProxyEnv(): ProxyEnv {
  const out: ProxyEnv = {};

  const allProxy = getEnvValue(["ALL_PROXY", "all_proxy"]);
  const httpsProxy = getEnvValue(["HTTPS_PROXY", "https_proxy"]);
  const httpProxy = getEnvValue(["HTTP_PROXY", "http_proxy"]);
  const noProxy = getEnvValue(["NO_PROXY", "no_proxy"]);

  if (allProxy) out.ALL_PROXY = allProxy;
  if (httpsProxy || allProxy) out.HTTPS_PROXY = httpsProxy || allProxy;
  if (httpProxy || allProxy) out.HTTP_PROXY = httpProxy || allProxy;
  if (noProxy) out.NO_PROXY = noProxy;

  return out;
}

function mergeNoProxy(noProxy: string, hosts: string[]): string {
  const normalizedHosts = hosts
    .map((host) => String(host || "").trim())
    .filter(Boolean);

  if (normalizedHosts.length === 0) return noProxy;

  const entries = noProxy
    ? noProxy.split(",").map((part) => part.trim()).filter(Boolean)
    : [];
  const merged = new Set(entries);

  for (const host of normalizedHosts) merged.add(host);
  return Array.from(merged).join(",");
}

function getDispatcherCache(): CachedDispatcherState {
  const globalKey = "__pi_vs_cc_scoped_dispatchers__";
  const globalState = globalThis as Record<string, unknown>;
  const cached = globalState[globalKey] as CachedDispatcherState | undefined;
  if (cached) return cached;

  const next: CachedDispatcherState = {
    proxy: new Map<string, unknown>(),
  };
  globalState[globalKey] = next;
  return next;
}

function getDirectDispatcher(undici: typeof import("undici")) {
  const cache = getDispatcherCache();
  if (!cache.direct) {
    cache.direct = new undici.Agent();
  }
  return cache.direct as InstanceType<typeof undici.Agent>;
}

function getProxyDispatcher(
  undici: typeof import("undici"),
  proxyEnv: ProxyEnv,
  effectiveNoProxy: string,
) {
  const cache = getDispatcherCache();
  const hasProxy = !!(proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY);
  if (!hasProxy) {
    return getDirectDispatcher(undici);
  }

  const signature = JSON.stringify({
    httpsProxy: proxyEnv.HTTPS_PROXY || "",
    httpProxy: proxyEnv.HTTP_PROXY || "",
    noProxy: effectiveNoProxy,
  });

  const cached = cache.proxy.get(signature);
  if (cached) {
    return cached as InstanceType<typeof undici.EnvHttpProxyAgent>;
  }

  const dispatcher = new undici.EnvHttpProxyAgent({
    httpProxy: proxyEnv.HTTP_PROXY || undefined,
    httpsProxy: proxyEnv.HTTPS_PROXY || undefined,
    noProxy: effectiveNoProxy || undefined,
  });
  cache.proxy.set(signature, dispatcher);
  return dispatcher;
}

export function getScopedTransport(options?: {
  mode?: ProxyTransportMode;
  noProxyHosts?: string[];
}): ScopedTransport {
  const mode = options?.mode ?? "proxy";
  const proxyEnv = getProxyEnv();
  const effectiveNoProxy = mergeNoProxy(proxyEnv.NO_PROXY || "", options?.noProxyHosts ?? []);

  if (effectiveNoProxy) {
    proxyEnv.NO_PROXY = effectiveNoProxy;
  }

  const undici = loadUndiciSync();
  if (!undici) {
    if (mode === "proxy" && (proxyEnv.ALL_PROXY || proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY)) {
      console.warn("[Proxy] Proxy env is set but `undici` is missing. Run `bun install` in the Pi repo root.");
    }

    return {
      fetch: globalThis.fetch.bind(globalThis),
      proxyEnv,
      effectiveNoProxy,
      dispatcherKind: "global-fetch",
      usingUndici: false,
    };
  }

  const dispatcher = mode === "direct"
    ? getDirectDispatcher(undici)
    : getProxyDispatcher(undici, proxyEnv, effectiveNoProxy);
  const dispatcherKind = mode === "direct" || !(proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY)
    ? "Agent"
    : "EnvHttpProxyAgent";

  const scopedFetch: typeof globalThis.fetch = (input, init) => {
    return undici.fetch(input as RequestInfo, {
      ...(init as RequestInit | undefined),
      dispatcher,
    } as Parameters<typeof undici.fetch>[1]) as Promise<Response>;
  };

  return {
    fetch: scopedFetch,
    proxyEnv,
    effectiveNoProxy,
    dispatcherKind,
    usingUndici: true,
  };
}

export function getScopedProxyEnv(options?: { noProxyHosts?: string[] }): ProxyEnv {
  return getScopedTransport({
    mode: "proxy",
    noProxyHosts: options?.noProxyHosts,
  }).proxyEnv;
}
