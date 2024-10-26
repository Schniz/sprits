import { Context, Deferred, Effect } from "effect";
import { type NodeModel, digraph, toDot as toGraphvizDot } from "ts-graphviz";

type ConstructionError<Inputs extends AnyStep[], R> = [
	{
		[key in keyof Inputs]: Inputs[key]["name"];
	}[Extract<keyof Inputs, number>],
	R,
] extends [infer Provided, StepContext<infer Requested>]
	? Exclude<Requested, Provided> extends never
		? never
		: string extends Requested
			? never
			: `undeclared step input ${Requested}`
	: never;

const ConstructionError = Symbol("ConstructionError");

export function make<
	const Name extends string,
	const Inputs extends AnyStep[],
	A,
	E,
	R,
	CE = ConstructionError<Inputs, R>,
>(
	...[opts]: [CE] extends [never]
		? [Omit<Step<Name, A, E, R | Current, Inputs>, "read">]
		: [
				Omit<Step<Name, A, E, R | Current, Inputs>, "read"> & {
					run: Step<Name, A, E, R | Current, Inputs>["run"] & [CE];
				},
			]
): Step<Name, A, E, R, Inputs> {
	const run = opts.run.pipe(
		Effect.provideService(Current, { title: String(opts.name) }),
	);
	return {
		...opts,
		run,
		read: Context.GenericTag<StepContext<Name>, A>(`step/${opts.name}`),
		// biome-ignore lint/suspicious/noExplicitAny: you are not my father
	} as any;
}

interface Step<Name extends string, A, E, R, Inputs extends AnyStep[]> {
	name: Name;
	readonly inputs: Inputs;
	run: Effect.Effect<A, E, R>;
	read: Effect.Effect<A, E, StepContext<Name>>;
}

type StepContext<Name extends string> = `step/${Name}`;

// biome-ignore lint/suspicious/noExplicitAny: no one cares
type AnyStep = Step<any, any, any, any, any[]>;
// biome-ignore lint/suspicious/noExplicitAny: no one cares
type Tail<Ts> = Ts extends [any, ...infer T] ? T : [];

type _ParentStepContexts<Ss extends AnyStep[], Current = never> = {
	empty: Current;
	nonempty: _ParentStepContexts<
		[...Tail<Ss>, ...Ss[0]["inputs"]],
		StepContext<Ss[0]["name"]> | Current
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
							const ctx = step.read as Context.Tag<unknown, unknown>;
							context = Context.add(context, ctx, value);
						}),
						Effect.onExit((exit) => Deferred.done(whenResolved, exit)),
						Effect.annotateLogs({ step: step.name }),
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
