// Recorded Jev answers for the bundled sample CSV (Replay mode).
// The fixture contains no keys, headers, or real data - all merchants are fictional.
// The hash lets Replay apply only when the sample's merchant summaries match.
import { z } from 'zod';

export const recordedJevSchema = z.object({
  fixture_version: z.number(),
  source: z.literal('sample-csv'),
  summaries_hash: z.string(),
  model: z.string(),
  recorded_response: z.object({
    model: z.string(),
    answers: z.record(z.string(), z.object({ type: z.string(), noul: z.number() })),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  }),
  request_log: z.object({
    question_count: z.number(),
    latency_ms: z.number(),
  }),
});

export type RecordedJevFixture = z.infer<typeof recordedJevSchema>;
