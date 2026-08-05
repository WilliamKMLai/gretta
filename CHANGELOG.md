# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Literature search results now cache on-device for 24 hours (ADR-028), so repeating a
  search with the same sources and filters is instant instead of a fresh network round
  trip. A new "Clear literature cache and search history" control in Settings deletes the
  cache outright, along with the in-progress query and results on screen.
- A "Recent searches" list in the Literature panel, built on that same cache, so past
  searches are browsable instead of only working invisibly behind the scenes. Clicking one
  restores its query and year filter and searches immediately — the row already shows the
  exact query, which is the same review ADR-028 requires before a fresh search is sent.
- The embedding model picker (Settings → Knowledge base) now also appears when Literature
  search is on, even with the knowledge base off — it was previously hidden in that case,
  the model it configures is required for literature ranking, and there was no way to see or
  fix it short of an opaque error at search time.
- Each literature result now shows a citation number (`[1]`, `[2]`, …), stable across the
  verified and collapsed limited-verification groups, so a specific result is easy to refer
  to while writing.
- A result's raw citation count (from OpenAlex, when available) is now shown as its own
  bolded, brand-colored line rather than sitting among the credibility badges, where it read
  as just another grey pill.
- A knowledge-base collection past the 30,000-excerpt fast-search ceiling now shows a
  warning explaining that retrieval will be slower and suggesting a split by topic (ADR-020),
  instead of silently degrading with no explanation. The ceiling is still advisory — indexing
  is never truncated, so nothing is silently left out of a collection's provenance.

### Fixed

- A literature cache hit skipped the network but still re-embedded the passage and every
  candidate through Ollama on every repeat search, leaving the perceived speedup negligible.
  An exact repeat — same query, sources, filters, and selected passage — now reuses the
  stored ranking outright with no embedding calls; a changed passage still re-ranks, since a
  stale ordering would be silently wrong.
- The "Searching…" status no longer claims to be checking retractions when that source is
  turned off.
- "Results per source" and the venue citation threshold, under Advanced search parameters,
  clamped on every keystroke, which snapped a typed value back to its minimum after the
  first digit whenever that digit alone was below it — typing `20` over `50` was impossible
  one digit at a time. Both are now spin buttons, which don't have this problem.
- The Search button could return a stale, cached result: changing an Advanced parameter that
  doesn't affect what's fetched (venue threshold, citation impact weight) and pressing Search
  again looked like nothing had happened, because a matching cache entry short-circuited the
  search before it re-ranked with the new setting. Search now always performs a fresh search;
  instant reuse of a past result is still available, but only by clicking it under
  "Recent searches."
- The citation-impact ranking nudge could boost a paper with _zero_ citations ahead of one with
  dozens: OpenAlex's same-year percentile is noisy early in a cohort year, when most other
  papers also have zero citations yet, and a paper can end up with a deceptively high percentile
  despite no demonstrated impact at all. Zero citations now always means zero boost, regardless
  of percentile.
- The same preprint cross-listed under multiple DOIs (e.g. deposited on more than one repository)
  could occupy several ranked positions at once and crowd out other results. Duplicate detection
  now also matches by normalized title, not DOI alone.

### Changed

- The grey "not checked" badges (registration, MEDLINE, venue) no longer repeat on every
  result when a source is off search-wide — that read as noise, not information. A single
  compact line now states which checks were skipped for the whole list; a genuinely per-record
  gap (e.g. one paper with no DOI while verification is otherwise on) still gets its own badge,
  since a search-wide note wouldn't cover it.
- The default "Results per source" is now 20, down from 50 — a lighter starting point given
  the cost in search time and embedding work; raise it per search from the Advanced panel
  when a topic needs a wider net.
- Literature ranking now gives a nudge to results with high citation impact for their
  publication year (OpenAlex), on top of relevance to your selection (ADR-029). This only
  breaks close calls — a clearly more relevant result still wins regardless of citations —
  so a well-established paper that ranked just outside the top few on relevance alone is more
  likely to surface near the top; it will not pull an unrelated but highly-cited paper into a
  search it doesn't belong in. How strong the nudge is is now a "Citation impact weight" field
  under Advanced search parameters (default 0.25, was a fixed 0.15); set it to 0 to turn it off.
- Knowledge-base retrieval is roughly 20x faster at collections near the 30,000-chunk capacity
  ceiling, and proportionally faster below it (ADR-020). Ranking now scans a single packed,
  pre-normalized matrix with a bare dot product instead of decoding every stored vector into a
  boxed array on every query. No reindex is required — existing collections benefit immediately.

## Initial feature set

No formal version has been released yet; this section groups the feature set built before
this changelog started tracking day-to-day changes individually.

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
