import { Context, Deferred, Effect, Effectable } from "effect";
import { type NodeModel, digraph, toDot as toGraphvizDot } from "ts-graphviz";

// biome-ignore lint/suspicious/noExplicitAny: it's a helper
type SuppressError<Reason> = any | Reason;
// biome-ignore lint/suspicious/noExplicitAny: this allows us to extend anything
type AnyGeneric = any;

const StepContextId = Symbol("StepContextId");

type ConstructionError<Inputs extends AnyStep[], R> = [
	{
		[key in keyof Inputs]: Inputs[key]["title"];
	}[Extract<keyof Inputs, number>],
	Extract<R, StepContext<string>>,
] extends [infer Provided, StepContext<infer Requested>]
	? Exclude<Requested, Provided> extends never
		? never
		: string extends Requested
			? never
			: `undeclared step input ${Exclude<Requested, Provided>}`
	: Inputs;

class StepClass<
	Title extends string,
	Inputs extends AnyStep[],
	A,
	E,
	R,
> extends Effectable.Class<A, never, StepContext<Title>> {
	public run: Effect.Effect<A, E, R>;

	constructor(
		public title: Title,
		public inputs: Inputs,
		run: Effect.Effect<A, E, R>,
	) {
		super();
		const spanContext: StepContext<Title> = `@sprits/${title}`;
		this[StepContextId] = class Ctx extends (
			Context.Tag(spanContext)<StepContext<Title>, A>()
		) {};
		this.run = Effect.provideService(run as Effect.Effect<A, E, R>, Current, {
			title,
		});
	}

	public [StepContextId]: Context.Tag<StepContext<Title>, A>;

	commit(): Effect.Effect<A, never, StepContext<Title>> {
		return this[StepContextId];
	}
}

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
	return new StepClass(
		opts.title,
		opts.inputs,
		opts.run as Effect.Effect<A, E, R>,
	);
}

interface Step<Title extends string, A, E, R, Inputs extends AnyStep[]>
	extends Effect.Effect<A, never, StepContext<Title>> {
	title: Title;
	readonly inputs: Inputs;
	run: Effect.Effect<A, E, R>;
}

type StepContext<Title extends string> = `@sprits/${Title}`;

type AnyStep = Step<
	AnyGeneric,
	AnyGeneric,
	AnyGeneric,
	AnyGeneric,
	AnyGeneric[]
>;
type Tail<Ts> = Ts extends [AnyGeneric, ...infer T] ? T : [];

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

type AllNonStepDependencies<Inputs extends AnyStep[], Result = never> = {
	empty: Exclude<Result, StepContext<string> | Current>;
	nonempty: AllNonStepDependencies<
		[...Tail<Inputs>, ...Inputs[0]["inputs"]],
		Result | Effect.Effect.Context<Inputs[0]["run"]>
	>;
}[Inputs extends [] ? "empty" : "nonempty"];

/**
 * Run a step and all of its dependencies
 */
export const run = <const S extends AnyStep>(
	step: S,
): Effect.Effect<
	Effect.Effect.Success<S["run"]>,
	Effect.Effect.Error<S["run"]>,
	| Exclude<Effect.Effect.Context<S["run"]>, ParentStepContexts<S>>
	| AllNonStepDependencies<[S]>
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
	}) as SuppressError<"TypeScript complains that Effect.gen is inferring stuff here. We don't really need that.'">;

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
