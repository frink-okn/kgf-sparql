import type * as RDF from '@rdfjs/types';
import { BufferedIterator } from 'asynciterator';

/** Pulls rows only on demand, while allowing metadata to resolve independently. */
export class LazyQuadIterator extends BufferedIterator<RDF.Quad> {
  public readonly abortController = new AbortController();
  private rows?: AsyncGenerator<RDF.Quad>;

  public constructor(private readonly generate: (signal: AbortSignal) => AsyncGenerator<RDF.Quad>) {
    super({ autoStart: false, maxBufferSize: 1 });
  }

  protected override _read(count: number, done: () => void): void {
    void (async() => {
      this.rows ??= this.generate(this.abortController.signal);
      for (let i = 0; i < count && !this.done; i++) {
        const row = await this.rows.next();
        if (this.done) {
          break;
        }
        if (row.done) {
          this.close();
          break;
        }
        this._push(row.value);
      }
    })().then(done, (error: Error) => { this.destroy(error); done(); });
  }

  protected override _destroy(cause: Error | undefined, callback: (error?: Error) => void): void {
    this.abortController.abort();
    void this.rows?.return(undefined).catch(() => {});
    super._destroy(cause, callback);
  }
}
