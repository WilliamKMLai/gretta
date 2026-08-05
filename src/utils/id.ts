/** Stable unique ids for domain entities (generation records, prompts). */
export const newId = (): string => crypto.randomUUID();
