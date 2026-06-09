# Confidence-driven apply model (one-click / modify / register)

V3 resolves every LCSC import through a **confidence state machine** with three states, not through a per-rule `autoApply: off/suggest/auto` mode with a silent Skip-Panel path. The import preview is **always visible** — there is no zero-click background write — but in the best case a single click is all it takes.

> **Amendment (2026-06-09, from the first end-to-end test).** Two refinements to the metadata handling and dialog presentation described below:
> - **Metadata is auto-upserted, not hand-mapped.** Every LCSC spec-table param becomes a symbol Property on import (existing → value replaced, missing → added); stock/price/qty are filtered out by the page scraper. The manual label-mapping editor is removed; the Import-Editor shows a **read-only property preview**. The rule no longer carries a `labelMapping`. Consequently the **"metadata labels mapped" one-click factor is dropped** — `labelsMapped` is always satisfied, so the MVP 🟢 threshold is now **symbol-template matched + category recognised + high confidence**.
> - **The ⚪ Register-Prompt and the Import-Editor are modal overlays** (dimmed backdrop); 🟢/🟡 stay inline (their always-visible preview is page flow, not a dialog).

- **🟢 Fully defined** — a rule exists, metadata + template data resolve, confidence is high → a **one-click Import** (no separate confirm, no countdown; the resolved result is shown before the click) plus a secondary **"Modify"** button that opens the Import-Editor for the special case.
- **🟡 Low confidence** — known but the match is uncertain → behaviour is a **user setting**: "keep EasyEDA + unobtrusive hint" *or* open the Import-Editor.
- **⚪ New / unknown** — no rule → an **active prompt**: "new part — download EasyEDA only *or* register?".

**"Register"** is the learning act: in the Import-Editor the user maps category ↔ part-type ↔ symbol ↔ footprint(s) ↔ 3D models and their linkage. It saves a **rule** *and* raises the **confidence** for future like parts. A single, reusable **Import-Editor** serves all three call sites (register / modify / low-confidence) — one data model, one test matrix. The MVP one-click threshold (symbol-first) is **symbol-template matched + category recognised + metadata labels mapped**; footprint/3D as confidence drivers arrive with the footprint follow-up slice (the EasyEDA footprint/3D ride along by default until then).

Chosen over the prior model (a three-way `autoApply` enum whose `"auto"` value triggered a Skip-Panel zero-click write, gated by `autoConfirm` + guards + an "Always show Override Panel" master brake, with a proposed 3-second cancel countdown) because the owner wants **speed without surrender of visibility**: the countdown was rejected outright ("if I click, it must happen now"), and a silent write that the user never sees contradicts the trust principle the project already commits to. Collapsing "suggest vs auto vs off" into "always show the preview, one click when 🟢" removes a whole class of edge cases (the master brake, the autoConfirm flag, the guard-gated skip) while keeping the one-click ergonomics that the old `§U3.3` already described.

## Consequences

- **`§U3.4` (Auto-Apply / Skip-Panel) is removed**, not edited. There is no "panel is never mounted, Phase 2 starts directly" path. The old `§3.5` Skip-Panel guard table, the `autoApply:"auto"` value, the `autoConfirm` flag, the "Always show Override Panel" master toggle (D-SET-2), and the `suggesting ──autoApply──▶ converting` state-machine edge all disappear.
- The per-rule mode shrinks: a rule no longer carries `off/suggest/auto`. What survives is the **sources + linkage** the rule defines (symbol/footprint source, label mapping, pin/pad map) and the fact that it was **registered**. Whether the import is one-click is derived from **confidence**, not from a rule flag. (`autoApply`/`autoConfirm` field migration is part of the rule-schema slice.)
- The Override Panel **is** the Import-Editor — renamed and generalised to three entry contexts. It is never fully skipped; in the 🟢 case it renders as a fast one-click confirm-preview.
- 🟡 low-confidence behaviour becomes a real **settings toggle** (keep-EasyEDA vs open-editor), replacing the old "low confidence always falls back to EasyEDA fallback" hard rule.
- ⚪ new-part handling becomes an **explicit register prompt**, replacing the implicit "No rule — keeping EasyEDA / best guess" panel header.
- The EasyEDA raw path stays as the always-available escape (exact V2 workflow) in every state.
- This ADR governs the apply/UX layer only. The transport (Native Messaging, [0001](0001-backend-via-chrome-native-messaging.md)), two-phase conversion ([0002](0002-two-phase-backend-conversion.md)) and 3D-follows-footprint ([0005](0005-3d-follows-footprint.md)) decisions are unaffected. Full user-decision log: `docs/ENTSCHEIDUNGEN.md` (Runde 2, 2026-06-05).
