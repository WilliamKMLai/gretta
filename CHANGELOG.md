# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0]

Initial public release.

### Added

- Core writing loop: model and prompt pickers, a document-context chip (selection,
  paragraph, or whole document), streaming generation with cancel, and result actions
  (Copy, Replace, Insert, Comment, Refine, export to Markdown/JSON).
- A prompt library: 12 built-in prompts across scientific writing, editing, style, grants,
  and communication, plus a custom-prompt editor.
- A local knowledge base (RAG): index folders of PDFs, Word files, and notes on-device,
  with retrieved excerpts cited by file and page or paragraph, bound per-document.
- Generation history: every run saved as a self-contained, reopenable, exportable record.
- Context budgeting: a self-calibrating token estimator and deterministic trimming policy
  that never silently drops a cited excerpt.
- Markdown-aware output rendering and insertion.
- Scholarly literature search across PubMed, Crossref, bioRxiv, and medRxiv, re-ranked
  on-device with credibility signals and retraction/correction flagging — off by default,
  opt-in per source.
- A validated settings panel: Ollama connection, sampling parameters, context length,
  embedding model, and theming.

See [ROADMAP.md](ROADMAP.md) for what's planned next, and
[DECISIONS.md](DECISIONS.md) for the architectural reasoning behind each of the above.
