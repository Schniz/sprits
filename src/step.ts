import { Context, Deferred, Effect } from "effect";
import { type NodeModel, digraph, toDot as toGraphvizDot } from "ts-graphviz";

export const make = <
	const Name extends string,
	A,
	E,
	R,
	const Inputs extends AnyStep[],
>(
	opts: Omit<Step<Name, A, E, R, Inputs>, "read">,
): Step<Name, A, E, R, Inputs> => {
	return {
		...opts,
		read: Context.GenericTag<StepContext<Name>, A>(`step/${opts.name}`),
	};
};

interface Step<Name extends string, A, E, R, Inputs extends AnyStep[]> {
	name: Name;
	readonly inputs: Inputs;
	run: Effect.Effect<A, E, R>;
	read: Effect.Effect<A, E, StepContext<Name> | R>;
}

type StepContext<Name extends string> = `step/${Name}`;

// biome-ignore lint/suspicious/noExplicitAny: no one cares
type AnyStep = Step<any, any, any, any, any[]>;
// biome-ignore lint/suspicious/noExplicitAny: no one cares
type Tail<Ts> = Ts extends [any, ...infer T] ? T : [];

type _ParentStepContexts<Ss extends AnyStep[], Current = never> = {
	empty: Current;
	nonempty: _ParentStepContexts<Tail<Ss>, StepContext<Ss[0]["name"]> | Current>;
}[Ss extends [] ? "empty" : "nonempty"];
type ParentStepContexts<S extends AnyStep> = _ParentStepContexts<S["inputs"]>;

const getDependencies = (s: AnyStep) =>
	Effect.gen(function* () {
		const dependencies = new Map<
			AnyStep,
			{ deps: Set<AnyStep>; whenResolved: Deferred.Deferred<unknown, unknown> }
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

export const run = <S extends AnyStep>(
	step: S,
): Effect.Effect<
	Effect.Effect.Success<S["run"]>,
	Effect.Effect.Error<S["run"]>,
	Exclude<Effect.Effect.Context<S["run"]>, ParentStepContexts<S>>
> =>
	// @ts-expect-error
	Effect.gen(function* () {
		yield* Effect.yieldNow();
		const dependencies = yield* getDependencies(step);

		yield* Effect.forEach(
			dependencies,
			([step, { deps, whenResolved }]) =>
				Effect.gen(function* () {
					let context = Context.empty();

					if (deps.size) {
						yield* Effect.forEach(
							deps,
							(dep) =>
								Effect.gen(function* () {
									const dependency = yield* Effect.fromNullable(
										dependencies.get(dep),
									).pipe(Effect.orDieWith(() => "Dependency not found?!"));
									const value = yield* dependency.whenResolved;
									const ctx = dep.read as Context.Tag<unknown, unknown>;
									context = Context.add(context, ctx, value);
								}),
							{
								discard: true,
							},
						);
					}

					yield* step.run.pipe(
						Effect.provide(context),
						Effect.onExit((exit) => Deferred.done(whenResolved, exit)),
						Effect.annotateLogs({ step: step.name }),
					);
				}),
			{ concurrency: "unbounded" },
		);
	});

export const toDot = (step: AnyStep) =>
	Effect.gen(function* () {
		const dependencies = yield* getDependencies(step);

		const graph = digraph((g) => {
			const nodes = {} as Record<string, NodeModel>;
			for (const [step] of dependencies) {
				nodes[step.name] = g.node(step.name);
			}
			for (const [step, { deps }] of dependencies) {
				for (const dep of deps) {
					g.edge([nodes[dep.name], nodes[step.name]]);
				}
			}
		});

		return toGraphvizDot(graph);
	});
