export type ToolErrorCode =
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "UNAUTHORIZED"
	| "RATE_LIMITED"
	| "CONFLICT"
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
		super(JSON.stringify(payload));
		this.name = "ToolContractError";
		this.payload = payload;
	}
}

export function makeToolError(payload: ToolErrorPayload): ToolContractError {
	return new ToolContractError(payload);
}

export function invalidArgument(message: string, actionHint: string): ToolContractError {
	return makeToolError({
		code: "INVALID_ARGUMENT",
		message,
		action_hint: actionHint,
		retryable: false,
	});
}

export function notFound(message: string, actionHint: string): ToolContractError {
	return makeToolError({
		code: "NOT_FOUND",
		message,
		action_hint: actionHint,
		retryable: false,
	});
}

export function unauthorized(message: string, actionHint: string): ToolContractError {
	return makeToolError({
		code: "UNAUTHORIZED",
		message,
		action_hint: actionHint,
		retryable: false,
	});
}

export function rateLimited(message: string, actionHint: string): ToolContractError {
	return makeToolError({
		code: "RATE_LIMITED",
		message,
		action_hint: actionHint,
		retryable: true,
	});
}

export function temporaryUnavailable(message: string, actionHint: string): ToolContractError {
	return makeToolError({
		code: "TEMPORARY_UNAVAILABLE",
		message,
		action_hint: actionHint,
		retryable: true,
	});
}

export function internalError(message: string, actionHint: string): ToolContractError {
	return makeToolError({
		code: "INTERNAL_ERROR",
		message,
		action_hint: actionHint,
		retryable: false,
	});
}

export function parseToolErrorMessage(message: string): ToolErrorPayload | undefined {
	try {
		const parsed = JSON.parse(message) as Partial<ToolErrorPayload>;
		if (
			typeof parsed?.code === "string" &&
			typeof parsed?.message === "string" &&
			typeof parsed?.action_hint === "string" &&
			typeof parsed?.retryable === "boolean"
		) {
			return parsed as ToolErrorPayload;
		}
	} catch {}
	return undefined;
}

export function conciseDetails<T extends Record<string, unknown>>(summary: string, details: T): T & { summary: string } {
	return { summary, ...details };
}
