<p align="center">
  <img src="docs/assets/gretta-banner.png" alt="GRETTA — Generative Research Engine for Technical Text Authoring. Local-first AI assistance for scientific and technical writing: scientific writing, local knowledge base (RAG), literature search, evidence-aware citations, runs with Ollama, private by design." width="100%">
</p>

# GRETTA

**Generative Research Engine for Technical Text Authoring**

A Microsoft Word task-pane add-in that turns a locally running [Ollama](https://ollama.com)
into a writing assistant for scientific and technical documents — drafting, rewriting,
proofreading, and retrieval from your own library of papers and notes. No cloud services and
no telemetry: generation never uses the network, and the only traffic it produces is between
the task pane, your own Ollama daemon, and a local indexing companion. Literature search is
the one exception, it is off until you turn on a source, and it is described below.

Built with TypeScript (strict), React 19, Vite, Fluent UI v9, Zustand, TanStack Query, Zod,
and Office.js. Unlike COM/VSTO-based tools, this is a web add-in, so it targets **Word for
Windows, Word for Mac, and Word on the web** from one codebase.

## What it does today

- **Writing assistance in Word** — model and prompt pickers, a prompt box with a
  document-context chip (selection, paragraph, or whole document), and a live streaming
  response with Generate / Stop / Retry.
- **Result actions** — Copy, Replace, Insert, Comment, Refine, and export to Markdown or JSON.
- **A prompt library** — 12 built-in prompts across scientific writing, editing, style, grants,
  and communication, plus a custom-prompt editor.
- **A local knowledge base (RAG)** — point GRETTA at folders of PDFs, Word files, and notes;
  it indexes them on-device with your own embedding model and injects relevant excerpts into
  your prompts, **with every excerpt cited** by file and page or paragraph. Documents bind to
  named collections, and the binding is stored inside the `.docx` so it travels with the file.
- **Scholarly literature search** — highlight a passage, have your local model draft a search
  query from it, review the exact text before anything is sent, then search PubMed, bioRxiv,
  medRxiv, and OpenAlex. Results are re-ranked **on your machine** against the passage itself,
  carry per-check credibility badges — citation counts, field-weighted impact, venue
  standing, MEDLINE indexing — and are flagged for retractions and corrections
  separately rather than collapsed into one warning.
- **Generation history** — every run is saved as a self-contained record (prompt, response,
  model, sources, and the passage it drew on) that you can reopen, export, or refine.
- **A validated settings panel** — Ollama URL, default model, sampling parameters, context
  length, embedding model, and light/dark/system/Match-Word themes.

Everything runs against a local Ollama daemon. See [ROADMAP.md](ROADMAP.md) for what is
planned but **not yet built** — notably ingesting found papers into the knowledge base,
non-Ollama model backends, and a plugin architecture. Those are direction, not current
capability.

## Philosophy

**Research first.** Capabilities are shaped around how researchers and technical writers
actually work, not around generic chat.

**Evidence aware.** When GRETTA draws on your library, it shows you exactly which excerpts it
used, so a claim can always be traced back to a document on disk.

**Local by default.** Your documents, your index, and your embeddings stay on your machine, and
generation never uses the network. Literature search is the one exception: it is off until you
turn on a source, it reaches only that source's public API, and it sends only a search query you
have seen and approved. Your document text is never transmitted.

**Open by design.** MIT-licensed and built to be read, forked, and extended.

> Looking for architecture, ADRs, or a specific feature guide? Jump to the
> [Documentation](#documentation) index.

## Prerequisites

- **Node.js ≥ 22.13**
- **pnpm** (`npm i -g pnpm`) — pnpm 11 requires Node 22.13+
- **Ollama** running locally with at least one model pulled (`ollama pull llama3.1`)
- **Microsoft Word** — Windows, Mac, or word on the web (Microsoft 365)

## Quickstart

From a stock machine, one command checks everything and does what it can:

```bash
node scripts/setup.mjs     # or: pnpm setup
```

It verifies Node, installs pnpm and dependencies, provisions the HTTPS
certificate Office requires, and checks that Ollama is running with both a text
model and an embedding model. Anything it cannot do itself, it prints with the
exact command to fix it. It is safe to re-run.

If you would rather do it by hand:

```bash
pnpm install
pnpm certs:install   # one-time: create + trust the localhost dev certificate
pnpm dev             # serves https://localhost:3000
```

Then sideload `manifest/manifest.xml` into Word — platform-by-platform steps in [docs/SIDELOADING.md](docs/SIDELOADING.md) — and click **Open GRETTA** on the Home ribbon. Use the pane's **Ollama connection check** to confirm the pane can reach your daemon (see [Connecting to Ollama](#connecting-to-ollama) below, especially on a Mac).

**On a Mac, skip the juggling** — one command sideloads the manifest and starts both the dev server and the Ollama proxy together:

```bash
pnpm dev:mac         # then quit and reopen Word once
```

Word for Mac runs the pane in WKWebView, which refuses to let an HTTPS page call
`http://localhost`. `pnpm dev:mac` starts the bundled HTTPS proxy for this
alongside everything else; set the Ollama URL in Settings to
`https://localhost:11435` if the connection check cannot find your daemon.

To work on the UI without Word at all:

```bash
pnpm dev:web         # plain http://localhost:3000/taskpane.html, Office mocked
```

## Day-to-day usage

The Quickstart above is a one-time setup. This section is about the next morning, and every
morning after — what has to happen before GRETTA will actually work.

GRETTA isn't a regular installed app yet — it's a **dev build**, which means it doesn't run in
the background on its own the way, say, a menu-bar app does. Two things have to be running
whenever you want to use it, and Word itself needs one small check.

**1. Ollama has to be running.**
If you installed the Ollama app, it normally starts on its own and sits quietly in your menu
bar — look for its icon. If it's not there, open the Ollama app once and leave it running.
(If you start Ollama by typing `ollama serve` into a terminal instead, that terminal has to
stay open too.)

**2. A terminal running GRETTA's dev server has to stay open.**
This is the step that's easy to miss. Each time you want to use GRETTA:

- Open Terminal.
- Go to the GRETTA folder — wherever you cloned or downloaded it, for example:
  ```bash
  cd ~/gretta
  ```
- Start it:
  ```bash
  pnpm dev:mac
  ```
  (Not on a Mac? Use `pnpm dev` instead — see [Scripts](#scripts) further down.)
- Leave that terminal window open in the background for as long as you're using GRETTA.
  Closing it — or your computer sleeping in a way that kills the process — stops GRETTA from
  working. The symptom is a blank pane in Word, or a connection check that fails, with nothing
  in Word itself explaining why.

**3. Open Word and click GRETTA — no restart needed.**
Quitting and reopening Word is only required the very first time you sideload the add-in, or
after the manifest changes. On a normal day, just open Word and go to
**Home → Add-ins → GRETTA**; it's already there from the first sideload.

**If the pane looks broken:** check step 2 first — the dev server terminal not running is the
single most common cause of a blank pane or a failed connection check. Then check step 1,
that Ollama is running.

## Uninstalling

- **Windows:** delete the manifest from the shared folder and/or remove the catalog from Trusted Add-in Catalogs; restart Word.
- **Mac:** delete the manifest from Word's `wef` folder; restart Word.
- **Web:** uploaded add-ins only last for the session — just reload.

Full steps and troubleshooting: [docs/SIDELOADING.md](docs/SIDELOADING.md#uninstalling).

## How the knowledge base changes answers

When a collection is bound to the document, retrieved excerpts are added to the
prompt with an explicit instruction: **prefer these over general knowledge**, and
say so rather than answering from general knowledge without noting it.

That is deliberate, and it has a visible consequence. With the knowledge base on,
GRETTA will often decline a question your documents do not cover — ask it how
many elements are in the periodic table and it may tell you the excerpts do not
say, where with the knowledge base off it would simply answer. This is the
intended trade: a knowledge base frequently holds unpublished or more recent work
that _should_ take precedence over what the model absorbed in training, and
silently blending the two is the failure worth preventing.

Turn the knowledge base off, or unbind the collection, for general questions.

Full setup, collections, and binding details: [docs/KNOWLEDGE-BASE.md](docs/KNOWLEDGE-BASE.md).

## Literature search

Off by default. Turning on a source under **Settings → Literature** is what
permits any outbound request; nothing reaches the internet until you do. GRETTA
drafts a search query from a passage **on your machine**, then searches PubMed,
bioRxiv, medRxiv, and OpenAlex — never your document, excerpts, or prompts, and
only the query you have seen and approved.

Source-by-source setup (OpenAlex's API key requirement, optional contact
addresses for PubMed/Crossref, retraction checking) and how to read results:
[docs/LITERATURE-SEARCH.md](docs/LITERATURE-SEARCH.md).

## Connecting to Ollama

The task pane is served over HTTPS (Office requires it) and calls Ollama at `http://127.0.0.1:11434` by default.

- **Word for Windows / Word on the web (Chromium):** works out of the box. Chromium treats loopback as trustworthy, and Ollama's default `OLLAMA_ORIGINS` already allows `localhost`/`127.0.0.1` origins — which is exactly what the dev server is.
- **Word for Mac (WebKit):** WebKit blocks `https → http://localhost` calls as mixed content. Run the bundled proxy and point GRETTA at it instead:

  ```bash
  pnpm proxy            # https://localhost:11435 → http://127.0.0.1:11434
  ```

  Then set the Ollama URL in the pane to `https://localhost:11435`. The proxy reuses the trusted certificate from `pnpm certs:install`, streams NDJSON chunk-by-chunk, and propagates cancellation to Ollama. Details and rationale: [DECISIONS.md](DECISIONS.md) ADR-008.

- **Hosting the pane anywhere other than `localhost:3000`:** add that origin to Ollama's allowlist, e.g.
  `OLLAMA_ORIGINS="https://your-host" ollama serve` (see ADR-009).

The pane's built-in **connection check** distinguishes "Ollama isn't running" from "running but blocked (CORS / mixed content)" and tells you which fix applies.

---

Everything below this line is technical reference — scripts, the full documentation set, the
quality gate, and the repository layout. Useful if you're developing GRETTA or want to go
deeper; not necessary just to use it.

## Documentation

| File                                                   | What it covers                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                     | Layers, service contracts, state map, streaming pipeline, error taxonomy      |
| [ROADMAP.md](ROADMAP.md)                               | What's shipped so far, and the direction ahead                                |
| [CONTRIBUTING.md](CONTRIBUTING.md)                     | Dev setup, the quality gate, and the ADR-first rule for architectural changes |
| [DECISIONS.md](DECISIONS.md)                           | Architecture Decision Records                                                 |
| [docs/PROMPTS.md](docs/PROMPTS.md)                     | What each of the 12 built-in prompts does, and how to write your own          |
| [docs/SIDELOADING.md](docs/SIDELOADING.md)             | Installing the dev build into Word on each platform                           |
| [docs/KNOWLEDGE-BASE.md](docs/KNOWLEDGE-BASE.md)       | Setting up and using the local knowledge base (RAG)                           |
| [docs/LITERATURE-SEARCH.md](docs/LITERATURE-SEARCH.md) | Setting up and running literature search, and reading its results             |

## Scripts

| Script                              | Purpose                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm setup`                        | First-run checks: Node, pnpm, dependencies, certificate, Ollama models          |
| `pnpm dev`                          | HTTPS dev server on port 3000 (what Word loads)                                 |
| `pnpm dev:web`                      | HTTP dev server in browser mode (`VITE_OFFICE_MOCK=1`)                          |
| `pnpm dev:mac`                      | **Mac one-command loader:** sideload + dev + proxy together (see below)         |
| `pnpm build`                        | Production build → `dist/` (taskpane + commands entries)                        |
| `pnpm typecheck`                    | `tsc --noEmit` across the app and node TS projects                              |
| `pnpm lint`                         | ESLint: strict type-checked rules + architecture boundaries                     |
| `pnpm test` / `pnpm test:watch`     | Vitest (jsdom) unit/component tests                                             |
| `pnpm e2e`                          | Playwright smoke tests against browser dev mode¹                                |
| `pnpm format` / `pnpm format:check` | Prettier                                                                        |
| `pnpm validate:manifest`            | Validates `manifest/manifest.xml` (calls Microsoft's validator; needs internet) |
| `pnpm proxy`                        | HTTPS → Ollama loopback proxy for Word for Mac (see below)                      |
| `pnpm certs:install`                | Create + trust the localhost dev certificate                                    |
| `pnpm check`                        | Full quality gate: typecheck + lint + format + test + build                     |

¹ First run needs `pnpm exec playwright install chromium` (downloads a browser).

## Verifying the scaffold

```bash
pnpm check
```

runs every gate. All gates pass on a clean checkout; `validate:manifest` and `e2e` additionally need internet access (Microsoft's validator and the Playwright browser download, respectively).

> **Note on a pnpm warning:** dependency post-install scripts are allow-listed in `pnpm-workspace.yaml` (`allowBuilds`), which pnpm ≥ 10 requires. If pnpm ever reports _"Ignored build scripts"_, run `pnpm approve-builds` or check that file.

## Repository layout

```
manifest/         Office add-in XML manifest (WordApi 1.3 baseline)
public/assets/    Ribbon + store icons
scripts/          dev-mac.mjs (one-command Mac loader) · ollama-https-proxy.mjs (loopback proxy)
src/
  app/            Shell, providers, composition root, views
  commands/       Ribbon function-command runtime
  services/       office / ollama / storage / clipboard boundaries
  types/          Shared domain model
  utils/          Pure helpers
tests/  e2e/      Vitest setup · Playwright specs
```

The full tree, layer rules, and service contracts live in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

Released under the [MIT License](LICENSE) — free to use, modify, and distribute.
