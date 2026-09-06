import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1; // ENGINE.md §5: one bounded retry — the SDK's own policy only retries timeouts/5xx/429, never a plain 4xx

let client: OpenAI | undefined;
function getOpenAiClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAiClient();
  const response = await openai.embeddings.create(
    { model: EMBEDDING_MODEL, input: text },
    { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
  );
  return response.data[0].embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    throw new Error("cosineSimilarity: zero vector has no defined direction");
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
