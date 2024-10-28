import { Effect } from "effect";
import * as Step from "../src/step";
import { test, expect, expectTypeOf } from "vitest";

test("workflow works", async () => {
	class Srv extends Effect.Service<Srv>()("Srv", {
		succeed: { value: "hi" },
	}) {}
	const order = [] as string[];
	const push = Step.Current.pipe(
		Effect.andThen(({ title }) => {
			order.push(title);
			return title;
		}),
	);
	const grandparent1 = Step.make({
		title: "grandparent1",
		inputs: [],
		run: Effect.zipLeft(push, Srv),
	});
	const parent1 = Step.make({
		title: "parent1",
		inputs: [grandparent1],
		run: push,
	});
	const grandparent2 = Step.make({
		title: "grandparent2",
		inputs: [],
		run: push,
	});
	const parent2 = Step.make({
		title: "parent2",
		inputs: [grandparent2],
		run: push,
	});
	const child = Step.make({
		title: "child",
		inputs: [parent1, parent2],
		run: Effect.zipLeft(push, Effect.all([parent2, parent1])),
	});

	const effect = Step.run(child);

	expectTypeOf(effect).toEqualTypeOf<Effect.Effect<string, never, Srv>>();

	const result = await Effect.runPromise(
		effect.pipe(Effect.provide(Srv.Default)),
	);
	expect(result).toBe("child");

	expect(order).toEqual([
		"grandparent2",
		"grandparent1",
		"parent2",
		"parent1",
		"child",
	]);

	expect(Effect.runSync(Step.toDot(child))).toMatchSnapshot();
});

test("invalid dependency tree", async () => {
	const order: string[] = [];
	const push = Step.Current.pipe(
		Effect.andThen(({ title }) => {
			order.push(title);
			return title;
		}),
	);
	// a -> b -> d
	// c --------^ but reads from a

	const a = Step.make({ title: "a", run: push, inputs: [] });
	const b = Step.make({ title: "b", run: push, inputs: [a] });
	const c = Step.make({
		title: "c",
		// @ts-expect-error
		run: Effect.andThen(a, push),
		inputs: [],
	});
	const d = Step.make({ title: "d", run: Effect.void, inputs: [b, c] });

	const effect = Step.run(d).pipe(Effect.andThen(() => order));

	const promise = Effect.runPromise(effect);
	expect(promise).rejects.toThrow("Service not found: @sprits/a");
});

test("composition", async () => {
	const order = [] as string[];
	const push = Effect.andThen(Step.Current, ({ title }) => {
		order.push(title);
		return title;
	});
	const end = Effect.andThen(Step.Current, ({ title }) => {
		order.push(`/${title}`);
		return title;
	});
	const subWorkflow = (prefix: string) => {
		const a = Step.make({ title: `${prefix}_a`, run: push, inputs: [] });
		const b = Step.make({
			title: `${prefix}_b`,
			run: Effect.andThen(a, push),
			inputs: [a],
		});
		return Step.run(b);
	};
	const first = Step.make({
		title: "first",
		run: Effect.andThen(push, subWorkflow("first")).pipe(Effect.andThen(end)),
		inputs: [],
	});
	const second = Step.make({
		title: "second",
		run: Effect.andThen(push, subWorkflow("second")).pipe(Effect.andThen(end)),
		inputs: [],
	});
	const accumulate = Step.make({
		title: "accumulate",
		run: Effect.void,
		inputs: [first, second],
	});

	await Effect.runPromise(Step.run(accumulate));
	expect(order).toEqual([
		"second",
		"first",
		"second_a",
		"first_a",
		"second_b",
		"first_b",
		"/second",
		"/first",
	]);
});
