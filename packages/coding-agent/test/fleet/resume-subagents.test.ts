import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionFileStatus } from "@oh-my-pi/pi-coding-agent/session/session-listing";

/**
 * Contract tests for the transcript-tail classifier the subagent auto-resume
 * uses to decide which parked children get re-kicked. A misclassification
 * either re-runs completed work (complete → interrupted) or strands a
 * genuinely interrupted child (interrupted → complete), so the branch table
 * is the contract.
 */
describe("readSessionFileStatus", () => {
	async function writeTranscript(lines: unknown[]): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-status-"));
		const file = path.join(dir, "agent.jsonl");
		await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		return file;
	}

	it("classifies a trailing unanswered tool call as interrupted", async () => {
		const file = await writeTranscript([
			{ type: "session_init", timestamp: 1 },
			{ type: "message", message: { role: "user", content: "do the thing" } },
			{
				type: "message",
				message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1" }] },
			},
		]);
		expect(await readSessionFileStatus(file)).toBe("interrupted");
	});

	it("classifies a trailing toolResult with no following assistant turn as interrupted", async () => {
		const file = await writeTranscript([
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "message", message: { role: "toolResult", content: [] } },
		]);
		expect(await readSessionFileStatus(file)).toBe("interrupted");
	});

	it("classifies a settled yield toolResult as complete (idempotent auto-resume)", async () => {
		// Regression: a subagent that finished by yielding has no trailing
		// assistant turn; misreading this as interrupted re-kicks the finished
		// child on EVERY resume of its parent.
		const file = await writeTranscript([
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "message", message: { role: "toolResult", toolName: "yield", toolCallId: "y1", content: [] } },
		]);
		expect(await readSessionFileStatus(file)).toBe("complete");
	});
	it("classifies an unanswered user prompt as pending", async () => {
		const file = await writeTranscript([{ type: "message", message: { role: "user", content: "go" } }]);
		expect(await readSessionFileStatus(file)).toBe("pending");
	});

	it("classifies a clean final assistant turn as complete (never re-kicked)", async () => {
		const file = await writeTranscript([
			{ type: "message", message: { role: "user", content: "go" } },
			{
				type: "message",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
			},
		]);
		expect(await readSessionFileStatus(file)).toBe("complete");
	});

	it("classifies an aborted final turn as aborted (never re-kicked)", async () => {
		const file = await writeTranscript([
			{ type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
		]);
		expect(await readSessionFileStatus(file)).toBe("aborted");
	});

	it("degrades a missing file to unknown instead of throwing", async () => {
		expect(await readSessionFileStatus("/nonexistent/omp-resume/agent.jsonl")).toBe("unknown");
	});
});
