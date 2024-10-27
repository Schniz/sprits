# sprits

> 💦 Type-safe concurrent pipeline for ambitious applications

## Features

### ✅ Declarative definition

A step is an object containing an Effect and its inputs.
When running a step, a dependency graph will be generated
and the steps will be run as concurrently as possible.

```ts
const child = Step.make({
  title: "some-step",
  inputs: [parent],
  run: Effect.succeed(42),
});
```

This means that you don't need to think whether something should
run concurrently, it will just happen.

### 🔒 Extreme type-safe and composability

Thanks to Effect.ts, we get extreme type-safe and composition
so we can build resilient apps that can scale fearlessly:

#### Error propagation

Errors are propagated to `Step.run` and can be handled in a
type safe manner, so we won't leak errors to customers.

#### Context-aware input reading

Reading a step's inputs is provided through an Effect.ts
context, meaning that you can compose function easily and don't
think about passing down the input arguments.

All you need is to `yield* step`.

Bonus: if you try to read from an input that wasn't defined
in `Step.make`, you will get a type error to make sure you
define all the inputs and the dependency graph is correct.

```ts
const parent = Step.make({
  title: "parent",
  inputs: [],
  run: Effect.succeed(42),
});

const child = Step.make({
  title: "child",
  inputs: [], // forgot to pass the parent

  // 👇 TypeScript error: undeclared step input "parent"
  run: Effect.gen(function* () {
    yield* parent;
  }),
});
```

> [!NOTE]
> Other Effect.ts context services will be propagated as usual. It's only step outputs that behave differently to ensure the dependency graph is known before we execute the code.
> This means you can keep doing `yield* Db` and provide you services in the runtime level the way you know and love from Effect.ts.

### 🖌️ Generate a graph (dot notation)

Once you have your steps defined, you can call `Step.toDot(step)`
to generate a nice dot notation graph of your steps.
This can be fed to a graphviz renderer to visualize the steps into a picture.

## Complete example

```ts
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
    const spawned = spawn(`bash`, ["-c", command], { cwd: opts?.cwd });
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
    yield* runShell(`pnpm install`, { cwd });
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
    yield* runShell(`pnpm run test`, { cwd });
  }),
});

const release = Step.make({
  title: "release",
  inputs: [install, test, build],
  run: Effect.gen(function* () {
    const cwd = yield* install;
    yield* runShell(`pnpm publish`, { cwd });
  }),
});

// Generate a dot notation
const dot = Step.toDot(release).pipe(Effect.runSync);
Fs.writeFile("file.dot", dot);

// Run the app
Step.run(release)
  .pipe(Effect.runPromise)
  .then(
    () => console.log("finished publishing"),
    (err) => console.error(`Error: ${err}`),
  );
```
