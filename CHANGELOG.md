# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Literature sources are now queried in parallel rather than one after another, so a search
  takes about as long as the slowest source instead of the sum of all four (ADR-032). A
  source that fails no longer discards the results from the ones that succeeded: the pane
  shows what did arrive plus a warning naming the source that did not, and only a
  total failure of every enabled source is reported as an error. Enrichment and the
  retraction check run together for the same reason; a failed retraction lookup leaves
  results marked "not checked" rather than implying they are clean.
- A Cancel button in the Literature panel, shown while a search or a query draft is running.
  A search fans out across four scholarly APIs, then enriches, then checks retractions, then
  ranks locally; until now the only way out of one was to reload the pane. Cancelling is
  treated as a decision rather than a failure: the pane returns to idle with no error banner,
  results already on screen are left alone, and the cancelled search is not recorded under
  "Recent searches". A run that is stopped or superseded can no longer paint its results over
  a later one that the user actually wanted.
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

- Citation count barely affected literature ranking, because the signal behind it was
  usually missing. Ranking read OpenAlex's `citedByPercentileYear`, which is null for most
  preprints and recent deposits, and treated null as zero impact — so a 2025 preprint with
  59 citations and a 2026 deposit with none both scored zero and the boost cancelled out.
  Impact is now derived from the raw citation count on a log curve, which is present
  whenever OpenAlex is, and the default weight rises from 0.25 to 0.6. Citation count is
  now a first-class ranking axis rather than a tie-break: a well-cited paper can overtake a
  somewhat more relevant uncited one, while a wholly irrelevant paper still cannot win on
  citations alone. Zero citations remains zero impact. Existing installs that never changed
  the weight are migrated to the new default; a value you set yourself is left alone,
  including 0, which still turns the boost off entirely (ADR-029).
- Supplementary deposits — Figshare-style datasets, issue covers and other front matter,
  standalone erratum notices — could outrank the papers they accompany, since ranking had no
  notion of what kind of record it was ordering. They are now demoted by work type, with
  OpenAlex's own "not a research work" flag weighted hardest (ADR-029). Editorials and
  perspectives are only lightly demoted — enough to prefer a research article when both match
  a passage equally well, not enough to push real commentary out of contention. Preprints are
  not demoted at all, since bioRxiv and medRxiv are sources you can turn on deliberately, and
  neither is a record whose type is simply unknown. Nothing is filtered out: a dataset that strongly
  matches your passage still ranks above a weakly matching article, so searching for one on
  purpose still works.
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
- A knowledge-base query is now embedded once per embedding model rather than once per bound
  collection (ADR-020). A document bound to three collections that share a model previously
  made three identical embedding requests at once for a single query; it now makes one.
  Retrieved excerpts and their scores are unchanged — this only removes redundant work, and
  removes it from the moment in a query where a cold model costs the most.

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
