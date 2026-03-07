/**
 * provider-kimi — Kimi For Coding provider for Pi
 *
 * Design notes:
 *   • Kimi For Coding chat endpoint is Anthropic-compatible
 *   • Remote Files API support is provider-dependent
 *   • For source/code/docs we prefer local workspace context injection
 *
 * Base URL: https://api.kimi.com/coding
 * Env: KIMI_API_KEY
 * Header: User-Agent: KimiCLI/0.77
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  streamSimpleAnthropic,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

type Api = "kimi-for-coding-api";
type ApiStyle = "anthropic" | "openai_legacy";
type UploadSupport = boolean | "partial";

interface ProviderCapabilities {
  provider: string;
  apiStyle: ApiStyle;
  baseUrl: string[];
  supportsRemoteFilesUpload: UploadSupport;
  supportsRemoteFilesReadback: boolean;
  supportsRemoteFilesList: boolean;
  supportsRemoteFilesDelete: boolean;
  supportsLocalWorkspaceRead: boolean;
  remoteFileApiBase?: string;
}

interface KimiFile {
  id: string;
  filename: string;
  purpose: string;
  bytes: number;
  created_at: number;
}

interface LineChunk {
  startLine: number;
  endLine: number;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FILE_UPLOAD_THRESHOLD = 50000; // ~12.5k tokens
const MAX_FILE_SIZE_MB = 100;
const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding";
const DEFAULT_KIMI_FILE_API_BASE = "https://api.kimi.com/coding/v1";
const MAX_CONTEXT_CHARS_PER_CHUNK = 4000;
const MAX_CONTEXT_CHUNKS_SMALL = 8;
const MAX_CONTEXT_CHUNKS_LARGE = 4;

const CAPABILITY_MATRIX: Record<string, ProviderCapabilities> = {
  "kimi-for-coding": {
    provider: "kimi-for-coding",
    apiStyle: "anthropic",
    baseUrl: ["https://api.kimi.com/coding/", "https://api.kimi.com/coding/v1"],
    supportsRemoteFilesUpload: "partial",
    supportsRemoteFilesReadback: false,
    supportsRemoteFilesList: false,
    supportsRemoteFilesDelete: false,
    supportsLocalWorkspaceRead: true,
    // upload endpoint accepts multipart POST, but read/list/delete are not guaranteed
    remoteFileApiBase: DEFAULT_KIMI_FILE_API_BASE,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Env helpers
// ─────────────────────────────────────────────────────────────────────────────

function readDotEnvValue(name: string): string | undefined {
  try {
    const envPath = join(process.cwd(), ".env");
    if (!existsSync(envPath)) return undefined;
    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key !== name) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function resolveEnv(name: string): string | undefined {
  return process.env[name]?.trim() || readDotEnvValue(name);
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getProviderCapabilities(provider: string, _baseUrl: string): ProviderCapabilities {
  // for now we map explicitly by provider id; baseUrl is logged for diagnostics
  return CAPABILITY_MATRIX[provider] ?? {
    provider,
    apiStyle: "anthropic",
    baseUrl: [_baseUrl],
    supportsRemoteFilesUpload: false,
    supportsRemoteFilesReadback: false,
    supportsRemoteFilesList: false,
    supportsRemoteFilesDelete: false,
    supportsLocalWorkspaceRead: true,
  };
}

function ensureRemoteReadbackSupported(capabilities: ProviderCapabilities): void {
  if (!capabilities.supportsRemoteFilesReadback) {
    throw new Error("This provider cannot resolve file_id to content. Inject local file text explicitly.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote file helpers (provider-dependent)
// ─────────────────────────────────────────────────────────────────────────────

async function uploadFileRemote(
  filePath: string,
  apiKey: string,
  purpose: "file-extract" | "image",
  fileApiBase: string,
): Promise<KimiFile> {
  const stats = statSync(filePath);
  if (stats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    throw new Error(`File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE_MB}MB)`);
  }

  const formData = new FormData();
  const fileContent = readFileSync(filePath);
  const blob = new Blob([fileContent]);
  formData.append("file", blob, basename(filePath));
  formData.append("purpose", purpose);

  const response = await fetch(`${fileApiBase}/files`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`File upload failed: ${response.status} - ${error}`);
  }

  return response.json();
}

async function getRemoteFileContent(
  fileId: string,
  apiKey: string,
  fileApiBase: string,
  capabilities: ProviderCapabilities,
): Promise<string> {
  ensureRemoteReadbackSupported(capabilities);

  const response = await fetch(`${fileApiBase}/files/${fileId}/content`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get file content: ${response.status}`);
  }

  const data = await response.json();
  return data.content || "";
}

async function listRemoteFiles(apiKey: string, fileApiBase: string, capabilities: ProviderCapabilities): Promise<KimiFile[]> {
  if (!capabilities.supportsRemoteFilesList) {
    throw new Error("Remote file listing is unsupported for this provider.");
  }

  const response = await fetch(`${fileApiBase}/files`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.status}`);
  }

  const data = await response.json();
  return data.data || [];
}

async function deleteRemoteFile(fileId: string, apiKey: string, fileApiBase: string, capabilities: ProviderCapabilities): Promise<void> {
  if (!capabilities.supportsRemoteFilesDelete) {
    throw new Error("Remote file deletion is unsupported for this provider.");
  }

  const response = await fetch(`${fileApiBase}/files/${fileId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete file: ${response.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local workspace context helpers
// ─────────────────────────────────────────────────────────────────────────────

function isProbablyText(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < sampleSize; i++) {
    const b = buffer[i];
    if (b === 0) return false;
    const isControl = b < 9 || (b > 13 && b < 32);
    if (isControl) suspicious++;
  }
  return suspicious / Math.max(1, sampleSize) < 0.02;
}

function chunkByLineRanges(text: string, maxChars: number): LineChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: LineChunk[] = [];

  let startLine = 1;
  let current = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withNewline = `${line}${i < lines.length - 1 ? "\n" : ""}`;

    if (current.length > 0 && current.length + withNewline.length > maxChars) {
      chunks.push({
        startLine,
        endLine: i,
        text: current,
      });
      startLine = i + 1;
      current = withNewline;
      continue;
    }

    current += withNewline;
  }

  if (current.length > 0 || lines.length === 0) {
    chunks.push({
      startLine,
      endLine: lines.length,
      text: current,
    });
  }

  return chunks;
}

function formatInjectedContext(filePath: string, fileBytes: number, text: string): string {
  const isLarge = fileBytes > FILE_UPLOAD_THRESHOLD;
  const maxChunks = isLarge ? MAX_CONTEXT_CHUNKS_LARGE : MAX_CONTEXT_CHUNKS_SMALL;
  const chunks = chunkByLineRanges(text, MAX_CONTEXT_CHARS_PER_CHUNK);
  const selected = chunks.slice(0, maxChunks);

  const header = [
    `Local workspace context injected`,
    `Path: ${filePath}`,
    `Size: ${(fileBytes / 1024).toFixed(1)}KB`,
    `Chunks included: ${selected.length}/${chunks.length}`,
    isLarge ? "Mode: large-file excerpt (line ranges + partial content)" : "Mode: full-context chunks",
    "",
  ].join("\n");

  const body = selected
    .map((chunk, idx) => {
      return [
        `--- chunk ${idx + 1} (lines ${chunk.startLine}-${chunk.endLine}) ---`,
        chunk.text,
      ].join("\n");
    })
    .join("\n\n");

  const tail = selected.length < chunks.length
    ? `\n\n[... ${chunks.length - selected.length} chunk(s) omitted. Use read/grep/find/ls to inspect more lines from workspace ...]`
    : "";

  return `${header}${body}${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream wrapper
// ─────────────────────────────────────────────────────────────────────────────

function streamKimiForCoding(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    try {
      const apiKey = options?.apiKey && options.apiKey !== "KIMI_API_KEY" ? options.apiKey : resolveEnv("KIMI_API_KEY");
      if (!apiKey) throw new Error("Missing KIMI_API_KEY");

      const modelWithBaseUrl = {
        ...model,
        id: model.id === "kimi-for-coding" ? "k2p5" : model.id,
        baseUrl: normalizeBaseUrl(resolveEnv("KIMI_BASE_URL") || DEFAULT_KIMI_BASE_URL),
      } as Model<"anthropic-messages">;

      const innerStream = streamSimpleAnthropic(modelWithBaseUrl, context, {
        ...options,
        apiKey,
        headers: {
          ...options?.headers,
          "User-Agent": "KimiCLI/0.77",
        },
      });

      for await (const event of innerStream) stream.push(event);
      stream.end();
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      });
      stream.end();
    }
  })();

  return stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Extension
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const baseUrl = normalizeBaseUrl(resolveEnv("KIMI_BASE_URL") || DEFAULT_KIMI_BASE_URL);
  const fileApiBase = normalizeBaseUrl(resolveEnv("KIMI_FILE_API_BASE") || DEFAULT_KIMI_FILE_API_BASE);
  const capabilities = getProviderCapabilities("kimi-for-coding", baseUrl);

  console.log(`[Kimi For Coding] Initializing with ${baseUrl}...`);
  console.log(`[Kimi For Coding] ${resolveEnv("KIMI_API_KEY") ? "KIMI_API_KEY found" : "KIMI_API_KEY not set"}`);
  console.log(`[Kimi For Coding] Provider: ${capabilities.provider} | API style: ${capabilities.apiStyle}`);
  console.log(`[Kimi For Coding] Capability path: local-workspace-context`);
  console.log(`[Kimi For Coding] Capabilities: ${JSON.stringify({
    ...capabilities,
    baseUrl,
  })}`);

  // ── Register Provider ─────────────────────────────────────────────────────
  pi.registerProvider("kimi-for-coding", {
    baseUrl,
    apiKey: "KIMI_API_KEY",
    api: "kimi-for-coding-api",
    headers: {
      "User-Agent": "KimiCLI/0.77",
    },
    models: [
      {
        id: "kimi-for-coding",
        name: "Kimi For Coding",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
        compat: {
          supportsDeveloperRole: false,
          requiresToolResultName: true,
        },
      },
    ],
    streamSimple: streamKimiForCoding,
  });

  // ── Register File Upload Tool ─────────────────────────────────────────────
  pi.registerTool({
    name: "kimi_upload",
    label: "KimiUpload",
    description:
      "Inject local file content into context (default) and optionally upload to provider File API (experimental/partial). " +
      "Use for large files via excerpts with line ranges.",
    promptSnippet: "Inject local file into context for Kimi For Coding",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to process" }),
      purpose: Type.Optional(
        Type.Union([Type.Literal("file-extract"), Type.Literal("image")], {
          description: '"file-extract" for text context injection, "image" for media upload',
        })
      ),
    }),

    async execute(_id, params, _signal) {
      const apiKey = resolveEnv("KIMI_API_KEY");
      if (!apiKey) throw new Error("KIMI_API_KEY not set");

      const { path: filePath, purpose = "file-extract" } = params;

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const stats = statSync(filePath);
      if (stats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        throw new Error(`File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE_MB}MB)`);
      }

      const remoteNotes: string[] = [];
      let uploadedFile: KimiFile | undefined;

      // Attachment mode (optional/experimental for kimi-for-coding)
      const shouldTryRemoteUpload = capabilities.supportsRemoteFilesUpload && (purpose === "image" || stats.size > FILE_UPLOAD_THRESHOLD);
      if (shouldTryRemoteUpload && capabilities.remoteFileApiBase) {
        try {
          uploadedFile = await uploadFileRemote(filePath, apiKey, purpose, fileApiBase);
          remoteNotes.push(
            `Remote upload (${capabilities.supportsRemoteFilesUpload}) succeeded: ${uploadedFile.filename} [${uploadedFile.id}] ${(uploadedFile.bytes / 1024).toFixed(1)}KB`
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          remoteNotes.push(`Remote upload failed (${capabilities.supportsRemoteFilesUpload}): ${message}`);

          if (purpose === "image") {
            throw new Error(
              `Image upload failed and cannot fallback to text injection for binary image data. ${message}`
            );
          }
        }
      }

      // Context mode (default for source/code/docs/logs)
      if (purpose === "image") {
        return {
          content: [{
            type: "text" as const,
            text: [
              `Attachment mode: image`,
              `Path: ${filePath}`,
              `Size: ${(stats.size / 1024).toFixed(1)}KB`,
              ...remoteNotes,
              `Remote readback/list/delete are provider-dependent and currently unsupported for kimi-for-coding.`,
            ].join("\n"),
          }],
          details: {
            mode: "attachment",
            purpose,
            uploaded: Boolean(uploadedFile),
            fileId: uploadedFile?.id,
            filename: uploadedFile?.filename,
            size: stats.size,
          },
        };
      }

      if (!capabilities.supportsLocalWorkspaceRead) {
        throw new Error("Local workspace reading is disabled for this provider capability profile.");
      }

      const fileBuffer = readFileSync(filePath);
      if (!isProbablyText(fileBuffer)) {
        throw new Error(
          `File appears binary. Use purpose=image for media attachments or provide a text/code/markdown/log file.`
        );
      }

      const localText = fileBuffer.toString("utf8");
      const injectedContext = formatInjectedContext(filePath, stats.size, localText);

      return {
        content: [{
          type: "text" as const,
          text: [
            `Context mode: text context injection`,
            `Provider: ${capabilities.provider}`,
            ...remoteNotes,
            "",
            injectedContext,
          ].join("\n"),
        }],
        details: {
          mode: "context",
          purpose,
          uploaded: Boolean(uploadedFile),
          fileId: uploadedFile?.id,
          filename: basename(filePath),
          size: stats.size,
          supportsRemoteReadback: capabilities.supportsRemoteFilesReadback,
        },
      };
    },
  });

  // ── Register Cleanup Command ──────────────────────────────────────────────
  pi.registerCommand("kimi-cleanup", {
    description: "Clean up uploaded Kimi files (provider-dependent)",
    handler: async (_args, ctx) => {
      const apiKey = resolveEnv("KIMI_API_KEY");
      if (!apiKey) {
        ctx.ui.notify("KIMI_API_KEY not set", "error");
        return;
      }

      if (!capabilities.supportsRemoteFilesDelete || !capabilities.supportsRemoteFilesList) {
        ctx.ui.notify(
          "/kimi-cleanup: unsupported for this provider capability profile (kimi-for-coding).",
          "info"
        );
        return;
      }

      try {
        const files = await listRemoteFiles(apiKey, fileApiBase, capabilities);
        for (const file of files) {
          await deleteRemoteFile(file.id, apiKey, fileApiBase, capabilities);
        }
        ctx.ui.notify(`Cleaned up ${files.length} files`, "success");
      } catch (err) {
        ctx.ui.notify(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── Register List Files Command ───────────────────────────────────────────
  pi.registerCommand("kimi-files", {
    description: "List uploaded Kimi files (provider-dependent)",
    handler: async (_args, ctx) => {
      const apiKey = resolveEnv("KIMI_API_KEY");
      if (!apiKey) {
        ctx.ui.notify("KIMI_API_KEY not set", "error");
        return;
      }

      if (!capabilities.supportsRemoteFilesList) {
        ctx.ui.notify(
          "/kimi-files: unsupported for this provider capability profile (kimi-for-coding).",
          "info"
        );
        return;
      }

      try {
        const files = await listRemoteFiles(apiKey, fileApiBase, capabilities);
        if (files.length === 0) {
          ctx.ui.notify("No files uploaded", "info");
        } else {
          const list = files.map(f => `${f.filename} (${(f.bytes / 1024).toFixed(1)}KB)`).join("\n");
          ctx.ui.notify(`Files:\n${list}`, "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  console.log("[Kimi For Coding] Registered successfully");
  console.log("[Kimi For Coding] Tools: kimi_upload");
  console.log("[Kimi For Coding] Commands: /kimi-cleanup, /kimi-files");

  // expose guard helper usage path so it doesn't get tree-shaken as dead code
  void getRemoteFileContent;
}
