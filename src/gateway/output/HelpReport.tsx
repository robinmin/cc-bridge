/** @jsxImportSource hono/jsx */
import { Header } from "./common";
import { renderTemplate } from "@/packages/template";

export interface CommandInfo {
	command: string;
	description: string;
}

export const HelpReport = ({ commands, format }: { commands: CommandInfo[]; format: "telegram" | "terminal" }) => {
	const header = Header({ title: "Kirin Help", format });
	return (
		renderTemplate(HELP_TEMPLATE, {
			header,
			commands,
		}) + "\n"
	);
};

const HELP_TEMPLATE = ["{{header}}", "", "{{#each commands}}/{{this.command}} - {{this.description}}", "{{/each}}"].join(
	"\n",
);
