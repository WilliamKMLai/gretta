# Knowledge base (RAG)

GRETTA can draw on your own documents — PDFs, Word files, and notes — when it writes.
Everything stays on your machine: your files are read by a small local helper process, and
the embeddings are computed by your own Ollama. Nothing is uploaded anywhere.

The feature is **off until you turn it on**, and if anything about it isn't running,
GRETTA keeps generating exactly as it did before.

Design rationale lives in **ADR-020** (`DECISIONS.md`).

## Concepts

**Collection** — a named knowledge base backed by one or more folders, with its own
embedding model. Name it however you think about the material: "Reference library", "Lab
protocols", "Course readings", "Client background".

**Binding** — which collections _this document_ uses. The binding is saved **inside the
.docx**, so it travels with the file: copy it, rename it, send it to another machine, and
it still knows which knowledge base it belongs to.

That single property covers both patterns you're likely to want:

- **Many documents, one collection.** Bind every document in a related body of work to the
  same collection and they all draw on the same material. Because the binding is part of
  the file, a template you've bound once passes that binding to every document you create
  from it.
- **Different documents, different collections.** An unrelated document binds to its own
  collection — or to none, in which case it retrieves nothing and generates exactly as it
  would with the feature switched off.

## Setup

1. **Pull an embedding model** (once):

   ```bash
   ollama pull nomic-embed-text
   ```

   Ollama stores it as `nomic-embed-text:latest`, which is the name the Settings dropdown
   shows and the default GRETTA uses.

2. **Start the companion.** On Mac, `pnpm dev:mac` already starts it alongside the dev
   server and proxy. Otherwise, in its own terminal:

   ```bash
   pnpm kb          # https://localhost:11436
   ```

3. **Turn it on.** Open the 📚 _Knowledge base_ tab and click **Enable knowledge base** —
   or use the **Knowledge base** switch in Settings, which is also how you turn it back
   off.

4. **Create a collection.** Give it a name, then either click **Choose folder…** or paste
   the **absolute path** to a folder, and click **Add**. Indexing starts immediately and
   the panel shows progress.

   > **Choose folder…** opens a normal macOS or Windows folder dialog. The pane itself
   > can't open one — Word add-ins have no such API — so the button asks the **companion**
   > to open it, which is also the process that reads your disk. The button only appears
   > when the companion is running on a platform that has a dialog; on Linux, or with the
   > companion stopped, type or paste the path instead. Nothing on the companion lists or
   > browses your filesystem over HTTP: the dialog hands back exactly the one folder you
   > picked (ADR-033).

5. **Bind the open document.** Tick the collections this document should use. Generate as
   usual; relevant excerpts are added to the prompt and listed under **Sources**.

## Verifying it's working

A quick end-to-end check, using a throwaway file with a fact GRETTA cannot already
know, so a correct answer can only have come from retrieval.

1. **Make a test folder** with one file, `buffer.txt`, containing something
   fictional and specific:

   ```
   The Vantrellium buffer must be held at 47.3 degrees Celsius during the second wash.
   ```

   "Vantrellium" isn't real, so no model has this fact from training — if GRETTA
   gets it right, the excerpt came from the file.

2. **Pull an embedding model and turn the feature on** — Setup steps 1–3 above
   (`ollama pull nomic-embed-text`, `pnpm kb` or `pnpm dev:mac`, then the
   **Knowledge base** switch in Settings). Confirm the **Embedding model** dropdown
   that appears underneath shows the model you pulled, with no "not installed" hint.

3. **Set the KB path.** In the 📚 _Knowledge base_ tab, add a collection pointing at
   the test folder's absolute path (Setup step 4).

4. **Confirm indexing.** Watch the collection card: the phase label should move
   through _Scanning folders…_ / _Indexing…_ to **"Ready to search,"** with a
   non-zero file/excerpt count and an "indexed `<relative time>`" stamp. If it says
   "Paused — Ollama unreachable" or the panel shows "Companion not running," see
   Troubleshooting below before continuing.

5. **Bind and ask.** Tick **"Use in this document"** on the collection, then prompt:

   > What temperature must the Vantrellium buffer be held at during the second wash?

   Generate. The answer should state **47.3°C**, with a **Sources** line citing
   `buffer.txt`.

6. **Prove it's live, not memorized.** Edit `buffer.txt` and change 47.3 to any
   other made-up number, save it, then either wait a moment for the folder watcher
   or click the collection's reindex (sync-arrow) icon. Once the "indexed" stamp
   updates, ask the exact same question again in a fresh generation. The answer
   should now report your new number — confirming GRETTA re-read the file from disk
   rather than reusing a cached or hallucinated value.

If any step doesn't match what's described, see Troubleshooting below.

## What gets indexed

| Type                       | Citation granularity |
| -------------------------- | -------------------- |
| `.pdf`                     | page number          |
| `.docx`                    | paragraph            |
| `.txt`, `.md`, `.markdown` | paragraph            |

Subfolders are included. Scanned PDFs with no text layer are skipped with a reason (there
is no OCR). Anything skipped is listed in the panel so you know what was left out.

