/**
 * tool-contract.ts — Shared structured error and details helpers for tools
 *
 * Provides:
 *   - Typed error codes and payloads
 *   - Factory helpers: invalidArgument, notFound, unauthorized, rateLimited, temporaryUnavailable, internalError
 *   - conciseDetails() for stable success payloads
 *
 * Usage:
 *   import { invalidArgument, conciseDetails } from "./tool-contract.ts";
 *   throw invalidArgument("bad url", "Provide a valid http:// URL");
 *   return { content: [...], details: conciseDetails("Fetched ok", { url, bytes }) };
 */

export type ToolErrorCode =
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "UNAUTHORIZED"
	| "RATE_LIMITED"
	| "TEMPORARY_UNAVAILABLE"
	| "INTERNAL_ERROR";

export interface ToolErrorPayload {
	code: ToolErrorCode;
	message: string;
	action_hint: string;
	retryable: boolean;
}

export class ToolContractError extends Error {
	readonly payload: ToolErrorPayload;

	constructor(payload: ToolErrorPayload) {
		super(`[${payload.code}] ${payload.message}`);
		this.name = "ToolContractError";
		this.payload = payload;
	}

	/** Returns structured content + details for tool result. */
	toToolResult() {
		return {
			content: [{ type: "text" as const, text: `Error: ${this.payload.message}` }],
			details: {
				summary: this.payload.message,
				error: this.payload.message,
				code: this.payload.code,
				action_hint: this.payload.action_hint,
				retryable: this.payload.retryable,
			},
			isError: true,
		};
	}
}

function make(code: ToolErrorCode, message: string, actionHint: string, retryable: boolean): ToolContractError {
	return new ToolContractError({ code, message, action_hint: actionHint, retryable });
}

export function invalidArgument(message: string, actionHint: string): ToolContractError {
	return make("INVALID_ARGUMENT", message, actionHint, false);
}

export function notFound(message: string, actionHint: string): ToolContractError {
	return make("NOT_FOUND", message, actionHint, false);
}

export function unauthorized(message: string, actionHint: string): ToolContractError {
	return make("UNAUTHORIZED", message, actionHint, false);
}

export function rateLimited(message: string, actionHint: string): ToolContractError {
	return make("RATE_LIMITED", message, actionHint, true);
}

export function temporaryUnavailable(message: string, actionHint: string): ToolContractError {
	return make("TEMPORARY_UNAVAILABLE", message, actionHint, true);
}

export function internalError(message: string, actionHint: string): ToolContractError {
	return make("INTERNAL_ERROR", message, actionHint, false);
}

/**
 * Wrap success details with a stable `summary` field.
 * Keeps all existing fields, just adds summary on top.
 */
export function conciseDetails<T extends Record<string, unknown>>(summary: string, details: T): T & { summary: string } {
	return { summary, ...details };
}
