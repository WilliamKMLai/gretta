/** Persistence schema for prompt-size calibration (ADR-025). */
import { z } from 'zod';
import type { ZodType } from 'zod';

export interface PersistedCalibration {
  /** Model name → calibrated characters-per-token. */
  ratios: Record<string, number>;
}

export const persistedCalibrationSchema = z.object({
  ratios: z.record(z.string(), z.number()),
}) satisfies ZodType<PersistedCalibration>;
