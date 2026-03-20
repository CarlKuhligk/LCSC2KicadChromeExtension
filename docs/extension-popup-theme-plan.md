# Extension popup: LCSC-aligned light UI + Dark-Reader-style dark toggle

Plan for **recoloring** and a **minimal layout polish** of `chrome_extension/popup.html` / `popup.css` / `popup.js`. Scope is the **extension popup window only** (not LCSC in-page content script modals unless you explicitly extend scope later).

> **Reference in repo:** Saved LCSC page assets live under **`styles/`** (per-page `*_files/` folders with hashed CSS/JS). There is **no top-level `.html`** in that snapshot—tokens and effects are taken from the bundled stylesheets (see below). Optional screenshots can still be added for layout nuance.

---

## Goals

| Goal | Detail |
|------|--------|
| **Light = LCSC-like** | Popup reads as “same family” as lcsc.com: light surfaces, blue primary, restrained shadows, familiar control density. |
| **Dark = Dark Reader–like** | Not a separate “gaming dark” theme: **desaturated dark grays**, softened white text, primary/accents **muted but recognizable** (same hues, lower chroma/luminance). |
| **User control** | Explicit **Light / Dark** toggle; optional follow-up: respect `prefers-color-scheme` **only as initial default** when no saved preference. |
| **Minimal redesign** | Adjust spacing, radii, tab chrome, header row, and shadows **slightly**—no new frameworks, no replacing Bootstrap in v1. |

## Non-goals (v1)

- Rewriting `popup.js` UI logic beyond theme persistence and toggle wiring.
- Matching LCSC pixel-perfect (tables, data grids, Vuetify internals).
- `filter: invert()` on the whole popup (breaks icons, images, and Bootstrap focus rings).
- Theming **content script** dialogs (`contentScript.js`); keep as a separate phase if desired.

---

## Design reference — extracted from `styles/`

### Where to look

| Area | Example paths under `styles/` |
|------|--------------------------------|
| **Search / list UI** (filters, pagination, table rows, page chrome) | `Search by _10k__files/01e7b97c.fc58820.css` (large Vue-scoped bundle) |
| **Global progress bar** | `Search by _10k__files/…` and `RC0603FR-0710KL …_files/f69643ec.a9a97d6.css` — `.nuxt-progress { background-color:#16d }` |
| **Product page / embed** | `RC0603FR-0710KL …_files/lceda.css` (symbol viewer chrome; not main marketing UI) |

LCSC repeats a **design-token export** across many scoped blocks (same values). Below is the **canonical palette** from those `:export{…}` blocks.

### LCSC token table (light, from live site CSS)

CSS uses **3-digit hex** where safe: `#16d` ≡ **`#1166dd`** (primary blue).

| Token (LCSC name) | Hex | Popup mapping |
|-------------------|-----|----------------|
| **primary** | `#1166dd` (`#16d`) | Primary buttons, links, active tab accent, focus ring (optional) |
| **major** | `#1c1f23` | Dark chrome (site uses for **table headers**, not page bg)—use for **dark theme** surfaces or bold headings in light |
| **secondary** | `#666666` | Secondary / body-strong gray |
| **lighter** | `#babbbc` | Placeholders, disabled-adjacent |
| **accent** | `#005caf` | Deep blue accent (links/alternate emphasis—use sparingly) |
| **error** | `#eb4526` | Errors / destructive emphasis |
| **info** | `#2196f3` | Info (optional; LCSC Material “info” blue) |
| **success** | `#3eb350` | Success states |
| **warning** | `#ff8a00` | Warnings |
| **price** | `#ff7134` | Price/highlight orange (optional; rarely in extension) |

### Surfaces, borders, shadows (from same `styles/` bundles)

Use these for **light theme** “LCSC feel” (search list / filters):

