import type { MediatorHttp } from '@comunica/bus-http';
import type { MediatorMergeBindingsContext } from '@comunica/bus-merge-bindings-context';
import type {
  IActionQuerySourceIdentify, IActorQuerySourceIdentifyArgs, IActorQuerySourceIdentifyOutput,
} from '@comunica/bus-query-source-identify';
import { ActorQuerySourceIdentify } from '@comunica/bus-query-source-identify';
import { KeysInitQuery } from '@comunica/context-entries';
import type { IActorTest, TestResult } from '@comunica/core';
import { ActionContext, failTest, passTestVoid } from '@comunica/core';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { QuerySourceKgf } from './QuerySourceKgf';

/** Identifies explicitly typed KGF sources without fetching any fragment or statistics. */
export class ActorQuerySourceIdentifyKgf extends ActorQuerySourceIdentify {
  public readonly mediatorHttp: MediatorHttp;
  public readonly mediatorMergeBindingsContext: MediatorMergeBindingsContext;

  public constructor(args: IActorQuerySourceIdentifyKgfArgs) {
    super(args);
    this.mediatorHttp = args.mediatorHttp;
    this.mediatorMergeBindingsContext = args.mediatorMergeBindingsContext;
  }

  public async test(action: IActionQuerySourceIdentify): Promise<TestResult<IActorTest>> {
    if (action.querySourceUnidentified.type !== 'kgf' || typeof action.querySourceUnidentified.value !== 'string') {
      return failTest(`${this.name} requires a URL source with type 'kgf'`);
    }
    return passTestVoid();
  }

  public async run(action: IActionQuerySourceIdentify): Promise<IActorQuerySourceIdentifyOutput> {
    const dataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    return {
      querySource: {
        source: new QuerySourceKgf(
          <string> action.querySourceUnidentified.value,
          this.mediatorHttp,
          dataFactory,
          await BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory),
        ),
        context: action.querySourceUnidentified.context ?? new ActionContext(),
      },
    };
  }
}

export interface IActorQuerySourceIdentifyKgfArgs extends IActorQuerySourceIdentifyArgs {
  /** Mediator for HTTP, including the caller's fetch, authentication and timeout settings. */
  mediatorHttp: MediatorHttp;
  /** Mediator for creating binding context merge handlers. */
  mediatorMergeBindingsContext: MediatorMergeBindingsContext;
}
