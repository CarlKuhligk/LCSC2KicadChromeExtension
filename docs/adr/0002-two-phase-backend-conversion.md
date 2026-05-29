# Two-phase backend conversion

V3's conversion runs in two phases: a fast **Phase 1 fetch** (~1 s, LCSC metadata only — Category Path, pin count, datasheet URL) and a slow **Phase 2 conversion** (~5–10 s, EasyEDA pull + Symbol/Footprint/3D generation, with the user-resolved override sources baked in). The Override Panel renders **between** the two phases.

Chosen over a single-RPC "convert-then-edit" flow because (a) showing the Panel after Phase 1 cuts time-to-first-feedback from ~10 s to ~1 s, (b) generating an EasyEDA symbol that the user then replaces with a Template is wasted work, and (c) Pin↔Pad map resolution depends on which Symbol/Footprint sources are chosen — that decision must happen before Phase 2 starts.

## Consequences

- Native-Host protocol has at least three RPC verbs: `fetchMetadata`, `convert`, `getState`. Each may stream `progress` events on the same port.
- Power-user flow (Category Rule fully resolves all overrides + no pin-map ambiguity): Phase 1 → auto-resolve → Phase 2, panel never shown. See "Skip-Panel" behaviour in V3-SPEC.md.
- Backend state is short-lived per Phase. No persistent job IDs; no queue; concurrent requests get a `busy` error.
