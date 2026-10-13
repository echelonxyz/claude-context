import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';

class RecordingEmbedding extends Embedding {
    protected maxTokens = 8192;
    calls: string[] = [];

    constructor(private readonly name: string, private readonly fail = false) {
        super();
    }

    async detectDimension(): Promise<number> { return 3; }

    async embed(text: string): Promise<EmbeddingVector> {
        this.calls.push(text);
        if (this.fail) throw new Error(`${this.name} unreachable`);
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map(t => this.embed(t)));
    }

    getDimension(): number { return 3; }
    getProvider(): string { return this.name; }
}

describe('Context.embedQuery', () => {
    const previous = process.env.EMBEDDING_CACHE;
    beforeAll(() => { process.env.EMBEDDING_CACHE = 'false'; });
    afterAll(() => {
        if (previous === undefined) delete process.env.EMBEDDING_CACHE;
        else process.env.EMBEDDING_CACHE = previous;
    });

    it('embeds queries on the reserved query embedder, leaving the bulk one alone', async () => {
        const bulk = new RecordingEmbedding('bulk');
        const query = new RecordingEmbedding('query');
        const context = new Context({ embedding: bulk, queryEmbedding: query, vectorDatabase: {} as any });

        await context.embedQuery('where do we gate reads');

        expect(query.calls).toEqual(['where do we gate reads']);
        expect(bulk.calls).toEqual([]);
    });

    it('falls back to the bulk embedder when the query embedder fails', async () => {
        const bulk = new RecordingEmbedding('bulk');
        const query = new RecordingEmbedding('query', true);
        const context = new Context({ embedding: bulk, queryEmbedding: query, vectorDatabase: {} as any });

        const vector = await context.embedQuery('q');

        expect(vector.vector).toEqual([1, 0, 0]);
        expect(query.calls).toEqual(['q']);
        expect(bulk.calls).toEqual(['q']);
    });

    it('uses the bulk embedder when no query embedder is configured', async () => {
        const bulk = new RecordingEmbedding('bulk');
        const context = new Context({ embedding: bulk, vectorDatabase: {} as any });

        await context.embedQuery('q');

        expect(bulk.calls).toEqual(['q']);
    });
});
