# Built-in prompt library

GRETTA ships 12 prompt templates. They live in code
(`src/features/prompts/builtins.ts`), never in storage — see
[ADR-015](../DECISIONS.md#adr-015--prompt-library-built-ins-ship-as-code-template-semantics-live-in-one-module).
Editing one is a code change; there is no migration and no per-user copy to
drift. Your own templates live alongside them under **My prompts** in the
picker and _are_ persisted.

> Keep this file in sync whenever `builtins.ts` changes — it ships in every
> phase delivery as the human-readable companion to the code.

## How to read this

Each template declares **what it needs from the document** before it will run.
GRETTA checks that requirement _before_ any network call, so an empty
selection gets you a friendly message rather than a wasted generation.

| Requirement | Where it comes from                                     |
| ----------- | ------------------------------------------------------- |
| `selection` | The text you have highlighted in Word                   |
| `paragraph` | The paragraph your cursor sits in — no highlight needed |
| `document`  | The whole document body                                 |
| `input`     | What you type into the prompt box                       |

**Temperature** is the only generation setting a built-in overrides; topP,
topK, seed, and context length always follow your Settings. Low values keep
the model literal and predictable, high values give it room to invent. Every
rewrite template also ends with an instruction to return _only_ the resulting
text — no preamble, no commentary, no wrapping quotation marks — because the
result feeds **Replace** and **Insert**, where a chatty "Sure! Here's your
revised paragraph:" would corrupt your document.

Where a template would need a fact it hasn't been given, it is instructed to
leave a `[bracketed placeholder]` rather than invent one. Treat any bracket in
the output as a to-do.

## Quick reference

| Prompt             | Category      | Needs             | Temp | One-line purpose                             |
| ------------------ | ------------- | ----------------- | ---- | -------------------------------------------- |
| Scientific Writing | Scientific    | selection         | 0.4  | Clearer, more precise scientific prose       |
| Grant Writing      | Grants        | selection         | 0.5  | Make the case persuasive to reviewers        |
| Reviewer Response  | Scientific    | input             | 0.4  | Draft a reply to a peer-review comment       |
| Proofreading       | Editing       | selection         | 0.2  | Fix errors, keep the voice                   |
| Grammar            | Editing       | paragraph         | 0.1  | Grammar only, on the paragraph at the cursor |
| Expand             | Editing       | selection         | 0.8  | Develop the reasoning in more detail         |
| Condense           | Editing       | selection         | 0.3  | Cut to roughly half, keep every claim        |
| Nature Style       | Journal style | selection         | 0.4  | Rewrite in the Nature-family register        |
| Science Style      | Journal style | selection         | 0.4  | Rewrite in the _Science_ register            |
| NIH Specific Aims  | Grants        | selection         | 0.5  | Restructure Aims along NIH conventions       |
| Professional Email | Communication | input             | 0.5  | Turn notes into a complete email             |
| Custom Prompt      | General       | input + selection | —    | Apply your own instruction to selected text  |

---

## Scientific Writing

**Needs a selection · temperature 0.4 · `builtin:scientific-writing`**

Rewrites the highlighted passage for clarity, precision, and logical flow
without changing what it says. Prefers active voice and concrete subjects,
removes redundancy, and keeps discipline-specific terminology rather than
plain-Englishing it away.

Preserves your claims, your hedging (an "may suggest" does not get promoted to
"demonstrates"), and every citation and numeric value verbatim. This is the
general-purpose choice when a paragraph is correct but reads badly.

## Grant Writing

**Needs a selection · temperature 0.5 · `builtin:grant-writing`**

Rewrites the passage to be persuasive to a review panel: leads with
significance and innovation, states the payoff plainly, and makes the
gap → approach → impact logic explicit rather than implied. Aims for
confident, concrete, jargon-light prose.

Facts and citations are held constant — it sharpens the framing, not the
science.

## Reviewer Response

**Needs typed input · temperature 0.4 · `builtin:reviewer-response`**

The one that doesn't read your document. Paste a reviewer's comment into the
prompt box and it drafts a courteous reply: a brief thank-you, a fair
restatement of their point, then a point-by-point response — either agreeing
and describing the change made, or disagreeing respectfully with evidence.

Because it can't see your manuscript, anything requiring specifics (page
numbers, what you actually changed, which figure) comes back as a
`[bracketed placeholder]` for you to fill in.

## Proofreading

**Needs a selection · temperature 0.2 · `builtin:proofreading`**

Corrects spelling, grammar, punctuation, and obvious word-choice errors —
and stops there. It applies only the changes a fix requires, so your voice,
formatting, terminology, numbers, and citations survive intact, and it returns
the corrected passage rather than a rewrite.

