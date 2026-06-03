/**
 * worktree-tool.ts — Git Worktree Tool for Pi
 *
 * Creates an isolated git worktree copy of a repository, executes a command
 * inside it, returns the result, then removes the worktree.
 *
 * Usage:
 *   import { registerWorktreeTool } from "./worktree-tool.ts";
 *   registerWorktreeTool(pi);
 *
 * Parameters:
 *   - command: string — shell command to run inside the worktree
 *   - cwd: string (optional) — path to the git repository (default: process.cwd())
 *
 * Returns:
 *   { exitCode, stdout, stderr, worktreePath }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { invalidArgument, internalError, conciseDetails } from "../base/tool-contract.ts";

// ── Constants ──────────────────────────────────────────────────────────

const WORKTREE_TIMEOUT_MS = 300_000; // 5 minutes default
const WORKTREE_STDOUT_MAX_LENGTH = 50_000; // Max stdout chars to return
const WORKTREE_PREVIEW_LENGTH = 500;

// ── Schema ─────────────────────────────────────────────────────────────

export const WorktreeParams = Type.Object({
	command: Type.String({ description: "Shell command to run inside the isolated git worktree" }),
	cwd: Type.Optional(Type.String({ description: "Path to the git repository (default: current working directory)" })),
});

export interface WorktreeDetails {
	worktreePath: string;
	repoPath: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutLength: number;
	stderrLength: number;
	truncated: boolean;
	elapsed: number;
	error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function findGitRoot(dir: string): string {
	try {
		const output = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15_000,
		}).trim();
		return resolve(output);
	} catch (err: any) {
		throw invalidArgument(
			`Not a git repository (or git not found): ${dir}`,
			"Ensure the directory is inside a git repository and git is installed"
		);
	}
}

function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const proc = spawn("bash", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			resolvePromise({ exitCode, stdout, stderr });
		};

		const timeoutId = setTimeout(() => {
			try { proc.kill("SIGTERM"); } catch {}
			// Give it a moment, then SIGKILL
			setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch {}
				finish(-1);
			}, 2000);
		}, timeoutMs);

		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		proc.on("close", (code) => {
			finish(code ?? -1);
		});

		proc.on("error", (err) => {
			stderr += err.message;
			finish(-1);
		});

		if (signal) {
			signal.addEventListener("abort", () => {
				try { proc.kill("SIGTERM"); } catch {}
				setTimeout(() => {
					try { proc.kill("SIGKILL"); } catch {}
					finish(-1);
				}, 2000);
			}, { once: true });
		}
	});
}

function truncateOutput(text: string, maxLength: number): { text: string; truncated: boolean } {
	if (text.length <= maxLength) return { text, truncated: false };
	const head = Math.floor(maxLength * 0.7);
	const tail = Math.max(200, maxLength - head - 24);
	return {
		text: text.slice(0, head) + "\n\n…[output truncated]…\n\n" + text.slice(-tail),
		truncated: true,
	};
}

// ── Tool Registration ────────────────────────────────────────────────

export function registerWorktreeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Create an isolated git worktree, run a command inside it, return the result, then remove the worktree. " +
			"Safe for destructive experiments — the original repo is never touched.",
		parameters: WorktreeParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const command = params.command?.trim();
			if (!command) {
				return invalidArgument(
					"command is required",
					"Provide a non-empty shell command to run inside the worktree"
				).toToolResult();
			}

			// Resolve repo path
			const repoPath = params.cwd
				? resolve(ctx.cwd, params.cwd)
				: ctx.cwd;

			if (!existsSync(repoPath)) {
				return invalidArgument(
					`Path does not exist: ${repoPath}`,
					"Provide a valid path to a git repository"
				).toToolResult();
			}

			// Find git root (validates it's a git repo)
			let gitRoot: string;
			try {
				gitRoot = findGitRoot(repoPath);
			} catch (err: any) {
				return invalidArgument(
					err.message || "Not a git repository",
					"Ensure the directory is inside a git repository and git is installed"
				).toToolResult();
			}

			// Create a temporary worktree
			const worktreeDir = mkdtempSync(join(tmpdir(), "pi-worktree-"));
			const start = Date.now();

			try {
				// git worktree add
				const addResult = await runCommand(
					`git worktree add --detach "${worktreeDir}" HEAD 2>&1`,
					gitRoot,
					30_000,
					signal,
				);

				if (addResult.exitCode !== 0) {
					// Cleanup on failure
					try {
						await runCommand(`git worktree remove --force "${worktreeDir}" 2>/dev/null`, gitRoot, 10_000);
					} catch {}
					return internalError(
						`Failed to create worktree: ${addResult.stderr || addResult.stdout}`,
						"Check git status and try again"
					).toToolResult();
				}

				// Run the user's command inside the worktree
				const execResult = await runCommand(command, worktreeDir, WORKTREE_TIMEOUT_MS, signal);

				const elapsed = Date.now() - start;

				// Truncate output if too large
				const stdoutFormatted = truncateOutput(execResult.stdout, WORKTREE_STDOUT_MAX_LENGTH);
				const stderrFormatted = truncateOutput(execResult.stderr, WORKTREE_STDOUT_MAX_LENGTH);

				const details: WorktreeDetails = {
					worktreePath: worktreeDir,
					repoPath: gitRoot,
					exitCode: execResult.exitCode,
					stdout: stdoutFormatted.text,
					stderr: stderrFormatted.text,
					stdoutLength: execResult.stdout.length,
					stderrLength: execResult.stderr.length,
					truncated: stdoutFormatted.truncated || stderrFormatted.truncated,
					elapsed,
				};

				const combinedOutput = [
					execResult.stdout ? `STDOUT:\n${stdoutFormatted.text}` : "",
					execResult.stderr ? `STDERR:\n${stderrFormatted.text}` : "",
				]
					.filter(Boolean)
					.join("\n\n") || "(no output)";

				const success = execResult.exitCode === 0;

				return {
					content: [
						{
							type: "text",
							text: success
								? `Command exited with code 0 in worktree:\n${combinedOutput}`
								: `Command exited with code ${execResult.exitCode} in worktree:\n${combinedOutput}`,
						},
					],
					details: conciseDetails(
						success
							? `Worktree command completed (exit ${execResult.exitCode})`
							: `Worktree command failed (exit ${execResult.exitCode})`,
						details as unknown as Record<string, unknown>,
					),
					isError: !success,
				};
			} finally {
				// Always remove the worktree (fire-and-forget in the background)
				runCommand(`git worktree remove --force "${worktreeDir}" 2>/dev/null`, gitRoot, 15_000).catch(() => {
					// If the first remove fails, try with recursive
					runCommand(`git worktree remove --force "${worktreeDir}" 2>/dev/null`, gitRoot, 15_000).catch(() => {
						// Last resort: just rm -rf the directory
						runCommand(`rm -rf "${worktreeDir}" 2>/dev/null`, "/", 10_000).catch(() => {});
					});
				});
			}
		},

		renderCall(args, theme) {
			const cmd = (args.command || "").slice(0, 60);
			return new Text(
				theme.fg("toolTitle", "worktree ") + theme.fg("accent", cmd),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as WorktreeDetails | undefined;
			if (!d) {
				return new Text(theme.fg("error", "✗ worktree (unknown)"), 0, 0);
			}

			const icon = d.exitCode === 0
				? theme.fg("success", "✓ ")
				: theme.fg("error", `✗ exit:${d.exitCode} `);

			if (expanded) {
				const lines = [
					icon + theme.fg("toolTitle", "worktree ") + theme.fg("dim", `${Math.round(d.elapsed / 1000)}s`),
					theme.fg("muted", `  repo: ${d.repoPath}`),
					theme.fg("muted", `  worktree: ${d.worktreePath}`),
					theme.fg("muted", `  stdout: ${d.stdoutLength} chars`),
					theme.fg("muted", `  stderr: ${d.stderrLength} chars`),
				];
				if (d.stdout) {
					lines.push(
						"",
						theme.fg("accent", "STDOUT:"),
						theme.fg("dim", d.stdout.slice(0, WORKTREE_PREVIEW_LENGTH) + (d.stdout.length > WORKTREE_PREVIEW_LENGTH ? "…" : "")),
					);
				}
				if (d.stderr) {
					lines.push(
						"",
						theme.fg("warning", "STDERR:"),
						theme.fg("dim", d.stderr.slice(0, WORKTREE_PREVIEW_LENGTH) + (d.stderr.length > WORKTREE_PREVIEW_LENGTH ? "…" : "")),
					);
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			const cmd = d.repoPath ? ` ${d.repoPath.split("/").pop()}` : "";
			return new Text(
				icon +
				theme.fg("toolTitle", "worktree") +
				theme.fg("dim", `${cmd} ${Math.round(d.elapsed / 1000)}s`),
				0,
				0,
			);
		},
	});
}
