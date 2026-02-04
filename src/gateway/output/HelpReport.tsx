/** @jsxImportSource hono/jsx */
import { Header } from "./common";

export interface CommandInfo {
    command: string;
    description: string;
}

export const HelpReport = ({
    commands,
    format,
}: {
    commands: CommandInfo[];
    format: "telegram" | "terminal";
}) => {
    const commandsList = commands.map((c) => `/${c.command} - ${c.description}`).join("\n");

    return (
        [
            Header({ title: "Kirin Help", format }),
            "",
            commandsList,
        ]
            .filter(Boolean)
            .join("\n") + "\n"
    );
};
