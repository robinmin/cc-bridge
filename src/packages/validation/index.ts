export function getMissingRequiredFields(
	values: Record<string, unknown>,
	requiredFields: string[],
): string[] {
	return requiredFields.filter((field) => {
		const value = values[field];
		return !(typeof value === "string" && value.trim().length > 0);
	});
}