| Role | Values observed | Use in popup |
|------|-----------------|--------------|
| **Page / shell bg** | `#f7f7f7` (`.searchWrap`) | `html, body` background (light) |
| **Panel / card** | `#ffffff` | Cards, modals, dropdown panels |
| **Border default** | `#dedede`, `#e7e7e7` | 1px borders on cards, inputs, list rows |
| **Active / hover outline** | border-color `#16d` | Active tab, selected row, thumb border |
| **Pressed / deeper blue** | `#033b96` (pagination active) | Primary **:active** / pressed state |
| **Disabled primary tint** | `#99c2f1` | Disabled primary button text/border (if needed) |
| **Subtle hover bg** | `#f5f5f5`, `#f4f7fe`, `#e4edff` | List hover, category selection (picker) |
| **Chip / neutral pill** | `#eaedf0` | Connection badge, neutral tags |
| **Dropdown shadow** | `0 8px 10px -5px rgba(0,0,0,.08)` + `border:.5px solid rgba(0,0,0,.2)` | Modals / menus (lighter than current heavy slate shadow) |
| **Row elevation hover** | `0 4px 30px 0 rgba(0,0,0,.06)` | Optional list-row hover (library list)—subtle |
| **Control height** | `34px` min-height on compact selects | Align input/button vertical rhythm where Bootstrap allows |
| **Radius** | `2px` (thumbnails), `4px` (e.g. collapse handle `4px 0 0 4px`), `12px` (pills) | Prefer **`4px`** for buttons/inputs; **`8px`** optional for cards to match `lceda.css` panels |
| **Scrollbar (LCSC)** | thumb hover `#d2dff1` | Map to `--scrollbar-thumb` in light theme |

### Optional screenshots

If you add crops (header, primary button, input), place them under `docs/img/` and link here for designers—**not required** now that tokens are documented.

### Dark theme (Dark Reader–style) — map from LCSC tokens

Anchor dark UI to LCSC **major** so the extension still “feels related” to the site:

| Light (above) | Dark target |
|---------------|-------------|
| Page `#f7f7f7` | `#1e1e1e`–`#242424` (slightly above OLED black) |
| Card `#fff` | `#2a2d32`–`#2f3237` (step from **major** `#1c1f23`) |
| Text / secondary | `#e8eaed` / `#aeb0b7` (muted from **lighter**) |
| Border `#dedede` | `#3d4248`–`#52575e` |
| Primary `#1166dd` | `color-mix` or hand-tune to **~70% luminance, lower saturation** (e.g. `#6b9bd8` range—verify contrast on dark bg) |
| Pressed `#033b96` | Slightly lighter blue for dark-bg press state |
| Shadow | Reduce opacity vs light; avoid large colored glows |

---

## Technical approach

### 1. Theme switch: `data-theme` + CSS variables

- Set **`data-theme="light"` | `"dark"`** on `<html>` or `<body>` (prefer `<html>` for cascade).
- Move all colors in `popup.css` to **semantic variables** only (no raw hex in rules except inside `:root` / `[data-theme=…]` blocks).
- Structure:

```text
:root { /* shared geometry: radius, spacing scale */ }
[data-theme="light"] { /* LCSC-light palette */ }
[data-theme="dark"] { /* derived dark palette */ }
```

Shared tokens (both themes): `--radius-sm`, `--radius-md`, `--shadow-card`, `--font-stack` if you unify with LCSC.

### 2. Bootstrap coexistence

- Keep Bootstrap 5.3 for layout/components.
- Override **`.btn-primary`**, **`.form-control`**, **`.modal-content`**, **`.list-group-item`**, **`.badge`**, **tabs** via variables + a thin layer of selectors in `popup.css` (you already override many).
- Avoid fighting Bootstrap: prefer `var(--…)` in your rules and **one** optional `.btn-primary` override block per theme.

### 3. Toggle UI (minimal)

- **Placement:** Settings tab, top of “Appearance” row, or compact control in header (icon + menu)—pick one for v1 to avoid clutter.
- **Control:** Segmented **Light | Dark** or a single switch “Dark mode” (label clarity: “Dark (comfort)” vs “Match LCSC (light)”).

### 4. Persistence

- Save `popupTheme: "light" | "dark"` in **`chrome.storage.local`** (same area as other extension settings).
- On `popup.js` load: read storage → set `document.documentElement.dataset.theme` before first paint if possible (small inline script in `popup.html` is optional; otherwise accept one-frame flash or default light until load).
- Optional: if no key stored, default from `window.matchMedia("(prefers-color-scheme: dark)")` **once**, then user choice always wins.

### 5. “Dark Reader feel” without an extension

