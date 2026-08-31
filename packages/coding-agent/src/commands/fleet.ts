/**
 * `omp fleet` (alias: `omp sessions`) — launch the interactive TUI with the
 * fleet overview open: the Claude-Code-style dashboard of parallel top-level
 * sessions for this project. Identical to a plain `omp` launch otherwise;
 * every launch flag applies.
 */
import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { fleetHelp } from "../cli/command-help";
import { runRootCommand } from "../main";
import { launchHelp } from "./launch-help";

export default class Fleet extends Command {
	static description = fleetHelp.description;
	static args = launchHelp.args;
	static flags = launchHelp.flags;

	static strict = false;

	async run(): Promise<void> {
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(this.argv);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		parsed.fleet = true;
		await runRootCommand(parsed, this.argv);
	}
}
