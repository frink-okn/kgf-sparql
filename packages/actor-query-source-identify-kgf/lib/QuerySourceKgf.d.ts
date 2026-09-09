import type { MediatorHttp } from '@comunica/bus-http';
import type { BindingsStream, ComunicaDataFactory, FragmentSelectorShape, IActionContext, IQueryBindingsOptions, IQuerySource } from '@comunica/types';
import { Algebra } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
/** Native KGF JSON triple source. Its published union is the SPARQL default graph. */
export declare class QuerySourceKgf implements IQuerySource {
    readonly referenceValue: string;
    private readonly mediatorHttp;
    private readonly dataFactory;
    private readonly bindingsFactory;
    private readonly clients;
    private readonly selectorShape;
    constructor(referenceValue: string, mediatorHttp: MediatorHttp, dataFactory: ComunicaDataFactory, bindingsFactory: BindingsFactory);
    getFilterFactor(): Promise<number>;
    getSelectorShape(): Promise<FragmentSelectorShape>;
    toString(): string;
    queryBindings(operation: Algebra.Operation, context: IActionContext, options?: IQueryBindingsOptions): BindingsStream;
    private client;
    private prepare;
    private readPages;
    queryQuads(_operation: Algebra.Operation, _context: IActionContext): AsyncIterator<RDF.Quad>;
    queryBoolean(_operation: Algebra.Ask, _context: IActionContext): Promise<boolean>;
    queryVoid(_operation: Algebra.Operation, _context: IActionContext): Promise<void>;
}
//# sourceMappingURL=QuerySourceKgf.d.ts.map