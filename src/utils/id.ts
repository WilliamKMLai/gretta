/** Stable unique ids for domain entities (conversations, messages, prompts). */
export const newId = (): string => crypto.randomUUID();
