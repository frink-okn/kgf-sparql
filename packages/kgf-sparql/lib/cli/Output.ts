import { once } from 'node:events';
import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { AsyncIterator } from 'asynciterator';
import { TransformIterator } from 'asynciterator';
import type { RunAccount } from './Budget';

/**
 * Short names for the media types of Comunica's result serializers. Any media type the
 * engine knows may also be given verbatim; the engine's own serializers write every format.
 */
export const FORMATS: Record<string, string> = {
  srj: 'application/sparql-results+json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/sparql-results+xml',
  nt: 'application/n-triples',
  nq: 'application/n-quads',
  ttl: 'text/turtle',
  jsonld: 'application/ld+json',
};

/** SPARQL Results JSON by default, because `kgfq` and the corpus scripts read it; N-Triples for quads. */
export function mediaTypeFor(format: string | undefined, resultType: string): string {
  if (format === undefined) {
    return resultType === 'quads' ? FORMATS.nt : FORMATS.srj;
  }
  return FORMATS[format] ?? format;
}

/**
 * Results go to a file, never to a pipe: Node truncates unflushed writes at exit and pipes
 * cap at 64 KB. `close` returns once the descriptor is closed, so nothing written is lost.
 */
export class FileSink {
  private failure?: Error;

  private constructor(public readonly stream: fs.WriteStream) {
    stream.on('error', (error: Error) => {
      this.failure = error;
    });
  }

  /** Opens the file before the query runs, so an unwritable path fails before the work, not after it. */
  public static async open(path: string): Promise<FileSink> {
    const stream = fs.createWriteStream(path);
    await once(stream, 'open');
    return new FileSink(stream);
  }

  public async close(): Promise<void> {
    if (!this.stream.writableEnded) {
      this.stream.end();
    }
    if (!this.stream.closed) {
      await once(this.stream, 'close');
    }
    if (this.failure) {
      throw this.failure;
    }
  }
}

/**
 * Counts rows on their way to the serializer and ends the stream cleanly at the row budget,
 * so the serializer closes its document and the rows before the budget are a well-formed file.
 */
export class BudgetIterator<T> extends TransformIterator<T, T> {
  public constructor(source: AsyncIterator<T>, private readonly account: RunAccount) {
    super(source, { autoStart: false });
    // Destroying the result destroys the operators feeding it, so an abort also stops work
    // the engine is doing from memory, which no request signal reaches. After the row
    // budget, the stream has already ended and this does nothing.
    account.signal.addEventListener('abort', () => this.destroy(), { once: true });
  }

  protected override _transform(item: T, done: () => void, push: (item: T) => void): void {
    if (this.account.countRow()) {
      push(item);
    } else {
      this.close();
    }
    done();
  }
}

/**
 * Pipes serialized output to the file with backpressure. A budget abort fails or destroys the
 * source, never the file, so what was written before the abort is flushed and kept.
 */
export async function pump(data: NodeJS.ReadableStream, sink: FileSink, account: RunAccount): Promise<void> {
  const readable = <Readable> data;
  readable.pipe(sink.stream, { end: false });
  const stop = (): void => {
    readable.destroy();
  };
  account.signal.addEventListener('abort', stop, { once: true });
  try {
    await finished(readable);
  } catch (error: unknown) {
    // A run the account ended surfaces here as the stream's error; the account says why.
    if (!account.exceeded && !account.signal.aborted) {
      throw error;
    }
  } finally {
    account.signal.removeEventListener('abort', stop);
  }
}
