import { ADVERTISED_TAG_NAMES, parseTags, validateTags } from "./agent-tags.ts";

export interface DelegationValidationResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
}

const ACTION_VERB_RE = /\b(analy[sz]e|inspect|review|compare|check|find|search|trace|debug|investigate|implement|change|edit|update|refactor|write|test|verify|summari[sz]e|document|plan|research|audit|map|locate|fix)\b/i;
const VAGUE_RE = [
	/\blook into\b/i,
	/\bcheck this\b/i,
	/\bsee what you find\b/i,
	/\bbased on (your|the) findings\b/i,
	/\bimplement what you found\b/i,
	/\bfix it\b/i,
	/\bhandle it\b/i,
	/\btake care of it\b/i,
];

export function validateDelegationPrompt(input: {
	text: string;
	tags?: string | string[];
	mode?: "spawn" | "continue";
}): DelegationValidationResult {
	const text = (input.text || "").trim();
	const mode = input.mode || "spawn";
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!text) {
		errors.push(mode === "spawn"
			? "Task cannot be empty. Provide a concrete delegated task."
			: "Prompt cannot be empty. Provide concrete continuation instructions.");
		return { ok: false, errors, warnings };
	}

	const wordCount = text.split(/\s+/).filter(Boolean).length;
	if (mode === "spawn" && wordCount < 3) {
		errors.push("Delegation is too short. Include a concrete objective, scope, or expected output.");
	}

	if (!ACTION_VERB_RE.test(text)) {
		warnings.push("Delegation may be underspecified: include an explicit action verb such as analyze, implement, verify, or compare.");
	}

	for (const pattern of VAGUE_RE) {
		if (pattern.test(text)) {
			if (mode === "spawn") {
				errors.push("Delegation is too vague. Replace phrases like 'look into' or 'implement what you found' with specific files, goals, or success criteria.");
			} else {
				warnings.push("Continuation prompt is vague. Consider naming files, mechanisms, or expected output explicitly.");
			}
			break;
		}
	}

	const parsedTags = parseTags(input.tags);
	const { invalid } = validateTags(parsedTags);
	if (invalid.length > 0) {
		errors.push(`Unknown or disabled tag(s): ${invalid.join(", ")}. Allowed tags: ${ADVERTISED_TAG_NAMES.join(", ")}.`);
	}

	if (mode === "spawn" && parsedTags.length >= 5) {
		warnings.push("Delegation requests many capability tags. Prefer the smallest relevant toolset.");
	}

	return { ok: errors.length === 0, errors, warnings };
}
