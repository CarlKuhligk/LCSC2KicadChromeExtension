# 3D Layer follows the Footprint; Template Footprints bring their own 3D

V3's 3D Layer is resolved per Footprint, not unconditionally from EasyEDA. When the user picks a Template Footprint, the Template's own `(model "...")` references are the primary 3D source — files inside the Template Library are **carried over** into the active library at conversion time (`<ActiveLib>.3dshapes/<basename>`, idempotent and content-hash-deduplicated so shared 3D models across multiple Template Footprints aren't duplicated). KiCad system-variable paths (`${KICAD9_3DMODEL_DIR}`, `${KISYS3DMOD}`) and other absolute paths outside the Template Library are left verbatim, no copy. Only when the Template Footprint has no `(model ...)` reference at all does EasyEDA's 3D fall back into play. EasyEDA Footprints continue to use EasyEDA's 3D as in V2.

Chosen over the prior "always EasyEDA-3D regardless of override choice" rule because (a) a user who has invested in a hand-curated Template Footprint almost certainly aligned a 3D model to it, and silently overlaying EasyEDA's 3D would visibly misalign in pcbnew; (b) the carry-over mechanic enables the **Template-Assembly** path — importing LCSC parts for which EasyEDA has neither Symbol nor Footprint, as long as the user has both Template layers and the Template Footprint carries its 3D; (c) preserving system-variable references avoids duplicating KiCad's bundled 3D library into every project.

## Consequences

- Phase 2 conversion has two modes — **EasyEDA Pipeline** (at least one layer EasyEDA) and **Template-Assembly** (both Template + Template-FP has 3D). The latter skips the EasyEDA API call entirely; LCSC metadata from Phase 1 supplies symbol properties.
- The 3D Layer is still **not user-overridable** in the Override Panel — there is no "3D source" dropdown. The 3D follows from the Footprint choice deterministically.
- Template-3D Carry-Over runs on every relevant import; idempotence and content-hash dedup are part of the contract so repeated imports of parts sharing a 3D model do not bloat the active library.
- The "geometric alignment between EasyEDA-3D and a Template Footprint" caveat from the prior rule survives, but only in the narrow fallback case (Template FP without its own 3D reference).
