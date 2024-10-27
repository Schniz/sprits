import { Context, Deferred, Effect, Effectable } from "effect";
import { type NodeModel, digraph, toDot as toGraphvizDot } from "ts-graphviz";

const StepContextId = Symbol("StepContextId");

type ConstructionError<Inputs extends AnyStep[], R> = [
	{
		[key in keyof Inputs]: Inputs[key]["title"];
	}[Extract<keyof Inputs, number>],
	R,
] extends [infer Provided, StepContext<infer Requested>]
	? Exclude<Requested, Provided> extends never
		? never
		: string extends Requested
			? never
			: `undeclared step input ${Requested}`
	: never;

/**
 * Create a step
 */
export function make<
	const Title extends string,
	const Inputs extends AnyStep[],
	A,
	E,
	R,
	CE = ConstructionError<Inputs, R>,
>(
	opts: [CE] extends [never]
		? { title: Title; run: Effect.Effect<A, E, R | Current>; inputs: Inputs }
		: {
				title: Title;
				run: Effect.Effect<A, E, R | Current> & [CE];
				inputs: Inputs;
			},
): Step<Title, A, E, R, Inputs> {
	class Ctx extends Context.Tag(`@sprits/${opts.title}`)<unknown, A>() {}

	class Class extends Effectable.Class<A, never, StepContext<Title>> {
		title = opts.title;
		inputs = opts.inputs;
		run = Effect.provideService(opts.run as Effect.Effect<A, E, R>, Current, {
			title: opts.title,
		});

		commit(): Effect.Effect<A, never, StepContext<Title>> {
			// @ts-expect-error trying to hack things
			return Ctx;
		}

		[StepContextId] = Ctx;
	}

	return new Class();
}

interface Step<Title extends string, A, E, R, Inputs extends AnyStep[]>
	extends Effect.Effect<A, never, StepContext<Title>> {
	title: Title;
	readonly inputs: Inputs;
	run: Effect.Effect<A, E, R>;
}

type StepContext<Title extends string> = `step/${Title}`;

// biome-ignore lint/suspicious/noExplicitAny: no one cares
type AnyStep = Step<any, any, any, any, any[]>;
// biome-ignore lint/suspicious/noExplicitAny: no one cares
type Tail<Ts> = Ts extends [any, ...infer T] ? T : [];

type _ParentStepContexts<Ss extends AnyStep[], Current = never> = {
	empty: Current;
	nonempty: _ParentStepContexts<
		[...Tail<Ss>, ...Ss[0]["inputs"]],
		StepContext<Ss[0]["title"]> | Current
	>;
}[Ss extends [] ? "empty" : "nonempty"];
export type ParentStepContexts<S extends AnyStep> = _ParentStepContexts<
	S["inputs"]
>;

const CurrentTag: Context.TagClass<
	Current,
	string,
	{ readonly title: string }
> = Effect.Tag("@sprits/__current__")();

/**
 * The current executed step
 */
export class Current extends CurrentTag {}

const getDependencies = (s: AnyStep) =>
	Effect.gen(function* () {
		const dependencies = new Map<
			AnyStep,
			{
				deps: Set<AnyStep>;
				whenResolved: Deferred.Deferred<unknown, unknown>;
			}
		>();
		const stack = [s];
		const visited = new Set<AnyStep>();

		while (true) {
			const item = stack.pop();
			if (!item) break;
			visited.add(item);

			const current = dependencies.get(item) || {
				deps: new Set<AnyStep>(),
				whenResolved: yield* Deferred.make<unknown, unknown>(),
			};
			dependencies.set(item, current);

			for (const input of item.inputs) {
				current.deps.add(input);

				if (!visited.has(input)) {
					stack.push(input);
				}
			}
		}
		return dependencies;
	});

/**
 * Run a step and all of its dependencies
 */
export const run = <S extends AnyStep>(
	step: S,
): Effect.Effect<
	Effect.Effect.Success<S["run"]>,
	Effect.Effect.Error<S["run"]>,
	Exclude<Effect.Effect.Context<S["run"]>, ParentStepContexts<S>>
> =>
	Effect.gen(function* () {
		const dependencies = yield* getDependencies(step);
		let context = Context.empty();

		yield* Effect.forEach(
			dependencies,
			([step, { deps, whenResolved }]) =>
				Effect.gen(function* () {
					if (deps.size) {
						yield* Effect.forEach(
							deps,
							(dep) =>
								Effect.gen(function* () {
									const dependency = yield* Effect.fromNullable(
										dependencies.get(dep),
									).pipe(Effect.orDieWith(() => "Dependency not found?!"));
									yield* dependency.whenResolved;
								}).pipe(Effect.provide(context)),
							{
								discard: true,
							},
						);
					}

					yield* step.run.pipe(
						Effect.provide(context),
						Effect.tap((value) => {
							// @ts-expect-error meh
							const ctx = step[StepContextId];
							context = Context.add(context, ctx, value);
						}),
						Effect.onExit((exit) => Deferred.done(whenResolved, exit)),
						Effect.annotateLogs({ step: step.title }),
					);
				}),
			{ concurrency: "unbounded" },
		);

		return yield* Effect.fromNullable(dependencies.get(step)).pipe(
			Effect.orDie,
			Effect.andThen(
				(x) =>
					x.whenResolved as Deferred.Deferred<
						Effect.Effect.Success<S["run"]>,
						Effect.Effect.Error<S["run"]>
					>,
			),
		);
	});

export const toDot = (step: AnyStep): Effect.Effect<string, never, never> =>
	Effect.gen(function* () {
		const dependencies = yield* getDependencies(step);

		const graph = digraph((g) => {
			const nodes = {} as Record<string, NodeModel>;
			for (const [step] of dependencies) {
				nodes[step.title] = g.node(step.title);
			}
			for (const [step, { deps }] of dependencies) {
				for (const dep of deps) {
					g.edge([nodes[dep.title], nodes[step.title]]);
				}
			}
		});

		return toGraphvizDot(graph);
	});