Re-indexing is **incremental**: a file is only re-read and re-embedded when its contents
actually change, edits are picked up automatically (a folder watcher, debounced so a burst
of saves is one pass), and deleted files drop out. Your index survives restarts.

## Capacity

Each collection shows how full it is against a **30 000-chunk** fast-search limit (roughly
a few thousand pages, depending on document density). Below that limit every query scans
the whole collection, which is fast and exact. The number is a guide, not a wall — if you
approach it, split the corpus into more specific collections, which also improves relevance.

## Editing a collection

The pencil icon on a collection lets you change its **name**, its **folders** (one absolute
path per line — a collection can span several), and its **embedding model**. **Choose
folder…** appends a folder to the list rather than replacing it, since a collection
spanning two folders is ordinary; the list stays editable either way. Saving re-indexes
incrementally, so only what actually changed is re-read.

Renaming is safe: the collection keeps its internal id, so documents already bound to it
stay bound.

## Choosing an embedding model

Settings has an **Embedding model** dropdown beneath the default model, listing the models
installed on your Ollama server. It seeds **new** collections; existing ones keep their own,
which you can change per collection when editing.

Pick an actual embedding model — `nomic-embed-text:latest` and `mxbai-embed-large:latest`
are common choices. A chat model will either refuse or produce poor retrieval.

**Changing a collection's model re-indexes that collection**, because vectors made by
different models aren't comparable. GRETTA does this for you rather than silently
returning nonsense, and warns you before you save.

## Working across two computers

The document's binding is stored **in the .docx**, and a collection is matched by its
name. So a laptop and an office machine share a knowledge base by each having a collection
with the **same name**, pointed at that machine's own copy of the folder — a synced folder
(OneDrive, Dropbox, a network share) is the usual way to keep the source documents in step.
Open the document on either machine and retrieval just works.

What does _not_ travel is the index itself: it is derived data, tied to absolute paths on
one machine, so each computer indexes its own copy. That is deliberate — it keeps a SQLite
database out of a sync folder, where concurrent writes and partial syncs corrupt it.

If you open a document whose collection does not exist on this computer, the panel says so
by name, so you can create it and carry on rather than wondering why nothing is retrieved.

## Deleting a collection

Deleting asks for confirmation first. It removes the collection and its indexed excerpts
from your computer — **your original files are never touched**. Any document still bound to
it simply stops retrieving. You can add the folder again later; it will re-index from
scratch.

## Troubleshooting

**"Companion not running"** — start `pnpm kb`. Generation still works without it; you just
won't get excerpts.

**Indexing says "Paused — Ollama unreachable"** — the companion is fine but Ollama isn't
answering. Start it (`ollama serve`); indexing resumes and keeps whatever was already done.

**Nothing retrieved** — check that the document is actually bound (ticked) and that the
collection reached _ready_ with a non-zero chunk count.

**Sources are cited but the model says the information isn't there** — the prompt is
overflowing the context window, so the excerpts get trimmed away before the model reads
them. Raise **Context length** in Settings (4096 is the default; whole-document work often
wants 8192 or more), or use a narrower context source than the whole document.

**Mac mixed-content** — the companion serves HTTPS by default for the same reason the
Ollama proxy does. If you hit certificate trouble, run `pnpm certs:install`.

**Windows / Word on the web** — plain-HTTP loopback is allowed there, so you can run
`GRETTA_KB_INSECURE=1 pnpm kb` and set the companion URL in Settings to
`http://localhost:11436`.

## Environment variables

| Variable                | Default                  | Purpose                                            |
| ----------------------- | ------------------------ | -------------------------------------------------- |
| `GRETTA_KB_PORT`        | `11436`                  | Listen port                                        |
| `GRETTA_KB_DIR`         | `~/.gretta`              | Where the index database lives                     |
| `GRETTA_KB_EMBED_MODEL` | `nomic-embed-text`       | Model for new collections                          |
| `GRETTA_OLLAMA_URL`     | `http://127.0.0.1:11434` | Ollama endpoint used for embeddings                |
| `GRETTA_KB_TOP_K`       | `5`                      | Excerpts retrieved per generation                  |
| `GRETTA_KB_MIN_SCORE`   | `0.2`                    | Minimum similarity to include                      |
| `GRETTA_KB_INSECURE`    | unset                    | `1` serves plain HTTP on loopback                  |
| `GRETTA_KB_FAKE_EMBED`  | unset                    | `1` uses offline deterministic vectors (testing)   |
| `GRETTA_KB_VERBOSE`     | unset                    | `1` logs each retrieval query and what it returned |

## Privacy

The companion listens on loopback only. Folder paths, file contents, and embeddings never
leave your computer, and the only thing stored in your document is the list of collection
ids it's bound to. Retrieved text is treated exactly like model output — data, never
instructions.

The companion reads only the folders you have explicitly bound to a collection. There is no
endpoint that lists or browses your filesystem, and **Choose folder…** does not add one: it
opens a native dialog and returns the single folder you selected, nothing else. This was a
deliberate choice over a browsable folder picker, which would have worked on Linux too but
would have let anything reaching loopback walk your disk (ADR-033).
