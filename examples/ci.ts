import { Step } from "../src/index.ts";
import { Config, Data, Effect } from "effect";
import Fs from "node:fs/promises";
import { spawn } from "node:child_process";

const RandomDirectory = {
	make: Effect.promise(() => Fs.mkdtemp("ci-")),
};

class ProcessFailed extends Data.TaggedError("ProcessFailed")<{
	code: null | number;
}> {}

const runShell = (command: string, opts?: { cwd: string }) =>
	Effect.async<void, ProcessFailed>((emit) => {
		const spawned = spawn("bash", ["-c", command], { cwd: opts?.cwd });
		spawned.on("close", (code) => {
			emit(code === 0 ? Effect.void : Effect.fail(new ProcessFailed({ code })));
		});
		return Effect.sync(() => spawned.kill());
	});

const clone = Step.make({
	title: "clone",
	inputs: [],
	run: Effect.gen(function* () {
		const cwd = yield* RandomDirectory.make;
		const repo = yield* Config.string("GIT_REPO");
		yield* runShell(`git clone ${repo} ${cwd}`);
		return cwd;
	}),
});

const install = Step.make({
	title: "install",
	inputs: [clone],
	run: Effect.gen(function* () {
		const cwd = yield* clone;
		yield* runShell("pnpm install", { cwd });
		return cwd;
	}),
});

const build = Step.make({
	title: "build",
	inputs: [install],
	run: Effect.gen(function* () {
		const cwd = yield* install;
		yield* runShell("pnpm run build", { cwd });
	}),
});

const test = Step.make({
	title: "test",
	inputs: [install],
	run: Effect.gen(function* () {
		const cwd = yield* install;
		yield* runShell("pnpm run test", { cwd });
	}),
});

const release = Step.make({
	title: "release",
	inputs: [install, test, build],
	run: Effect.gen(function* () {
		const cwd = yield* install;
		yield* runShell("pnpm publish", { cwd });
	}),
});

// Generate a dot notation
const dot = Step.toDot(release).pipe(Effect.runSync);
Fs.writeFile("file.dot", dot);
