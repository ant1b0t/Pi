import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";

const QWEN_PROVIDER_ID = "qwen-code";
const QWEN_DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_SCOPE = "openid profile email model.completion";
const QWEN_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_POLL_INTERVAL_MS = 2000;
const QWEN_USER_AGENT = `QwenCode/0.10.3 (${process.platform}; ${process.arch})`;

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getPiAuthPath(): string {
  return join(getPiAgentDir(), "auth.json");
}

function loadPiAuth(): Record<string, any> {
  const authPath = getPiAuthPath();
  if (!existsSync(authPath)) return {};
  try {
    return JSON.parse(readFileSync(authPath, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  resource_url?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function startDeviceFlow(): Promise<{ deviceCode: DeviceCodeResponse; verifier: string }> {
  const { verifier, challenge } = await generatePKCE();

  const body = new URLSearchParams({
    client_id: QWEN_CLIENT_ID,
    scope: QWEN_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const response = await fetch(QWEN_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": randomUUID(),
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device code request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as DeviceCodeResponse;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Invalid device code response: missing required fields");
  }

  return { deviceCode: data, verifier };
}

async function pollForToken(
  deviceCode: string,
  verifier: string,
  intervalSeconds: number | undefined,
  expiresIn: number,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = Math.max(1000, Math.floor((intervalSeconds || QWEN_POLL_INTERVAL_MS / 1000) * 1000));

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");

    const body = new URLSearchParams({
      grant_type: QWEN_GRANT_TYPE,
      client_id: QWEN_CLIENT_ID,
      device_code: deviceCode,
      code_verifier: verifier,
    });

    const response = await fetch(QWEN_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const responseText = await response.text();
    let data: TokenResponse | null = null;
    if (responseText) {
      try {
        data = JSON.parse(responseText) as TokenResponse;
      } catch {
        data = null;
      }
    }

    const error = data?.error;
    const errorDescription = data?.error_description;

    if (!response.ok) {
      switch (error) {
        case "authorization_pending":
          await abortableSleep(intervalMs, signal);
          continue;
        case "slow_down":
          intervalMs = Math.min(intervalMs + 5000, 10000);
          await abortableSleep(intervalMs, signal);
          continue;
        case "expired_token":
          throw new Error("Device code expired. Please restart authentication.");
        case "access_denied":
          throw new Error("Authorization denied by user.");
        default:
          throw new Error(`Token request failed: ${response.status} ${response.statusText}. ${errorDescription || responseText}`);
      }
    }

    if (data?.access_token) return data;
    throw new Error("Token request failed: missing access token in response");
  }

  throw new Error("Authentication timed out. Please try again.");
}

async function loginQwen(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { deviceCode, verifier } = await startDeviceFlow();
  const authUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;
  const instructions = deviceCode.verification_uri_complete ? undefined : `Enter code: ${deviceCode.user_code}`;

  callbacks.onAuth({ url: authUrl, instructions });
  callbacks.onProgress?.("Waiting for browser authentication...");

  const tokenResponse = await pollForToken(
    deviceCode.device_code,
    verifier,
    deviceCode.interval,
    deviceCode.expires_in,
    callbacks.signal,
  );

  return {
    refresh: tokenResponse.refresh_token || "",
    access: tokenResponse.access_token,
    expires: Date.now() + tokenResponse.expires_in * 1000 - 5 * 60 * 1000,
    enterpriseUrl: tokenResponse.resource_url,
    scope: tokenResponse.scope,
  };
}

async function refreshQwenToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: QWEN_CLIENT_ID,
  });

  const response = await fetch(QWEN_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error("Token refresh failed: no access token in response");
  }

  return {
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    enterpriseUrl: data.resource_url ?? credentials.enterpriseUrl,
    scope: data.scope ?? credentials.scope,
  };
}

function getQwenBaseUrl(resourceUrl?: string): string {
  if (!resourceUrl) return QWEN_DEFAULT_BASE_URL;

  let url = resourceUrl.startsWith("http") ? resourceUrl : `https://${resourceUrl}`;
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url = `${url.replace(/\/$/, "")}/v1`;
  return url;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(QWEN_PROVIDER_ID, {
    baseUrl: QWEN_DEFAULT_BASE_URL,
    apiKey: "QWEN_CLI_API_KEY",
    api: "openai-completions",
    headers: {
      "User-Agent": QWEN_USER_AGENT,
      "X-DashScope-CacheControl": "enable",
      "X-DashScope-UserAgent": QWEN_USER_AGENT,
      "X-DashScope-AuthType": "qwen-oauth",
    },
    models: [
      {
        id: "coder-model",
        name: "Qwen Coder",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "vision-model",
        name: "Qwen Vision",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
        compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
      },
    ],
    oauth: {
      name: "Qwen Code",
      login: loginQwen,
      refreshToken: refreshQwenToken,
      getApiKey: (cred) => cred.access,
      modifyModels: (models, cred) => {
        const baseUrl = getQwenBaseUrl(cred.enterpriseUrl as string | undefined);
        return models.map((model) =>
          model.provider === QWEN_PROVIDER_ID ? { ...model, baseUrl } : model
        );
      },
    },
  });

  pi.registerCommand("qwen-status", {
    description: "Check Qwen Code OAuth status",
    handler: async (_args, ctx) => {
      const auth = loadPiAuth();
      const cred = auth[QWEN_PROVIDER_ID];

      if (!cred) {
        ctx.ui.notify(`Qwen Code is not logged in. Use /login ${QWEN_PROVIDER_ID}`, "info");
        return;
      }

      if (cred.type !== "oauth") {
        ctx.ui.notify("Qwen Code auth exists, but it is not OAuth-based.", "warning");
        return;
      }

      const expires = typeof cred.expires === "number" ? cred.expires : undefined;
      const expired = expires ? Date.now() >= expires : false;
      const expiresText = expires ? new Date(expires).toLocaleString() : "unknown";
      const baseUrl = getQwenBaseUrl(cred.enterpriseUrl as string | undefined);

      ctx.ui.notify(
        expired
          ? `Qwen Code OAuth found but expired. /login ${QWEN_PROVIDER_ID}\nBase URL: ${baseUrl}\nExpires: ${expiresText}`
          : `Qwen Code OAuth is configured.\nBase URL: ${baseUrl}\nExpires: ${expiresText}`,
        expired ? "warning" : "success",
      );
    },
  });

  console.log(`[Qwen Code] Registered provider ${QWEN_PROVIDER_ID}`);
  console.log(`[Qwen Code] Use built-in /login and /logout. Status command: /qwen-status`);
}
