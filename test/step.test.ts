import { Effect } from "effect";
import * as Step from "../src/step";
import { test, expect } from "bun:test";

test("workflow works", async () => {
	const order = [] as string[];
	const push = Step.Current.pipe(
		Effect.andThen(({ title }) => {
			order.push(title);
			return title;
		}),
	);
	const grandparent1 = Step.make({
		name: "grandparent1",
		inputs: [],
		run: push,
	});
	const parent1 = Step.make({
		name: "parent1",
		inputs: [grandparent1],
		run: push,
	});
	const grandparent2 = Step.make({
		name: "grandparent2",
		inputs: [],
		run: push,
	});
	const parent2 = Step.make({
		name: "parent2",
		inputs: [grandparent2],
		run: push,
	});
	const child = Step.make({
		name: "child",
		inputs: [parent1, parent2],
		run: Effect.sync(() => order.push("child")).pipe(
			Effect.zipLeft(parent2.read),
			Effect.zipLeft(parent1.read),
		),
	});

	const effect = Step.run(child).pipe(Effect.andThen(() => order));

	expect(await Effect.runPromise(effect)).toEqual([
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

	const a = Step.make({ name: "a", run: push, inputs: [] });
	const b = Step.make({ name: "b", run: push, inputs: [a] });
	const c = Step.make({
		name: "c",
		// @ts-expect-error
		run: Effect.andThen(a.read, push),
		inputs: [],
	});
	const d = Step.make({ name: "d", run: Effect.void, inputs: [b, c] });

	const effect = Step.run(d).pipe(Effect.andThen(() => order));

	const promise = Effect.runPromise(effect);
	expect(promise).rejects.toThrow("Service not found: step/a");
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
		const a = Step.make({ name: `${prefix}_a`, run: push, inputs: [] });
		const b = Step.make({
			name: `${prefix}_b`,
			run: Effect.andThen(a.read, push),
			inputs: [a],
		});
		return Step.run(b);
	};
	const first = Step.make({
		name: "first",
		run: Effect.andThen(push, subWorkflow("first")).pipe(Effect.andThen(end)),
		inputs: [],
	});
	const second = Step.make({
		name: "second",
		run: Effect.andThen(push, subWorkflow("second")).pipe(Effect.andThen(end)),
		inputs: [],
	});
	const accumulate = Step.make({
		name: "accumulate",
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
