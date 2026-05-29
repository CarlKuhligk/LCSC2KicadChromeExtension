# Coding Standards — KiCad Parts Importer

Loaded by the reviewer agent via `@.sandcastle/CODING_STANDARDS.md`.
Enforce these during review.

## Domain language is load-bearing

- Names defined in `CONTEXT.md` are used **verbatim** in code, commit
  messages, and docs. Paraphrases ("backend" instead of "Native Host",
  "metadata fetch" instead of "Phase 1 Fetch") are a review-blocker.
- New domain concepts get added to `CONTEXT.md` **before** they become
  a module or class name.

## JavaScript (extension + popup + service worker)

- ES modules (`.mjs` for shared, `.js` for content scripts) — no
  bundler, no TypeScript.
- camelCase for functions and variables; PascalCase only for classes.
- Prefer named exports over default exports.
- Browser APIs: feature-detect, don't UA-sniff.
- DOM access via the content-script Shadow-DOM root where possible.
- Any new content-script module **must** be added to
  `web_accessible_resources` in the extension manifest (the
  `tests/test_extension_manifest.py` guard will catch omissions).

## Python (backend / Native Host)

- Python 3.11+, type hints on public functions.
- snake_case for functions and variables; PascalCase for classes.
- Use `pathlib.Path`, not `os.path` joins.
- JSON-RPC handlers in the Native Host: one function per RPC verb, no
  hidden global state. Free-form `progress` messages are streamed; no
  Job IDs (see ADR-0004).
- Category Path normalization MUST go through the Python mirror of
  `shared/categoryPath.mjs` to keep JS/Python in sync. The paired
  drift-detection tests must stay green.

## Comments

- Default: **no comment**. Well-named identifiers carry the WHAT.
- Write a comment ONLY when the WHY is non-obvious — a hidden
  constraint, a subtle invariant, a workaround for a specific upstream
  bug, behaviour that would surprise a reader. One line, not paragraphs.
- Never write "added for issue #N" / "used by X" / "removed Y". That
  rots; the PR + git history are authoritative.

## Tests

- JS: Vitest, jsdom environment, fixture-backed where the input is real
  LCSC HTML.
- Python: Pytest. Mark slow / network-dependent tests with markers.
- Tests describe behaviour, not implementation. Test names read like
  sentences ("returns null when the anchor table is missing").
- New cross-cutting state introduced in V3 needs a regression test
  *before* the PR is shippable. The V2 lesson "108 cases pinned a
  changing surface" applies to V3 too.

## Architecture

- One module = one responsibility. Modules that drift toward god-object
  status get extracted (the REFACTOR-PLAN.md history is full of these —
  don't repeat it).
- Service Worker is the **only** context that calls `chrome.runtime.connectNative`.
  Content script and popup talk to the SW, never to the Native Host directly.
- Phase 1 and Phase 2 (ADR-0002) are distinct RPCs with distinct
  contracts. Do not fuse them into a single call.

## Commits

- Conventional-commits style: `feat(v3): …`, `fix(extension): …`,
  `refactor(backend): …`, `test(...): …`, `docs(...): …`.
- Subject ≤ 72 chars. Body explains WHY.
- Reference the issue: `(#<N>)` in subject, `Closes #<N>` in the PR body.
- AFK commits sign off with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Forbidden

- Mocking the production loading environment for tests that are meant
  to verify production behaviour (Vitest + jsdom does NOT enforce
  Chrome MV3's `web_accessible_resources` contract — that's what
  `tests/test_extension_manifest.py` is for).
- "Tests green ⇒ shipped working" without a manual smoke. AFK agents
  cannot do the manual smoke; that gap must be flagged in the PR body,
  not papered over.
- Adding V2-migration code. V3 is a clean break per ADR-0003.
- Committing `.env` / `.sandcastle/.env` / tokens / OAuth secrets.
