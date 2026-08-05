# GRETTA — Decision Log (ADRs)

> One record per architecturally significant decision. New decisions — including reversals
> discovered during implementation — are appended **before** the change lands, per the
> project workflow. Format: Status · Context · Decision · Alternatives · Consequences.
>
> Statuses: **Accepted** · Proposed · Superseded by ADR-NNN.

---

## ADR-001 — Office.js web add-in with the add-in-only (XML) manifest

**Status:** Accepted (2026-07-13)

**Context.** The incumbent (wordollama.com) is a COM/VSTO add-in on .NET Framework —
which is precisely why it is Windows-only; VSTO does not exist on macOS. Cross-platform
support, especially Mac, is this project's differentiator. Separately, Office now offers
two manifest formats: the classic add-in-only XML manifest (supported on Windows, Mac,
web, mobile) and the unified JSON manifest, whose Word-on-Mac sideloading support only
begins at Word for Mac 16.103+ and which still excludes some hosts.

**Decision.** Build a web add-in on Office.js with the **add-in-only XML manifest**,
baseline requirement **WordApi 1.3**, with newer sets (1.4 comments) feature-detected at
runtime.

**Alternatives.** VSTO/COM (rejected: Windows-only — the exact failure we're avoiding);
unified JSON manifest (rejected for v1: narrower platform floor on Mac and perpetual
builds; revisit post-v1 — migration is mechanical).

**Consequences.** One codebase for Windows/Mac/web. We inherit webview constraints
(HTTPS, CORS, WebKit mixed-content — see ADR-008). Manifest migration to unified format
remains open later.

**Amendment (Phase 3, 2026-07-14).** Per-operation requirement sets verified from the
reference annotations in `@types/office-js`: every core member we call is WordApi 1.1;
`Range.insertComment` is 1.4 and stays a runtime gate. The manifest floor remains **1.3**
deliberately — below 1.3, `paragraphs` collections exclude paragraphs inside tables, so
`getParagraph` would silently return nothing with the cursor in a table. Evidence and
the full table live in `src/services/office/requirements.ts`.

---

## ADR-002 — Vite as the build tool (not webpack/yo-office)

**Status:** Accepted

**Context.** Microsoft's `yo office` generator scaffolds webpack. The spec mandates Vite.
Office add-ins need: HTTPS dev server, two HTML entries (`taskpane.html`,
`commands.html`), and stable localhost URLs matching the manifest.

**Decision.** Vite with rollup multi-entry input; dev server on `https://localhost:3000`
using certificates from `office-addin-dev-certs` (whose CA is installed as trusted —
which we also reuse for the Mac proxy, ADR-008). Keep Microsoft's CLI utilities
(`office-addin-dev-certs`, `office-addin-manifest`) as dev dependencies; skip
`office-addin-debugging` initially (documented manual sideload is more transparent and
cross-platform).

**Alternatives.** webpack via yo-office (rejected: slower DX, more config, spec says
Vite); no Microsoft tooling at all (rejected: dev-certs and manifest validation are
genuinely useful and tiny).

**Consequences.** Fast HMR inside the task pane webview; we own a small amount of
manifest/sideload glue that yo-office would have generated.

---

## ADR-003 — Service layer behind interfaces + module-level composition root (no DI framework, no Context)

**Status:** Accepted

**Context.** Spec: no component may call Office.js or `fetch`; dependency inversion where
appropriate; no React Context for global state; everything testable.

**Decision.** Each boundary (Office, Ollama, Storage, Clipboard) is an interface in
`services/*`; concrete instances are created once in `app/services.ts` and consumed via
`getServices()`. Tests and browser dev mode swap implementations with `setServices()`.
Lint (`no-restricted-imports` + `eslint-plugin-boundaries`) forbids `office.js`/`fetch`
outside `services/`.

**Alternatives.** React Context provider for services (rejected: spec's spirit, plus
services are stable singletons — Context adds ceremony and re-render surface); a DI
container like tsyringe/InversifyJS (rejected: decorators/reflect-metadata weight for
four services violates "avoid unnecessary dependencies"); passing services as props
(rejected: prop-drilling noise).

**Consequences.** One-line test seams; trivial mock mode; the registry is mutable
global state — mitigated by freezing in production builds and confining `setServices` to
test/dev code paths.

---

**Amendment (Phase 5, 2026-07-14).** The composition root is its own file-mode
boundaries element (`services-root` → `src/app/services.ts`) so features and hooks can
import `getServices()` without gaining access to the rest of `app/` (views, UI store).
Matrix: `main/app/features → services-root`; `services-root → features + services +
types + utils` — it reads the settings store so the Ollama client resolves its base URL
at call time (§7.2), with no import cycle because stores persist through
`services/storage` directly, never through the root. `boundaries/entry-point` now
enforces barrel-only imports of `services/*` and `features/*`, as planned in Phase 2.

## ADR-004 — Streaming API shape: `AsyncIterable<StreamEvent>` + `AbortSignal`

**Status:** Accepted

**Context.** Ollama streams NDJSON over HTTP. Consumers need token-by-token delivery,
cancellation, completion stats, and testability. Candidate shapes: callback handlers,
EventEmitter/observable, or async iteration.

**Decision.** `chat()`/`generate()` return `AsyncIterable<StreamEvent>` where
`StreamEvent = {type:'token'} | {type:'done', stats}`; errors are thrown (typed);
cancellation is the caller's `AbortController` — aborting closes the HTTP connection,
which stops Ollama's generation server-side. Non-streaming requests use the identical
contract (single token event + done), so the UI has one code path.

**Alternatives.** Callback object `{onToken,onDone,onError}` (rejected: inversion of
control makes sequential logic and tests clumsier); RxJS (rejected: heavyweight
dependency for one stream); returning the raw `ReadableStream` (rejected: leaks
transport/parsing into features).

**Consequences.** `for await` in `useGeneration` reads top-to-bottom; fixtures are plain
async generators; must remember `iterator.return()` semantics (handled: `finally` blocks
release the reader).

---

## ADR-005 — State: feature-colocated Zustand stores + TanStack Query strictly for Ollama server cache

**Status:** Accepted

**Context.** Spec mandates Zustand (app/conversation/settings/streaming/UI separation,
no Context) _and_ TanStack Query. The overlap needs a crisp boundary, and the spec's
folder sketch has no `stores/` directory.

**Decision.** Five stores, each colocated with its owning feature
(`settings`, `conversations`, `prompts`, `stream` in `features/ai`, `ui` in `app/`),
exported only through feature barrels. TanStack Query owns **only** Ollama read-model
state: health (15 s refetch), model list, model details. Generation is _not_ a Query
mutation — its lifecycle (connecting/streaming/cancelled/partial-error) is an explicit
state machine in `stream.store.ts`.

**Alternatives.** Global `src/stores/` directory (rejected: weakens feature ownership);
Query mutations for generation (rejected: mutation status can't represent
streaming/partial/cancelled states without fighting the library); Zustand for models too
(rejected: refetch/stale/retry is exactly what Query is for).

**Consequences.** Clear ownership table (ARCHITECTURE §8); cross-feature reads are
explicit imports of sibling public APIs; two state libraries stay non-overlapping.

---

## ADR-006 — Persistence: async `StorageService` over `localStorage`, versioned envelopes, Zod at the boundary

**Status:** Accepted

**Context.** Settings, conversations, and custom prompts must persist locally.
`localStorage` is universally available in task pane webviews but synchronous,
origin-scoped, and small (~5–10 MB). Data shapes will evolve.

**Decision.** An **async** `StorageService` interface with a `localStorage` adapter.
Every payload is `{version, data}`; reads validate with Zod and run migrations; invalid
or corrupt payloads log, fall back to defaults, and surface a non-blocking toast — never
crash. Zustand `persist` is wired through this service.

**Alternatives.** Raw `localStorage` calls in stores (rejected: violates the service
rule; untestable; no migration story); IndexedDB now (rejected: adds async schema
ceremony before quota pressure exists — the async interface makes it a drop-in later);
`OfficeRuntime.storage` (rejected: partition semantics vary by host; adds no value for a
task-pane-only app); file export as primary persistence (rejected: downloads are
unreliable in panes — kept as explicit export instead).

**Consequences.** Swap-ready for IndexedDB; slightly ceremonious writes; conversation
growth is bounded by quota → mitigations are pruning UX + export (tracked for Phase 10
hardening).

---

## ADR-007 — Security posture: model output is plain text, `insertText` only, validate every boundary

**Status:** Accepted

**Context.** Spec: escape inserted HTML, never execute model output, prevent XSS, handle
malformed responses. LLM output is untrusted input.

**Decision.** v1 renders responses as plain text (`white-space: pre-wrap`) through
React's default escaping — no `dangerouslySetInnerHTML`, no Markdown→HTML pipeline.
Document insertion uses `Word.Range.insertText` exclusively (never `insertHtml`). All
network and storage payloads pass Zod before use. No `eval`/`new Function`; template
interpolation is literal substitution with no expression language. CSP restricts
`connect-src` to the configured Ollama origin + the Office.js CDN.

**Alternatives.** Markdown rendering now with DOMPurify (rejected for v1: adds a
sanitizer dependency and audit surface before core value ships; ARCHITECTURE §16 keeps a
single-component seam for it); trusting Ollama as localhost-safe (rejected: the model's
_content_ is still untrusted, and users can point the URL anywhere on their LAN).

**Consequences.** Zero XSS surface in v1 at the cost of unstyled code blocks/tables in
responses — acceptable for writing-assistance use; revisit as the first post-v1 item.

---

## ADR-008 — macOS connectivity strategy: transport seam + diagnostics + local HTTPS proxy fallback

**Status:** Accepted — **confirmed on real Word for Mac (2026-07-14)**

**Context.** The task pane is served over HTTPS. Calling `http://127.0.0.1:11434` from an
HTTPS page is a mixed-content request. Chromium (WebView2, Word on Windows) treats
loopback as potentially trustworthy, so it works. WebKit (WKWebView, Word for Mac) has
historically blocked insecure loopback subresources (WebKit bug 171934; the same
Chrome-works/Safari-blocks split is widely reported). This is the most likely root cause
of "not Mac compatible" local-AI add-ins and therefore our top technical risk. A further
wrinkle: CORS — Ollama's default `OLLAMA_ORIGINS` allows localhost-origin pages, but any
non-localhost hosting requires user configuration.

**Decision.** Three-layer strategy: (1) `OllamaClient` depends on an injected
`HttpTransport`, so the wire path is swappable; (2) `diagnostics.ts` discriminates
_offline_ vs _policy-blocked_ using a `no-cors` reachability probe, then uses platform +
URL scheme to distinguish CORS from mixed-content and shows targeted fixes; (3) the repo
ships `scripts/ollama-https-proxy.mjs`, a tiny TLS-terminating reverse proxy reusing the
already-trusted `office-addin-dev-certs` certificate — Mac users set the Ollama URL to
`https://localhost:11435`, eliminating mixed content entirely. A Phase 2 spike on real
Word for Mac decides whether the proxy is the _documented default_ on Mac or merely a
fallback; results will be appended here.

**Alternatives.** Ship only direct HTTP (rejected: reproduces the incumbent's Mac
failure); require users to run Ollama itself behind TLS (rejected: heavier ask than one
script; some users can't reconfigure Ollama); bundle a native companion app (rejected:
destroys the "sideload a manifest" simplicity; platform-specific builds); Electron
wrapper (rejected: it's a Word add-in, not an app).

**Consequences.** Mac support becomes an explicit, testable path with guided recovery
instead of a silent failure. Costs: one Node script to maintain and a slightly longer
Mac setup doc. Diagnostics can't _prove_ mixed-content vs CORS (browsers deliberately
hide the distinction) — the platform+scheme heuristic plus "try this first" ordering
covers it.

**Spike results (Phase 2):**

- _Container rehearsal (2026-07-14):_ proxy mechanics verified end-to-end against a fake
  streaming Ollama — TLS termination ✓; NDJSON passthrough stayed incremental (the
  ~150 ms inter-chunk gaps survived the hop, i.e. no buffering) ✓; a client abort
  mid-stream propagated upstream and stopped the fake's generator ✓.
- _Real hosts (user-confirmed 2026-07-14):_ sideload works; **Word for Mac cannot reach
  Ollama over direct HTTP and works only with `pnpm proxy` active** — exactly the
  predicted WebKit mixed-content behavior. The proxy is therefore the **documented
  default** on Mac (README + SIDELOADING already present it that way). Windows direct
  was not explicitly reported; expected-working per Chromium loopback policy.

---

## ADR-009 — Serving & distribution: localhost-served dev; static hosting + documented `OLLAMA_ORIGINS` for shared installs

**Status:** Accepted

**Context.** The manifest's source URL determines the page origin, which determines
Ollama CORS behavior. Localhost origins pass Ollama's defaults; anything else needs
`OLLAMA_ORIGINS`.

**Decision.** Development and default personal installs run from
`https://localhost:3000` (Vite dev or `vite preview` of the production build) —
zero-config CORS. For sharing without a dev server, the README documents static hosting
of the built assets plus setting `OLLAMA_ORIGINS=<origin>` (or `*` with a stated
tradeoff), and the in-app diagnostics detect the misconfiguration and point at the
instructions. Marketplace distribution is out of scope for v1.

**Alternatives.** Ship a bundled local static server binary (deferred: convenience later,
not required for v1); host-only-on-domain (rejected as the default: forces every user to
configure Ollama).

**Consequences.** Personal use is friction-free; shared installs have one documented
knob; the diagnostics banner turns the failure mode into instructions.

---

## ADR-010 — Testing seams: transport fakes for Ollama, service mock + `office-addin-mock` for Office, Playwright on browser dev mode; no MSW

**Status:** Accepted

**Context.** Spec requires unit/component/integration tests, mocked Office.js, mocked
Ollama, Vitest, Playwright — with minimal dependencies. True in-Word UI automation is
brittle and platform-bound.

**Decision.** Mock Ollama at the `HttpTransport` seam with hand-rolled fakes producing
real `ReadableStream`s (fixtures for chunk splits, aborts, malformed lines, drops). Mock
Office two ways: `office.mock.ts` (our in-memory implementation of `OfficeService`) for
features/E2E, and Microsoft's `office-addin-mock` to test `office.service.ts` itself.
Playwright drives the real UI in **browser dev mode** (`VITE_OFFICE_MOCK=1`) — full app,
mock document, scripted streams. Real-Word verification is a per-phase manual checklist.

**Alternatives.** MSW for network mocking (rejected: a service-worker layer to fake a
transport we already own as one function type); Playwright inside actual Word (rejected
for v1: WebView automation hooks differ per platform and rot quickly — manual matrix
instead); jsdom-only E2E (rejected: not end-to-end).

**Consequences.** Fast, deterministic suites with zero mock-framework deps; the
uncovered gap (Office.js runtime quirks in real hosts) is explicitly owned by the manual
matrix in Phases 3, 7, and 10.

---

## ADR-011 — Error model: typed `Error` subclasses + single user-message mapper; cancellation is a state, not an error

**Status:** Accepted

**Context.** Spec lists seven failure families and demands friendly messages and "never
crash". Errors originate in three services and surface in one UI.

**Decision.** Typed classes (`OfficeError`, `OllamaError`, `StreamError`,
`StorageError`) carrying `code`, `cause`, and `partialText` where relevant;
`toAppError(unknown)` normalizes at service boundaries; one `describeError()` mapper owns
all user-facing copy (testable, consistent, i18n-ready). User-initiated cancellation
never enters the error path — it is the `cancelled` terminal state with partial output
preserved. An app-level error boundary catches the truly unexpected with a reset.

**Alternatives.** `Result<T,E>` returns everywhere (rejected: fights async iteration and
TanStack Query, which are exception-based; we keep exceptions but _typed_); string codes
on plain `Error` (rejected: loses `instanceof` narrowing); per-component copy (rejected:
drift and duplication).

**Consequences.** Exhaustive `switch` on `kind`/`code` with compiler help; one file to
review for tone; services stay UI-copy-free.

---

## ADR-012 — Clipboard lives outside `OfficeService`

**Status:** Accepted

**Context.** "Copy to clipboard" sits in the spec's Document feature list, but the
clipboard is a browser capability (`navigator.clipboard`), not Office.js — and WKWebView
permission behavior differs from WebView2.

**Decision.** A separate `ClipboardService` (`navigator.clipboard.writeText` with a
hidden-textarea `execCommand('copy')` fallback), injected via the composition root. The
_document feature's_ `useDocumentActions` composes it alongside `OfficeService`, so the
UI still sees one cohesive action set.

**Alternatives.** Fold into `OfficeService` (rejected: muddies "the only Office.js call
site" invariant and drags browser quirks into Office tests).

**Consequences.** Honest boundaries; one extra tiny service; the fallback path is
testable in isolation.

---

## ADR-013 — Fluent UI v9 with React 19: verify at scaffold; defined fallback ladder

**Status:** Accepted — **verified 2026-07-14 (Phase 2)**

**Context.** The spec pins React 19 and Fluent UI v9. Fluent v9's React 19 peer support
arrived relatively recently; the safe move is to verify the currently-latest v9 release
against React 19 at scaffold time rather than assume.

**Decision.** Pin latest `@fluentui/react-components` v9 at Phase 2 and run the smoke
render under React 19 strict mode. If a peer or runtime incompatibility appears, the
fallback ladder is: (a) pin the newest Fluent v9 release that declares React 19 support;
(b) temporarily build on React 18.3 (code written to React-19-compatible patterns) and
record a follow-up ADR; (c) only as a last resort, re-open the component-library
decision. Theme integration (`'office'` preference → `Office.context.officeTheme` →
web light/dark tokens) is unaffected by the ladder.

**Alternatives.** Different component library (rejected: Fluent is both mandated and the
native Office look); building unthemed (rejected: Copilot-like UX is a requirement).

**Consequences.** A 30-minute gate in Phase 2 converts an assumption into a fact; the
outcome is recorded here either way.

**Outcome (Phase 2, 2026-07-14).** `@fluentui/react-components@9.74.3` resolved with peer
range `react >=16.14.0 <20.0.0` — React 19 is inside the declared range, and
`react@19.2.7` installed with no peer warnings. The shell smoke-renders under React 19
`StrictMode` (Vitest/jsdom, RTL) cleanly. Fallback ladder steps (a)–(c) were not needed.

## ADR-013b — Host theme access via `OfficeService.getOfficeTheme()`

**Status:** Accepted (Phase 6, 2026-07-15)

**Context.** The `'office'` theme preference (ARCH §10) must map the Word host theme onto
Fluent light/dark tokens. `Office.context.officeTheme` is an Office.js surface — rule
zero forbids touching it outside `services/office`.

**Decision.** Add `getOfficeTheme(): OfficeThemeKind | null` to the service contract
(sync — it's a property read, not a `Word.run` batch). The Word implementation prefers
the modern `officeTheme.isDarkTheme` flag and falls back to perceived luminance of
`bodyBackgroundColor`; anything unreadable yields `null`. The mock returns `null`
(browser dev mode), and `useTheme` treats `null` as "follow the system preference".
Theme is read on mount/preference change, not live-subscribed — `OfficeThemeChanged`
events need newer requirement sets than our 1.3 floor, and a pane reload on host theme
change is acceptable.

## ADR-014 — FluentProvider stays style-free; the visual root is an inner div

**Status:** Accepted (Phase 6 live-fix, 2026-07-18)

**Context.** The live blank-pane bug: Fluent UI v9 propagates the FluentProvider's
className onto every portal mount wrapper it appends to `<body>` (theme CSS variables
must reach portaled content — Toaster, Menus, Dialogs, Tooltips). Phase 6 both mounted a
Toaster and put `styles.root` (flex column, full height, `colorNeutralBackground2`) on
the provider. The portal wrapper — `position: absolute; z-index: 1000000`, a direct
child of `<body>` — therefore inherited a full-height, theme-opaque background and
became a blank sheet covering the entire app in every real browser (near-white in light
theme, near-black in dark), in Word and desktop browsers alike, dev and prod. jsdom
cannot see it (no paint), so 149+ tests stayed green. Identified live by the
bootDiagnostics 17f paint probe naming the occluder verbatim.

**Decision.** The provider receives _only_ `theme`. All layout and visual styling lives
on an inner `div#gretta-app` (which is also the commit-watchdog shell id). The root
uses `height: 100vh` since the provider is auto-height. The commit watchdog's
paint-probe stays in the product permanently as the regression tripwire for this entire
class of committed-but-occluded failure.

---

## ADR-015 — Prompt library: built-ins ship as code, template semantics live in one module

**Status:** Accepted (Phase 8, 2026-07-21)

**Context.** Phase 8 adds 12 built-in templates plus custom-prompt CRUD. Three questions
had to be settled before writing them. (1) Where do built-ins live — in the persisted
store alongside customs, or in code? Storing them means every user carries a copy of
data that ships with the binary, and editing a built-in in v1.1 would leave v1.0 copies
frozen on disk with no migration path. (2) The `requires` rules (which context variables
a run captures, which must be non-empty, and the typed error for each) were inlined in
`useGeneration`, which had grown to 356 lines — past the 300-line rule — and mixed
template semantics with orchestration, leaving no seam to snapshot request payloads
against. (3) Ids: `newId()` customs and built-ins share one `selectedPromptId` field, so
collisions are a real corruption risk.

**Decision.** Built-ins are a frozen `readonly PromptTemplate[]` in `builtins.ts`, never
persisted; `persist.partialize` continues to write only `customPrompts` and
`selectedPromptId`. Reads merge the two sets through `findPrompt(id, customs)`, which
resolves built-ins first and falls back to the free prompt for ids that match nothing —
so a stale id from an old payload degrades instead of pinning the UI to a ghost.
Built-in ids carry a literal `builtin:` prefix, which `newId()` can never emit. Template
semantics move wholesale into `prompts/template.ts` (interpolation, `neededVars`,
`requiredVars`, `requirementError`, `assertRequiredContext`, plus `unknownPlaceholders`
for editor validation), and request construction becomes a pure function in
`ai/request.ts`. `useGeneration` keeps only orchestration and drops to 261 lines. The
pure builder is what the 13 per-built-in payload snapshots exercise — no React, no
services, no stores.

**Consequences.** Editing a built-in is a code change with no migration. Users cannot
modify built-ins in place; the editor is custom-only (the picker routes only custom ids
to it), and the intended path for "almost right" is to create a custom prompt. Adding a
13th built-in means appending to the array and accepting one new snapshot.

**Alternatives.** Seeding built-ins into the store on first run (rejected: freezes copies
on disk, and every future edit needs a migration); one flat id namespace without a prefix
(rejected: a `newId()` collision would silently shadow a built-in); leaving the requires
logic in `useGeneration` (rejected: keeps the file over the line limit and leaves the
payload snapshots with no seam short of driving the whole hook).

---

## ADR-016 — Settings is a validated buffer over the store; no Save button

**Status:** Accepted (Phase 9, 2026-07-21)

**Context.** Phase 9 layers React Hook Form + Zod validation onto the settings surface.
The obvious shape for a validated form is a Save button: edit freely, validate on submit,
commit as a batch. But two prior commitments rule that out. Phase 6 made settings
_hot-apply_ — the Ollama client reads `ollamaUrl` from the store at call time (§7.2), the
theme hook reads the store, and the header ModelPicker writes `defaultModel` directly — so
there is no "apply" step to attach a save to. And Phase 9's own exit criterion requires
that changing the URL _immediately_ re-drives the health and model queries. A Save button
would contradict both.

**Decision.** The panel is a validated buffer, not a batch editor. React Hook Form owns
the in-progress value of each field; the store owns what is committed; and each field
commits to the store the moment _that field alone_ validates. Validation is per-field
(`FIELD_SCHEMAS`), so a half-typed URL blocks only the URL — every other field still
commits. What Phase 9 adds over Phase 6 is the guarantee that an invalid value never
reaches the store at all, which is the exit criterion ("invalid input can't be saved")
restated for a form that has no save.

The commit _trigger_ differs by control type. Constrained controls — slider, spin button,
switch, radio, select — commit on change, because they cannot express an out-of-range
value. Free-text fields — the URL and the seed — commit on blur or Enter: validation still
runs live so the error message appears as you type, but the value only lands in the store
once you leave the field, so a transient `12.5` on the way to `125` never commits as `12`.

The store→form direction is field-precise: a subscription writes back only the fields that
actually changed (ModelPicker touching `defaultModel`, or a reset), so an external change
never discards what the user is typing elsewhere. Reset to defaults is the one case the
subscription cannot handle alone — an abandoned edit never reached the store, so resetting
the store leaves that field unchanged and the stale text on screen — so the button calls an
explicit `resetForm()` that re-reads every field. Connection diagnostics (`describeError`
for Ollama) moved to the shared error taxonomy so the connection banner and "Test
connection" cannot give contradictory advice.

**Consequences.** There is no atomic "apply all". A user who types an invalid value into
one field and a valid value into another gets the valid one committed and the invalid one
held — which is the intended behaviour, but it means "nothing is saved until I click Save"
is not a mental model the UI supports; live application is. Every free-text field must
choose blur-commit deliberately; a future text field that commits on change would
reintroduce the transient-value bug the seed field demonstrated.

**Alternatives.** A Save button with batch validation (rejected: contradicts hot-apply and
the Phase 9 exit criterion, and would strand the header ModelPicker, which writes the same
store directly). Commit-on-change for every field including free text (rejected: commits
transient values like `12` while typing `125`, and fires the health poll at half-typed
URLs). A blanket `reset()` on every store change (rejected: discards in-progress edits to
unrelated fields when the ModelPicker writes).

---

## ADR-017 — Ollama query hooks live in `hooks/`, not the `ai` feature

**Status:** Accepted (Phase 9 follow-up, 2026-07-21)

**Context.** The Ollama server-cache hooks (`useModels`, `useOllamaHealth`, `ollamaKeys`,
`useModelDetails`) were created inside the `ai` feature in Phase 6, when `ai` was their only
consumer. Phase 9's `ConnectionSection` — part of the `settings` feature — needs the model
list and query keys too. That made `settings` import `ai`, while `ai` already imported
`settings` (`useSettingsStore`, read by `ModelPicker`, `ConnectionBanner`, and
`useGeneration`). Two features importing each other is a dependency cycle: they stop being
independently reasoned about, and circular module loads are a latent source of
"undefined at import time" bugs even when the bundler currently tolerates them. The
`boundaries` lint rules permit feature→feature imports, so nothing flagged it — the cycle
was structural, not a rule violation.

**Decision.** Move the four query hooks to `src/hooks/useOllamaQueries.ts`. `hooks/` is a
neutral layer both features are already allowed to import, so `settings` and `ai` each
depend on the hook rather than on each other. The remaining `ai → settings` import
(generation and the pickers genuinely need the current settings) is now a one-way edge, not
a loop.

This required widening the `hooks` boundary rule to allow `services-root` (the hooks call
`getServices()` from `src/app/services.ts`). Previously no hook reached the composition
root and the layer was pure. The widening is deliberate and bounded: `services-root` is the
single composition seam every feature already depends on, and a shared data-fetching hook is
a legitimate consumer of it. Hooks still may not import `features` or `app` broadly — only
the services root, other hooks, services, types, and utils.

**Consequences.** `hooks/` is no longer service-free; a future hook may now reach the
composition root, which is the intended tradeoff but slightly weakens the layer's original
purity guarantee. The `ai` barrel no longer re-exports the query hooks — consumers import
them from `hooks/useOllamaQueries` directly (barrels are for a feature's _own_ public API,
and these are no longer part of it). File renamed from `useModels.ts` to `useOllamaQueries.ts`
to reflect that it owns health and model-details queries too, not just the model list.

**Alternatives.** Leave the cycle (rejected: the smell compounds as either feature grows,
and it's cheapest to cut now while there is exactly one offending import). Duplicate the
query keys/hooks into `settings` (rejected: two `ollamaKeys` definitions would desync and
TanStack Query's cache would fragment across mismatched keys). Put the hooks in a third
feature both import (rejected: they aren't a feature — they're shared infrastructure, which
is precisely what `hooks/` is for).

---

## ADR-018 — Seed is a variance-reduction knob, not a determinism guarantee

**Status:** Accepted (Phase 9 follow-up, 2026-07-22)

**Context.** A user ran the Expand prompt twice with seed 100, the same model, and the same
input, and got two different outputs. Tracing the full path confirmed GRETTA builds,
forwards, and JSON-serializes `options.seed` into the `/api/chat` body correctly at every
layer — the app is not dropping the seed. The non-determinism originates in Ollama /
llama.cpp and is not something a seed alone controls. Two documented causes, both matching
the report: (1) a warmup effect — Ollama's own issue tracker notes that even with a fixed
seed, temperature 0, and a fixed `num_ctx`, the first execution after a model loads is
random while the second and subsequent executions are deterministic; (2) non-associative
floating-point reduction across parallel threads/GPU warps perturbs the logits slightly,
and at Expand's temperature of 0.8 — the highest in the library — that easily flips a
sampled token, after which outputs diverge. Prior UI copy (and a domain-model comment)
claimed a seed "reproduces a result on the same machine," which is false.

**Decision.** Treat the seed as what it is: a variance-reduction control, not a determinism
switch. Do not add features that imply a stronger guarantee. Specifically we do NOT pin
`num_thread: 1` (kills throughput for a guarantee we still couldn't fully make), and we do
NOT send `keep_alive`/`num_batch` as a determinism mechanism (reduces but does not eliminate
the wobble, and would invite the same overpromise). GRETTA already sends `num_ctx`, which
the community identifies as necessary for stability; that stays. The correction is in the
copy: the Settings seed hint and the `GenerationOptions.seed` comment now state plainly that
a seed makes repeat runs more consistent, that the first run after a load often differs, and
that parallelism, hardware, quantization, and engine version can all still change output.

**Consequences.** Users who need reproducibility get a documented workaround (run twice so
the model is warm; runs after the first tend to agree at low temperature) rather than a
promise the stack can't keep. Anyone later tempted to advertise "deterministic output"
should read this ADR first — this is the second time the claim was made incorrectly in UI
copy, which is why it is now written down. If true cross-run determinism ever becomes a
requirement, it is a substantial effort (deterministic GEMM kernels, pinned threading, warm
model, fixed engine build) and a v2 topic, not a hint-text tweak.

**Alternatives.** Pin single-threaded execution (rejected: severe performance cost, still no
cross-machine guarantee). Send `keep_alive: -1` to keep the model resident and dodge the
warmup path (rejected as a _determinism_ fix — it's a reasonable UX/latency change on its
own, but framing it as determinism repeats the overpromise; revisit purely on latency
grounds in Phase 10 if desired). Lower Expand's temperature to stabilize it (rejected:
temperature 0.8 is a deliberate creative choice for Expand per ADR-015's authoring notes —
consistency is not the goal for that prompt).

---

## ADR-019 — One-command Mac dev loader; GitHub with lighter CI

**Status:** Accepted (Phase 10, 2026-07-22)

**Context.** Two Phase 10 needs beyond the planned hardening scope. (1) Developing on
Word for Mac meant orchestrating three things by hand: `pnpm dev` (Vite on :3000),
`pnpm proxy` in a second terminal (the HTTPS→Ollama bridge WKWebView requires, ADR-008),
and copying the manifest into Word's `wef` folder. Forgetting any one produced a blank
pane or a dead connection check with no obvious cause — a recurring friction point. (2)
The project needed to move to GitHub, which for a public repo means an actual security
pass, a truthful README (the old one still announced "Phase 6 of 10" with generation
stubbed), a real LICENSE, and CI.

**Decision.**

_Mac loader._ A single `scripts/dev-mac.mjs` (run as `pnpm dev:mac`) that sideloads the
manifest into `~/Library/Containers/com.microsoft.Word/Data/Documents/wef`, spawns the dev
server and proxy as supervised children with `[dev]`/`[proxy]`-prefixed logs, tears both
down together on Ctrl+C, and — if either dies on its own — takes the whole thing down
rather than leaving the confusing half-running state the script exists to prevent. It is
Mac-guarded (`platform() === 'darwin'`, override `GRETTA_FORCE=1`) because the `wef`
path and proxy rationale are Mac-specific. The one thing it cannot automate is the Word
restart (Word reads `wef` only at launch), so it prints that instruction in a boxed banner
after startup. Implemented with Node built-ins only — no `concurrently`/`nodemon`
dependency — and it _spawns_ `pnpm proxy` rather than importing the proxy module, keeping
the proxy's standalone `pnpm proxy` usage untouched.

_GitHub._ Public repo, MIT license (`LICENSE` with a copyright-holder placeholder). CI is
the _lighter_ gate — typecheck + `pnpm test` on push to main and on every PR — not the full
`pnpm check`: lint/format are fast locally and `build` is effectively covered by the
typecheck plus tests, so CI stays quick. The workflow pins pnpm 11.13.0 and Node 20.19 to
match `packageManager`/`engines`, and uses concurrency-cancel so newer pushes supersede
in-flight runs. A pre-push security audit confirmed nothing secret or generated is tracked:
the only `.env*` file committed is `.env.browser` (`VITE_OFFICE_MOCK=1`, a public flag that
_should_ ship so browser mode works on clone), and secret-shaped grep hits were false
positives ("task" inside "task-pane" comments). `.gitignore` was hardened for a public repo
(editor dirs, logs, and explicit `*.pem`/`*.crt`/`*.key`/dev-cert exclusions so CA material
can never be committed).

**Consequences.** Mac onboarding drops from "read the doc, run three things in the right
order" to "`pnpm dev:mac`, restart Word once." The loader is not covered by the vitest
suite (it orchestrates real processes); it was validated manually — guard fires on non-Mac,
sideload lands at the correct path, both children spawn with prefixed logs, SIGINT tears
down cleanly with no orphans. The actual GitHub repo creation and first push require the
user's credentials and cannot be done from the build environment; the repo is prepared and
the exact push commands are provided separately.

**Alternatives.** `concurrently` for the two servers (rejected: a dependency for something
~40 lines of `spawn` handles, against this project's minimal-surface preference). Full
`pnpm check` in CI (rejected per the chosen lighter gate — revisit if CI ever needs to catch
lint/format regressions that slip past local runs). `office-addin-debugging` for sideload
(rejected: not installed, and the `wef` sideload is a two-line `mkdir -p` + `copyFile` that
needs no extra package). Private repo (rejected: chosen public).

## ADR-020 — Local knowledge base (RAG): companion indexer + ContextProvider pipeline

**Status:** Accepted (Phase 11, 2026-07-22). Revised after review — open questions resolved,
and a multi-collection model + per-document binding folded in (see _Collections & document
binding_).

**Context.** RAG is a post-v1 seam in ARCHITECTURE.md §16 ("context assembly is isolated in
useGeneration's build-request step; add a ContextProvider[] pipeline there") and the §16
backlog. The goal: a user points GRETTA at a folder of PDFs/DOCX; content is parsed,
chunked, embedded locally via Ollama, and stored on-device; at generation time relevant
chunks are retrieved and injected into the request, with visible provenance for citation.
Two hard constraints shape every choice. (1) The task pane runs in a sandboxed webview with
no filesystem access, so parsing/embedding/storage cannot live in the pane — they need a
local companion process, a sibling to the Ollama HTTPS proxy (ADR-008). (2) The system stays
fully local: the only network peers remain the user's Ollama daemon and this new companion.
A prior companion (the proxy) shipped a certificate start-order bug, fixed by
self-provisioning; this ADR designs the new companion's startup explicitly so that class of
bug does not recur.

**Decision.**

_Topology._ Two new units. A browser-safe webview service, `services/knowledgebase/`,
mirroring `services/ollama/` (interface + Zod schemas + client + own transport seam, single
`fetch` call-site, injected via the composition root). And a Node companion, `scripts/kb/`,
sibling to `ollama-https-proxy.mjs`, owning folder scanning, parsing, chunking, embedding,
storage, and a small local HTTP API (`/health`; `/collections` CRUD; `/query` scoped by
collection id; per-collection NDJSON progress). The pane never touches disk; it speaks HTTP to the companion exactly as it speaks
HTTP to Ollama. The two realms share one source of truth for wire shapes via
`types/knowledgebase.ts` (the companion imports them `import type`, erased at runtime), so
the boundary cannot drift.

_Companion authored in TypeScript, run on Node's native type stripping._ The chunker and
retrieval scorer are the algorithm-heavy new code and must be strict TS and unit-tested per
§14 — but they execute in the companion (Node), not the pane. Rather than duplicate them or
lose type-safety in a `.mjs`, the companion is authored as `.mts` and run directly by Node
(`node --experimental-strip-types scripts/kb/server.mts`; the flag is a no-op on Node ≥ 22.18
where stripping is default, and required on the 22.13–22.17 part of our `engines` floor).
This needs no bundler and no new runtime dependency. It imposes one rule the codebase's
existing `verbatimModuleSyntax`/`isolatedModules`/strict style already follows: only
_erasable_ TS — no enums, namespaces, or constructor parameter properties. (The in-container
rehearsal caught one parameter-property slip immediately, confirming the guardrail; a lint
rule enforcing it is in the wiring below.) The pure modules (`chunk.mts`, `score.mts`,
`progress.mts`) import nothing platform-specific and are unit-tested in the normal vitest
suite via an added `scripts/kb/**/*.test.mts` glob — the same "pure logic is tested TS"
discipline as `services/ollama/ndjson.ts`.

_Chunking._ Structural, provenance-preserving, character-budgeted. Parsing (impure,
format-specific) emits an ordered `SourceBlock[]` carrying a locator — page for PDFs
(pdf.js), paragraph index otherwise (mammoth for DOCX, blank-line paragraphs for text). The
pure chunker groups blocks greedily to a soft target of ~2 000 characters (~512 tokens;
characters are a stable, tokenizer-free proxy) with ~256-character word-aligned overlap for
retrieval continuity, and pre-splits any single block over a 3 000-character ceiling on
sentence→whitespace→hard boundaries. A chunk's citation is the locator of its first _primary_
block; overlap carried from the previous chunk does not move the citation. Character budgets
over token budgets because embedding models differ in tokenizer and the companion should not
depend on one; the sizes are defaults, not constants.

_Storage + size threshold._ Durable SQLite (better-sqlite3) from the start. A `collections`
registry (id, name, source folders, embedding model, timestamps) plus a `chunks` table keyed
by (collection id, source path, content hash) holding text, locator, and the embedding blob.
Durability buys incremental re-embedding and survives restarts; the collection id makes every
row scopable to a specific knowledge base. Ranking is brute-force cosine over the queried
collection set up to a size threshold, above which sqlite-vec ANN takes over _behind the same
ranking contract_ (`score.mts`'s `topK`). Threshold (post-review): brute-force below **30 000
chunks** in the queried set, ANN above. Rationale: a 768-dim float32 vector is ~3 KB, so
30 000 chunks ≈ 90 MB resident and a full scan is single-digit-ms in native code,
low-tens-of-ms in JS — fine for the target corpus. Capacity is reported per collection
(`chunkCount` against the 30 000 ceiling → a percentage the UI surfaces, so a user always sees
how full a knowledge base is). This keeps the native-dependency surface to one well-supported
module and defers sqlite-vec's extension-loading complexity until a measured need. All
candidate dependencies are local and do no network I/O: pdf.js, mammoth, better-sqlite3, and
(deferred) sqlite-vec; embeddings go to the already-approved local Ollama peer. Nothing phones
home.

_Companion startup sequencing (the anti-bug)._ (a) TLS self-provisions through
office-addin-dev-certs — the exact mechanism the dev server and proxy use, generating a cert
when missing — so companion/dev start order is irrelevant by construction; file-on-disk
fallback, then a friendly exit, then plain-HTTP loopback (`GRETTA_KB_INSECURE=1`) for
Chromium hosts (Windows/web) and CI. The pane reaches the companion over HTTPS on Mac for the
same mixed-content reason as Ollama (ADR-008), so HTTPS is the default. (b) The data
directory is created on boot; no other service need have run. (c) Ollama is _optional at
boot_: the companion serves `/status` immediately and, if embeddings are unreachable, reports
an `ollama-unreachable` phase and retries — it never crashes on a missing daemon, so there is
no boot-ordering dependency between the companion and Ollama. (d) The pane never blocks on
the companion: if it is down, the KB toggle shows guidance (mirroring the Ollama
ConnectionBanner) and generation proceeds without retrieved context.

_ContextProvider pipeline (the integration point)._ A new additive stage in `useGeneration`'s
build-request step, exactly where §16 reserved it. After the existing Office-variable capture
and before the pure `buildChatRequest`, `runContextProviders(providers, request)` runs
registered providers concurrently; each returns a `ContextBlock` (`{ label, text, sources }`)
or null. The KB provider (in `features/knowledgebase`, consumed by `ai` through the feature
barrel) reads the collection ids bound to the active document, queries the KB client top-k
scoped to those collections with the user's prompt as the retrieval query, and formats the
chunks into a labeled block with per-chunk provenance. A document with no binding retrieves
nothing — RAG simply contributes nothing and generation proceeds. `buildChatRequest` gains
an optional assembled-context parameter prepended to the user message, keeping its pure,
snapshot-tested contract intact. Retrieved `RetrievedChunk[]` (source, page/paragraph,
snippet, score) are captured into the stream store at `start()` and rendered as a "Sources"
list in `ResponseView`. Crucially, the Office-variable capture is _not_ reframed as a
provider: doing so would churn the M1 request-building contract and its per-built-in payload
snapshot tests (ADR-015/Phase 8) for no benefit. Retrieval is best-effort — a provider that
fails, times out (4 s ceiling), or returns nothing contributes nothing and never breaks
generation.

_Collections & document binding (post-review)._ A knowledge base is not global — it is a
named _collection_ backed by one or more folders with its own embedding model. Different
documents bind to different collections; any set of documents that should draw on the same
material binds to the _same_ collection, and because the binding is part of the file, a
template that carries one passes it to every document created from it. The binding lives _in the document_, not in app
state: `Office.context.document.settings` persists the bound collection ids inside the .docx
and saves them with the file, so the association survives copy, rename, and move, and travels
with the document (resolving on another machine against that machine's like-named collection).
Collections are managed globally against the companion (create, point at folders, choose
model, delete); the pane binds the active document to a subset, and retrieval scopes to that
set — ad-hoc cross-collection querying is a later nicety, not v1. Because the embedding model
is a property of the collection, the configurable-model guardrail applies per collection:
changing a collection's model re-indexes that collection only, and an app-level default model
seeds new collections.

_State + prompts._ A colocated `features/knowledgebase/` store (ADR-005) owns the enable
toggle, the collection list mirrored from the companion (name, folders, model, chunk count +
capacity %, phase), and the active document's binding (read from / written to
`Office.context.document.settings`); companion _health_ is a TanStack query like Ollama's and
index _progress_ streams per collection into the store. Built-in prompt templates are
untouched — retrieved context is injected by the pipeline, not by `builtins.ts` — so
`docs/PROMPTS.md` needs no change for this feature. _Scope note:_ this ADR assumes today's
single-shot generation model (each pane action is one prompt→response; retrieval is keyed on
the current prompt). The weakness of the multi-"conversation" view under that model is a
separate concern, addressed in its own ADR rather than folded into RAG.

**Alternatives.** Companion as plain `.mjs` like the proxy (rejected: loses strict typing and
shared types on the most algorithm-heavy new code — chunking/scoring — where types and tests
earn their keep; the erasable-TS rule is a small price). A build/transpile step or a `tsx`
dependency to share logic (rejected: a build artifact or dependency for something Node now
does natively). Chunker/scorer in `src/services` imported by the companion (rejected:
cross-realm value imports of `.ts` plus the browser-safety boundary; keeping impure companion
code out of `src/services` is cleaner — only `import type` crosses). A native companion app
or Electron (rejected as in ADR-008: it is a Word add-in, not an app; destroys "sideload a
manifest" simplicity). File System Access API from the pane (rejected: unavailable/unreliable
in the Office webview sandbox across hosts — the whole reason the companion exists).
Flat-file JSON vector store (rejected as default: no incremental update, unwieldy past a few
hundred chunks). sqlite-vec from day one (deferred: extension-loading complexity before a
measured need). Reframing Office capture as a provider (rejected: needless churn to a tested
contract).

**Consequences.** GRETTA gains local RAG with cited provenance while staying fully local
and keeping every architectural rule (service isolation, single `fetch` call-site, colocated
store, import boundaries). New surface to maintain: one companion process, one webview
service, one store, and a small config/lint/build wiring delta. The companion needs Node ≥
22.13 (already the `engines` floor) and adds better-sqlite3's native build (prebuilt binaries
cover common platforms; documented in setup). The erasable-TS constraint on `scripts/kb/` is
lint-enforced. The size threshold is measure-then-tune. Collections add a small registry
table, a CRUD surface on the companion, and document-embedded bindings via Office settings;
the trade is that a knowledge base becomes a first-class, shareable object rather than one
global folder. The conversation/history model is tracked separately (see the scope note) and
does not gate RAG.

**Open questions — resolved (post-review, 2026-07-22).**

1. _Reindex on change → incremental._ The (collection, path, contentHash) key lets a watcher
   event re-embed only the changed file (delete its rows, re-chunk, re-embed, insert);
   deletions drop rows; a full rebuild happens only on a collection's embedding-model change
   or a schema bump. A debounced watcher absorbs editors' multiple writes per save.
2. _Max corpus size → 30 000 chunks (the prior 20 000 + 50 %)._ Applied as the
   brute-force/ANN threshold on the queried set (~90 MB at 768-dim). Capacity is surfaced per
   collection as `chunkCount / 30 000`, so a user always sees how full a knowledge base is.
3. _Folder-selection UX → accepted for now, flagged to revisit._ A typed/pasted absolute path
   per collection (with a `GRETTA_KB_FOLDER` companion override for the first). A better
   picker / trust-boundary UX is recorded as a Phase 11 revisit item.
4. _Embedding model → configurable with guardrail._ Per collection (an app-level default,
   `nomic-embed-text`, seeds new ones). Changing a collection's model invalidates its stored
   vectors and forces a full re-index of that collection; the stored model header detects the
   mismatch on boot and rebuilds.

**Skeleton results (rehearsed in-container, 2026-07-22).**

- _Pure logic_ (node:assert harness mirroring the shipped vitest specs): chunker grouping +
  word-aligned overlap + first-primary-block provenance + oversized-block sentence splitting;
  cosine identity/orthogonal/opposite/zero/length-mismatch; top-k ordering + `minScore` floor
  - stability + no-mutation; NDJSON progress round-trip + typed parse errors; provider
    pipeline order-stability + null/timeout/throw dropping + labeled assembly — all pass.
- _Companion server:_ `/health` ✓; `POST /config` starts indexing ✓; `/status` reaches
  `ready` with folder-relative provenance ✓; `POST /query` ranks the on-topic chunk first
  with source + page/paragraph + score ✓; 400/404/204-preflight paths ✓; data dir
  self-provisioned ✓; boots with no Ollama present (Ollama-optional) ✓.
- _Transport:_ HTTPS termination via the office-addin-dev-certs→file fallback ladder ✓
  (`curl -k /health`); EADDRINUSE guard exits with guidance ✓. Type stripping verified
  unflagged on Node 22.22 and flag-accepted for the 22.13 floor.

**Amendment (2026-08-04) — retrieval rewrite closes the gap to the documented number.**
This document's storage section claimed "a full scan ranks in low-tens-of-ms," but the
code path it described did not: `allChunks` boxed every stored `Float32Array` blob into a
`number[]` via `Array.from` on every query, and `topK` recomputed both vectors' norms
from scratch on every comparison even though the stored norms never change. Measured
end-to-end (decode + score + sort, one machine, median of 7 runs, 768-dim vectors):

| Chunks | Old (`allChunks` + `topK`) | New, warm (`topKPacked`, cached matrix) | Speedup |
| ------ | -------------------------- | --------------------------------------- | ------- |
| 3,000  | 35.7 ms                    | 1.9 ms                                  | ~19x    |
| 10,000 | 125.6 ms                   | 5.9 ms                                  | ~22x    |
| 30,000 | 375.3 ms                   | 17.6 ms                                 | ~21x    |

Absolute numbers are machine-dependent, but the qualitative result — a ~20x-plus win,
landing warm retrieval at the 30,000-chunk ceiling inside the "low-tens-of-ms" this
document always claimed — is not.

_What changed._ `SqliteStore.chunkVectors` packs a collection's vectors into one
contiguous, L2-normalized `Float32Array` (rows whose blob length disagrees with the
collection's dimension — leftovers from a model change — are skipped, never scored).
`score.mts`'s `topKPacked` scores it with a bare dot product per row (both sides
pre-normalized) and a bounded insertion into two fixed-size arrays sized `min(k, count)`,
instead of a full sort of every row. Blobs stay exactly as they are on disk — no storage
migration, no reindex required to benefit. `CollectionIndexer` caches the built matrix
per instance, building it lazily on first `query()` and invalidating it on every write
path (`replaceFile`, `removeFile`, `clearCollection`, `setConfig`, and unconditionally at
the start of every `reindex()`) so a stale cache can never outlive the write that would
make it wrong. `allChunks` and `topK` are unchanged and still exported — `allChunks` has
other callers, both remain covered by their own tests — but production retrieval no
longer calls either.

_Output equivalence, the criterion that matters most here._ Verified directly at each
size above, not just by the shared `score.test.mts` suite: `allChunks`+`topK` and
`chunkVectors`+`topKPacked` were run against identical stored data and an identical query
vector, and the resulting top-8 chunk texts, in order, were identical at all three sizes.
Retrieval drives citation provenance, so this was checked before anything else.

_Memory._ The cached matrix is `count * dims * 4` bytes — 92.2 MB at the 30,000-chunk
ceiling and 768 dims, matching this document's original estimate. That memory is held
once per collection per companion process lifetime, not allocated and discarded on every
query the way `allChunks`'s `Array.from` was.

_The 30,000 threshold is now provisional._ It was set against an implementation that was
this much slower than it needed to be; now that "low-tens-of-ms" is real at that ceiling
rather than aspirational, whether 30,000 is still the right number — or whether a faster
floor changes the sqlite-vec calculus — is an open re-measurement rather than a decision
made here. `KB_MAX_CHUNKS` is unchanged by this amendment.

`store.sqlite.mts`'s docstring is corrected to attribute the low-tens-of-ms claim to the
`chunkVectors` + `topKPacked` path specifically, rather than to the module in general —
`allChunks` remains the slower, unoptimized shape it always was.

**Amendment (2026-08-04) — the capacity ceiling is surfaced, not enforced.** `KB_MAX_CHUNKS`
existed only inside `capacityPct()`'s arithmetic and a progress bar — nothing read it as a
limit, so a collection well past it rendered an honest-looking percentage over 100% with no
explanation, and its query latency degraded silently. `CollectionStatus` gains
`overCapacity` (`chunkCount > maxChunks`), computed alongside `capacityPct` in
`CollectionIndexer.status()` and surfaced in `CollectionCard` as a warning `MessageBar` once
a collection crosses the ceiling, naming the fix (split it into topic-scoped collections).
Indexing itself is deliberately never truncated to stay under the ceiling: a silently
dropped source would break the provenance guarantee this feature exists to keep — a
retrieved excerpt is either indexed and citable, or it was never indexed at all, never
quietly omitted past some limit. A user who indexes a large folder gets a working, slower
knowledge base and an honest warning, not a partially-built one.

**Amendment (2026-08-05) — the query is embedded once per model, not once per collection.**
`CollectionRegistry.query()` fanned out to every bound collection in parallel, and each
`CollectionIndexer.query()` independently embedded the same query text. Three collections
sharing an embedding model meant three identical `/api/embed` round trips, fired
concurrently, for one user query.

_What changed._ `registry.query()` now groups the requested collections by
`embeddingModel`, embeds the text once per distinct model via a new
`CollectionIndexer.embedQuery()`, and passes that vector to each collection in the group
through `query()`'s new optional `precomputedVector` parameter. Ranking, merging, sorting
and the top-k slice are untouched.

_Why the grouping key is the model, and why that is not incidental._ An embedding is a pure
function of (model, text), so collections declaring the same model would each have computed
bit-identical vectors — sharing one is not an approximation. Across models it would be
plain wrong, and this ADR's own "vectors from different models are not comparable"
invariant is precisely the rule that makes model the correct grouping key. Retrieval output
is therefore unchanged: the same chunks with the same scores, so everything downstream —
including ADR-025's prompt-budget trimming — behaves exactly as before. This is a
network-avoidance change only.

_Empty collections must not start embedding._ A collection with no indexed chunks returns
from `query()` before it embeds, so it never cost an embed call. Grouping naively would let
an empty collection lead a group and embed a vector nothing consumes — loading a cold
embedding model into memory for nothing, which is worst on exactly the low-RAM machines this
change is meant to help. Collections are filtered on a new `hasChunks` getter before
grouping, preserving the previous behaviour: no content, no embed.

_Resource effect._ Strictly downward on every axis. One shared vector rather than N
identical copies; one embed request per model rather than N concurrent ones (the previous
`Promise.all` put N simultaneous requests on the daemon); and, since `Promise.all` rejects
on any failure, N chances to fail become one.

## ADR-021 — Generation history replaces the multi-conversation model

**Status:** Accepted (Phase 12, 2026-07-23)

**Context.** The pane presents "conversations" — a list of threads, each openable, renameable,
and exportable. But generation is single-shot by design (ARCHITECTURE.md §11.1, "Request scope
(M1)"): each run sends a system message plus one user message, and prior turns are never
resent. A thread therefore accumulates entries that never influence one another, and the
multi-conversation view implies a continuity the engine does not provide. Phase 11 sharpens
the mismatch: retrieved knowledge-base context is scoped to one prompt and one set of sources
(ADR-020), so provenance is per-run, not per-thread.

Two directions were possible: make conversations real (resend history, add turn management,
context-window budgeting, per-turn provenance), or make the UI honest about what the product
actually is. This ADR takes the second, because a document-centric assistant's persistent
context is the _document plus its bound knowledge base_, not a chat log — the useful unit is
"what did I generate, from what, into where", which is a record, not a turn.

**Decision.**

_History of generation records._ Replace the conversation/thread model with a flat, reverse-
chronological list of self-contained records: prompt (and template), response text, model,
generation stats, retrieved `RetrievedChunk[]`, target document range if inserted, and
timestamp. Each record is independently viewable, re-runnable, insertable, and exportable.
Nothing is "continued"; nothing implies shared state between records.

_"Refine last result" instead of turn-taking._ The one genuinely useful multi-step behavior —
"now make it shorter" — becomes an explicit action that starts a NEW single-shot run seeded
with the previous output. It is a fresh record with its own sources, not an appended turn, so
the request contract and the §16 context pipeline are untouched. As built, the previous
response rides along as an optional `priorResult` on `GenerationInput`, appended to the user
message as a delimited `--- previous result ---` block exactly like document context — so a
run without refinement is byte-identical to before, and the built-in payload snapshots
continue to pass unchanged.

_Migration._ Existing persisted conversations flatten to records: each user/assistant message
pair becomes one record, preserving text, model, stats, and timestamps. The storage envelope
version for the conversations key bumps, with the migration living in `storage.service.ts` per
ADR-006. Export keeps working over the flattened shape.

**Alternatives.** Implement real multi-turn chat (rejected for now: turn management, history
resending, and context-window budgeting are a large surface for a task pane whose core actions
are one-shot document transforms; it would also make retrieval provenance ambiguous across
turns). Leave the UI as-is (rejected: it advertises continuity the engine does not deliver,
which is the confusion this ADR exists to remove). Keep threads but hide them (rejected: the
persisted shape would still model something unreal).

**Consequences.** The mental model matches the engine, and every record carries unambiguous
provenance — which is what makes knowledge-base citations trustworthy. `features/conversations`
became `features/history` with a simpler store and no thread lifecycle; rename and "new
conversation" disappeared along with the concept, and `RenameDialog` went with them. Anyone
who wanted a true chat loses it; "refine last result" covers the common case, and real
multi-turn remains possible later as an explicitly-scoped feature rather than an implied one.

Two details worth recording. History is capped at 200 records so a persisted store cannot
grow without bound — the old model had the same exposure and no bound. And every terminal
branch now records, including cancelled and interrupted runs: the partial text is worth
keeping, and `outcome` is what makes a truncated response explicable rather than mysterious.

This is also the first real exercise of ADR-006's migration seam, which had been empty since
Phase 5. The v1 → v2 step is written defensively — it never throws on a malformed payload,
keeps a prompt that never got a reply, and keeps a reply whose prompt is missing, because
losing generated text to a migration is worse than carrying an odd row.

## ADR-022 — Prompt budget: ordering, context window, and corrected defaults

**Status:** Accepted (Phase 12, 2026-07-23)

**Context.** Testing the knowledge base end to end surfaced a failure that looked like a
wiring bug and was not one. With a whole-document context source, the pane cited retrieved
excerpts under the response while the model insisted the material did not exist. The request
was correct — the excerpts were in it — but the prompt exceeded `num_ctx`, and Ollama trims an
over-long prompt from the front. The excerpts were first in the user message, so they were
exactly what got discarded. Provenance is recorded client-side from the retrieval result, so
the pane happily cited text the model had never seen.

Two contributing defaults made this easy to hit. `contextLength` defaulted to 2048 tokens
(~8k characters), which a single document context can exceed several times over; and
`kbDefaultEmbeddingModel` was `nomic-embed-text`, while Ollama reports installed models with
their tag (`nomic-embed-text:latest`), so the default never matched the picker's own list and
showed as "not installed".

**Decision.**

_Retrieved excerpts go last._ In the assembled user message the order is: instruction/template
output, then the document-context block, then retrieved excerpts, then any previous result
being refined. Two reasons point the same way. Truncation eats the front, so the bulky and most
expendable content (a whole document) should be first and the dense, deliberately-retrieved
content last. And attention favours the end of the prompt, so the excerpts land where they are
most likely to be used. With no retrieval the assembled message is byte-identical to before,
which is what keeps the M1 request contract and its per-built-in snapshots valid.

_`contextLength` defaults to 4096._ 2048 is not a realistic working budget for a
document-centric assistant: the document context alone can exceed it, and every token spent on
context is one the retrieved excerpts do not get. 4096 is the smallest default that makes the
common cases behave, and remains conservative on KV-cache memory. Whole-document work on a
long document still wants 8192 or more, which the setting exposes.

_`kbDefaultEmbeddingModel` is a tagged name._ `nomic-embed-text:latest`, matching what
`/api/tags` returns, so the Settings dropdown resolves it instead of reporting it missing.

_Migrations only correct untouched values._ Both defaults ship with a `gretta/settings`
v1 → v2 migration that rewrites a stored value **only when it still equals the old default**.
A value the user deliberately chose is theirs; silently overwriting it would be a worse bug
than the one being fixed.

**Alternatives.** Put excerpts first, as most RAG examples do (rejected: it is precisely the
position that gets truncated here, and the failure is silent). Cap or summarise the document
context to fit the budget (rejected for now: it changes what the user asked to be sent, and
the ordering fix addresses the observed failure without touching semantics — worth revisiting
if the budget is exceeded often). Warn in the UI when a prompt likely exceeds `num_ctx`
(deferred: needs a tokenizer estimate the app does not currently have, and is a good follow-up
now that the ordering makes overflow non-catastrophic). Leave defaults alone and document them
(rejected: a default that silently degrades the headline feature is not a documentation
problem). Migrate every stored value to the new defaults (rejected: overwrites deliberate
choices).

**Consequences.** Retrieval survives a crowded prompt, and the common failure mode becomes a
truncated document rather than silently-dropped excerpts. Existing installs pick the corrected
defaults up automatically unless the user had already chosen their own. The deeper issue — that
nothing in the app measures the prompt against `num_ctx` — is unaddressed and now the main
remaining sharp edge: a sufficiently long document can still crowd out the excerpts, just less
easily. A token-budget estimate with a visible warning is the natural next step.

## ADR-023 — Stream timeouts measure silence, not total generation time

**Status:** Accepted (Phase 12, 2026-07-23)

**Context.** Rewriting an abstract against a 21-document knowledge base with a 32B reasoning
model failed twice in a row with "The connection to Ollama was interrupted mid-generation."
Nothing was wrong with the connection. `composeAbort` armed a 120-second timer when the
request was issued and only cleared it in the `finally` block that runs after the stream
completes, so the timer was a wall clock on the **entire generation**. At 120 seconds it
aborted the fetch, the body read failed, the caller's signal was not aborted, and the failure
surfaced as an interrupted connection.

Any generation slower than the window died, deterministically. That is not an edge case: a
32B model streams slowly, a reasoning model emits a long thinking block before its first
useful token, time-to-first-token includes loading tens of gigabytes from disk, and retrieved
excerpts lengthen the prompt that has to be processed first. The feature set actively pushes
users toward exactly the generations this killed.

Two further faults sat behind it. The reader-cancel listener watched only the caller's signal,
so when the timeout fired against a transport that ignores `AbortSignal` nothing unstuck the
pending read — the timeout armed, aborted, and hung. And the Mac HTTPS proxy set no timeouts
at all, inheriting Node's 300-second `requestTimeout`: a second, independent wall clock that
would have produced the same symptom once the first was lifted.

**Decision.**

_The timeout measures silence._ `ComposedAbort` gains `resetTimer()`, and the NDJSON pump
restarts the clock every time bytes arrive. A generation may run for as long as it likes
provided it keeps producing output; only genuine silence trips the timeout. The default
window rises to 300 s, sized for a cold load of a large model plus prompt processing before
the first token — not for the length of the response, which is now unbounded.

_A timeout says so._ Silence produces "Ollama stopped sending data for Ns. The model may have
stalled or run out of memory" rather than blaming the connection, in both the throwing and
the closed-stream paths (cancelling a reader surfaces as a clean end-of-stream, so the branch
that reports a truncated response has to check for it too). Partial text is preserved either
way.

_Cancellation is driven by the composed signal._ The reader-cancel listener moves from the
caller's signal to the composed one, so it fires for a user cancel and for the timeout alike.
This is what makes the timeout enforceable regardless of whether the transport honours
signals — behaviour the fixture tests depend on and real `fetch` happened to mask.

_The proxy stops enforcing a duration._ `requestTimeout`, `headersTimeout`, `timeout`, and
per-socket timeouts are disabled in `ollama-https-proxy.mjs`. It is a loopback pipe to a local
daemon; it has no business deciding how long a model may think, and the client's idle timeout
plus the user's Stop button already bound the wait.

**Alternatives.** Raise the wall clock to a bigger number (rejected: it only moves the cliff,
and any fixed total budget is wrong for a local model whose speed varies by two orders of
magnitude across hardware and model size). Make the total timeout a user setting (rejected as
the primary fix: it asks the user to predict generation time, which is the thing they cannot
know; the idle window needs no such guess). Drop the timeout entirely and rely on Stop
(rejected: a genuinely wedged daemon would spin forever with no feedback).

**Consequences.** Long generations — large models, reasoning models, long prompts — work.
Detecting a truly dead connection now takes up to the idle window rather than the old fixed
budget, which is an acceptable trade because Stop is always available and the pane stays
responsive. The timeout is now enforceable against any transport rather than only those that
honour abort signals. Two independent duration caps are gone; the remaining bound on a
generation is the user's patience.

## ADR-024 — Rebrand to GRETTA, with a one-time adoption path for existing data

**Status:** Accepted (2026-07-23)

**Context.** The project is being re-established as a distinct tool — GRETTA, _Generative
Research Engine for Technical Text Authoring_ — in its own repository, rather than continuing
as the previous Word-and-Ollama-specific assistant. The name change is not cosmetic: it
widens the framing from "a local Ollama add-in for Word" to a research-writing platform, and
it needs to be unambiguous which tool a given install, manifest, or index belongs to.

A rename touches more than strings. Four identifiers are load-bearing, and changing them
naively loses user data silently: the localStorage keys holding settings, prompt library, and
generation history; the Office document-settings key that records which knowledge-base
collections a `.docx` uses; the add-in `Id` GUID in the manifest, which is how Word
distinguishes one add-in from another; and the companion's data directory.

**Decision.**

_Everything is renamed, including the identifiers._ Storage keys become `gretta/settings`,
`gretta/history`, `gretta/prompts`; the document binding key becomes `gretta:kbCollections`;
the companion's data directory becomes `~/.gretta`; environment variables become `GRETTA_*`;
the shell element id becomes `gretta-app`. Leaving old names in place would make the split
half-hearted and permanently confusing. The history key is also corrected while renaming:
it was still literally `wordllama/conversations` for migration reasons (ADR-021), and a
rebrand is exactly the right moment to retire a name that had already stopped describing its
contents.

_A new add-in GUID._ The manifest gets a freshly generated `Id`. Word keys sideloaded add-ins
by that GUID, so reusing it would make GRETTA and its predecessor the same entry — installing
one would replace the other, and a user could not run both while migrating.

_Existing data is adopted once, not abandoned._ On first read of a `gretta/*` key with no
value, the previous build's `wordllama/*` value is copied across **raw**, so the versioned
migrations then run exactly as they normally would. Document bindings get the same treatment:
if a `.docx` has no `gretta:kbCollections` setting, the legacy key is read and adopted. The old
values are left in place, so the previous build keeps working if it is still installed.

_The compatibility surface is one file and two call sites._ `services/storage/legacy.ts`, its
call in `storage.service.ts`, and `LEGACY_KB_BINDING_KEY` in the knowledge-base feature. It is
documented as deletable for anyone who wants a clean break.

**Alternatives.** A hard break with no adoption (rejected: it silently resets settings and
prompt libraries, and — worse — unbinds knowledge-base collections _inside documents the user
owns_, which looks like data loss in their own files rather than an app reset). Keeping the
old key names behind the new brand (rejected: the ambiguity is the thing the rename exists to
remove). Reusing the manifest GUID (rejected: it makes the two add-ins indistinguishable to
Word). A migration that deletes the legacy values after copying (rejected: it would break the
previous install, which a user may still be relying on during the transition).

**Consequences.** GRETTA is a genuinely separate add-in: it can be installed alongside its
predecessor, has its own index directory, and shares no identifiers. Users carry their
settings, prompts, history, and document bindings across without doing anything. The cost is
a small, clearly-fenced compatibility module that references the old name — deliberate, and
easy to remove once it has served its purpose. The broader product direction implied by the
new name (literature search, non-Ollama backends, plugins) is **not** implemented; it is
recorded in ROADMAP.md as direction, and the README states plainly what exists today so the
public repository does not overclaim.

## ADR-025 — Prompt budget: estimate, allocate, and report

**Status:** Accepted (Phase 13, 2026-07-23)

**Context.** ADR-022 fixed the symptom of an over-long prompt — retrieved excerpts were being
truncated away by Ollama while the pane went on citing them — by moving excerpts behind the
document-context block, where the front-trimming lands last. It explicitly left the cause
open: nothing in GRETTA measures the assembled prompt against `num_ctx`. With one context
provider and a 4096-token default that is survivable. Phase 15 adds a second provider
competing for the same window, and two providers contending for an unmeasured budget is the
same silent failure with more ways to reach it. The budget has to exist before that.

Exact counts are not available. Ollama has no tokenizer endpoint — the feature request has
been open for years — so the only true measurement is `prompt_eval_count`, which arrives in
the `done` event _after_ a generation has already run.

**Decision.**

_Estimate conservatively, then learn._ Prompt size is estimated as characters ÷ a per-model
ratio, starting at a deliberately pessimistic 3.6 characters per token so the estimate
over-states rather than under-states: over-estimating costs a little retrieval headroom,
under-estimating silently truncates, which is the failure being prevented. The ratio is then
calibrated from reality — every completed generation folds its `prompt_eval_count` into an
exponential moving average for that model, persisted so accuracy survives a restart. Samples
that cannot be trusted are rejected rather than absorbed: prompts too small for template
overhead to wash out, and the implausibly high ratios that Ollama's prompt caching produces
when it reports only the uncached suffix.

_Reserve room for the reply._ `num_ctx` covers prompt and response together, so the prompt
budget is the window minus a reserved share, exposed as a setting (`responseReservePct`,
default 25 %, bounded 5–60). Without this a prompt can fit perfectly and still leave the model
no room to answer.

_A fixed sacrifice order._ When the assembled prompt exceeds its budget: first the document
context is trimmed (middle-out, keeping the framing and the conclusion, with an explicit
marker saying how much was removed); then, only if that is not enough, retrieved excerpts are
dropped whole, lowest-scoring first; the instruction is never trimmed. Excerpts deliberately
outrank the document: they are small, they were selected _because_ they matched, and dropping
them while continuing to cite them is exactly the bug this work exists to prevent. Retrieval
also gets a share cap (50 % of the prompt budget) so it can never crowd the document out
before the document has been considered at all.

_Overflow blocks; trimming proceeds and says so._ If the instruction alone will not fit,
nothing is sent — a prompt stripped of its instruction is not a smaller request, it is a
different one — and the user is told how many tokens were needed against how many were
available. Otherwise the request proceeds and the response pane names exactly what was given
up. When usage is high but nothing was sacrificed, the pane shows the percentage used; below
that it stays quiet, because a meter that is always visible in a narrow pane is noise.

_Dropping an excerpt re-renders its block._ The block's text is rebuilt from the excerpts that
survive, so the text sent to the model and the sources cited under the response can never
disagree.

**Alternatives.** Bundle a tokenizer such as tiktoken (rejected: it encodes GPT's vocabulary,
not Llama's or DeepSeek's, so it would be confidently wrong for the models GRETTA actually
runs, while adding a dependency). Ship per-model tokenizer files (rejected: large, and stale
the moment a user pulls a model we have never seen). Send the prompt and read
`prompt_eval_count` to decide whether to send it (rejected: that _is_ sending it). Trim the
document from the tail (rejected: middle-out keeps both framing and conclusions, and the
marker tells the model material is missing rather than leaving a non-sequitur). Block on any
trim (rejected: hostile mid-flow, when the trim is usually harmless). Always show a context
meter (rejected as the default: the pane is ~320 px wide and a permanent gauge earns its space
only when it is close to mattering).

**Consequences.** Overflow is now measured and reported instead of discovered later, and
retrieved excerpts can no longer be the silent casualty. Estimates start conservative and
converge on each model's real tokenisation within a few generations. The estimate remains an
estimate — a badly wrong ratio on an unusual model could still under-count — but the reserve
and the conservative starting ratio both bias toward safety, and the failure mode is now a
visible trim rather than an invisible one. Phase 15 can add a second provider against a budget
that exists.

## ADR-026 — Markdown in, plain prose out; and the brand mark

**Status:** Accepted (Phase 14, 2026-07-23)

**Context.** Models emit Markdown whether or not anyone asked them to. The pane rendered it as
raw text and the document received it verbatim, so a heading arrived as `## Results` and
emphasis as `**effect**` — in a manuscript. This is not cosmetic: it is visible in every single
generation and has to be cleaned by hand each time.

The obvious fix — render the Markdown — collides with §13.1, which mandates `insertText` only
and treats model output strictly as data. That rule exists because a language model's output is
attacker-influenceable in a RAG system: a retrieved document can contain instructions or markup.

**Decision.**

_A small reader, not a Markdown library._ Parsing produces a **data structure**, and the
renderer turns that structure into React elements. There is no HTML string and no
`dangerouslySetInnerHTML` anywhere in the path, so model output cannot become markup regardless
of content — the safety property holds by construction rather than by sanitiser correctness. A
library plus a sanitiser would add a dependency, bundle weight, and a much larger surface, to
support syntax models rarely emit. The supported subset is headings, emphasis, inline and
fenced code, ordered and unordered lists, quotes, and rules; anything unrecognised stays text.

_Links render inert._ A link is shown as its text followed by the visible URL, never as a
clickable anchor. A model-generated clickable link inside a Word task pane is a phishing vector,
and the destination is more useful visible than hidden behind text anyway.

_Formatting is resolved before insertion, not carried into the document._ `insertText` remains
the only path into Word (§13.1 stands), but the text is now converted from Markdown to clean
prose first: headings lose their hashes, emphasis loses its asterisks, lists keep their markers,
code stays verbatim, and links keep their destination in parentheses. This removes the visible
defect without relaxing the security rule at all.

_Rich insertion is deferred, deliberately._ Inserting real Word formatting means either
`insertHtml` or generated OOXML. Both are defensible when the markup is generated from our own
parsed structure with escaped text, but neither can be verified anywhere except in Word, and
shipping an unverifiable path into a user's document is a worse trade than plain prose that is
demonstrably correct. It stays a follow-up with this reasoning recorded.

_Streaming renders raw._ Mid-stream text is syntactically incomplete — a half-written fence or
an unclosed asterisk — so formatting is applied only once the run reaches a terminal state.

_Embedding models are matched by name._ `/api/tags` reports no capabilities and probing
`/api/show` per model would cost one request per installed model on every panel open. Names are
matched against a hint list instead, and because that list is necessarily incomplete the filter
falls back to the full list rather than presenting an empty picker.

_Brand._ The Office icons come from the supplied knowledge-graph mark. At 16 and 32 pixels the
node graph collapses into an unreadable blob, so those sizes use a simplified glyph in the same
palette; 64 and above keep the full mark. The pane header uses the mark plus a letter-spaced
wordmark, styled through weight and spacing rather than colour so it survives the light, dark,
and Match-Word themes.

**Alternatives.** `react-markdown` with `rehype-sanitize` (rejected: dependency and bundle cost,
and it makes safety contingent on a sanitiser's correctness rather than on the shape of the
pipeline). Stripping Markdown everywhere including the pane (rejected: the formatting is
genuinely useful to read). Rendering formatted output into Word via `insertHtml` now (rejected:
unverifiable outside Word, and it would relax §13.1 for a benefit that plain prose already
mostly delivers). Probing `/api/show` for embedding capability (rejected for now: N requests per
panel open; revisit if the hint list proves inadequate).

**Consequences.** Every generation now reads properly in the pane and lands cleanly in the
document, with no change to the security posture. The Markdown subset is ours to maintain, and
unusual syntax degrades to text rather than breaking. Rich formatted insertion remains open, and
the parsed structure this ADR introduces is exactly what a future OOXML writer would consume.

## ADR-027 — The task pane is short, and the layout has to admit it

**Status:** Accepted (Phase 14, 2026-07-23)

**Context.** A Word task pane is resized by dragging the document edge, and users routinely
squash it to a few hundred pixels tall. Reported from real use at roughly 500 px: the "New
prompt" button overlapped the notice above it, the disabled-Generate tooltip covered the context
picker, the response was crushed to a couple of visible lines, the Sources list was clipped
mid-entry, and the action bar consumed two full rows. There was, as reported, "no good way to
navigate any of the panels".

The cause is structural rather than cosmetic. The chat view stacked seven regions — banner,
notice, composer, context chip, controls, result, actions — of which only the result could flex.
Every other region held its natural height, so all the pressure landed on the one region that
could yield, and it yielded to nothing. Nothing scrolled, because the only scroll container was
inside the region that had been squeezed out of existence.

**Decision.**

_Measure the pane and adapt._ The pane is the window, so `window.innerHeight` measures it
exactly — no `ResizeObserver`, which also means the behaviour is testable under jsdom. Below
560 px (derived from the fixed chrome: header, pickers, composer, controls, and actions leave
under ~150 px for the result) the view switches to a compact layout.

_In compact mode the view scrolls, not the result._ Every region takes its natural height and
the chat view itself becomes the scroll container, so nothing is crushed and everything is
reachable. The inner result scroller is disabled in this mode: nested scroll regions in a 320 px
pane are worse than the problem they solve. Above the threshold the existing layout is
unchanged — fixed chrome with the result scrolling internally, which is the better arrangement
when there is room for it.

_Generation controls stay pinned._ A scrolling view would otherwise scroll Generate and Stop out
of reach, which is the one thing that must always be available.

_Secondary actions collapse into a menu._ Six buttons wrap onto two rows and cost roughly 90 px
that the result needs more. Copy and Insert stay inline; Replace, Refine, Comment, and Export
move behind a "More" menu. Nothing is removed, only relocated.

_The notice loses its embedded button._ The saved-result `MessageBar` carried a "New prompt"
action that overlapped its own body at pane width — a bug at any height, not only in compact
mode. The action is now the single "New prompt" control below, which previously appeared only in
the mutually exclusive case; one control, one place, no overlap.

**Alternatives.** A single scrolling view at every height (rejected: when there is room, keeping
the composer fixed and scrolling only the result is better, and it is the layout that already
works). Switching between separate "compose" and "result" modes below the threshold (rejected
for now: a bigger change, and it hides the result at exactly the moment the user is reading it —
worth revisiting if scrolling proves insufficient). A CSS container query (rejected: the
threshold depends on the summed height of the chrome, which is a component concern, and Griffel
support would complicate a decision that is one arithmetic comparison). Shrinking fonts and
paddings globally (rejected: it buys a little space and costs legibility, in a product used for
close reading).

_Compact regions size to their content._ The first attempt turned the inner result scroller off
but left `height: 100%` on the result root, so its text painted outside a box that was still
constrained and landed on top of the Sources list. Overflow without a scroller and without a
flexible height is an overlap by definition. In compact mode the result root, its scroll region,
and the wrapper around them all size to content and are forbidden to shrink; only the view
scrolls. The other three views were checked and are not affected — each has exactly one
flexible region absorbing the pressure, which is the pattern the chat view now follows too.

**Consequences.** A squashed pane stays usable: everything is reachable by scrolling, the
primary action is always visible, and no control overlaps another. There is one more piece of
responsive state to keep in mind when adding to the chat view, and the 560 px threshold is a
judgement that will need revisiting if the fixed chrome grows — which is itself an argument for
keeping that chrome small. Verified by tests at the boundary and on resize; the visual result
still needs confirming in Word at several pane sizes.

## ADR-028 — Literature discovery goes to the network; the guarantee is reworded, not abandoned

**Status:** Accepted (Phase 15, 2026-07-25)

**Context.** GRETTA's headline promise is that nothing leaves the machine. It is stated in the
README's opening paragraph, restated as "Local by default" in the features list, and encoded in
ARCHITECTURE.md §13.5 ("the only network peers are the user-configured Ollama URL and (when
enabled) the loopback knowledge-base companion") and §13.6 ("Indexed content, absolute folder
paths, and embeddings never leave the machine"). The promise is load-bearing rather than
decorative: it is the reason a user can point a collection at unpublished manuscripts, grant
applications, or confidential drafts without further thought.

Phase 15 adds scholarly search. That requires outbound HTTPS to third-party APIs, so the promise as
written becomes false the moment the feature ships. This ADR settles what is transmitted, what the
guarantee becomes, what the defaults are, and whether anything can leave without an explicit user
action.

Two things about the intended use case reshape the question relative to the assumptions recorded in
`ROADMAP.md` and `docs/PHASE-15-BRIEF.md` §3.

First, **the query is document-derived**. The use case is: highlight a passage, find literature that
supports or contradicts it. The roadmap's working assumption was that a query is a string the user
types, and therefore not document content. A query good enough to find the literature bearing on a
specific claim is one that encodes that claim. Having the local model draft it does not resolve
this; it relocates the authorship of the disclosure without changing the disclosure.

Second, **there are two network surfaces, not one**. Ingesting a paper means fetching a PDF and
writing it to disk. The pane cannot write to disk — the companion does. So `scripts/kb` becomes an
outbound HTTP client, which §13.6 currently forbids by description. The brief addresses only the
pane.

**Decision.**

_The guarantee, reworded._ The following replaces the README's opening claim and its "Local by
default" paragraph, and appears in the same words in the Literature settings section and above the
search box, so that a user cannot encounter a stronger version of the promise than the one that is
true.

> **Local by default.** Your documents, your index, and your embeddings stay on your machine, and
> generation never uses the network. Literature search is the one exception: it is off until you
> turn on a source, it reaches only that source's public API, and it sends only a search query you
> have seen and approved. Your document text is never transmitted.

A short form is used at the point of enabling an individual source, where the consequence must be
stated rather than referenced:

> Turning this on lets GRETTA send search queries to _<source>_ over the internet. Only queries you
> review and send — never your document, your excerpts, or your prompts.

_Generation never touches the network — as an enforced invariant, not a claim._ Literature results
reach a generation only after the user has obtained the full text and indexed it, at which point
they are ordinary knowledge-base documents retrieved by the existing provider. No literature code
runs inside the generation path, and nothing in that path opens a socket. This is asserted by test:
the literature service is constructed with a transport that throws on any call, and a full
generation is driven through it.

_Amended on implementation._ The draft left open (open question 1) whether a
`literatureProvider.ts` was needed at all. **It is not, and the question is now closed.** Following
the two rules above to their conclusion — verified papers become knowledge-base documents,
abstract-only papers never enter a prompt — leaves a second provider with nothing to contribute; it
would return `null` on every call. The remaining candidate use, injecting citation metadata so the
model "knows" what to cite, is the failure mode being guarded against, and Phase 16's citation
insertion is deterministic CSL formatting rather than generation. Consequently Phase 15 does not
touch `useGeneration`, `buildChatRequest`, or ADR-025's allocator, and `services/literature`
exports no provider.

This also corrects a rationale recorded in `ROADMAP.md` and the Phase 15 brief: ADR-025 was
sequenced before this phase because "a second provider competing for an unmeasured budget would
silently starve the first". That reasoning was wrong, but its conclusion was not — ingesting papers
grows the knowledge-base corpus, so retrieval pressure on the context window still rises, through
the existing provider rather than a new one. The budget work was needed; the stated reason was not
the real one.

_What may be transmitted, exhaustively._ A search query the user has seen in its final form and
explicitly sent; public identifiers (DOI, PMID, arXiv id) for metadata lookup and open-access
resolution; the optional contact email that Crossref's polite pool and NCBI request; and a
`User-Agent` naming GRETTA and its version. Nothing else. Specifically never: document text,
verbatim or paraphrased beyond the reviewed query; retrieved knowledge-base excerpts; prompt drafts
or model output; file names, folder paths, or collection names; and any telemetry, usage count,
crash report, or error trace. GRETTA has no analytics endpoint and this ADR does not create one.

_The review gate._ A derived query is drafted by the user's own Ollama — a local operation — and is
then displayed as an editable field containing the exact string that will be transmitted, byte for
byte, not a summary of it. Transmission requires a distinct, deliberate action. Consequently: no
search fires on selection change, no result is prefetched, and **no remote typeahead or
autocomplete exists anywhere in the feature**, because a completion request transmits the prefixes
of a query the user has not finished writing, let alone reviewed. The drafted query is constrained
to keywords and Boolean operators and capped at 256 characters; an over-long query is refused with
an explanation rather than truncated, because a query the length of a paragraph is document text
with extra steps, and the cap is the structural defence that does not depend on the user reading
carefully every time.

_Amended on implementation._ The gate is enforced in the type system rather than by convention.
`ApprovedQuery` is a branded string obtainable only from `approveQuery`, and every search client
accepts only that type, so a raw string cannot reach a network call without passing the checks.
The brand does not and cannot enforce that a human read the string; that remains a UI obligation,
recorded here so the limitation is not mistaken for a guarantee. The cap is measured after
whitespace normalisation, so padding cannot smuggle length past it, and multi-line input is
rejected outright rather than flattened — flattening would transmit a pasted paragraph while
appearing to comply.

_Default state._ A master switch, off. Beneath it one toggle per source — PubMed (NCBI
E-utilities), Crossref, arXiv, bioRxiv/medRxiv, OpenAlex — each off, each enabled individually,
each showing the short-form consequence at the moment of enabling rather than on a settings page
the user may never revisit. OpenAlex is called out separately in its own copy, because it is used
for metadata enrichment as well as search: it receives the identifiers of results being ranked, and
so learns what the user is reading rather than only what they searched for. That is a different
disclosure and is described as one.

_The companion's outbound path, enumerated._ ARCHITECTURE.md §13.6 is amended: the companion binds
to loopback for **inbound** connections, as before, and may now make outbound requests under
conditions that are enumerated rather than general. One PDF per explicit click — no batching, no
queue drain, no background retry, no speculative fetch. Only to an allowlist of open-access hosts
plus a URL returned by an open-access resolver; a URL taken from an arbitrary metadata field is
validated against the allowlist or refused. HTTPS only; redirects followed only within the
allowlist; `Content-Type` must be a PDF; size and time capped. No cookies, no credentials, no
`Authorization` header — ever, by construction rather than by policy. The exact URL is shown in the
pane before the click, so the request is attributable to something the user read. The file lands in
a collection folder the user names, and the existing watcher indexes it. There is no second ingest
path.

_On paywalls, stated plainly rather than worked around._ GRETTA fetches only what is lawfully free:
arXiv, bioRxiv/medRxiv, the PMC open-access subset, and publisher-hosted full text an open-access
resolver reports as open. It does not attempt to defeat paywalls, does not use shadow libraries,
and does not carry institutional credentials. If the operating system routes traffic through a VPN,
GRETTA's requests follow it, because they use the ordinary network stack; GRETTA neither knows nor
manages this. EZproxy and Shibboleth access will **not** work, because they are granted by a browser
session cookie and the Word webview has its own cookie jar that does not share the user's browser
session. This is documented as a limitation rather than engineered against.

_Two trust tiers._ **Verified**: full text obtained and indexed, citable exactly as any other
knowledge-base document. **Queued**: metadata and abstract only, held in a reading list with a
resolvable link, never injected into a prompt. An abstract states a finding without its conditions,
and a model given abstracts would produce cited claims resting on text it never saw — the same
failure ADR-022 fixed at the mechanical level, reappearing at the semantic one. The queue is the
honest answer to a paywall: GRETTA says what it found and cannot read, and the user decides.

_Caching and its own privacy surface._ Search results cache in the pane's existing `StorageService`
(ADR-006's versioned envelopes), keyed by query and source, with a 24-hour TTL and a bounded entry
count. This cache is a record of what the user searched for and therefore of what they are writing
about; it is treated as sensitive. A single "Clear literature cache and search history" control
deletes it, and the deletion is real rather than a hidden flag. Fetched PDFs are ordinary files in a
collection folder. Generation history (ADR-021) records which papers informed a generation, never
the query that found them.

_CSP and `AppDomains`._ Both are added in this phase rather than after it. The manifest gains an
`AppDomains` element; external links open in the system browser via `Office.context.ui`, never by
navigating the pane, which would discard state and create a phishing surface inside a trusted
frame. `connect-src` enumerates `'self'`, the companion origin, the Office CDN, and the literature
origins. Two honesties: the enumeration must include disabled sources because CSP is static and the
toggles are not, so **CSP bounds the blast radius to a known host list while the per-source toggle
is enforced in the service layer** — the toggle is the security control, the CSP is the backstop.
And the user-configurable Ollama URL cannot be enumerated at build time, which is why ADR-009
already places the policy at hosting time; this ADR does not change that.

_Rate-limit etiquette._ Each client encodes its own source's published limits in one place, read
from that source's current policy at implementation time. No limits are recorded in this ADR,
deliberately: a number copied from memory into a decision document acquires authority it has not
earned.

_Amended on implementation._ The refusal to record numbers turned out to be more than caution.
Crossref advertises the limit in force on **every response**, in `X-Rate-Limit-Limit` and
`X-Rate-Limit-Interval`, and revised its limits in December 2025 — the first change since the API
launched in 2013 — so any constant written here would already be stale. Clients therefore read the
advertised limit and adopt it, starting from a deliberately slow fallback pace until a first
response has been seen. A client that starts cautious and speeds up on evidence cannot get a user
blocked; one that starts fast and backs off after a 429 already has. An explicit `Retry-After` is
obeyed in preference to GRETTA's own backoff, since the server has said what it wants.

**Alternatives.** Decline Phase 15 and keep the absolute guarantee (rejected: the capability is
directly useful to the target user, and the promise can be made accurate without being diluted into
meaninglessness — "generation never uses the network" is still a strong claim, and it is true).
Route all literature traffic through the companion so the pane has no outbound origin (the closest
alternative, and genuinely attractive: one audited egress point, a natural home for the cache in
SQLite, and a simpler CSP. Rejected because the companion is optional and may not be running, which
would make search unavailable on a machine where it works fine today, and because it changes where
requests originate without changing what is disclosed). Send the selection verbatim as the query
(rejected: that is document text leaving the machine). Derive and send automatically (rejected:
makes outbound traffic a side effect of highlighting text). Remote typeahead (rejected above).
Inject abstracts as generation context (rejected above). Ship a predatory-journal denylist
(rejected: Beall's list is unmaintained, Cabell's is licensed, and asserting in shipped software
that a named journal is predatory is a legal exposure with no maintained source behind it). Bundle
Journal Impact Factor (rejected: licensed by Clarivate, not redistributable). Use institutional
proxy credentials (rejected: terms of service, credential handling GRETTA has no business doing,
and the webview cannot hold the session anyway).

**Consequences.** The product's central claim changes, and the README, the settings panel, and the
search surface must change in the same commit or the promise fragments. Five new origins enter the
threat model, along with `AppDomains` and a CSP story that needs verification in real Word rather
than jsdom. The companion acquires an outbound path and therefore an audit surface, kept small by
enumeration and by the one-click rule. In exchange, generation remains genuinely offline and now
provably so. The literature cache is a new sensitive artifact that must stay clearable as the
feature grows. Users on EZproxy will get less than they expect, and will be told so. Phase 16 has
the metadata it needs because every client normalises to a CSL-JSON-compatible record from the
first line of code.

**Open questions.**

1. ~~Does Phase 15 need a `ContextProvider`?~~ **Resolved: no.** See _Amended on implementation_
   above.
2. _The 256-character query cap_ is a judgement with nothing behind it yet. It should be checked
   against real derived queries for the intended use case before it is fixed.
3. _Whether the query-drafting model should be user-selectable_ or should reuse `defaultModel`. A
   poor drafter produces poor searches, but a second model setting is a second thing to explain.

**Amended on implementation (the literature cache).** "Caching and its own privacy surface"
above is now built, in `src/features/literature/cache.ts`, as a new `gretta/literature-cache`
slot in the existing `StorageService` (ADR-006's versioned envelopes) rather than a TanStack
Query cache — an in-memory cache would not survive the pane reloading, which happens
constantly in a Word task pane, and would give the required "Clear literature cache and
search history" control nothing durable to delete.

The bound is **20 entries**, evicted oldest-first, on top of the 24-hour TTL the ADR already
specified. Chosen because a cached entry carries full abstracts for up to
`litResultsPerSource` records — the single largest persisted payload in the app after
history — against a `localStorage` budget (~5 MB) shared with settings, history, and
prompts; 20 is generous for one writing session's worth of distinct query/source/filter
combinations without risking that budget.

What is cached is the _retrieved, enriched_ records — including the OpenAlex/PubMed/Crossref
signals and the retraction check, since fetching those is exactly the network cost the cache
exists to avoid — never the ranking. Re-ranking is a local, passage-dependent step (ADR-029),
and the passage can differ between two searches that share a query, sources, and filters, so a
cache hit re-embeds against the _current_ passage rather than replaying an ordering computed
for a possibly different one; only the cache miss path does new network I/O. The cache key
folds in the normalized query text, the enabled source set (order-independent), `fromYear`,
and `litResultsPerSource` — any change to one of those is a miss, by construction, since a
different value means a different request would have been sent.

The clear control lives in `LiteratureSection.tsx` and does two things, both required by the
ADR: `clearCache()` removes the storage key outright (not a tombstone), and
`useLiteratureStore.getState().reset()` clears the in-memory passage, draft, and results — the
store isn't persisted, but leaving the last query on screen after the user asked to clear their
search history would say one thing and show another. This is the one place `features/settings`
imports `features/literature`, alongside the pre-existing reverse edge (`useLiteratureSearch`
already reads `useSettingsStore`), so the two features now import each other — the same
structural shape ADR-017 cut for `settings`/`ai` by moving shared logic into `hooks/`. That
fix doesn't transfer here: the thing being shared (`useLiteratureStore`, `clearCache`) is
literature-owned state and storage access, and `hooks/` may not import `features` at all (only
`services-root`, `services`, `types`, `utils`), so there is nowhere neutral to relocate it to
without a disproportionate refactor for a one-button feature. `boundaries/element-types`
permits feature-to-feature imports, so nothing is lint-broken, and the cycle is inert at
runtime — both cross-imports are only read inside hook bodies and event handlers, never at
module-evaluation time — verified by a clean `pnpm build` with no circular-import warning from
Rollup. Left as a known wart rather than a blocker; worth a `hooks/`-style fix if this shape
recurs a third time.

**Amended on implementation (recent searches).** The cache doubled as a browsable "search
history" from the start of this paragraph's own wording, but nothing exposed it — a
completed search vanished from the pane the moment its results were replaced by the next
one. `listEntries()` (`cache.ts`) lists cached searches newest-first, pruning expired ones on
the way out same as a lookup by key, and `LiteratureHistoryList.tsx` renders them as a
"Recent searches" list in the panel, open by default (it only renders once there is
something to show, so a collapsed-by-default state — right for "Advanced search
parameters" — would just be one more click for the common case here).

Each cache entry now denormalizes `query`, `sources`, `fromYear`, and `resultsPerSource`
alongside the existing fields, rather than the UI parsing them back out of `cacheKey`'s
`JSON.stringify` output — that string is an implementation detail of the key, not a format
worth depending on elsewhere.

_Amended again on implementation._ Clicking a past search was first built to restore the
query into the draft field without searching, reasoning that ADR-028's review gate requires a
distinct, deliberate action before anything is sent. On reflection (and a direct request)
that drew the gate in the wrong place: the row already displays the exact query text that
would be sent, in full, before the click — the same information the draft field shows before
a press of Search — and that query has already been sent once before, reviewed the same way.
The gate's actual requirement is that a query never reaches the network before the user has
seen it; a visible row the user clicks on is not that, so clicking one now restores the query
and year filter and searches immediately. What the gate still forbids, unchanged: nothing
searches on its own from a passage selection, a mount, or a re-render — only an explicit
click, here or on the Search button, ever transmits anything.

**Amended on implementation (a cache hit still re-embedded).** User-reported: repeating a
search still took as long as the first one, because a hit only ever skipped the network —
`rank()` re-embedded the passage and every candidate through Ollama on every hit, which for
an uncached local model is comparable in wall-clock cost to the network round trips the cache
was built to avoid. The re-embed was deliberate, not an oversight: two searches sharing a
query, sources, and filters can still be ranked against different passages, and reusing a
stale ordering would be silently wrong.

The actual repeat case — press Search again with the same selection, or reload a query from
"recent searches" without capturing a new one — has an identical passage too, and for that
case there is nothing to recompute. Each cache entry now also stores `passageHash`
(`hashPassage()`, an FNV-1a hash — non-cryptographic on purpose, since a collision only costs
an unneeded re-rank rather than a wrong one). A hit whose current passage hashes the same
skips `rank()` entirely and delivers the stored ordering as-is; a hit whose passage differs
still re-ranks, exactly as before, and writes the fresh ordering back under the same key so
the _next_ repeat is the fast path too. The passage itself is still never persisted — only its
hash — consistent with keeping it out of every other piece of stored state.

Also fixed in the same pass: the "Searching, checking retractions, and ranking against your
selection…" status line named retraction checking unconditionally, even with that source
(Crossref, gated on `litVerification`) off. It now reads "Searching and ranking…" when
verification is off — a status line should describe what search is _doing_, not what the
feature is capable of when everything is enabled.

**Amended once more (Search itself no longer checks the cache).** The paragraph above says
"press Search again with the same selection... has an identical passage too, and for that
case there is nothing to recompute" — true of the mechanism, wrong about who gets to use it.
User-reported: changing an Advanced parameter that doesn't participate in `cacheKey` (venue
threshold, and ADR-029's citation-impact weight once that shipped) and pressing Search kept
showing the old ranking, because the Search button itself did the cache lookup and a matching
key plus a matching `passageHash` meant "nothing to recompute" even though something the user
had just changed very much wanted recomputing.

The fix draws the line the bug exposed as missing: `search()` (the Search button) now never
reads the cache — it always re-fetches and re-ranks, full stop, and still writes the fresh
result to cache afterward so the _next_ lookup benefits. The instant-reuse path
(`resolveCacheHit`'s passage-hash check) survives only behind a second, separate function,
`reuseSearch`, called from exactly one place: clicking an entry in "recent searches," where
the user is deliberately asking to revisit a known past result rather than asking for a new
one. A press of Search now means what it says regardless of what the cache holds; a click on
a specific past search still means "show me that again, fast."

## ADR-029 — Rank relevance locally, show credibility, never score a paper

**Status:** Accepted (Phase 15, 2026-07-25)

**Context.** ADR-028 deferred ranking deliberately, to keep that document about one thing. This is
that decision. The stated goal is to favour high-impact venues — Science, Nature, Cell Press — and
downplay predatory journals, so that a search returns something a researcher can act on rather than
three hundred undifferentiated records.

The instinct is right about the problem and wrong about the instrument, and the gap matters enough
to state before designing around it.

The problem is real. Triaging a large result set without reading everything requires a prior, and
citing a paper from a fake journal as though it were peer-reviewed is a serious error a writing
tool is well placed to prevent. But journal prestige is a weak predictor of an individual article's
quality — a position the community GRETTA is built for has stated formally in the San Francisco
Declaration on Research Assessment, which argues specifically against using journal-level metrics
to judge individual papers. A tool for scientists that ranks by journal name embeds a judgement its
users have publicly rejected, and does so invisibly.

Three further constraints, two inherited from ADR-028. Journal Impact Factor is licensed by
Clarivate and cannot ship. A predatory-journal denylist has no maintained, redistributable source,
and asserting in software that a named journal is predatory is a legal exposure. And a hard-coded
list of favoured publishers is parochial: GRETTA targets scientific and technical writing
generally, where the leading venues in geophysics, materials science, or pure mathematics share
none of those names, and where a Cell Press imprint means nothing at all.

There is also a hazard specific to the use case. "Find literature that supports or rejects this
passage" is two features, and a tool that serves the first better than the second is a
citation-shopping machine pointed at a manuscript the user has already written.

**Decision.**

_Three axes, never summed._ Relevance ("does this bear on my claim?"), credibility ("should I trust
this record?") and stance ("does it agree?") are distinct questions with distinct evidence and
distinct failure modes. They are computed separately, displayed separately, and never collapsed
into a composite score. A single number is unfalsifiable to the person reading it, encodes contested
weights silently, and cannot be overridden intelligently because there is nothing to disagree with.

_Relevance is ranked locally, against the passage the network never saw._ This is the load-bearing
idea and it inverts the expected privacy trade. ADR-028 sends a broad, reviewed keyword query; that
query is a **recall** instrument and is all the network sees. Precision happens afterwards, on the
device: GRETTA embeds the selected passage and each candidate's title and abstract with the user's
own Ollama, using the already-configured `kbDefaultEmbeddingModel`, and re-ranks by cosine
similarity. The specific claim therefore drives the ordering without ever being transmitted. Being
coarse on the wire is precisely what buys the freedom to be precise on the machine.

Cosine ranking is duplicated as a small pure module in `src/services/literature/rank.ts` rather than
imported from `scripts/kb/score.mts`, because ADR-020 forbids cross-realm value imports. This is a
knowing duplication of roughly twenty lines, tested on both sides, and is recorded here so it is not
later mistaken for drift. When embeddings are unavailable the source's own ordering is kept and the
pane says so, rather than presenting an unranked list as a ranked one. Candidates that cannot be
embedded score zero and sink rather than being dropped: a record the user can see and judge is
better than one that vanished because an embedding call came back short.

_Credibility is a set of named signals, shown and filterable, never summed._ Verified against the
OpenAlex schema: at venue level, `is_in_doaj`, `is_oa`, `type`, `summary_stats.2yr_mean_citedness`,
`summary_stats.h_index`, and `apc_usd`; at work level, `fwci`, `cited_by_percentile_year`,
`citation_normalized_percentile`, `indexed_in`, `type` (which distinguishes an article from an
editorial, letter, or erratum) and `is_paratext`. From PubMed, MEDLINE indexing, which is a curation
decision by NLM's selection committee rather than mere presence. From the record itself: a
registered DOI, complete Crossref metadata, and deposited references.

Each appears as a badge with a tooltip naming what it is and where it came from. Raw citation counts
are never used for ranking, because they bury recent work by construction; the field-normalised and
percentile measures carry that job and the raw count is shown only as context.

One hard rule: **the absence of a signal must look different from a signal not checked.** With
OpenAlex disabled, badges read "not checked", never "absent". Silent degradation of a trust
indicator is worse than no indicator. This is enforced structurally: signals are grouped by the
source that provides them and each group is nullable, so there is no flat bag of booleans in which
the two states could be confused.

_"Downplay predatory journals" becomes a filter on absent signals, not an accusation._ Records that
pass none of the baseline checks — no DOI or Crossref record, not MEDLINE-indexed, venue unknown to
OpenAlex, or a venue charging an APC while absent from DOAJ with negligible citedness — are
collapsed behind a disclosure reading "N further results with limited verification", one click from
view and never silently dropped. GRETTA reports which checks a record passed and which it did not.
It does not assert that a journal is predatory, which gives the requested behaviour without either
the defamation surface or a dependency on a list nobody maintains. The APC caution fires only on the
conjunction of charge, absence from DOAJ, and negligible citedness: reputable journals charge more
than predatory ones do, so the fee alone says nothing.

Collapsing rather than hiding is deliberate for a second reason: indexing coverage is biased toward
English-language and Global North publishing, so a missing signal is often missing _coverage_ rather
than missing rigour, and a legitimate regional journal must not be disappeared by a heuristic.

_Venue prominence is a sort, not the default._ Sorting by venue citedness exists, because the triage
instinct behind the request is legitimate. It is not the default, and it is labelled for what it
measures: the journal's recent average, not this paper.

_Retraction is a warning rather than a signal, and is read from Crossref rather than a boolean._
Retractions and expressions of concern are flagged prominently, are exempt from every filter, and
appear even on a result ranked first. The flag reads Crossref's `update-to` structure, which
preserves both the _type_ of update and its source, `publisher` or `retraction-watch`. Crossref
acquired the Retraction Watch database in September 2023 and made it public; the data is in the REST
API and freely reusable.

OpenAlex's `is_retracted` is deliberately **not** the authority, despite being derived from the same
Retraction Watch data, because it collapses distinct update types into a single boolean. Hauschke
and Nazarovets documented the consequence: the Corman et al. RT-PCR paper — among the most cited
works of the pandemic — was marked retracted in OpenAlex when it had only been corrected, across a
three-month window in 2023–24. Telling a researcher that a citation they are about to make has been
retracted when it has not is a worse failure than saying nothing, and it is one they cannot detect
without doing the check themselves. So the flag names the update type, links the notice, and never
paraphrases it. Retraction status is checked before ingest as well as at search time.

_Amended on implementation — reinstatement._ The draft's update taxonomy was incomplete in a way
that would have caused the mirror image of the failure it was written to prevent. Retraction Watch
records `Reinstatement`, a notice that withdraws a withdrawal, and Crossref's Crossmark schema
carries `partial_retraction` and `removal`; none were modelled. A paper retracted and later
reinstated would therefore have carried a permanent warning — telling a researcher not to cite sound
work, which is the same class of error as flagging a corrected paper, pointed the other way.

The assessment now returns the blocking notices, any reinstatements, and a `standsRetracted`
verdict, so the pane shows the sequence rather than a stale conclusion. Where either notice is
undated it errs toward clearing, because over-warning has a real cost and there is no ordering to
reason from. An unrecognised notice type maps to `other` and is surfaced with its own label intact
but never promoted to a warning: the two upstream vocabularies are explicitly not the same list, and
Retraction Watch maintains a changelog of revisions to its terms, so new strings are expected.

_Preprints are labelled, not demoted._ arXiv, bioRxiv, and medRxiv are requested sources. A preprint
is marked "Preprint — not peer reviewed", and where a published version is known GRETTA offers it.
That is a fact about the record, not a demerit.

_Stance is advisory, evidence-bound, and never the sort order._ Classification runs locally, on the
abstract, with the user's own model — on demand for a result the user selects, not automatically
across the list. ADR-028's rule that nothing happens without an explicit action applies to local
compute as much as to network calls.

The model returns one of supports, contradicts, mixed, or unclear, together with a **verbatim span
quoted from the abstract**. That span is checked to occur in the abstract; when it does not, the
classification is discarded as fabrication rather than displayed. It is a cheap check and it catches
the characteristic failure of a small model asked to make a judgement it cannot support. The model
is instructed to prefer "unclear" over a guess.

Labels are phrased about the abstract, not the paper — "the abstract reports a result consistent
with…", never "this paper supports your claim" — because GRETTA's own rule is that an abstract does
not support a trusted claim. Stance is triage that decides what to read, not evidence that settles
anything.

**Results are never sorted by stance, in either direction.** Supporting-first is a
confirmation-bias engine aimed at a manuscript the user has already written; contradicting-first is
a different distortion. Instead the counts of each are shown, so a one-sided literature is visible
at a glance, and contradicting results are never among those collapsed behind a disclosure even when
they are few — which is exactly when they matter most.

_Amended on implementation — abstracts are markup._ Neither draft anticipated that Crossref returns
abstracts as JATS XML, and that other sources embed stray HTML. This is attacker-influenceable
third-party text heading for a pane that has no `dangerouslySetInnerHTML` anywhere by deliberate
choice (ADR-026). Abstracts are therefore **converted to plain text, not sanitised**: there is no
allowlist to get wrong, no parser differential to exploit, and no path by which a tag could reach
the DOM. `DOMParser` is specifically not used — it is safe for `text/xml` in principle, but reaching
for a parser at all invites someone later to reach for `text/html`, and the value here is that no
parsing happens. Tags are stripped before entities are decoded, so escaped markup decodes to
literal text that is never re-examined; the reverse order would manufacture a tag out of escaped
content. Script and style elements are dropped with their contents, since their text is never prose.

**Alternatives.** A single composite quality score (rejected: opaque, unfalsifiable, silently
weighted, and it invites trust in a number GRETTA cannot justify on request). A hard-coded prestige
list of Nature, Science, and Cell Press (rejected: field-parochial in a general scientific tool,
brittle as journals launch and merge and decline, and it hard-codes precisely the judgement this ADR
argues against making — field-normalised citedness expresses the same intent without the
parochialism). Journal Impact Factor (rejected in ADR-028 as licensed, and again here on the merits:
DORA's argument is that it is the wrong instrument for an individual paper regardless of
availability). A predatory denylist (rejected in ADR-028; the absent-signal filter is its
replacement). Remote re-ranking, or sending the passage to a relevance service (rejected: violates
ADR-028). Server-side stance detection (same). Running stance automatically on every result
(rejected: the compute cost is real, and it renders a judgement the user did not request on material
they have not read). Trusting OpenAlex's `is_retracted` (rejected on the documented evidence above).
Hiding low-signal results outright rather than collapsing them (rejected: absence of a signal is
frequently absence of coverage, and the coverage gap is not evenly distributed). Sanitising
abstracts rather than flattening them (rejected: see the amendment above).

**Consequences.** OpenAlex becomes the credibility backbone in practice; with it disabled most
badges read "not checked" and the low-verification filter cannot run, which the UI must state
plainly. Local re-ranking adds an embedding round-trip per search, bounded by capping the candidate
pool per source. Stance adds one local generation per examined result, which on a modest machine is
seconds — the reason it is on demand. The retraction check is an additional Crossref lookup, issued
one DOI at a time: the batch filter returns only works that _have_ updates, which would collapse
"checked, nothing found" into "not checked" and destroy the distinction this ADR is built around.
Cosine similarity now exists in two places by design. And GRETTA will sometimes rank a Nature paper
below a specialist one: that is intended, and it needs saying in `docs/` or it will be reported as a
bug by someone who was promised the opposite.

**Amended on implementation (not-checked badges, consolidated).** The hard rule above — silence must
never look like an all-clear — was first built as a grey "not checked" badge on _every_ card for
every unconsulted source. In practice this repeated identically down an entire result list whenever
a source was off search-wide (OpenAlex, MEDLINE via PubMed, Crossref), which is exactly the
per-result noise the retraction-disclosure banner (below) already solved for one check — "one
banner, not one per result." User-reported: it wasn't clear the per-card badges carried any
information at all.

`LiteratureResultList.tsx`'s `describeSkippedChecks` now states the rule once per search rather than
once per result: a single compact line naming every check that ran for _none_ of the current
results ("Not checked: retraction/registration · MEDLINE · venue"), computed with `.every()` so a
check skipped for only some results — a record missing a DOI while verification is otherwise on —
still gets its per-record "not checked" badge on the card it actually applies to, unrolled from
`describeCredibility`'s existing badge list. `describeCredibility` itself is unchanged: it still
returns a `tone: 'unchecked'` badge for every group a record didn't get checked against, and remains
independently tested. Only the _rendering_ choice changed — `ResultCard` filters `tone === 'unchecked'`
badges out of the per-card row now that the summary line covers the common case — not the type-level
guarantee: `CredibilitySignals`' groups are still nullable and nothing here would let "checked,
nothing found" read as "not checked" or vice versa. The hard rule is about the distinction existing
and being stated; it does not require the statement to repeat identically down the page.

**Amended on implementation (citation impact now nudges ranking).** This ADR's title says "never
score a paper," and until now that was true without qualification: relevance, credibility, and
stance were computed independently and never combined into anything, displayed or otherwise.
User-reported: searching a specific tool/method by name, the paper that introduced it — by far the
most-cited result in the list — ranked 12th, because ranking is purely cosine similarity between
the _passage_ and each candidate's title/abstract, and has nothing to do with the query text or with
how well-established a paper is. A highly technical introducing paper can legitimately embed further
from a passage's phrasing than a later paper that happens to restate the idea in words closer to the
user's own — semantic similarity is real relevance, but it is not the only thing a researcher means
by "this is the right result."

The fix is narrower than "use citations": `applyImpactBoost` (`services/literature/rank.ts`) runs as
an explicit, separate step _after_ relevance ranking (semantic or lexical), nudging the order by each
candidate's OpenAlex `citedByPercentileYear` — the age-normalised measure this ADR already computes
and displays specifically because a raw count rewards age by construction, the exact bias that was
the original, and still valid, reason citations were excluded from ranking entirely. The nudge is
capped by a weight — at weight _w_, a maximally-cited candidate can close at most a _w_-wide relevance
gap, never overturn a clearly larger one, so a highly relevant but uncited paper still beats a barely
relevant, highly-cited one. A candidate never checked against OpenAlex scores 0 impact — neutral, not
penalised, consistent with this ADR's "not checked is not absent" rule elsewhere.

_Amended again on implementation._ The weight started as a hardcoded, unmeasured constant
(`CITATION_IMPACT_WEIGHT = 0.15`) in the same spirit as `NEGLIGIBLE_CITEDNESS` before it got a
Settings control — and on the first real search that motivated this amendment, 0.15 was not enough to
move the paper in question out of the teens. Rather than guess again, `litCitationImpactWeight`
(default 0.25, range 0–1) is now a `SpinButton` in the Advanced search parameters panel next to
`litMinVenueCitedness`, following exactly the path that field already took: expose an unmeasured
number rather than keep re-guessing it in code. 0 turns the nudge off outright, recovering pure
relevance ranking without a code change.

What did _not_ change: `embeddableText` still excludes venue and journal name, so prestige cannot
enter the embedding itself; `describeCredibility` still returns badges only, never a number, so
nothing resembling a composite score is ever _shown_; and the three axes are still computed and
displayed independently. What changed is narrower and real: the final sort order is now a function of
two axes, not one, and that is a genuine, deliberate exception to "never score a paper" — scoped to
ordering, invisible in the UI as a number, and recorded here rather than left to be discovered by
someone reading the code after this paragraph was already stale.

**Amended a third time (zero citations were still getting boosted).** User-reported and confirmed
with a concrete case: a 2026 paper with zero citations was outranking a 2025 paper from the same
journal carrying 58. Not a weight-tuning problem — a percentile artifact. `citedByPercentileYear` is
computed within a same-year cohort, and early in a cohort year most other papers _also_ have zero
citations yet; percentile-of-ties-at-the-minimum gets assigned the percentile of that entire tied
mass, which can be large. A paper can therefore carry a high percentile while having demonstrated no
citation impact whatsoever. `citationImpact()` (`searchPipeline.ts`) now requires `citedByCount` to be
present and nonzero before consulting the percentile at all — zero citations is zero impact,
unconditionally, regardless of what the percentile for that (mostly empty) cohort says. This is a
tighter version of the same principle the weight already enforces: impact can break a close call, not
manufacture one out of nothing.

**Amended a fourth time (the same paper, three DOIs).** Also user-reported, same search: one preprint
cross-listed on Open MIND and twice on Figshare — three deposits, three DOIs, three ranked positions —
pushed the actual target paper to a fourth. `mergeRecords`'s DOI-only key could not see they were the
same work, because each repository mirror is registered under its own DOI. It now dedupes a second
time, by normalized title (lowercased, punctuation stripped), after the DOI pass — same preference
rule, the record with an abstract wins. A blank title is never merged with another blank title, so two
genuinely different DOI-less records don't collapse into one. This is unrelated to the citation-impact
fixes above but was found by the same report and fixed in the same pass, so it is recorded here rather
than invent a separate section for two lines of context.

**Amended a fifth time (the percentile was the wrong measure all along).** User-reported, a third
time on the same class of failure: searching BoltzGen, the 2025 bioRxiv preprint carrying **59
citations** ranked 10th, while a 2026 Figshare deposit with **zero** citations ranked 4th. The three
amendments above had each tuned something around the edge of a signal that was not firing at all.

The mechanism: `citationImpact()` returned `citedByPercentileYear / 100`, and **returned 0 when that
percentile was null** — which it very often is. OpenAlex populates `cited_by_percentile_year` from a
same-year cohort computation that is simply absent for a large share of preprints and recent
deposits. So the 59-citation preprint scored 0 impact, the 0-citation deposit scored 0 impact, the
boost cancelled out, and ranking fell back to pure cosine similarity — which is exactly the state
this whole amendment chain was written to move away from. Every previous fix was tuning the weight
on a term that evaluated to zero.

The percentile is now dropped from ranking entirely. Three reasons, in order of weight:

1. **It is absent precisely where it is needed.** Preprints and recent work are the results a
   researcher is most likely to be checking against, and they are the population OpenAlex is least
   likely to have percentiled.
2. **It has already produced one confirmed defect** (the third amendment above), because a
   percentile computed over a cohort that is mostly ties at zero is not a statement about impact.
3. **A null it cannot distinguish from a real zero** is a signal that fails silently, and this ADR's
   own rule elsewhere is that "not checked" must never be rendered as "absent".

`citationImpact()` now derives from the **raw `citedByCount`, log-scaled**:
`log10(1 + count) / log10(1 + SATURATION)`, clamped to 1, with `SATURATION = 200`. Log scaling is
what makes a raw count usable despite the age bias that was the original reason for avoiding it: the
curve is steep where the evidence is (0 → 10 citations is most of the available signal) and nearly
flat where age dominates (a 500-citation 2015 paper scores 1.0 against a 59-citation 2025 preprint's
0.77 — a 0.23 separation, not the 8× the raw counts would imply). Zero citations still scores
exactly 0, unconditionally, preserving the third amendment's rule.

The default weight rises **0.25 → 0.6**, and this is the substantive behavioural change rather than
a tuning nudge: at 0.6 a well-cited result can close a 0.46 relevance gap, which on real cosine
distributions is enough to move a paper from the bottom of a twenty-result list to the top. That is
deliberate and was explicitly asked for. It does mean citation count is now a first-class ranking
axis rather than a tie-break, so the sentence above about impact "breaking close calls, not
overturning larger ones" no longer describes the default — it describes weights up to about 0.3, and
the Settings hint says so rather than leaving the old promise standing where it stopped being true.

Because the impact term now means a different quantity, a stored weight tuned against the old
percentile scale no longer refers to anything. Settings migrate v4 → v5: a stored `0.25` — the old
default, and so indistinguishable from never having been touched — is replaced with the new default;
any other value is left exactly as the user set it, on the principle that a deliberate choice
outranks our rescaling.

**Amended a sixth time (supplementary deposits are demoted).** The same BoltzGen report contained a
second, independent problem the citation fix does not address. The Figshare record at position 4 was
not a paper at all — it was a supplementary deposit accompanying one. Fixing citation weighting moves
it down because it has no citations, but only incidentally: a supplementary deposit that _did_
accumulate citations would climb straight back, and the reason it does not belong at position 4 has
nothing to do with how often it is cited. It is the wrong **kind** of record.

Ranking now subtracts a penalty by work type, alongside the citation boost:

| Signal                 | Penalty | Why                                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------------------- |
| OpenAlex `is_paratext` | 1.0     | The index itself says this is not a research work — issue covers, ToCs, mastheads |
| `dataset`              | 0.5     | The reported case; supplementary data from both Crossref and OpenAlex             |
| `erratum`              | 0.5     | The correction already appears as a badge on the paper it corrects                |
| `editorial`            | 0.2     | A tie-break only — an editorial or perspective is real, citable scholarly writing |

_On the editorial number._ It was first written as 0.75 and corrected on review. That figure was
aimed at OpenAlex folding its `paratext` type into `editorial`, and so charged every genuine
editorial for a mapping artifact — a commentary or perspective is frequently exactly what someone
wants when looking for how a field received a result. `is_paratext` catches paratext directly at full
strength and is the assertion that actually means "not a research work", which leaves the type-based
number free to describe editorials alone. At 0.2 an editorial loses to an equally relevant research
article and still beats a clearly worse-matching one — the difference between a tie-break and a
demotion. The residual gap, named rather than hidden: an OpenAlex record typed `paratext` that was
never enriched arrives with no signals and is judged on 0.2 alone. Front matter carries almost no
abstract text to embed, so it rarely ranks high enough for that to bite.

Three properties this deliberately has:

_It demotes, it never filters._ Same principle as refusing to truncate knowledge-base indexing at the
capacity ceiling: a record that is absent cannot be judged, and a user searching for a dataset on
purpose must not be told none exists. A strongly matching dataset still outranks a weakly matching
article — the penalty is a handicap, not a floor.

_`preprint` and `other` are not penalised._ Preprints because bioRxiv and medRxiv are requested
sources and this ADR already says a preprint is labelled rather than demoted; `other` because it is
the fallback both Crossref and OpenAlex map an absent type to, so penalising it would punish thin
metadata rather than supplementary material.

_The penalty is unscaled by `litCitationImpactWeight`._ A claim about what a record **is** must not
weaken as the citation knob is turned down — otherwise setting that weight to 0 to get pure relevance
ranking would also silently stop demoting supplementary deposits, which is not what "0" says on the
control. This is why `applyImpactBoost` became `applyRankAdjustments`, taking impact and penalty
together and computing one score in one sorting pass: applying them as two successive sorts would
have let the second rescore from `relevance` alone and discard the first, which is exactly the sort of
bug that leaves an ordering looking plausible and being wrong.

The four numbers are provisional, chosen against one reported result set rather than a measured
corpus — the same status `litMinVenueCitedness` had before it got a control. They are constants
rather than settings on purpose: a knob per record type is more configuration than this pane should
ask anyone to reason about. If they prove wrong the answer is better numbers, or one combined
control, not five.

**Open questions.**

1. _Does local semantic re-ranking actually beat PubMed's own relevance ranking?_ Assumed, not
   measured. PubMed's Best Match is a trained model over a corpus GRETTA does not have. The re-rank
   should be compared against source order on real queries before it becomes the default, and the
   honest outcome may be that it helps for passage-derived queries and hurts for typed ones.
2. _Which signals constitute "limited verification", and how many must be missing to collapse a
   record._ The set above is a starting proposal, with `NEGLIGIBLE_CITEDNESS` at 0.2 as a
   placeholder. It needs tuning against real result sets, deliberately including non-Anglophone
   ones, so the coverage bias is measured rather than assumed away.
3. _Should ingested papers be re-checked for retraction over time?_ A collection can hold a paper
   retracted after it was indexed, and nothing currently notices. Probably a companion job in a
   later phase.
4. _Should stance re-run against full text once a paper is ingested?_ Better evidence, and it would
   let a stance label graduate from advisory to something closer to citable — but it is a different
   feature with its own cost profile.
5. _Expressions of concern are not comprehensively covered_ in the Retraction Watch data, by
   Crossref's own statement. An absent flag is therefore not an all-clear, and the UI must not imply
   that it is. The exact wording is unresolved.
6. ~~`CITATION_IMPACT_WEIGHT` should become a Settings field.~~ **Resolved:**
   `litCitationImpactWeight`, default 0.25. ~~The paper in question may simply lack a
   `citedByPercentileYear`.~~ **Also resolved, and wrong**: it had one — the actual cause was the
   zero-citations percentile artifact fixed above. Still open: whether relevance ranking itself is
   the real gap for named-entity queries (searching a tool/method by name and expecting its
   introducing paper near the top regardless of passage phrasing) — an exact-title-match signal was
   the alternative this ADR chose not to build first, and the citation-impact route has now had two
   rounds of fixes without a confirmed re-check against the motivating search.

## ADR-030 — The pane embeds for itself; the companion keeps its own

**Status:** Proposed (Phase 15, 2026-07-26) — decision delegated, written for rejection on the merits

**Context.** ADR-029 ranks literature results by embedding the user's selected passage and each
candidate's title and abstract locally, then sorting by cosine similarity. That is the mechanism by
which the specific claim drives the ordering while never being transmitted: the network sees a broad
keyword query, and precision happens on the device.

It cannot currently run. `OllamaClient` exposes `health`, `list`, `show`, `chat`, and `generate`.
There is no `embed`. ADR-020 put embedding in the knowledge-base companion — `scripts/kb/embedder.mts`
— because indexing is a batch job over folders of documents, which is companion work by nature.
ADR-029 then assumed a capability the pane had never been given, and nobody noticed until the code
was due to be written.

So the question is not whether to embed. It is which process does it.

**Decision.** Add `embed()` to the pane's Ollama service. Literature re-ranking calls Ollama
directly and does not involve the companion.

_Why not route through the companion, which already embeds._ Because the companion is optional.
The knowledge base is a feature a user may never set up; literature search is a feature they may
want on its own. Routing re-ranking through `scripts/kb` would mean that on a machine with no
collections, no watcher, and no SQLite database, literature results come back in whatever order
Crossref returned them — and, per ADR-029, the pane would have to say so. The feature would be
quietly worse for a reason the user cannot see and did not choose, and the coupling would be
invisible in the UI: nothing about "search for papers" suggests "start the document indexer".

That is the whole argument. It is not about layering elegance; it is that one option makes a
feature's quality depend on an unrelated feature being configured.

_Why the objection to duplication does not hold._ The companion's embedder and the pane's would
both POST to `/api/embed` on the same user-configured Ollama. This looks like duplication and is
not quite: they have different lifetimes and different failure semantics. The companion embeds
thousands of chunks in a batch job that may run for minutes, retries, reports progress over SSE,
and must survive a restart. The pane embeds a handful of short strings inside a single user
interaction, must abort when the user navigates away, and has no persistence at all. A shared
implementation would carry the batch machinery into the interactive path for no benefit. This is
the same reasoning ADR-020 used to forbid cross-realm value imports, applied one level up.

_What is added._ A single method on the existing client:

```ts
embed(request: EmbedRequest, signal?: AbortSignal): Promise<number[][]>;
```

Batched — Ollama's `/api/embed` accepts an array of inputs — because the re-ranker always has a
passage plus N abstracts and wants them in one round trip. It returns raw vectors and nothing else;
cosine lives in `services/literature/rank.ts` where ADR-029 put it.

_Failure is not fatal._ If Ollama has no embedding model pulled, or the call fails, or the model
returns mismatched dimensions, re-ranking is skipped, the source's own ordering is kept, and the
pane says the results are unranked. ADR-029 already requires this; adding `embed()` does not create
a new way for search to fail, only a new way for it to be better.

_Which model._ `kbDefaultEmbeddingModel`, the setting that already exists. A second embedding-model
setting would be a second thing to explain for a benefit nobody has demonstrated, and the two uses
genuinely want the same property — that the vectors be comparable. Note the consequence, though:
this is a knowledge-base-named setting doing literature work, which will read oddly in the settings
panel and should probably be renamed when the literature UI lands.

**Alternatives.** Route re-ranking embeddings through the companion (rejected above: makes literature
relevance depend on an optional process). Add a third process that owns embedding for both (rejected:
a new lifecycle to install, supervise, and explain, to avoid duplicating one HTTP call). Re-rank
without embeddings, using lexical overlap between the passage and each abstract (rejected as the
primary mechanism — it degrades exactly where the feature is meant to help, on claims phrased
differently from the literature that bears on them — but it is worth reconsidering as the _fallback_
when no embedding model is available, in place of giving up and showing source order). Skip local
re-ranking and trust source relevance (rejected: it is the mechanism that lets the query on the wire
stay coarse, which is the privacy argument of ADR-028 and ADR-029 both; without it, precision would
have to come from sending a more specific query).

**Consequences.** `services/ollama` grows a method and a schema, and the Ollama client is now used
for something other than generation, which slightly widens what "the model service" means. Two
places in the codebase call `/api/embed` against the same server for different reasons, and a
comment in each should say why. Literature search works fully on a machine where the knowledge base
was never configured. And ADR-029's local re-rank becomes implementable, which unblocks the rest of
Phase 15 — it sits upstream of the search surface, since a results list cannot be designed before
its ordering is decided.

**Open questions.**

1. _Should lexical overlap be the fallback when no embedding model is available_, rather than source
   order? It would be better than nothing and worse than embeddings, and ADR-029's open question 1
   already doubts that embeddings beat PubMed's own ranking. Both should be measured together.
2. _Should `kbDefaultEmbeddingModel` be renamed_ now that it serves two features. Cosmetic, but it
   is a persisted settings key, so renaming it later costs a migration.

## ADR-031 — Sources have roles: OpenAlex searches, Crossref verifies

**Status:** Accepted (Phase 15, 2026-07-28)

**Context.** ADR-028 treated the scholarly sources as interchangeable — five toggles, each a place
results come from. Live use showed they are not. A passage naming specific tools (AlphaFold3,
Boltz-2, RFdiffusion) returned ten-year-old, weakly related work, and the papers introducing those
tools never appeared at all.

The diagnosis matters more than the fix. This was **not** a ranking failure. ADR-029's local
re-ranking is precision over a candidate pool; if the right paper is not in the pool, no ordering
produces it, and weighting by venue on top of the wrong twenty-five records yields high-impact
irrelevant papers rather than low-impact ones. Retrieval was broken.

Two causes, both measured:

1. **Crossref has no relevance model.** Its index is bibliographic — no citation signal, no recency
   weighting, no full-text matching. Worse, it is redundant: OpenAlex ingests Crossref metadata and
   adds PubMed, arXiv, and institutional sources on top. Searching both returned the same records
   twice, once ranked well and once badly, and the badly ranked copies diluted the pool. Measured
   side by side, Crossref returned 5 records with 1 abstract; OpenAlex returned a median publication
   year of 2025 with the relevant methods papers in the top five.
2. **PubMed ANDs every term.** Its Automatic Term Mapping treats a multi-keyword query as a
   conjunction, so a twelve-keyword query derived from a passage asks for one paper containing all
   twelve and returns nothing. PubMed alone found zero results while Crossref found some — the same
   string, opposite semantics.

**Decision.**

_OpenAlex is the primary search source._ Relevance-ranked across titles, abstracts, and full text.
It is also the only source of venue standing, citation measures, and the abstracts others omit —
Crossref deposits abstracts for roughly one record in five, OpenAlex backfill reaches seven in ten.
It was previously buried inside an "Enrichment" toggle, which understated it: it is the thing that
makes search work at all.

_Crossref is demoted to verification only._ It remains the sole source of **typed** post-publication
notices — the Wakefield paper returns a 2004 correction and a 2010 retraction as two separate typed
entries, which exists nowhere else and is exactly the distinction ADR-029 was written to preserve.
That is its job, and it is irreplaceable at it. It is no longer offered as a place to search.

_PubMed remains a biomedical complement,_ with progressive relaxation: the strict query first,
because when it matches it matches well, and the terms OR-ed only when it returns nothing. Its
limits are stated rather than hidden — it returned a single record for a structural-biology methods
query, which is a domain mismatch and not a defect.

_arXiv gets a real client_ over its Atom search API. _bioRxiv and medRxiv do not_, because they
publish no keyword search API: theirs serves details by DOI and listings by date, and their website
search is not an interface anyone may depend on. Those preprints are reached through OpenAlex
filtered to the two repositories, and the settings copy says so. Shipping a toggle backed by a
client that cannot exist would be the same defect as the arXiv and bioRxiv switches that previously
turned on and silently returned nothing.

_Name variants are expanded, quoted, and visible._ Scientific tools carry version numbers with no
convention about separators, and no index normalises across them: `AlphaFold3` misses the paper
titled "…with AlphaFold 3". Measured, the unquoted form is worse than useless — it returns the 2020
AlphaFold paper, because the loose tokens match the stem anywhere and the version is diluted away.
So every spelling is emitted as a quoted phrase, including the one the user typed. The expansion is
applied during drafting and offered as an explicit action for typed queries; it is **never** applied
inside a client, because ADR-028 promises the field shows the exact bytes that will be transmitted.

_What each source received is disclosed._ Sources do not speak the same dialect — PubMed retries
OR-ed, arXiv takes an `all:` prefix, Crossref receives DOIs rather than words — so the pane can show
each source's actual query on request. This is how ADR-028's promise survives per-source adaptation:
by continuing to say what left, rather than by refusing to adapt or by quietly adapting.

**Alternatives.** Keep Crossref as a search source and weight results by venue prestige (rejected:
treats a retrieval failure as a ranking problem, and yields high-impact irrelevant papers). Build
real bioRxiv and medRxiv clients (rejected: no keyword search API exists to build against). Expand
name variants inside each client (rejected: silently rewriting an approved query falsifies ADR-028's
central promise for the sake of one click). Drop Crossref entirely (rejected: typed retraction
notices exist nowhere else).

**Consequences.** `litSources` changes shape — `crossref` and `biorxiv` out, `openalex` and
`preprints` in — and `litEnrichment` becomes `litVerification`, which is a persisted settings
change. Turning on bioRxiv/medRxiv also contacts OpenAlex, which the copy states. The retraction
check now depends on a toggle separate from every search source, so a user can search without it
and must be told that no retraction checking ran.

_Amended after release review — OpenAlex demoted, PubMed primary._

OpenAlex began requiring an account and metering usage against a daily budget in February 2026,
with a paid tier above it. The key is free, but a core capability that depends on someone else's
account and allowance is not local-first in the way the rest of GRETTA is, and the direction of
travel is one this project should not be exposed to. **PubMed is now the primary source**: free, no
account, and the best abstract coverage of any of them. OpenAlex remains available as an optional
toggle for the venue standing and citation measures nothing else provides.

_Amended — preprints reached through Crossref; arXiv measured and disabled._

bioRxiv and medRxiv still publish no keyword search API, but both deposit into Crossref, which
does. Filtering `type:posted-content` by DOI prefix narrows the index to their preprints. Two
prefixes are required: `10.1101` from the Cold Spring Harbor era, and `10.64898`, which openRxiv
began issuing on 1 December 2025 — either alone hides half the corpus. The prefixes cannot
distinguish the two servers, so results are separated by the server name Crossref carries in
`institution` or `group-title`.

arXiv is **not** reachable this way: DataCite registers its DOIs, so Crossref does not index it. Its
own search API supports field-specific queries, which was never in question — the open question was
whether a browser may call `export.arxiv.org`.

**That is now measured, and the answer is no.** `export.arxiv.org` sends no
`Access-Control-Allow-Origin` header, so no browser will permit the pane to read the response, and
the Word task pane is a browser. The smoke suite records this by inspecting the header from Node
rather than by making a request that Node would allow and a webview would not — a passing request
from a terminal proves nothing about CORS, since Node does not enforce it.

The client and its tests are kept, because the code is correct and the obstacle is arXiv's server
policy rather than anything GRETTA does; a companion-side proxy would make it usable, and the
companion already exists for the knowledge base. The **toggle is disabled** with the reason stated
in its own copy. A switch that turns on and silently returns nothing reads as a broken search rather
than an absent capability, which is the failure this project has now shipped twice.

The earlier settings copy conflated "has no search API" with "cannot be called from a webview". Only
the first was ever true, and only of bioRxiv and medRxiv.

_Amended for release — arXiv removed, source list closed._

Both routes to arXiv are measured and closed to a browser: `export.arxiv.org` sends no
`Access-Control-Allow-Origin`, and neither does DataCite, which registers arXiv's DOIs and is the
only other index carrying them. The client, its tests, and the toggle are removed rather than
shipped disabled — a permanently disabled switch is UI debt, and the supported set should say what
GRETTA does rather than what it once hoped to.

The CORS probes stay in `pnpm smoke:lit`. They cost nothing when skipped, they are the standing
evidence for this decision, and they would reverse it automatically if either server ever sends the
header.

Supported sources are therefore **PubMed, bioRxiv, medRxiv, and OpenAlex**, all off by default.
Expansion beyond that is deferred pending beta feedback rather than designed further: whether
literature search is used heavily enough to justify more sources is a question about users, not
about APIs, and it cannot be answered from here. The DataCite and Semantic Scholar probes remain in
the smoke suite so that question can be reopened against measurements rather than guesses.

**Open questions.**

1. _Should retraction checking be forced on rather than merely recommended?_ Citing a retracted
   paper is the failure this feature exists to prevent, and an optional guard is one most users will
   never enable. Against that, ADR-028's rule is that nothing contacts a third party without
   explicit consent, and Crossref receives the DOIs of everything being read.
2. _Whether the quoted-variant expansion helps or hurts on ordinary prose queries._ It is measured
   only on tool names so far.

---

## ADR-032 — Sources are queried in parallel, and one failing does not lose the others

**Status:** Accepted (2026-08-05)

**Context.** `useLiteratureSearch.search()` queried PubMed, bioRxiv, medRxiv, and OpenAlex as four
sequential `await`s against four independent hosts, so wall-clock latency was the sum of four
round trips rather than the slowest one. A literature search already asks the user to wait through
enrichment, a retraction check, and a local embedding pass on top; spending three of those round
trips waiting for hosts that could have been answering concurrently is latency bought for nothing.

The failure behaviour was worse than the latency. A single rejection from any one source escaped
into the outer `catch`, painted an error banner, and discarded **every** result — including the
three sources that had already answered successfully. Scholarly APIs are third-party infrastructure
with rate limits, maintenance windows, and occasional 500s; treating any one of them as a
precondition for showing anything means a routine outage at one host presents as a totally broken
feature.

**Decision.**

_Fan out with `Promise.allSettled`, indexed by position._ Each enabled source contributes a
descriptor — label, disclosure note, and a thunk — built in the current source order (PubMed first,
per ADR-031). Results are read back **by index** rather than pushed as they resolve.

This is not incidental. The order of the groups array is load-bearing twice over: `mergeRecords`
falls back to first-wins when neither of two duplicate records has an abstract, and
`rankByRelevance` sorts stably, so source order survives as the final tie-break. Pushing results in
completion order would make both of those depend on which host happened to answer first, which is to
say non-deterministic. `Promise.allSettled` preserves input order, and indexing into it keeps the
output byte-identical to the sequential implementation for any given set of successful responses.

_Partial failure is a warning, not an error._ A rejected source contributes an empty group and an
entry in a new `failedSources: { source, message }[]` on `LiteratureState`, rendered in the pane as a
warning `MessageBar` naming the source. The results that did arrive are shown. Only when **every**
enabled source fails does this become a full `setError`, because at that point there is genuinely
nothing to show and a warning above an empty list would be a worse description of the situation than
an error.

Naming the failed source matters more than it might appear. "Some results may be missing" is
unactionable; "PubMed could not be reached" tells a user whose search is biomedical that the result
set is not merely thin but is missing the source that mattered, and tells a user whose search is not
biomedical that they can ignore it. The distinction is theirs to make and they can only make it if
we say which host failed.

_Enrichment and the retraction check run together._ `openAlexClient.enrich(dois)` and
`crossref.lookupUpdates(dois)` are independent, keyed on the same DOI list, and were also sequential.
They now run under `allSettled` with the same isolation. A rejected retraction lookup leaves
`updates.checked` **false** rather than resolving to an empty update list, which ADR-029 requires:
"not checked" and "checked, nothing found" are different claims, and rendering the first as the
second is how a retracted paper gets presented as clean.

_Rate-limit etiquette is not a reason to serialize._ The pacing in `etiquette.ts` is per client
instance and these are four different hosts, so concurrency across them violates nobody's terms.
Sequencing _within_ a client is preserved — `enrich`'s internal batch loop stays serial, so any one
source still sees one request at a time.

_A partially failed search is still cached,_ with its `failedSources` stored alongside the results,
so reusing it from "recent searches" reproduces the same warning. The alternative — refusing to
cache a degraded result set — would silently discard results the user can see on screen, and a
cached entry that shows results without the warning that explains why they are thin would be the
dishonest version of the same thing.

**Alternatives.**

_`Promise.all`._ Rejected: it rejects on the first failure, which is the current all-or-nothing
behaviour with extra concurrency, i.e. the wrong half of the problem fixed.

_Push results as they resolve, and re-sort afterwards._ Rejected: it makes deduplication and
tie-breaking depend on host response times. The bug this would introduce is intermittent and
ordering-only, which is the hardest class to notice and the hardest to reproduce.

_Retry a failed source before reporting it._ Deferred. It is a reasonable thing to want, but a retry
policy needs to distinguish a 429 from a 500 from a DNS failure to avoid making an overloaded host
worse, and that is a larger design than this one. A named failure the user can act on is the
honest interim.

**Consequences.** Wall-clock search time becomes the slowest source rather than the sum. The pane
gains a state it did not have — results plus a warning — and every place that renders results has to
tolerate it. Result ordering is unchanged by construction, which is the property to hold hardest:
retrieval order drives which papers a user reads, and this change must not be allowed to alter it as
a side effect of going faster.

---

## ADR-033 — The companion opens the folder dialog, and nothing enumerates the filesystem

**Status:** Accepted (2026-08-05)

**Context.** ADR-020 shipped folder binding as a typed absolute path and flagged it as needing "a
better picker/trust UX." For the audience this is built for — academics with a references folder
somewhere in Documents or on a network share — it is the single biggest day-one friction point. The
pane asks for `/Users/you/Documents/References` and offers no way to find it.

**A pane-side picker is not possible.** Recording this explicitly so the question stops being
reopened:

- Office.js has no directory-picker API. It has file pickers for Office documents, not folders, and
  not for arbitrary local paths.
- `showDirectoryPicker()` is Chromium-only. Word on macOS runs WKWebView, so it is simply absent for
  a large share of the audience — and the macOS share is exactly the one that has been driving this
  project's bug reports.
- Even where it exists, it returns a `FileSystemDirectoryHandle`, not a path. The consumer here is
  the companion: a separate Node process that needs a real absolute path to `readdir`. Handles are
  scoped to the browsing context and do not cross that boundary.

The companion can solve it, because it is a local process with ordinary filesystem access and a
desktop session to draw a window into.

**Decision.**

_A companion-invoked native OS dialog,_ behind `POST /pick-folder`. macOS uses `osascript` with
`choose folder`; Windows uses PowerShell with `System.Windows.Forms.FolderBrowserDialog`. Every other
platform answers `unsupported` and the pane keeps the text input it has always had.

_Rejected: a `GET /browse?path=…` enumeration endpoint_ plus an in-pane folder browser. It works on
every platform, including the Linux and WSL cases the dialog does not cover, and it would be more
testable. It is rejected because it adds an HTTP endpoint that enumerates the user's filesystem on
request — a capability ADR-020's threat model does not cover and did not have to. The companion
currently reads only paths the user has explicitly bound; a browse endpoint would let anything that
can reach loopback walk the disk. The dialog returns exactly one path, only after a human clicked a
button in a native window, and enumerates nothing. That asymmetry is worth losing Linux support over.

_Nothing from the request reaches a command line._ The endpoint takes **no body at all** — there is
no parameter to inject. `execFile` is used with an argument array, never `exec` with an interpolated
string, and the prompt text is a module constant in `pick-folder.mts`. Both invariants are asserted
in tests rather than left to review, because this is the one place in the project that spawns a
process.

_Four outcomes, and a cancel is not an error._ `{ ok: true, path }`;
`{ ok: false, reason: 'cancelled' }` when the user dismissed the dialog; `'unsupported'` on a
platform without one; `'busy'` when a dialog is already open. Clicking Cancel is a normal thing to
do and must leave the input untouched with no error banner — the same principle as ADR-032's
treatment of a cancelled search.

_Serialized, and timed out at two minutes._ A second concurrent request is refused rather than
opening a second dialog, because two native modal windows fighting over one desktop session is a
state with no good exit. The timeout exists so a dialog someone opened and forgot cannot wedge a
companion request indefinitely; `execFile`'s own `timeout` kills the child.

_Support is advertised on `/health`,_ as `pickFolder: boolean`, rather than discovered by calling the
endpoint and seeing what happens. The pane must decide whether to render a button _before_ anyone
clicks it, and a button that opens nothing is worse than no button. The field is optional in the
schema so an older companion still parses, and absent reads as false.

**Consequences.** The companion gains its first ability to draw UI, which is a genuine expansion of
what it is — until now it was a headless indexer. That is the cost of the friction it removes. The
text input stays editable in every case: a network volume may not be reachable from the dialog, some
users will paste a path, and the picker is unavailable on Linux entirely, so it is an accelerator and
never the only way in.

The dialog itself cannot be unit-tested — it is a modal window awaiting a human. Everything around
it (platform dispatch, outcome mapping, the argument array, the concurrency guard) is tested with
`execFile` mocked, and the dialog is verified by hand on each platform.
