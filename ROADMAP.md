# GRETTA — Roadmap

GRETTA is a complete local writing assistant: generation, a prompt library, a local
knowledge base, generation history, and scholarly literature search, all running against
your own Ollama daemon with nothing else leaving the machine. This document covers what
has shipped so far and what comes after it. No formal version has been released yet.

Phase numbers below are stable labels referenced throughout [DECISIONS.md](DECISIONS.md) and
in commit history — they are kept for traceability, not because work is still in flight.
Every phase passed the full gate (`pnpm check`: typecheck · lint · format · test · build) and
was verified running live in Word before being marked shipped; see [CONTRIBUTING.md](CONTRIBUTING.md)
for the process a new phase follows.

---

## Shipped so far

- **Phases 1–8 — Core writing loop.** Model and prompt pickers, a prompt box with a
  document-context chip (selection, paragraph, or whole document), streaming generation with
  cancel, and result actions: Copy, Replace, Insert, Comment, Refine, export to Markdown/JSON.
- **A prompt library** — 12 built-in prompts across scientific writing, editing, style,
  grants, and communication, plus a custom-prompt editor.
- **Phase 11 — Local knowledge base (RAG)**, ADR-020. A local companion indexes folders of
  PDFs, Word files, and notes into named collections; retrieval feeds prompts with every
  excerpt cited, and the binding travels with the document.
- **Phase 12 — Generation history**, ADR-021. Every run is saved as a self-contained record
  you can reopen, export, or refine.
- **Phase 13 — Context budget & prompt assembly**, ADR-025. A self-calibrating token
  estimator, explicit budget allocation, and a deterministic trimming policy that never
  silently drops a cited excerpt.
- **Phase 14 — Output fidelity & pane polish**, ADR-026. Markdown output renders and inserts
  as clean prose instead of literal `**bold**`; settings reorganized; embedding-model
  filtering; the GRETTA brand mark.
- **Phase 15 — Literature discovery**, ADR-028–031. Search PubMed, Crossref, bioRxiv, and
  medRxiv (the latter two via Crossref, filtered by DOI prefix), with results re-ranked
  on-device against the passage you're writing, per-source credibility signals, and
  retraction/correction flagging. Off by default, opt-in per source — the one exception to
  "nothing leaves the machine," and only ever a query you've reviewed and approved.
- **Rebrand to GRETTA**, ADR-024, with a one-time adoption path so pre-rebrand settings,
  history, and knowledge-base bindings carry over.
- **Phase 17a — Images in prompts**, ADR-034. Attach, paste, or drop a figure and ask about
  it. One optional `visionModel` setting defaulting to the model you already use, with
  vision support detected via `/api/show` rather than guessed from the model name. Images
  are downscaled before sending and charged against the context budget.
- **Phase 17b — The figure in your document**, ADR-035. Read the selected figure out of the
  open document as OOXML and send it, with Windows metafiles (Excel charts, equations)
  detected and explained rather than silently skipped.
- **Phase 17c — Figures in the knowledge base**, ADR-036. Figures in indexed PDFs are found by
  their captions, rendered on demand with `@napi-rs/canvas` (so vector figures work), described
  in the background to improve retrieval, and attached to answers. Adds the companion's first
  schema-migration mechanism.

---

## What's next

### Phase 17d — Describe-all, with live progress

**Objective:** let a user pay the description cost up front when they want to.

**Scope:** a per-collection "Describe all figures now" action that walks the same on-demand path
over every figure, with the estimated cost shown before it starts (measured at ~16s a figure),
live progress, and cancel. This is finally the feature that justifies consuming the NDJSON
progress stream the companion has served since ADR-020 and nothing has ever read (ADR-037).

**Exit criteria:** a 50-figure collection can be described in one pass, cancelled safely, and
resumed without repeating work.

### Phase 16 — Citations & reference managers

**Objective:** turn provenance into real citations.

**Scope:** CSL-based citation and bibliography generation from literature metadata and
knowledge-base provenance; Zotero through its **local** HTTP API (localhost:23119 — no cloud
account); insert in-text citations and a reference list; style selection.

**Exit criteria:** a retrieved paper can be cited in a document with a correct formatted
reference and bibliography entry.

### Later, and conditional

Not scheduled. Each needs its own ADR, and several need evidence anyone wants them.

- **Model-agnostic backends** — llama.cpp directly, and OpenAI-compatible HTTP APIs. Bigger
  than a driver swap: the architecture assumes exactly one local peer (§13.5) and the privacy
  guarantees are built on it. Do this on demand, not on principle.
- **Word-native revision** — track changes and batch comments across a document. High value
  for the revision workflow and squarely in Office.js territory.
- **Plugin architecture** — deferred on purpose. Generalising from one provider produces a bad
  abstraction; revisit once phase 16 has produced a third real one to generalise from.
- **Ingesting found papers into the knowledge base** — literature search and the knowledge
  base currently run side by side; feeding search results into a collection is a natural next
  step but not yet built.
- **arXiv as its own source.** Currently covered indirectly through Crossref/OpenAlex
  metadata; a dedicated client isn't built.
- **Template engine**, **voice dictation**, **document-structure awareness** (sections,
  figures, tables).

### Explicitly not planned

Recorded so the scope question stops recurring.

- **Multi-turn chat.** ADR-021 replaced threads with generation records because the engine is
  single-shot and a thread implies continuity it does not have. Revisit only with evidence
  that "refine last result" is insufficient.
- **Syncing the knowledge-base index between machines.** ADR-024: the index is derived data
  tied to absolute paths, and a live SQLite file in a sync folder corrupts. Collections match
  by name instead — sync the source folder, not the index.
- **A browsable folder picker in the pane.** ADR-033: Office.js has no directory API and
  `showDirectoryPicker()` is absent under WKWebView, so the companion opens a native OS
  dialog instead — macOS and Windows only. A cross-platform in-pane browser would need an
  HTTP endpoint that enumerates the filesystem, which is a trust surface not worth adding;
  on Linux the path is typed, as it always was.
- **Bundling a model.** Users choose and manage their own through Ollama.
- **Telemetry.** No usage reporting, ever.
