import type { MediatorHttp } from '@comunica/bus-http';
import type { MediatorMergeBindingsContext } from '@comunica/bus-merge-bindings-context';
import type { IActionQuerySourceIdentify, IActorQuerySourceIdentifyArgs, IActorQuerySourceIdentifyOutput } from '@comunica/bus-query-source-identify';
import { ActorQuerySourceIdentify } from '@comunica/bus-query-source-identify';
import type { IActorTest, TestResult } from '@comunica/core';
/** Identifies explicitly typed KGF sources without fetching any fragment or statistics. */
export declare class ActorQuerySourceIdentifyKgf extends ActorQuerySourceIdentify {
    readonly mediatorHttp: MediatorHttp;
    readonly mediatorMergeBindingsContext: MediatorMergeBindingsContext;
    constructor(args: IActorQuerySourceIdentifyKgfArgs);
    test(action: IActionQuerySourceIdentify): Promise<TestResult<IActorTest>>;
    run(action: IActionQuerySourceIdentify): Promise<IActorQuerySourceIdentifyOutput>;
}
export interface IActorQuerySourceIdentifyKgfArgs extends IActorQuerySourceIdentifyArgs {
    /** Mediator for HTTP, including the caller's fetch, authentication and timeout settings. */
    mediatorHttp: MediatorHttp;
    /** Mediator for creating binding context merge handlers. */
    mediatorMergeBindingsContext: MediatorMergeBindingsContext;
}
//# sourceMappingURL=ActorQuerySourceIdentifyKgf.d.ts.map