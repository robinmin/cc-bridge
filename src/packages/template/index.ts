type TemplateValue = string | number | boolean | null | undefined | TemplateValue[] | Record<string, TemplateValue>;

type RenderContext = Record<string, TemplateValue>;

const get = (ctx: RenderContext, path: string): TemplateValue => {
	const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
	let cur: TemplateValue = ctx;
	for (const part of parts) {
		if (cur && typeof cur === "object" && !Array.isArray(cur) && part in cur) {
			cur = (cur as Record<string, TemplateValue>)[part];
		} else {
			return undefined;
		}
	}
	return cur;
};

const isTruthy = (val: TemplateValue): boolean => {
	if (Array.isArray(val)) return val.length > 0;
	return !!val;
};

const renderSection = (tpl: string, ctx: RenderContext): string => {
	let out = tpl;

	// each blocks: {{#each items}} ... {{/each}}
	out = out.replace(/\{\{#each\s+([^\}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, path, body) => {
		const val = get(ctx, String(path).trim());
		if (!Array.isArray(val)) return "";
		return val
			.map((item) =>
				renderSection(body, {
					...ctx,
					this: item as TemplateValue,
				}),
			)
			.join("");
	});

	// if blocks: {{#if cond}} ... {{/if}}
	out = out.replace(/\{\{#if\s+([^\}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, path, body) => {
		const val = get(ctx, String(path).trim());
		if (!isTruthy(val)) return "";
		return renderSection(body, ctx);
	});

	// variables: {{var}}
	out = out.replace(/\{\{\s*([^\}]+)\s*\}\}/g, (_m, path) => {
		const val = get(ctx, String(path).trim());
		if (val === null || val === undefined) return "";
		if (Array.isArray(val)) return val.join(", ");
		if (typeof val === "object") return "";
		return String(val);
	});

	return out;
};

export const renderTemplate = (template: string, context: RenderContext): string => {
	return renderSection(template, context);
};
