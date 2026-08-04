# Literature search

Find published papers and preprints that back up — or contradict — a passage you're writing,
without ever sending your document anywhere. GRETTA drafts a search query from your selection
**on your machine**, shows you the exact text before anything is sent, and only searches once
you approve it.

Design rationale lives in **ADR-028** through **ADR-031** (`DECISIONS.md`).

## Concepts

**Off until you turn it on.** Literature search is disabled by default, and turning on a
source under **Settings → Literature** is what permits any outbound request. Nothing reaches
the internet until you do that.

**Draft, then approve.** Drafting a query from a passage is a local step — the passage never
leaves your machine. The drafted text lands in an editable box; searching is a second,
separate click. What you see in that box is exactly what gets sent, character for character.

**Sources have roles, not one combined index.** GRETTA queries up to four sources
independently rather than presenting one merged "the literature":

- **PubMed** — the primary source. Free, no account, best abstract coverage of any source;
  strongest in biomedicine, weaker outside it.
- **bioRxiv** and **medRxiv** — preprints. Neither publishes its own keyword search API, so
  both are found through Crossref, filtered to posted-content from that server.
- **OpenAlex** — the broadest source, and the only one that reports venue standing and
  citation measures. Requires a free API key (see [Setup](#setup)).

arXiv is not a source you can enable: it sends no CORS headers, so a browser can never read
its response, and neither can DataCite, the only other route to arXiv metadata. This is a
platform limitation, not a missing toggle — `pnpm smoke:lit` re-checks it.

**Ranked locally, never scored.** Results are re-ranked on your machine, by embedding your
passage and each candidate's title/abstract with your own Ollama and comparing similarity —
the passage is never transmitted for this. Credibility signals (citation counts,
field-weighted impact, venue standing, MEDLINE indexing, DOAJ listing) are shown as separate
badges rather than folded into one score, and retractions/corrections are flagged distinctly
from each other. GRETTA deliberately avoids producing a single "trust this paper" number.

**Discovery only, for now.** Literature search does not insert citations or fetch full text
into the knowledge base — it's a read-only panel of candidates today. Wiring a found paper
into the knowledge base, and inserting citations into the document, are both planned but not
yet built (see `ROADMAP.md`).

## Setup

1. **Settings → Literature → Literature search → On.**

2. **Turn on at least one source.** All four toggles start off; the Search button stays
   disabled until one is on.

3. **OpenAlex needs a free API key** if you enable it. As of February 2026, OpenAlex requires
   a key (keys replaced the older email-based pool). Without one you get a small trial
   allowance per day, then requests start failing — which looks like a search that suddenly
   finds nothing. Create an account at [openalex.org](https://openalex.org), copy the key
   from _Settings → API_ there, and paste it into **OpenAlex API key** in GRETTA. The
   underlying data stays free and CC0; the key just covers the query service.

4. **PubMed and Crossref (bioRxiv/medRxiv) need nothing**, but accept an optional **contact
   email**. Giving one buys faster service from the polite pool; leaving it blank uses the
   public pool instead. It's your address to give or withhold — OpenAlex ignores this field
   and uses the API key instead.

5. **Turn on retraction checking (Crossref)** if you want it — strongly recommended. It's the
   only source of typed post-publication notices, so it can tell a correction from a
   retraction rather than collapsing both into one flag. It sends the DOIs of your results to
   Crossref to check.

6. **Pick a query-drafting model (optional).** Any installed text model works — it turns your
   selected passage into keywords, on your machine. Leave it as "Same as the general model"
   unless you want something smaller/faster just for this. This is separate from the
   embedding model (set under _Settings → Connection_) that does the relevance ranking.

## Running a search

1. Select the passage you're writing or checking in the Word document.
2. Open the **Literature** panel from the toolbar.
3. Click **Draft a query from my selection.** GRETTA reads the passage locally and asks your
   drafting model for 3–6 distinctive keyword terms. Nothing is sent to a source at this
   step — you'll see "Writing a query from the passage, on your machine. Nothing has been
   sent."
4. **Review the query.** It appears in an editable **Search query** box. Edit it however you
   like — add, remove, or rewrite terms — before continuing. It must be a single line, 256
   characters or fewer.
5. Optionally expand **Advanced search parameters**:
   - **Published since** — a year filter, applied server-side where the source supports it
     (OpenAlex) and client-side otherwise (PubMed, Crossref). Blank means no date bound.
     Undated records are always kept.
   - **Results per source** — how many candidates to fetch before ranking trims the list
     (5–100, default 20). This is the pool ranking works within; it can't surface anything
     past it, so a wider pool finds more at the cost of a slower search and more embedding
     work.
   - **Venue citation threshold** — a journal that charges to publish, is absent from DOAJ,
     and is cited less often than this draws a caution badge (0–50, default 0.2). The default
     is provisional, so tune it rather than trust it.
   - **Citation impact weight** — how much a result's citation impact for its publication
     year (OpenAlex) can nudge it up the ranking, on top of relevance to your selection
     (0–1, default 0.25). It only breaks close calls between similarly relevant results; set
     it to 0 for pure relevance ranking.
6. Click **Search.** This is the only step that reaches the network, and only for the sources
   you've enabled.

You can also skip drafting entirely and type a query by hand — drafting is a convenience, not
a requirement.

## Reading the results

Each result is a card showing:

- **Title**, linking out to the source's page (opens in your system browser).
- **Authors** (up to three, then "et al."), **venue**, and **year** — with a "Preprint — not
  peer reviewed" note for bioRxiv/medRxiv results.
- **Abstract**, shown as plain text.
- **Credibility badges** — separate, never combined into one score: Crossref registration,
  MEDLINE indexing, DOAJ listing, raw citation count, field-weighted citation impact (FWCI,
  "× field average"), citation percentile for its year, venue mean citedness, a "front/back
  matter" flag, and a compound caution for journals that charge to publish but have little
  citation record. A badge that's absent means that check wasn't run — not that the paper
  failed it. Hover any badge for what it means.
- **A retraction/correction banner**, shown above the title whenever Crossref's update
  metadata flags one — a still-active retraction is shown as an error; a correction or a
  reinstatement (a later notice that undoes an earlier retraction) is shown as a warning,
  with a link to the actual notice.
- **A ranking banner** at the top of the list, stating how it was ordered: ranked against your
  selection on your machine (the normal case), ranked by shared words rather than meaning (if
  your embedding model couldn't be reached — check _Settings → Connection_), or shown in each
  source's own order (if nothing was rankable).

Results with none of the indexing/verification checks passed are collapsed behind a
"N further results with limited verification" toggle, rather than being dropped or hidden.

Expand **"What was sent to each source"** to see the literal query text each enabled source
received, plus notes on any per-source adaptation — e.g. PubMed retries with `OR`-joined
terms if a strict `AND`ed query returns nothing, and bioRxiv/medRxiv queries are noted as
having gone through Crossref, filtered to preprints from that server.

Results aren't cached, saved, or exported from this panel — it's transient state that clears
when you navigate away or run a new search.

## What this does not send

- Your document, your other selections, and your prompts are never transmitted by this
  feature.
- Only the query text you've reviewed in the Search query box — and, if verification or
  OpenAlex ranking is on, the DOIs of the results themselves — ever leaves your machine.
- The passage you selected is used only to draft the query and to rank results locally; it is
  never sent to a source.
- Full text is never fetched from behind a paywall, and institutional proxy logins (EZproxy,
  Shibboleth) aren't supported — those rely on browser cookies the Word task pane doesn't
  share. Paywalled papers are still listed, with a link, so you can decide.

## Troubleshooting

- **"No sources are turned on."** The Search button stays disabled until at least one source
  toggle is on in Settings.
- **"No results."** Try broader keywords, or turn on another source — PubMed in particular
  ANDs all your terms together, so an over-specific drafted query can return nothing even
  though the paper exists (GRETTA retries once with the terms OR'd together before giving
  up).
- **OpenAlex suddenly finds nothing.** Almost always a missing or exhausted API key —
  OpenAlex's unkeyed trial allowance is small and resets daily. Add a key under Settings.
- **"Could not embed with `<model>`."** Your embedding model (Settings → Connection) isn't
  reachable. Results still appear, ranked by word overlap instead of meaning, with this note
  shown so you know why the order looks rougher than usual.
- **A search fails outright** (offline, rate-limited, a malformed response, or a rejected
  query) surfaces as a visible error naming which source failed — it isn't swallowed silently
  the way some other GRETTA errors are.

## What's not built yet

- Sending a found paper's full text into the knowledge base for use in generation.
- Inserting a citation into the document from a result.
- A results cache (every search today is a fresh set of requests to every enabled source).

See `ROADMAP.md` for status on all of these.
