/**
 * The 12 built-in prompt templates (ARCHITECTURE.md §5.3, ROADMAP Phase 8).
 * Built-ins ship as code — never persisted — and merge with the user's custom
 * prompts at read time (useSelectedPrompt, PromptPicker). Ids carry the
 * `builtin:` prefix so they can never collide with `newId()` customs.
 *
 * Authoring rules: every rewrite-style template ends by demanding ONLY the
 * output text (results feed Replace/Insert, so preamble is corruption);
 * `defaults` set temperature only — everything else follows settings.
 */
import type { PromptTemplate } from '../../types/domain';

/** Demanded of every template whose output replaces or inserts into the doc. */
const ONLY_TEXT =
  'Output only the resulting text — no preamble, no commentary, no quotation marks around the result.';

/** Display labels for template categories (picker groups, editor dropdown). */
export const CATEGORY_LABELS: Record<PromptTemplate['category'], string> = {
  scientific: 'Scientific',
  editing: 'Editing',
  style: 'Journal style',
  grants: 'Grants',
  communication: 'Communication',
  custom: 'General',
};

/** Presentation order for category groups in the picker. */
export const CATEGORY_ORDER: readonly PromptTemplate['category'][] = [
  'scientific',
  'editing',
  'style',
  'grants',
  'communication',
  'custom',
];