Dark Reader effectively **compresses contrast** and **desaturates**. Implementation options:

| Approach | Pros | Cons |
|----------|------|------|
| **Hand-tuned `[data-theme="dark"]` variables** | Predictable, accessible tuning | Two palettes to maintain |
| **`color-mix(in srgb, …)`** from light tokens | Fewer duplicated hexes | Older Chromium? (MV3 targets recent Chrome—usually OK) |
| **CSS `@media (prefers-color-scheme)` only** | Zero toggle code | Doesn’t meet “explicit toggle” requirement alone |

**Recommendation:** Hand-tuned dark variables v1; optionally derive a few accents with `color-mix` from `--primary` to stay in sync.

### 6. Minimal layout / component tweaks (LCSC light)

Small, high-impact changes only (aligned to `styles/`):

- **Header:** Single row; connection status as **chip** (`#eaedf0` bg, `#666` text, `12px` radius) or outline + **primary** dot when online.
- **Tabs:** Active = **primary** border or text (`#1166dd`); inactive hover → `#f4f7fe` / `#e4edff` background strip (category pattern).
- **Cards:** White surface, **`#dedede`/`#e7e7e7` border**, shadow like dropdown (`0 8px 10px -5px rgba(0,0,0,.08)`) or flatter; **remove** heavy slate blur for light theme.
- **Primary button:** `#1166dd` default; **:active** toward `#033b96`; radius **`4px`** (collapse-handle pattern) unless cards use `8px`.
- **Inputs:** White bg, `#dedede` border, min height **34px** where possible (LCSC compact controls).
- **Typography:** LCSC uses **system / sans** in bundles; either match **Roboto, "Helvetica Neue", Arial** or keep **Inter** as deliberate slight offset.

---

## File touch list

| File | Changes |
|------|---------|
| `popup.html` | Optional: `data-theme` default; toggle markup; tiny inline script to reduce flash (optional). |
| `popup.css` | Theme blocks, remove/replace slate-only assumptions, scrollbar colors per theme, modal/toast/picker. |
| `popup.js` | Read/write `popupTheme`, wire toggle, `document.documentElement.dataset.theme = …`. |
| `background.js` | Only if you mirror theme into `snapshotState` for consistency—**not required** if popup-only. |
| `docs/extension-refactor-strategy.md` | Optional one-line pointer to this doc. |

---

## Phased delivery

| Phase | Outcome |
|-------|---------|
| **P1 — Tokens** | `[data-theme=light|dark]` + all colors via variables; light palette LCSC-like; dark palette Reader-like; no toggle yet (manual `data-theme` in devtools). |
| **P2 — Toggle + storage** | Settings UI + `chrome.storage.local` + load on startup. |
| **P3 — Polish** | Tab style, header, card shadow/border pass, focus rings visible in both themes. |
| **P4 — QA** | Keyboard nav, modals (library picker, add library), toasts, connection hint contrast, Windows HiDPI. |

---

## Acceptance checks

- [ ] Light theme: WCAG **AA** for body text vs background (aim **4.5:1** normal text).
- [ ] Dark theme: no pure `#000` page with pure `#fff` text; primary buttons still distinguishable.
- [ ] Toggle survives popup close and browser restart.
- [ ] No unreadable Bootstrap components (switches, modals, list group active state).

---

## Open decisions (you choose)

1. **Default theme:** Always start **light** (LCSC-first) vs follow system until user toggles.
2. **Header toggle vs Settings-only:** Header is faster; Settings keeps chrome minimal.
3. **Inter vs system/Roboto:** LCSC fidelity vs slight “extension identity”.

---

## Related

- **Live LCSC reference assets:** `styles/**/*` (saved CSS; primary source for this plan’s token table).
- **Current popup tokens:** `chrome_extension/popup.css` (`:root` …) — to be split into `[data-theme="light"]` / `[data-theme="dark"]` per above.
- **Content script alignment:** `LCSC_BTN.blue` / `COLORS.primary` in `contentScript.js` (`#1166dd`) — match popup **primary** for a consistent LCSC-adjacent brand.

When LCSC ships a redesign, re-scan `styles/` (or a fresh save) and diff the `:export{…}` blocks and `.searchWrap` / `.productFilter*` rules for token drift.
