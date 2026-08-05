# Contributing to GRETTA

## Setup

```bash
pnpm install
pnpm certs:install   # one-time: create + trust the localhost dev certificate
pnpm dev             # serves https://localhost:3000
```

Then sideload `manifest/manifest.xml` into Word — see
[docs/SIDELOADING.md](docs/SIDELOADING.md) for platform-specific steps. `pnpm dev:web` runs
the UI in a browser with Office mocked, if you don't need Word itself for the change you're
making.

## The quality gate

```bash
pnpm check   # typecheck · lint · format · test · build
```

This must pass before a change merges. CI runs a lighter gate on every PR — typecheck and
the unit/component tests only, not lint/format/build — so `pnpm check` locally is what
actually catches everything before review (see `.github/workflows/ci.yml` for why). It's
also necessary but not sufficient: a change that touches generation, the knowledge base,
history, or literature search should also be run live in Word. Green tests have missed real
defects here before (context-window truncation, stream timeouts, a history pane showing the
wrong record) that were obvious within minutes of actual use.

## Architectural changes get an ADR first

Any change to the architecture — a new service boundary, a new external dependency, a change
to how data is stored or transmitted — needs a decision record in [DECISIONS.md](DECISIONS.md)
written **before** the implementation, not after. Look at the existing entries for the format:
context, the decision, and the reasoning, so a later reader can tell why the codebase looks
the way it does without having to ask.

## Style

- TypeScript strict mode throughout; no `any` without a comment saying why.
- No dead TODOs — if something is deliberately incomplete, say so in the relevant ADR or
  [ROADMAP.md](ROADMAP.md) instead of leaving a marker in code.
- Prettier/ESLint formatting is enforced by `pnpm check`; run `pnpm format` before committing.

## Reporting issues

Use [GitHub Issues](https://github.com/WilliamKMLai/gretta/issues) for bugs and feature
requests. For a bug, include your OS, Word host (Windows/Mac/web), and Ollama version.
