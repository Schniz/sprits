import { Effect, Console, type Duration } from "effect";
import * as Step from "./step";

class SomeService extends Effect.Tag("SomeService")<
	SomeService,
	{ hello: string }
>() {}

class Random extends Effect.Tag("Random")<SomeService, { next: number }>() {}

const debugging =
	(dur: Duration.DurationInput) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			yield* Effect.logInfo("start");
			const value = yield* effect;
			yield* Effect.sleep(dur);
			yield* Effect.logInfo("end");
			return value;
		});

const grandparent = Step.make({
	name: "grandparent",
	inputs: [],
	run: Effect.gen(function* () {
		yield* Console.log("hi from grandparent");
		return 666;
	}).pipe(debugging("400 millis")),
});

const step1 = Step.make({
	name: "step1",
	inputs: [grandparent],
	run: Effect.gen(function* () {
		yield* SomeService;
		if ((yield* Random).next > 0.5) {
			yield* Effect.fail("oh no (from step 1)" as const);
		}
		yield* Console.log("hi from step1");
		return "step1" as const;
	}).pipe(debugging("400 millis")),
});

const step_parent = Step.make({
	name: "step_parent",
	inputs: [],
	run: Effect.gen(function* () {
		yield* SomeService;
		if ((yield* Random).next > 0.5) {
			yield* Effect.fail("oh no (parent)" as const);
		}
		yield* Console.log("hi from step_parent");
		return "parent" as const;
	}).pipe(debugging("400 millis")),
});

const step2 = Step.make({
	name: "step2",
	inputs: [step1, step_parent],
	run: Effect.gen(function* () {
		if ((yield* Random).next > 0.5) {
			yield* Effect.fail("oh no" as const);
		}
		yield* step1.read;
		yield* step_parent.read;
		yield* Console.log("hi from step2");
		return "step2" as const;
	}).pipe(debugging("400 millis")),
});

const beforeUnwrapping = step2.run;
//    ^?

const effect = Step.run(step2);
//    ^?

await effect.pipe(
	Effect.provideService(SomeService, { hello: "world" }),
	Effect.provideService(Random, { next: 0 }),
	Effect.tapBoth({
		onSuccess: Console.log,
		onFailure: Console.error,
	}),
	Effect.runPromise,
);