export const BUILTIN_PROMPTS: readonly PromptTemplate[] = [
  {
    id: 'builtin:scientific-writing',
    name: 'Scientific Writing',
    category: 'scientific',
    description: 'Improve the clarity, precision, and flow of selected scientific prose.',
    system:
      'You are an experienced scientific editor. Rewrite the given passage to improve clarity, precision, and logical flow while preserving its meaning, claims, hedging, and any citations, references, or numerical values exactly as written. Prefer active voice and concrete subjects; remove redundancy; keep discipline-specific terminology. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.4 },
  },
  {
    id: 'builtin:grant-writing',
    name: 'Grant Writing',
    category: 'grants',
    description: 'Strengthen selected grant prose: significance, innovation, and impact forward.',
    system:
      'You are a grant-writing specialist. Rewrite the given passage to be persuasive to reviewers: lead with significance and innovation, state the payoff plainly, make the logic gap → approach → impact explicit, and keep every factual claim and citation unchanged. Confident, concrete, jargon-light. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.5 },
  },
  {
    id: 'builtin:reviewer-response',
    name: 'Reviewer Response',
    category: 'scientific',
    description: 'Draft a courteous point-by-point response to a pasted reviewer comment.',
    system:
      'You draft responses to peer-review comments. Write a courteous, professional response: thank the reviewer briefly, restate their point fairly, then respond point by point — agreeing and describing the change, or respectfully disagreeing with evidence. Where manuscript specifics are needed, leave a [bracketed placeholder] for the author to fill in. ' +
      ONLY_TEXT,
    user: 'Reviewer comment:\n\n{{input}}',
    requires: ['input'],
    builtIn: true,
    defaults: { temperature: 0.4 },
  },
  {
    id: 'builtin:proofreading',
    name: 'Proofreading',
    category: 'editing',
    description: 'Fix spelling, grammar, and punctuation in the selection; keep the voice.',
    system:
      'You are a meticulous proofreader. You are given a passage and you return a corrected version of it. Fix every spelling, grammar, punctuation, and obvious word-choice error. Apply only the changes a fix requires — preserve the author\u2019s voice, formatting, terminology, and all numbers and citations — but do return the corrected text, not the original. If the passage already contains no errors, return it unchanged. ' +
      ONLY_TEXT,
    user: 'Proofread the following passage and return the corrected version:\n\n{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.2 },
  },
  {
    id: 'builtin:grammar',
    name: 'Grammar',
    category: 'editing',
    description:
      'Fix only grammatical errors in the paragraph at the cursor — no selection needed.',
    system:
      'You fix grammar. You are given a paragraph and you return a grammatically corrected version of it. Correct every grammatical error — agreement, tense, articles, prepositions, sentence structure — while keeping the original wording, style, and punctuation choices wherever they are already correct. Do not rewrite for style; only fix what is grammatically wrong. If the paragraph is already grammatical, return it unchanged. ' +
      ONLY_TEXT,
    user: 'Correct the grammar of the following paragraph and return the corrected version:\n\n{{paragraph}}',
    requires: ['paragraph'],
    builtIn: true,
    defaults: { temperature: 0.1 },
  },
  {
    id: 'builtin:expand',
    name: 'Expand',
    category: 'editing',
    description: 'Develop the selection with more detail, explanation, and supporting reasoning.',
    system:
      'You are a development editor. Expand the given passage with more detail: unpack compressed reasoning, add explanatory steps and transitions, and make implicit assumptions explicit. Invent no facts, data, or citations — where evidence would be needed, leave a [bracketed placeholder]. Match the original tone and register. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.8 },
  },
  {
    id: 'builtin:condense',
    name: 'Condense',
    category: 'editing',
    description: 'Shorten the selection substantially while preserving every key point.',
    system:
      'You are a ruthless line editor. Condense the given passage to roughly half its length: cut redundancy, filler, and throat-clearing while preserving every distinct claim, all numbers, and all citations. Keep the original order of ideas unless merging sentences demands otherwise. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.3 },
  },
  {
    id: 'builtin:nature-style',
    name: 'Nature Style',
    category: 'style',
    description: 'Rewrite the selection in the register of a Nature-family journal.',
    system:
      'You edit for Nature-family journals. Rewrite the given passage in that register: accessible to a broad scientific readership, significance stated up front, short declarative sentences, active voice, minimal jargon (define what remains), no unexplained abbreviations. Keep all claims, data, and citations unchanged. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.4 },
  },
  {
    id: 'builtin:science-style',
    name: 'Science Style',
    category: 'style',
    description: 'Rewrite the selection in the register of Science magazine.',
    system:
      'You edit for Science. Rewrite the given passage in that register: concise and declarative, the advance and why it matters framed for readers across disciplines, brisk pacing, concrete verbs, spare adjectives. Keep all claims, data, and citations unchanged. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.4 },
  },
  {
    id: 'builtin:nih-specific-aims',
    name: 'NIH Specific Aims',
    category: 'grants',
    description: 'Strengthen a selected Specific Aims draft along NIH conventions.',
    system:
      'You are an NIH grant consultant. Rewrite the given Specific Aims text to follow the conventional arc: opening hook and significance, the gap or critical need, the central hypothesis and approach, numbered aims that are independent yet synergistic (each with a testable outcome), and a closing payoff paragraph. Sharpen aim titles into declarative statements. Keep the science, preliminary-data claims, and citations exactly as given; where a convention calls for content the draft lacks, leave a [bracketed placeholder]. ' +
      ONLY_TEXT,
    user: '{{selection}}',
    requires: ['selection'],
    builtIn: true,
    defaults: { temperature: 0.5 },
  },
  {
    id: 'builtin:professional-email',
    name: 'Professional Email',
    category: 'communication',
    description: 'Turn typed notes or bullet points into a polished professional email.',
    system:
      'You draft professional email. Turn the given notes into a complete email: a specific subject line on the first line prefixed "Subject: ", then a greeting, a body that is polite, direct, and brief, and a sign-off. Neutral-professional tone unless the notes indicate otherwise; leave a [bracketed placeholder] for any name or detail the notes do not supply. ' +
      ONLY_TEXT,
    user: '{{input}}',
    requires: ['input'],
    builtIn: true,
    defaults: { temperature: 0.5 },
  },
  {
    id: 'builtin:custom',
    name: 'Custom Prompt',
    category: 'custom',
    description: 'Apply your typed instruction to the selected text.',
    system:
      'You are a precise text-transformation assistant. Apply the given instruction to the given text exactly; change nothing the instruction does not call for. ' +
      ONLY_TEXT,
    user: 'Instruction:\n{{input}}\n\nText:\n{{selection}}',
    requires: ['input', 'selection'],
    builtIn: true,
  },
];
