import { z } from 'zod';

/** App-owned timing data for one streamed audio segment. Times are segment-relative. */
export const voiceAlignmentSchema = z
  .object({
    characters: z.array(z.string()),
    startsMs: z.array(z.number().finite().nonnegative()),
    endsMs: z.array(z.number().finite().nonnegative()),
  })
  .strict()
  .superRefine((alignment, context) => {
    if (
      alignment.characters.length !== alignment.startsMs.length ||
      alignment.characters.length !== alignment.endsMs.length
    ) {
      context.addIssue({ code: 'custom', message: 'Alignment arrays must have equal lengths.' });
    }
  });

/** One line of the `/voice/speech` NDJSON response. */
export const voiceSpeechChunkSchema = z
  .object({
    audioBase64: z.string().min(1),
    alignment: voiceAlignmentSchema,
  })
  .strict();

export type VoiceSpeechChunk = z.infer<typeof voiceSpeechChunkSchema>;