Low temperature by design: you want the same conservative correction every
time, not a creative reinterpretation. If the passage is already clean it
comes back unchanged — which is correct behavior, not a failure to run.

## Grammar

**Needs a paragraph — no selection · temperature 0.1 · `builtin:grammar`**

The narrowest template, and the only one that works from the paragraph your
**cursor** sits in rather than a highlight. Put the cursor anywhere in a
sentence and run it.

Fixes agreement, tense, articles, prepositions, and sentence structure —
nothing else — and returns the corrected paragraph. It won't rewrite for
style, so a grammatical-but-clumsy sentence keeps its wording; if you want
clumsy fixed, use Proofreading or Scientific Writing. A paragraph that is
already grammatical comes back unchanged.

## Expand

**Needs a selection · temperature 0.8 · `builtin:expand`**

Develops a compressed passage: unpacks reasoning, adds explanatory steps and
transitions, and makes implicit assumptions explicit. Matches the original
tone and register rather than switching to a chattier voice.

The highest temperature in the library, because this is the one genuinely
generative task. It is nevertheless instructed to invent no facts, data, or
citations — where evidence would be needed, you get a `[bracketed
placeholder]`. Read its output more carefully than the others.

## Condense

**Needs a selection · temperature 0.3 · `builtin:condense`**

Cuts the passage to roughly half its length: redundancy, filler, and
throat-clearing go, while every distinct claim, all numbers, and all citations
stay. Keeps the original order of ideas unless merging sentences forces a
change.

The tool for a paragraph that's 340 words against a 200-word limit.

## Nature Style

**Needs a selection · temperature 0.4 · `builtin:nature-style`**

Rewrites into the register of a Nature-family journal: accessible to a broad
scientific readership, significance stated up front, short declarative
sentences, active voice, minimal jargon with whatever remains defined, and no
unexplained abbreviations.

Claims, data, and citations are unchanged — this is a register change, not an
edit to the substance.

## Science Style

**Needs a selection · temperature 0.4 · `builtin:science-style`**

The sibling of Nature Style, tuned to _Science_: concise and declarative, the
advance and why it matters framed for readers across disciplines, brisk
pacing, concrete verbs, spare adjectives.

The two overlap considerably. Run both on the same paragraph and take the one
you prefer — that's a cheaper decision than theorizing about house style.

## NIH Specific Aims

**Needs a selection · temperature 0.5 · `builtin:nih-specific-aims`**

Restructures a Specific Aims draft along the conventional arc: opening hook
and significance → the gap or critical need → central hypothesis and approach
→ numbered aims that are independent yet synergistic, each with a testable
outcome → a closing payoff paragraph. Aim titles get sharpened into
declarative statements.

Your science, preliminary-data claims, and citations are preserved. Where the
convention calls for something your draft doesn't contain, you get a
`[bracketed placeholder]` rather than an invented rationale.

## Professional Email

**Needs typed input · temperature 0.5 · `builtin:professional-email`**

The second template that ignores your document. Type notes or bullet points
into the prompt box and it returns a complete email: a specific subject line
on the first line prefixed `Subject: `, a greeting, a polite and direct body,
and a sign-off.

Neutral-professional tone unless your notes indicate otherwise. Names and
details you didn't supply come back bracketed.

## Custom Prompt

**Needs typed input _and_ a selection · no temperature override · `builtin:custom`**

A one-off transformation without saving a template. Highlight text, type an
instruction ("convert to past tense", "make this a bulleted list", "rewrite
for a lay audience"), and it applies exactly that — changing nothing the
instruction doesn't call for.

The only built-in with no temperature default, so it runs at whatever your
Settings specify. If you find yourself typing the same instruction repeatedly,
that's the signal to save it as a custom prompt instead.

---

## Writing your own

**Prompt ▾ → New prompt…** opens the editor. A custom prompt has the same
shape as a built-in: a system prompt, a user template, and a set of
requirements.

Use `{{selection}}`, `{{paragraph}}`, `{{document}}`, and `{{input}}` as
placeholders in either the system prompt or the user template. Substitution is
literal — a placeholder inside your selected text stays literal text and is
never re-scanned. The editor names any token that won't interpolate, including
near-misses like `{{ selection }}` (spaces are not trimmed) and `{{selektion}}`.

Tick a variable under **Requires before running** to make GRETTA check it is
non-empty before generating. A template can reference a variable without
requiring it — useful when empty is an acceptable input.

Set a temperature default only if the task genuinely calls for one; leaving it
empty follows your Settings, which is usually what you want. If you're
adapting a built-in, copying its system prompt — including the closing
"output only the resulting text" instruction — is a reasonable starting point.
