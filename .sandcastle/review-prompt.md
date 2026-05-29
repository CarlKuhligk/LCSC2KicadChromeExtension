# TASK

Review the code changes on branch `{{BRANCH}}` of the **KiCad Parts
Importer** project and improve correctness, code clarity, consistency,
and maintainability while preserving exact functionality.

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

## V3 vocabulary and decisions

Verify that the change respects the project's domain language and
architectural decisions:

- `CONTEXT.md` — V3 vocabulary (load-bearing terms). Reject paraphrases
  of established names like **Native Host**, **Phase 1 Fetch**,
  **Override Panel**, **Anchor Card**, **Template-3D Carry-Over**,
  **Template-Assembly**.
- `V3-SPEC.md` — architectural commitments.
- `docs/adr/0001-…0005-…` — load-bearing decisions. A change that contradicts
  an ADR is a blocker — flag it instead of patching around it.

# REVIEW PROCESS

1. **Understand the change.** Read the diff and the linked issue. The
   implementer leaves the issue link in the PR or the most recent
   commit message — find it.

2. **Correctness — does it match the issue's intent?**
   - Does every Acceptance Criterion that can be verified in tests have
     a corresponding test?
   - Are edge cases from the issue body covered?
   - Pin↔Pad / 3D / Override behaviour: does the implementation actually
     follow the ADR (e.g. ADR-0005 "3D follows the Footprint")?
   - For V3 RPC code: does it speak the streamed-progress contract of
     ADR-0004 (no Job IDs, no queue, `busy` on concurrent)?
   - For DOM-injection code: is `web_accessible_resources` updated and
     does `tests/test_extension_manifest.py` still pass?

3. **Look for cleanup opportunities**:
   - Reduce unnecessary complexity, nesting, and dead code
   - Eliminate redundant abstractions
   - Improve names — V3 vocabulary verbatim, not paraphrased
   - Consolidate related logic
   - Remove obvious-from-code comments; keep WHY comments
   - Replace nested ternaries with switch / if-else chains
   - Choose clarity over brevity

4. **Security & safety**:
   - No credentials, tokens, or `.env` content committed
   - No injection vulnerabilities in shell-quoted strings or RPC payloads
   - No unsafe parsing of attacker-controlled LCSC HTML (defence in depth)

5. **Maintain balance**: Avoid over-simplification that would:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions
   - Remove abstractions that improve testability
   - Make the code harder to debug or extend

6. **Apply project standards**: Follow the coding standards defined in
   @.sandcastle/CODING_STANDARDS.md.

7. **Preserve functionality**: Never change WHAT the code does — only
   HOW. All original features, outputs, and behaviours must remain.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on the branch you are already on
   (`{{SOURCE_BRANCH}}`). Do NOT create a side branch — the implementer's
   PR is already open against this branch; a side branch breaks the PR.
2. Run `cd chrome_extension && npm test` (Vitest) and `pytest`
   (from repo root). Both must remain green.
3. Commit with the same conventional-commits style as the implementer:
   `refactor(v3): clarify ... (#<issue-number>)` or
   `test(v3): add edge-case coverage for ... (#<issue-number>)`.
4. Sign off with
   `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
5. **Push your commit to origin** with `git push` so the PR includes
   your refinement. A reviewer commit that stays local is invisible
   to the human reviewer and effectively unreviewed work. Verify with
   `git rev-parse origin/{{SOURCE_BRANCH}}` — it must point at your
   newest commit's SHA before you emit the completion signal.

If the implementation is already clean and correct, do nothing — the
implementer earned the PR as-is.

If you find a change that **contradicts an ADR or the V3 spec**, do NOT
silently patch it. Leave a comment on the PR explaining the contradiction
and which ADR/section is violated. The human reviewer must arbitrate.

Once complete, output <promise>COMPLETE</promise>.
