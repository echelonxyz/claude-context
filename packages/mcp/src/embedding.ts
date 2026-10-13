import { OpenAIEmbedding, VoyageAIEmbedding, GeminiEmbedding, OllamaEmbedding } from "@zilliz/claude-context-core";
import { ContextMcpConfig } from "./config.js";

// Helper function to create embedding instance based on provider
export function createEmbeddingInstance(config: ContextMcpConfig): OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding  {
    console.log(`[EMBEDDING] Creating ${config.embeddingProvider} embedding instance...`);

    switch (config.embeddingProvider) {
        case 'OpenAI':
            if (!config.openaiApiKey) {
                console.error(`[EMBEDDING] ❌ OpenAI API key is required but not provided`);
                throw new Error('OPENAI_API_KEY is required for OpenAI embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring OpenAI with model: ${config.embeddingModel}`);
            const openaiEmbedding = new OpenAIEmbedding({
                apiKey: config.openaiApiKey,
                model: config.embeddingModel,
                ...(config.openaiBaseUrl && { baseURL: config.openaiBaseUrl })
            });
            console.log(`[EMBEDDING] ✅ OpenAI embedding instance created successfully`);
            return openaiEmbedding;

        case 'VoyageAI':
            if (!config.voyageaiApiKey) {
                console.error(`[EMBEDDING] ❌ VoyageAI API key is required but not provided`);
                throw new Error('VOYAGEAI_API_KEY is required for VoyageAI embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring VoyageAI with model: ${config.embeddingModel}`);
            const voyageEmbedding = new VoyageAIEmbedding({
                apiKey: config.voyageaiApiKey,
                model: config.embeddingModel
            });
            console.log(`[EMBEDDING] ✅ VoyageAI embedding instance created successfully`);
            return voyageEmbedding;

        case 'Gemini':
            if (!config.geminiApiKey) {
                console.error(`[EMBEDDING] ❌ Gemini API key is required but not provided`);
                throw new Error('GEMINI_API_KEY is required for Gemini embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring Gemini with model: ${config.embeddingModel}`);
            const geminiEmbedding = new GeminiEmbedding({
                apiKey: config.geminiApiKey,
                model: config.embeddingModel,
                ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl })
            });
            console.log(`[EMBEDDING] ✅ Gemini embedding instance created successfully`);
            return geminiEmbedding;

        case 'OpenRouter':
            if (!config.openrouterApiKey) {
                console.error(`[EMBEDDING] ❌ OpenRouter API key is required but not provided`);
                throw new Error('OPENROUTER_API_KEY is required for OpenRouter embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring OpenRouter with model: ${config.embeddingModel}`);
            // Reuse OpenAIEmbedding with OpenRouter's OpenAI-compatible endpoint
            const openrouterEmbedding = new OpenAIEmbedding({
                apiKey: config.openrouterApiKey,
                model: config.embeddingModel,
                baseURL: 'https://openrouter.ai/api/v1',
            });
            console.log(`[EMBEDDING] ✅ OpenRouter embedding instance created successfully`);
            return openrouterEmbedding;

        case 'Ollama':
            const ollamaHost = config.ollamaHost || 'http://127.0.0.1:11434';
            console.log(`[EMBEDDING] 🔧 Configuring Ollama with model: ${config.embeddingModel}, host: ${ollamaHost}${config.ollamaDimension ? `, dimension: ${config.ollamaDimension}` : ''}`);
            const ollamaEmbedding = new OllamaEmbedding({
                model: config.embeddingModel,
                host: ollamaHost,
                ...(config.ollamaDimension && { dimension: config.ollamaDimension })
            });
            console.log(`[EMBEDDING] ✅ Ollama embedding instance created successfully`);
            return ollamaEmbedding;

        default:
            console.error(`[EMBEDDING] ❌ Unsupported embedding provider: ${config.embeddingProvider}`);
            throw new Error(`Unsupported embedding provider: ${config.embeddingProvider}`);
    }
}

// One short query string embeds in well under a second on two CPU cores; past
// this the query host is wedged and the bulk embedder is the better bet.
const QUERY_EMBED_TIMEOUT_MS = 15_000;

/**
 * The embedder reserved for search queries, or undefined when none is
 * configured. Only Ollama has one: the hosted providers have no local queue for
 * a query to starve in. Same model as the bulk embedder, so the vectors share a
 * space; a short per-request timeout keeps a dead query host from stalling a
 * search before the fallback to the bulk embedder kicks in.
 */
export function createQueryEmbeddingInstance(config: ContextMcpConfig): OllamaEmbedding | undefined {
    if (config.embeddingProvider !== 'Ollama' || !config.ollamaQueryHost) {
        return undefined;
    }
    console.log(`[EMBEDDING] 🔧 Reserving query embedder at ${config.ollamaQueryHost}`);
    return new OllamaEmbedding({
        model: config.embeddingModel,
        host: config.ollamaQueryHost,
        requestTimeoutMs: QUERY_EMBED_TIMEOUT_MS,
        ...(config.ollamaDimension && { dimension: config.ollamaDimension })
    });
}

export function logEmbeddingProviderInfo(config: ContextMcpConfig, embedding: OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding): void {
    console.log(`[EMBEDDING] ✅ Successfully initialized ${config.embeddingProvider} embedding provider`);
    console.log(`[EMBEDDING] Provider details - Model: ${config.embeddingModel}, Dimension: ${embedding.getDimension()}`);

    // Log provider-specific configuration details
    switch (config.embeddingProvider) {
        case 'OpenAI':
            console.log(`[EMBEDDING] OpenAI configuration - API Key: ${config.openaiApiKey ? '✅ Provided' : '❌ Missing'}, Base URL: ${config.openaiBaseUrl || 'Default'}`);
            break;
        case 'VoyageAI':
            console.log(`[EMBEDDING] VoyageAI configuration - API Key: ${config.voyageaiApiKey ? '✅ Provided' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[EMBEDDING] Gemini configuration - API Key: ${config.geminiApiKey ? '✅ Provided' : '❌ Missing'}, Base URL: ${config.geminiBaseUrl || 'Default'}`);
            break;
        case 'OpenRouter':
            console.log(`[EMBEDDING] OpenRouter configuration - API Key: ${config.openrouterApiKey ? '✅ Provided' : '❌ Missing'}`);
            break;
        case 'Ollama':
            console.log(`[EMBEDDING] Ollama configuration - Host: ${config.ollamaHost || 'http://127.0.0.1:11434'}, Model: ${config.embeddingModel}${config.ollamaDimension ? `, Dimension: ${config.ollamaDimension}` : ''}`);
            break;
    }
}
