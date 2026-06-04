# KiCad Parts Importer — Finalisiertes Konzept (V3)
> **Status:** Autonom finalisiert durch 8 Recherche-Agenten · Stand 2026-06-04 · Engine-Strategie **S1 Hybrid** (Engine behalten, Transport/Orchestrierung neu) · Transport **Chrome Native Messaging** · open-source/AGPL.
>
> **Marker:** 🟢 **ENTSCHIEDEN** = vom Agent beschlossen (in §Entscheidungs-Index gelistet) · 🔴 **BRAUCHT DICH** = echte Wert-/Kosten-/Präferenz-Entscheidung (am Ende gesammelt).

## 0. Produktvision

Ein-Klick-Import eines LCSC-Bauteils direkt in die aktive KiCad-Bibliothek — Symbol, Footprint, 3D, Metadaten — mit **Einfluss auf jedes Puzzleteil**:

- **Konsistenz statt EasyEDA-Wildwuchs:** Gleiche Bauform → immer derselbe Footprint (ein 0402-Widerstand bekommt *immer* den Standard-0402-Footprint). Das **Template-System** ersetzt Symbol/Footprint/3D durch standardisierte Varianten.
- **Auto-Vorschlag** anhand **LCSC-Kategorie + Pin-Zahl + erkannter Bauform** (Kategorie „Widerstände" → nur Widerstands-Templates), als Regel-Liste in den Settings konfigurierbar (vorschlagen vs. automatisch ersetzen).
- **Metadaten als Symbol-Labels** (Value, Toleranz, Hersteller, MPN, Package …) automatisch von der Seite geholt und gesetzt.
- **Perfektfall:** Das System wählt automatisch das richtige Symbol + Footprint + passendes 3D — selbst wenn EasyEDA nichts liefert.
- **Intuitiv:** klicken/auswählen/tippen, Datei-Explorer-artiger Pfad-Picker, Mehr-Dialog-Flows („kein Footprint — was nun?"). Der Nutzer soll es *benutzen*, nicht *studieren*.


---

## 1. Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform


# Feature-Block G+ — Auto-Selection Intelligence (das Herz der V3-Vision)

> Erweitert KONZEPT.md §12 (Category Rules + Skip-Panel-Flow). Diese Spec ist **buildable**: ein autonomer Coding-Agent kann daraus implementieren. Sie ist *additiv* zum existierenden V2-Code — sie ersetzt das schmale `categorySettings`-Modell, behält aber den bereits korrekten Deepest-Prefix-Matcher (`background.js:50` `resolveCategorySettings`), den Param-Mapper (`background.js:33` `mapParamKey` / `LCSC_PARAMS_MAP`) und den Metadaten-Merge (`template_merger.py:222` `_build_value_map`).

## 0. Was heute existiert (Ground Truth, file:line) — was bleibt, was wächst

| Baustein | Datei:Zeile | Status | V3-Aktion |
|---|---|---|---|
| Kategorie-Normalisierung (JS) | `chrome_extension/shared/categoryPath.mjs:37` | ✅ kanonisch, mirror Python | **KEEP** |
| Kategorie-Normalisierung (Python-Mirror) | `easyeda2kicad/helpers.py:12` `normalize_category_path` | ✅ drift-getestet | **KEEP** |
| Deepest-Prefix-Matcher | `background.js:50` `resolveCategorySettings` | ✅ korrekt (longest key mit Slash-Boundary) | **KEEP, generalisieren** auf Rule-Objekt statt nur `{hidePinNumbers,…}` |
| `categorySettings`-Datenmodell | `background.js:118`, popup `buildCategoryItem` (`popup.js:1073`) | ⚠️ nur `{hidePinNumbers,hidePinNames,valueParam}` | **EXTEND** → `ComponentRule` (siehe §1) |
| Page-Snapshot (Category/Package/Params) | `src/content/lcscPageSnapshot.js:66` `extractPageData` → `{category,package,params,description,datasheetUrl,valueParamOptions}` | ✅ liefert `package` bereits | **KEEP**, Package an Phase 1 + Rule-Matcher weiterreichen |
| Phase-1-Resolver | `native_host/phase1.py:92` `fetch_metadata` → `{lcscId,categoryPath,pinCount,datasheetUrl}` | ⚠️ kein Package, keine Lib-Existenz | **EXTEND** (siehe §3.1) |
| Param-Label-Mapper | `background.js:8` `LCSC_PARAMS_MAP` + `mapParamKey` | ✅ | **KEEP**, in Rule-`labelMapping` wiederverwenden |
| Metadaten-als-Labels (Symbol-Properties) | `template_merger.py:222` `_build_value_map`, `background.js:1324` Value-Override | ✅ implementiert | **KEEP**, durch Rule konfigurierbar machen |
| Override Panel (Symbol/Footprint-Dropdowns) | `src/content/overridePanel.js:82` `buildOverridePanel`, `:154` `selectionToOverrides` | ✅ Symbol+Footprint-Source | **EXTEND**: Preselect aus Rule, Confidence-Badges, „Auto"-Hinweis |
| Phase-2-Runner | `native_host/phase2.py:147` `run_phase2_conversion` | ⚠️ Footprint-Template **rejected** (`phase2.py:139`) | **EXTEND** wenn #6/#9 landen — diese Spec liefert die Auto-Selection davor |
| Template-Listing pro Lib | `background.js` `templateSymbolsByLib` / `templateFootprintsByLib` (`:134/:135`, befüllt `:897`) | ✅ Symbol- und Footprint-Namen pro Lib | **KEEP**, Matcher liest daraus |

🟢 ENTSCHIEDEN: Wir bauen **nicht** ein zweites paralleles Rules-Array (`chrome.storage.local.rules` aus KONZEPT §12.2) NEBEN dem existierenden `categorySettings`. Stattdessen wird `categorySettings[categoryPath]` zum vollwertigen `ComponentRule` erweitert (Superset des heutigen `{hidePinNumbers,hidePinNames,valueParam}`). Begründung: Es gibt bereits eine vollständige CRUD-UI (popup.js Categories-Tab), Persistenz, Dedup (`dedupeCategorySettings`), Python-Mirror und einen funktionierenden Matcher — alle keyed auf den normalisierten Category Path. Ein zweites Modell würde Migration, doppelten Matcher und Drift-Risiko erzeugen. Das KONZEPT-§12-`Rule`-Shape wird als *Teilmenge* eingebettet.

---

## 1. Datenmodell: `ComponentRule` (chrome.storage.local.categorySettings)

**Storage-Key bleibt:** `categorySettings: Record<NormalizedCategoryPath, ComponentRule>`. Key = `normalizeCategoryPath(rawBreadcrumb)` (z.B. `"Passives/Resistors/Chip Resistor - Surface Mount"`). Dedup über `canonicalCategoryKey` (lowercase) wie heute (`categoryPath.mjs:59`).

```ts
type ComponentRule = {
  // ── V2-Bestand (KEEP, abwärtskompatibel; fehlende Felder = false/null) ──
  hidePinNumbers?: boolean;      // default false
  hidePinNames?: boolean;        // default false
  valueParam?: string | null;    // LCSC-Param-Name → Symbol "Value" (z.B. "Resistance")

  // ── NEU: Layer-Sources (analog overridePanel LayerChoice) ──
  symbolSource?:    LayerChoice;   // default { source: "easyeda" }
  footprintSource?: LayerChoice;   // default { source: "easyeda" }
  // 3D: KEIN eigenes Feld — 3D folgt dem Footprint (KONZEPT §11.3, ADR-0005).

  // ── NEU: Auto-Apply-Steuerung ──
  autoApply?: "off" | "suggest" | "auto";  // default "suggest"
  //   off     = Rule matcht, aber Panel zeigt EasyEDA-Default, keine Vorauswahl
  //   suggest = Panel öffnet mit vorausgewählten Sources + Confidence-Badge (Default)
  //   auto    = Skip-Panel-Flow: bei voller Auflösung Phase 2 direkt (KONZEPT §12.4)

  // ── NEU: Erwartungs-Constraints (Guards gegen Fehlanwendung) ──
  expectedPinCount?: PinCountSpec | null;  // s. §1.1 — z.B. {exact:2} oder {min:2,max:3}
  packageForm?: string | null;             // erwartete normalisierte Package-Form, z.B. "0603"
  //   Wenn gesetzt: Rule gilt nur, wenn detektierte Package-Form == packageForm
  //   (case-insensitive auf der normalisierten Taxonomie, s. §2). null = egal.

  // ── NEU: Metadaten-/Label-Mapping (Erweiterung des heutigen impliziten Mappings) ──
  labelMapping?: LabelMapping | null;      // s. §1.2

  // ── Bookkeeping ──
  notes?: string | null;
};

type LayerChoice =
  | { source: "easyeda" }
  | { source: "template"; libPath: string; name: string };

type PinCountSpec =
  | { exact: number }
  | { min?: number; max?: number };   // mind. eines gesetzt
```

**Default-Rule (bleibt als Seed, erweitert):** `background.js:120` heute
`"Passives/Resistors": { hidePinNumbers: true, hidePinNames: true, valueParam: "Resistance" }`.
🟢 ENTSCHIEDEN: Seed wird zu
```js
"Passives/Resistors": {
  hidePinNumbers: true, hidePinNames: true, valueParam: "Resistance",
  symbolSource: { source: "easyeda" },          // bis Stock-Lib (§5) installiert ist
  footprintSource: { source: "easyeda" },
  autoApply: "suggest",
  expectedPinCount: { exact: 2 },
  packageForm: null,                             // gilt für alle Widerstands-Packages
  labelMapping: null                             // null = Default-Mapping (§1.2)
}
```
Begründung: Ohne installierte Stock-Library zeigt `template`-Source auf nichts; `easyeda` ist der sichere Default, der den V2-Workflow exakt erhält. Sobald die Stock-Lib (§5) registriert ist, kann der User (oder ein Setup-Wizard, §5.3) `symbolSource` auf das Standard-Resistor-Symbol umstellen.

### 1.1 PinCountSpec-Semantik
- `{exact:n}` → Match nur wenn `pinCount === n`.
- `{min,max}` → Match wenn `min ≤ pinCount ≤ max` (fehlende Grenze = unbeschränkt).
- `null`/fehlend → kein Pin-Constraint.
- `pinCount === 0` (EasyEDA lieferte keine Pins, z.B. reines Footprint-Part) → Constraint wird **übersprungen** (treated as „unbekannt", nicht als Mismatch), damit Perfect-Workflow (§4) nicht blockiert wird.

### 1.2 LabelMapping (Metadaten-als-Labels, konfigurierbar)
Heute ist das Mapping fest verdrahtet: `valueParam` → Symbol-`Value` (`background.js:1324`), Rest der Params → `mapParamKey`-normalisierte Hidden-Properties (`background.js:1340` + `template_merger.py:_build_value_map`). V3 macht das **rule-konfigurierbar**, mit dem Fest-Mapping als Fallback.

```ts
type LabelMapping = {
  // LCSC-Param-Name (vor mapParamKey) → KiCad-Property-Name. Überschreibt LCSC_PARAMS_MAP punktuell.
  fields?: Record<string, string>;   // z.B. { "Resistance": "Value", "Tolerance (±)": "Tolerance" }
  // Whitelist: nur diese (gemappten) Properties als Labels schreiben. null/fehlend = alle (heutiges Verhalten).
  include?: string[] | null;
  // Blacklist nach Mapping. z.B. ["RoHS","Stock"].
  exclude?: string[] | null;
};
```
🟢 ENTSCHIEDEN: `LCSC_PARAMS_MAP` (`background.js:8`) bleibt die globale Default-Mapping-Tabelle; `LabelMapping.fields` ist eine **per-Rule-Überlagerung** darüber (rule wins). Begründung: Die globale Tabelle deckt 90 % ab (Power/Tolerance/Voltage/MPN…); per-Rule-Overrides lösen Sonderfälle (z.B. eine Kategorie nennt „Resistance" anders) ohne Code-Edit. Zielbild des Users (Value=50R, Tolerance=±1%, Package=0603) ist damit deklarativ.

**Mapping-Ablauf (Phase 2, erweitert `background.js:1324–1347`):**
1. `valueParam` → Symbol-`Value` (via `normalizeSymbolValue`, `background.js:37` — strippt z.B. `Ω`).
2. Für jeden übrigen Param `k`: `target = LabelMapping.fields[k] ?? mapParamKey(k)`.
3. `include`/`exclude` anwenden.
4. `Package`-Property aus detektierter Package-Form (§2) injizieren (heute: `payload.componentPackage`, `background.js:1344`).
5. Ergebnis → `symbol_params` → `template_merger._build_value_map` (`template_merger.py:245`) schreibt sie als Properties (sichtbar wenn im Template vorhanden, sonst hidden ans Ende).

---

## 2. Package-Form-Detection & -Taxonomie

**Ziel:** aus dem LCSC-`Package`-Feld (`snapshot.package`) + Footprint-Titel eine **kanonische Package-Form** wie `0402`, `0603`, `SOT-23`, `SOT-23-3`, `SOIC-8` ableiten — als Match-Schlüssel für Rules und als Vorschlags-Signal für die Footprint-Auswahl.

### 2.1 Eingangssignale (Priorität)
1. `snapshot.package` (DOM, `lcscPageSnapshot.js` Label „Package"/„封装" etc., `:27`) — **primär**. Beispiele real: `"0603"`, `"0402"`, `"SOT-23-3"`, `"SOT-23"`, `"SOP-8_3.9x4.9x1.27P"`, `"0603(1608 Metric)"`.
2. EasyEDA-Footprint-Name (Phase 2 `easyeda_footprint.info.name`) — sekundär, nur wenn (1) leer.
3. Pin-/Pad-Count als Disambiguierungs-Hinweis (z.B. SOT-23 vs SOT-23-5).

### 2.2 Normalisierungs-Algorithmus `detectPackageForm(rawPackage, footprintName, pinCount)`
Neues Modul `chrome_extension/shared/packageForm.mjs` **+ Python-Mirror** `easyeda2kicad/package_form.py` (gleiche Drift-Test-Pattern wie `categoryPath`, s. `tests/test_category_path_mirror.py`).

```
1. raw = String(rawPackage || "").trim()
2. Lowercase-Kopie für Matching; Original für Anzeige.
3. CHIP-IMPERIAL: Regex /\b(0075|0100|0201|0402|0603|0805|1206|1210|1812|2010|2512|2920)\b/
   → kanonisch = die 4-stellige Imperial-Zahl. (EasyEDA-Naming R0402/C0603/L0805,
      verifiziert via EasyEDA Footprint Naming Rule Reference.)
4. METRIC-IN-PAREN: "0603(1608 Metric)" / "1608" → map Metric→Imperial via Tabelle
   {1005:0402, 1608:0603, 2012:0805, 3216:1206, 3225:1210, 5025:2010, 6332:2512, ...}.
   Imperial gewinnt als kanonische Form.
5. SOT/SOD/SOIC/TO/QFN/QFP/DFN/BGA-FAMILIE: Regex
   /\b(SOT|SOD|SOIC|SOP|MSOP|TSSOP|SSOP|QFN|DFN|LQFP|TQFP|QFP|BGA|TO|DPAK|SMA|SMB|SMC)[- ]?(\d+)?/i
   → Familie uppercase + "-" + Pin-Zahl wenn vorhanden ("SOT-23-3", "SOIC-8").
   Wenn Pin-Zahl fehlt aber pinCount bekannt: anhängen ("SOT-23" + pinCount=3 → "SOT-23-3"),
   ABER nur wenn das die kanonische Variante ist (Whitelist bekannter Suffixe).
6. THT/RADIAL/AXIAL: Patterns für "DIP-8", "Radial", "Axial", Pin-Pitch ("P2.54").
7. Fallback: trimmed Original, Whitespace→einfacher Space, uppercase-Familie-Präfixe.
   NIE leeren String zurückgeben wenn raw nicht leer war.
8. Rückgabe: { canonical: string, family: string, sizeImperial?: string, sizeMetric?: string,
               pinSuffix?: number, raw: string, confidence: 0..1 }
```

**Confidence-Heuristik:** exakte Whitelist-Treffer (0402/SOT-23-3) → `1.0`; abgeleiteter Pin-Suffix → `0.8`; reiner Fallback-Trim → `0.4`.

### 2.3 Taxonomie (mitgeliefert als `packageForm.taxonomy`)
🟢 ENTSCHIEDEN: Die Taxonomie ist eine **versionierte Datei** `chrome_extension/shared/packageTaxonomy.json` (kein Hardcode im Algorithmus), damit neue Packages ohne Code-Release ergänzt werden. Struktur:
```json
{
  "version": 1,
  "chipImperial": ["0201","0402","0603","0805","1206","1210","1812","2010","2512","2920"],
  "metricToImperial": { "1005":"0402","1608":"0603","2012":"0805","3216":"1206","3225":"1210" },
  "families": {
    "SOT-23": { "pins": [3,5,6], "default": 3 },
    "SOIC":   { "pins": [8,14,16] },
    "QFN":    { "pins": [16,20,24,28,32,48,64] },
    "...": {}
  }
}
```

🟢 ENTSCHIEDEN: Imperial ist die kanonische Form für Chip-Packages (0603, nicht 1608). Begründung: KiCad-Standard-Footprint-Libraries und der Großteil der LCSC-DOM-Anzeige nutzen Imperial; eine Form als Kanon vermeidet Doppel-Rules. Metric wird als Alias `sizeMetric` mitgeführt, damit Matching gegen Metric-only-Footprint-Namen trotzdem klappt.

---

## 3. Matching-Algorithmus → Ranked Suggestion pro Layer

### 3.1 Erweiterte Phase-1-Response (Input für den Matcher)
`native_host/phase1.py:fetch_metadata` (`:92`) wird erweitert. Neue Felder **🟢 ENTSCHIEDEN** (additiv, keine Breaking-Changes):
```jsonc
{
  "lcscId": "C25804",
  "categoryPath": "Passives/Resistors/Chip Resistor - Surface Mount",
  "pinCount": 2,
  "datasheetUrl": "...",
  // NEU:
  "package": "0603",                 // aus page_hints.package (DOM) durchgereicht + normalisiert
  "packageForm": { "canonical":"0603","family":"0603","confidence":1.0 },
  "manufacturer": "UNI-ROYAL",       // aus CAD-Daten/Page (best effort, kann null)
  "mpn": "0603WAF5102T5E",           // best effort
  "existsInActiveLib": { "symbol": false, "footprint": false, "model": false }  // §4.3
}
```
- `package`/`packageForm`: Das Content-Script schickt `snapshot.package` als `page_hints.package`; Phase 1 ruft den Python-`detect_package_form` und gibt `packageForm` zurück. (Pin-Count steht in Phase 1 bereits zur Verfügung → SOT-23-Suffix-Ableitung möglich.)
- `existsInActiveLib`: Phase 1 prüft die Active Library (analog `checkComponentExists`/`ComponentCheckRequest`, `models.py:151`) — wird für Overwrite-Vorschau und Perfect-Workflow gebraucht.

Der **Matcher läuft im Service Worker** (background.js), weil dort `categorySettings`, `templateSymbolsByLib`, `templateFootprintsByLib` und die Active Library leben. Neue Funktion `matchComponentRule(phase1, state)` → `MatchResult`.

### 3.2 MatchResult-Shape
```ts
type LayerSuggestion = {
  layer: "symbol" | "footprint";
  choice: LayerChoice;          // { source:"easyeda" } | { source:"template", libPath, name }
  confidence: number;           // 0..1
  reasons: string[];            // human-readable, fürs Panel-Tooltip
  source: "rule" | "auto-template-match" | "easyeda-fallback";
};
type MatchResult = {
  ruleKey: string | null;       // gewinnender categorySettings-Key (deepest prefix)
  rule: ComponentRule | null;
  symbol: LayerSuggestion;
  footprint: LayerSuggestion;
  autoApply: "off" | "suggest" | "auto";
  guards: {                     // warum NICHT auto (für Skip-Panel-Entscheid §3.5)
    pinCountOk: boolean;        // expectedPinCount erfüllt?
    packageFormOk: boolean;     // packageForm erfüllt?
    templatesResolvable: boolean; // alle template-Sources existieren in templateXByLib?
    pinPadResolvable: boolean;  // Sidecar existiert ODER symPins==fpPads (KONZEPT §13)
    overwriteClear: boolean;    // kein Konflikt ODER overwrite-policy=on
  };
};
```

### 3.3 Schritt-für-Schritt (deterministisch)
```
INPUT: phase1 (§3.1), state.categorySettings, templateSymbolsByLib, templateFootprintsByLib

1. RULE-MATCH (wiederverwendet resolveCategorySettings, background.js:50):
   r = resolveCategorySettings(phase1.categoryPath, categorySettings)
   ruleKey = r?.key ?? null ; rule = r?.config ?? null

2. GUARD: PIN-COUNT
   pinCountOk = matchesPinSpec(phase1.pinCount, rule?.expectedPinCount)   // §1.1
   (pinCount===0 → übersprungen, gilt als ok)

3. GUARD: PACKAGE-FORM
   packageFormOk = !rule?.packageForm
     || equalsFold(rule.packageForm, phase1.packageForm?.canonical)
     || equalsFold(rule.packageForm, phase1.packageForm?.sizeMetric)

4. SYMBOL-SUGGESTION:
   if rule?.symbolSource?.source === "template" && pinCountOk:
       if templateExists(symbolSource, templateSymbolsByLib):
           symbol = { choice: rule.symbolSource, confidence: 0.95, source:"rule",
                      reasons:["Category rule","pin-count "+phase1.pinCount] }
       else: symbol = easyedaFallback("template symbol missing on disk")
   else if rule?.symbolSource?.source === "easyeda":
           symbol = { choice:{source:"easyeda"}, confidence:0.9, source:"rule" }
   else:   // keine Rule oder keine Symbol-Source → versuche Auto-Template-Match (§3.4)
           symbol = autoTemplateMatch("symbol", phase1, templateSymbolsByLib)
                    ?? { choice:{source:"easyeda"}, confidence:0.5, source:"easyeda-fallback" }

5. FOOTPRINT-SUGGESTION (analog, aber Package-Form-getrieben):
   if rule?.footprintSource?.source === "template" && packageFormOk:
        ... (wie Symbol, gegen templateFootprintsByLib)
   else if rule?.footprintSource?.source === "easyeda":
        footprint = { choice:{source:"easyeda"}, confidence:0.9, source:"rule" }
   else:
        footprint = autoTemplateMatch("footprint", phase1, templateFootprintsByLib)
                    ?? easyedaFallback

6. autoApply = rule?.autoApply ?? "suggest"   (keine Rule → "suggest" mit easyeda-Defaults)

7. GUARDS für Skip-Panel (§3.5): templatesResolvable, pinPadResolvable, overwriteClear.

OUTPUT: MatchResult
```

### 3.4 Auto-Template-Match (ohne explizite Rule) — `autoTemplateMatch(layer, phase1, libsByLayer)`
Wird genutzt, wenn KEINE Rule die Source vorgibt, der User aber Template-Libs hat. Heuristik:
```
SYMBOL:
  - Kandidaten = alle Template-Symbol-Namen über alle aktiven Libs.
  - Score per Kandidat:
      +0.5 wenn Name-Token ∈ category-Leaf (z.B. category endet "Resistor" & name enthält "Resistor")
      +0.3 wenn Template-Pin-Count == phase1.pinCount   (Pin-Count via TemplatePinCheck-RPC,
            models.py:170 TemplatePinCheckPayload — gecacht pro (lib,name))
      +0.2 wenn Name enthält detektierte family/size (selten bei Symbolen)
  - Bestes Match mit Score ≥ 0.6 → suggestion (confidence=score, source:"auto-template-match").
  - Sonst null.
FOOTPRINT:
  - Kandidaten = alle .kicad_mod-Basenames über aktive Libs (templateFootprintsByLib).
  - Score:
      +0.7 wenn packageForm.canonical als Token im FP-Namen ("SMD_0603", "R_0603", "0603")
      +0.2 wenn family-Token matcht ("SOT-23")
      +0.1 wenn pinSuffix matcht
  - Score ≥ 0.6 → suggestion. Sonst null.
```
🟢 ENTSCHIEDEN: Auto-Template-Match feuert **nur als Vorschlag** (nie Skip-Panel), selbst bei hoher Confidence, solange keine explizite Rule mit `autoApply:"auto"` existiert. Begründung: Namens-Heuristik ist fehleranfällig (User-Benennungen sind frei); Auto-Apply darf nur bei *explizit vom User gesetzter* Rule passieren — sonst landen falsche Footprints still in der Library. Confidence steuert nur die Vorauswahl + Badge-Farbe im Panel.

### 3.5 Wann Auto-Apply (Skip-Panel) vs. Panel zeigen
Erweitert KONZEPT §12.4. Skip-Panel-Flow **nur wenn alle** erfüllt:
```
autoApply === "auto"
&& guards.pinCountOk && guards.packageFormOk
&& guards.templatesResolvable
&& guards.pinPadResolvable          // Sidecar ODER symPins==fpPads (KONZEPT §13.2)
&& guards.overwriteClear            // (!exists) ODER Settings.defaultOverwrite==true
&& !forcePanel                      // Customize-Button (KONZEPT §12.5)
&& !Settings.alwaysShowOverridePanel  // Master-Toggle (KONZEPT §12.6)
```
→ Phase 2 startet direkt; Inline-Status-Span zeigt z.B. `Auto: Resistor_Std → SMD_0603 · 0603 · 2 pins`.
Sonst → Override Panel mit Vorauswahl + Confidence-Badges (§3.6).

### 3.6 Panel-Vorauswahl & Confidence-Darstellung (erweitert overridePanel.js)
`renderOverridePanel` (`overridePanel.js:216`) bekommt neuen `opts.match: MatchResult`. Verhalten:
- `symSelect.value` / `fpSelect.value` werden auf `match.symbol.choice` / `match.footprint.choice` vorgesetzt (encode via `encodeTemplateValue`, `overridePanel.js:43`).
- Pro Dropdown ein **Confidence-Badge** rechts: 🟢 high (≥0.85) / 🟡 medium (0.6–0.85) / ⚪ low (<0.6, „EasyEDA fallback").
- Tooltip = `match.<layer>.reasons.join(" · ")`.
- Header-Zeile: `Auto-suggested from rule "<ruleKey>"` oder `No rule — best guess` oder `No rule — keeping EasyEDA`.

```
┌─ Override sources ───────────────────────────────────────────┐
│  Auto-suggested from rule "Passives/Resistors"   [Customize]  │
│                                                               │
│  Symbol     [ Resistor_Std (StdLib) ▾ ]   🟢 high             │
│             ↳ Category rule · 2 pins                          │
│  Footprint  [ R_0603_1608Metric (StdLib) ▾ ]  🟡 medium       │
│             ↳ package "0603" matched footprint name           │
│  3D         (follows footprint — not user-selectable)         │
│                                                               │
│  ⚠ Symbol already in active library — overwrite? [ ]          │
│                                   [ Cancel ]  [ Confirm ]     │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. Perfect-Workflow Auto-Assembly (EasyEDA fehlt Symbol/Footprint/3D)

**Use-Case (User-Vision Punkt 5):** LCSC kennt das Bauteil (Page hat Specs), aber EasyEDA liefert kein/leeres Symbol oder keinen Footprint. Das System soll trotzdem die richtigen Teile aus den Template-Libs zusammenklicken — perfekt: voll automatisch.

### 4.1 Erkennung „EasyEDA-Layer fehlt"
- **Symbol fehlt/leer:** `helpers.py:43` `symbol_is_empty(symbol)` existiert bereits. In Phase 1 als Flag `easyedaHas.symbol` (= `pinCount>0 && !empty`) hochreichen.
- **Footprint fehlt:** EasyEDA-CAD-Daten ohne `packageDetail`/Footprint-Shape → `easyedaHas.footprint=false`.
- **3D fehlt:** kein `model_3d` → `easyedaHas.model=false`.

🟢 ENTSCHIEDEN: Diese drei `easyedaHas.*`-Flags werden in der erweiterten Phase-1-Response mitgeliefert (billig: derselbe CAD-Fetch, den Phase 1 ohnehin macht, `phase1.py:127`). Begründung: Der Matcher braucht sie, um „muss-Template" von „kann-Template" zu unterscheiden, ohne einen zweiten Fetch.

### 4.2 Assembly-Entscheidung
```
Für jeden Layer L ∈ {symbol, footprint}:
  if easyedaHas[L]:
      Source-Wahl wie §3 (Rule > Auto-Match > EasyEDA-Default).
  else (EasyEDA hat L NICHT):
      // EasyEDA-Fallback unmöglich → Template ist PFLICHT
      pick = rule?.<L>Source (template) ?? autoTemplateMatch(L) ?? null
      if pick == null:
          suggestion = { choice:{source:"none"}, confidence:0, source:"missing",
                         reasons:["EasyEDA has no "+L+"; no template matched"] }
          → Panel zeigt „No "+L+" found — pick one:" Dropdown (Pflichtfeld, §4.4).
      else:
          confidence bonus, weil Template hier alternativlos und damit „korrekt by construction".
```
**Perfect case** = beide Layer aus Template aufgelöst, Footprint bringt eigenes 3D (`(model …)`-Ref) → **Template-Assembly-Pipeline** (KONZEPT §9.2): **kein EasyEDA-HTTP-Call**, 3D Carry-Over (§11.2). Der Matcher setzt dafür `phase2Mode: "template-assembly"`.

### 4.3 3D-Auto-Assoziation (Footprint ↔ 3D)
3D folgt dem Footprint (ADR-0005, KONZEPT §11.3) — **kein 3D-Dropdown**. Die „Assoziation" passiert über die `(model …)`-Ref im gewählten Template-Footprint:
- Template-Footprint hat `(model …)` → Carry-Over (KONZEPT §11.1 Fall 2–4).
- Template-Footprint ohne Ref + EasyEDA hat 3D → Fallback anhängen (Fall 5).
- Weder noch → kein 3D, kein Fehler (Fall 6).

🟢 ENTSCHIEDEN: Zusätzlich „**check whether the active library already has a matching footprint/3D**" (User-Vision 5) wird über `phase1.existsInActiveLib` (§3.1) + Footprint-Name-Match realisiert: Wenn die Active Library bereits einen Footprint mit demselben kanonischen Package-Form-Namen UND ein zugehöriges 3D hat, zeigt das Panel den Hinweis „Active library already has R_0603 + 3D — reuse?" und bietet diesen als Footprint-Source an (confidence 0.9). Begründung: vermeidet Duplikate, nutzt vorhandene saubere Footprints. Implementierung: Footprint-Index der Active Lib (Basenames + `.3dshapes`-Inhalt) wird beim Lib-Validate ohnehin gezählt (`LibraryValidateResponse.counts`, `models.py:140`); für den Namen-Match braucht es eine Basename-Liste — kleiner Zusatz zum Validate-RPC.

### 4.4 Multi-Dialog-Entscheidungsfluss bei Lücken (User-Vision 7)
Statt separater Dialoge bleibt **alles im Override Panel** (KONZEPT §8: ein Panel ersetzt 5 Dialoge). Bei Lücken werden conditionale Sub-Sektionen eingeblendet:
- „No footprint found" → Footprint-Dropdown rot umrandet, Pflicht, mit Auto-Match-Vorauswahl wenn vorhanden.
- „No symbol found" → analog.
- Confirm bleibt disabled, bis jede Pflicht-Lücke eine Auswahl ≠ `none` hat.

---

## 5. Stock-Library: Auslieferung & Konfiguration der Standard-Symbole/Footprints

**Ziel (User-Vision 4 + 6):** standardisierte Symbole pro Komponentenklasse (ein kanonisches Resistor-Symbol) + Standard-Footprints, die der Auto-Selection als Quelle dienen.

### 5.1 Form der Stock-Library
🟢 ENTSCHIEDEN: Die Stock-Library wird als **normale Template-Library** ausgeliefert — eine `StdLib.kicad_sym` + `StdLib.pretty/` + `StdLib.3dshapes/` — die der Installer in einen User-Ordner schreibt und die Extension automatisch als Template-Library registriert (`isTemplateLibrary:true`, das Flag existiert schon, popup.js:828). **Kein neuer Storage-Mechanismus.** Begründung: Override Panel, ListTemplates, Always-Re-Resolve, Footprint-Carry-Over funktionieren dann *unverändert* mit der Stock-Lib; der User kann Stock-Templates in KiCad inspizieren/forken wie jede andere.

### 5.2 Inhalt v1 (mitgeliefert)
Aufbauend auf den schon bekannten Template-Namen (`template_merger.py:37` `KNOWN_TEMPLATE_NAMES`):
```
StdLib.kicad_sym:
  Resistor_Std, Capacitor_Std, Capacitor_Polarized_Std, Inductor_Std, Diode_Std, LED_Std
StdLib.pretty/:
  R_0402, R_0603, R_0805, R_1206, C_0402, C_0603, C_0805, SOT-23-3, SOT-23-5, SOD-123, ...
StdLib.3dshapes/:  (optional; Footprints können auch auf ${KICAD9_3DMODEL_DIR} referenzieren → Fall 3)
```
🟢 ENTSCHIEDEN: Die mitgelieferten Footprints referenzieren primär die **KiCad-System-3D-Variable** (`${KICAD9_3DMODEL_DIR}`) statt eigene Files (KONZEPT §11.1 Fall 3 = „verbatim, kein Copy"). Begründung: vermeidet Auslieferung großer STEP-Files, nutzt die hochwertigen KiCad-Standardmodelle, die fast jeder KiCad-User installiert hat; nur für Packages ohne KiCad-Pendant wird ein eigenes 3D mitgeliefert.

### 5.3 Installation & Default-Rule-Seeding
- Installer (`native_host/install.py`) legt `StdLib.*` unter einem festen App-Daten-Pfad ab und schreibt den Pfad in eine Manifest-Datei.
- Beim ersten Extension-Start (background.js init) wird die Stock-Lib **automatisch** als Template-Library in `state.libraries` aufgenommen (falls Pfad existiert und noch nicht registriert).
- **Setup-Hint (kein Zwang):** Falls Stock-Lib vorhanden und noch keine Rule eine Stock-Source nutzt, zeigt der Categories-Tab einen Button „Standard-Regeln aus StdLib übernehmen" → seedet erweiterte Default-Rules (Resistor→`Resistor_Std`+`R_<pkg>`, etc., je mit `autoApply:"suggest"`).
🟢 ENTSCHIEDEN: Auto-Apply der Stock-Rules ist initial **`"suggest"`, nie `"auto"`**. Begründung: Der User soll die ersten Imports sehen und bestätigen; erst nach Vertrauen schaltet er einzelne Kategorien auf `"auto"` (One-Click). Das matcht KONZEPT-Zielbild „nach ein paar Imports kennt das Tool die Kategorien" ohne stille Überraschungen am Tag 1.

---

## 6. End-to-End Decision Flow (Phase1 → suggest → panel-or-skip → Phase2)

```
                 ┌────────────────────────────────────────────────────────────┐
                 │ User klickt Download (oder Customize → forcePanel=true)     │
                 └───────────────────────────────┬────────────────────────────┘
                                                 ▼
   ┌──────────────────────── PHASE 1 FETCH (native_host/phase1.py, ~1s) ───────────────────┐
   │ Input: lcscId + pageHints{categoryPath, package, datasheetUrl} (lcscPageSnapshot.js)   │
   │ Output (erweitert §3.1):                                                               │
   │   categoryPath, pinCount, packageForm, manufacturer, mpn,                              │
   │   easyedaHas{symbol,footprint,model}, existsInActiveLib{...}, datasheetUrl             │
   └───────────────────────────────────────────┬───────────────────────────────────────────┘
                                                 ▼
   ┌──────────── MATCH (background.js: matchComponentRule, §3.3) ──────────────┐
   │ 1. resolveCategorySettings → ruleKey/rule (deepest prefix, bg.js:50)      │
   │ 2. Guards: pinCountOk, packageFormOk                                      │
   │ 3. Symbol-/Footprint-Suggestion (Rule > Auto-Match §3.4 > EasyEDA)        │
   │ 4. Perfect-Workflow: easyedaHas[L]==false ⇒ Template Pflicht (§4.2)       │
   │ → MatchResult { symbol, footprint, autoApply, guards }                    │
   └───────────────────────────────────────────┬──────────────────────────────┘
                                                 ▼
                              ┌──────────────── SKIP-PANEL? (§3.5) ───────────────┐
                              │ autoApply=="auto" && alle guards ok && !forcePanel │
                              │ && !alwaysShowOverridePanel                        │
                              └───────┬───────────────────────────┬───────────────┘
                                  JA  │                           │  NEIN
                                      ▼                           ▼
              Inline-Status:                       ┌─ OVERRIDE PANEL (overridePanel.js, §3.6) ─┐
              "Auto: Resistor_Std →                │ Dropdowns vorausgewählt aus MatchResult    │
                 SMD_0603 · 0603 · 2 pins"         │ Confidence-Badges 🟢🟡⚪ + reasons-Tooltip │
                                      │            │ conditional: Overwrite-Warn, fehlende Layer│
                                      │            │ (Pflicht), Datasheet-Preview               │
                                      │            │ Confirm → overrides ; Cancel → Abbruch     │
                                      │            └───────────────┬────────────────────────────┘
                                      │                            │ Confirm
                                      └─────────────┬──────────────┘
                                                    ▼
   ┌──────────────── PHASE 2 (native_host/phase2.py → service/conversion.py) ────────────────┐
   │ overrides = selectionToOverrides(...) ODER MatchResult-Choices (Skip-Pfad)               │
   │ phase2Mode:                                                                              │
   │   - beide template + FP hat (model) ⇒ Template-Assembly (KONZEPT §9.2, KEIN EasyEDA-Call)│
   │   - sonst ⇒ EasyEDA-Pipeline (overrides pro Layer)                                        │
   │ Metadaten-Labels: LabelMapping (§1.2) → symbol_params → template_merger._build_value_map │
   │ 3D: folgt Footprint (KONZEPT §11) — Carry-Over / Fallback / none                          │
   │ Streamed progress → Anchor-Card-Status                                                    │
   └──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Inputs / Outputs (Schnittstellen-Vertrag, für den Coding-Agent)

**`matchComponentRule(phase1, state)` (neu, background.js)**
- IN: `phase1` (§3.1 Shape), `state.{categorySettings, templateSymbolsByLib, templateFootprintsByLib, selectedLibraryPath, settings}`.
- OUT: `MatchResult` (§3.2). Reine Funktion (außer optionalem TemplatePinCheck-RPC-Cache) → unit-testbar mit Vitest/jsdom (analog KONZEPT §17 „Category-Rule-Matcher").

**`detectPackageForm(rawPackage, footprintName, pinCount)` (neu, packageForm.mjs + Python-Mirror)**
- IN: Strings + number. OUT: `{canonical, family, sizeImperial?, sizeMetric?, pinSuffix?, raw, confidence}`.
- Drift-Test JS↔Python mit geteiltem Fixture-Corpus (`tests/test_package_form_mirror.py` + `packageForm.test.mjs`), Muster wie `categoryPath`.

**Erweiterung `categorySettings`-CRUD (popup.js Categories-Tab, `buildCategoryItem` :1073)**
- Neue Felder im Body: Symbol-Source-Dropdown (EasyEDA + Template-Optgroups, identisch overridePanel `populateSelect`), Footprint-Source-Dropdown, `autoApply`-Segmented-Control (off/suggest/auto), `expectedPinCount` (exact/range), `packageForm` (Text mit Taxonomie-Autocomplete), LabelMapping-Editor (Key→Value-Rows, optional/collapsible).
- `readCategoryTableState` (`popup.js:1318`) + `dedupeCategorySettings` (`categoryPath.mjs:91`) erweitern, um die neuen Felder zu lesen/mergen. **mergeCategoryConfig** (`categoryPath.mjs:73`) muss um die neuen Felder ergänzt werden (OR für Booleans, first-non-empty für Sources/Mapping).

---

## 8. Test-Plan (Acceptance, erweitert KONZEPT §12.6/§17)
- [ ] Deepest-Prefix-Match deterministisch (Bestand, `resolveCategorySettings`).
- [ ] PinCountSpec: exact/range/0-skip korrekt.
- [ ] PackageForm: `0603`, `0603(1608 Metric)`, `1608`, `SOT-23`, `SOT-23-3`(pinCount-abgeleitet), `SOP-8_3.9x4.9x1.27P`, leer → korrekte canonical + confidence. JS↔Python drift-frei.
- [ ] Matcher: Rule-Template resolvable → suggestion; Template fehlt auf Disk → easyeda-fallback + reason.
- [ ] Auto-Template-Match: feuert nur als Vorschlag, nie Skip-Panel ohne explizite `autoApply:"auto"`-Rule.
- [ ] Skip-Panel-Flow nur wenn alle Guards ok; jeder Guard einzeln blockt.
- [ ] Perfect-Workflow: EasyEDA ohne Symbol + Template-Symbol vorhanden → Template Pflicht, Panel-Pflichtfeld bis Auswahl.
- [ ] LabelMapping: per-Rule-Override schlägt `LCSC_PARAMS_MAP`; include/exclude greift; Value=50R/Tolerance=±1%/Package=0603 landen als Properties.
- [ ] Stock-Lib: nach Install auto-registriert als Template-Lib; Default-Rule-Seeding setzt `autoApply:"suggest"`.

---
**Quellen (Package-Naming-Recherche):**
- [EasyEDA Footprint Naming Rule Reference (PDF)](https://image.easyeda.com/files/EasyEDA+Footprint+Naming+Rule+Reference.pdf)
- [SMD Package Size Guide](https://www.schemalyzer.com/en/tools/smd-package-guide)
- [SMD Components Guide 0402/0603/0805](https://zbotic.in/smd-components-guide-0402-0603-0805-sizes-explained/)
- [LCSC: Smarter PCB Design — EasyEDA & KiCad](https://www.lcsc.com/blog/smarter-pcb-design-easyeda/)


---

## 2. Template-System + Metadaten-als-Labels

# Bereich: Template-System + Metadata-as-Labels

Dieser Bereich ist in V2 **weitgehend implementiert**. Die folgende Spezifikation beschreibt, was existiert (mit `file:line`-Grounding), was 1:1 erhalten bleibt, und was für V3 ergänzt werden muss (Footprint-Template-Override + Pin-Map-Sidecar). Das Symbol-Template + Metadata-Mapping ist produktionsreif und wird **eingefroren übernommen**.

---

## 1. Datenfluss-Überblick (Ende-zu-Ende)

```
LCSC-Produktseite (DOM)
  │  Content-Script: extractPageData()
  │  (chrome_extension/src/content/lcscPageSnapshot.js:66)
  ▼
{ category, package, params{}, description, datasheetUrl, valueParamOptions[] }
  │  Service-Worker / background.js: Category-Rules + Param-Mapping
  │  (chrome_extension/background.js:1300-1375)
  ▼
TaskCreatePayload / Phase-2-RPC-Params
  │  hide_pin_*, symbol_value_override, symbol_value_param_key,
  │  symbol_params{}, symbol_description, symbol_datasheet_url,
  │  use_template, template_name, template_lib_path, force_template, template_pin_map
  │  (easyeda2kicad/api/models.py:9-69 ; native_host/phase2.py)
  ▼
ConversionRequest (easyeda2kicad/service/conversion.py:54-124)
  │
  ├── use_template=False ──► ExporterSymbolKicad.export()  (EasyEDA-Graphik + Properties)
  │                          (easyeda2kicad/kicad/export_kicad_symbol.py:337)
  │
  └── use_template=True ───► _export_symbol_from_template()  (conversion.py:306)
                              │  ExporterSymbolKicad baut ki_info (gleiche Felder)
                              │  TemplateMerger.merge()  (template_merger.py:373)
                              │  apply_pin_number_map()   (symbol_pin_remap.py:109) [optional PAD-Map]
                              ▼
                          gemergter Symbol-String → add/update in <lib>.kicad_sym
```

**Kernprinzip (V3-Policy):** Der Template-Merge ist ein **reiner String-/S-Expression-Transform** auf dem Template-`.kicad_sym`-Block. Template-Graphik, Property-Positionen, Font-Größen und Sichtbarkeiten bleiben erhalten; nur Property-**Werte** werden ersetzt und das Pin-Set an EasyEDA angeglichen.

---

## 2. Symbol-Template-Merge (IMPLEMENTIERT — übernehmen)

**Datei:** `easyeda2kicad/kicad/template_merger.py`, Klasse `TemplateMerger` (Zeile 208), Methode `merge()` (Zeile 373).

### 2.1 Was eine Template-`.kicad_sym` ist
Eine selbst-enthaltene KiCad-v6/v7-Symboldefinition, die der User im Symbol-Editor zeichnet. Sie liefert:
- Grafischen Körper (Rechteck/Polylinien/Pins-Geometrie),
- Property-Layout (Positionen `(at …)`, `(effects (font (size …)))`, `(hide yes)`),
- Den **Reference-Prefix** (z.B. `R`, `C`, `L`, `D`) — dieser wird **bewusst NICHT** durch EasyEDAs Prefix (oft `U`) überschrieben (`template_merger.py:230-237`, `_build_value_map`).

**Guard:** Templates mit `(extends "…")` werden mit klarer `ValueError` abgelehnt (`template_merger.py:384-392`) — sie haben keinen eigenen Body. 🟢 ENTSCHIEDEN: beibehalten; das ist die richtige Fehlermeldung.

### 2.2 Merge-Schritte (`merge()`, in Reihenfolge)
1. **Value-Map bauen** (`_build_value_map`, Zeile 221): siehe §3.
2. **Property-Werte ersetzen** (Zeile 399-423): Fuzzy-Key-Match zwischen LCSC-Param-Namen und Template-Field-Namen. Nur das **zweite gequotete Argument** der `(property "Key" "Value" …)`-Zeile wird getauscht (`_replace_property_value`, Zeile 75-83 via Regex); Position/Effects bleiben intakt.
3. **Property-Namen normalisieren** (Zeile 426): `℃`→`°C`, `℉`→`°F`, nur wenn das Zielname noch nicht existiert (`_normalize_property_declaration_names`, Zeile 100).
4. **Extra-LCSC-Felder anhängen** (Zeile 429-451): LCSC-Params, die zu keinem Template-Field matchen, werden als **versteckte** Properties (`(hide yes)`) vor `(embedded_fonts …)` bzw. vor dem schließenden `)` eingefügt (`_make_hidden_property`, Zeile 261).
5. **Pin-Tabelle reconcilen** (`_merge_pin_table`, Zeile 276): siehe §2.3.
6. **Sub-Symbol-Blöcke umbenennen** `TemplateName_N_M` → `ComponentName_N_M` (Zeile 462).
7. **Äußere Symbol-Deklaration umbenennen** (Zeile 469).
8. **Tabs → 2 Spaces** normalisieren (Zeile 479; KiCad-Writer erwartet Spaces).
9. **Pin-Sichtbarkeit auf Root-Ebene** anwenden (`_apply_root_symbol_pin_visibility`, Zeile 166) — Kategorie-Flags `hide_pin_numbers`/`hide_pin_names` werden auch im Template-Pfad respektiert (vorher übersprungen).

### 2.3 Pin-Reconciliation (`_merge_pin_table`, Zeile 276)
Das finale Symbol muss **exakt** das EasyEDA-Pin-Set haben (KiCad-Constraint: jede `(pin (number "N"))` muss zu einem `(pad "N")` im Footprint passen — es gibt keine separate Verbindungstabelle, siehe `symbol_pin_remap.py:1-11`).

Logik:
- Fehlende EasyEDA-Pins werden bei `(0,0)` eingefügt (über `KiSymbolPin.export_v6()`, an die Primär-Unit `symbol "Name_0_1"`).
- Template-only Pins werden entfernt (von hinten nach vorn, damit Offsets gültig bleiben).
- **Sonderfall (Zeile 307-317):** Template-Pin-**Nummern** disjunkt von LCSC (z.B. `G/D/S` vs `1/2/3`), aber **Pin-Anzahl identisch** → Template-`(pin …)`-Blöcke bleiben **unverändert**, damit die Gallery-PAD-Map (Keys = Template-Pin-Nummern) vor `apply_pin_number_map` ausgerichtet bleibt.
- Validierung am Ende (Zeile 360-369): warnt bei Diskrepanz.

### 2.4 PAD-Map (Symbol-Pin-Nummern-Remap)
**Datei:** `easyeda2kicad/kicad/symbol_pin_remap.py`, `apply_pin_number_map()` (Zeile 109), aufgerufen in `conversion.py:366-384`.

- Schreibt **nur** Symbol-`(pin … (number "…"))` um — **niemals** `(name …)` und **niemals** Footprint-`(pad …)` (Footprint-Pads bleiben immer EasyEDA, siehe `footprint_pad_remap.py:1-14` Warnung).
- Zwei-Phasen-Rename mit Temp-Labels (`__K2C_PINNUM_…`, Zeile 134) gegen Swap-/Offset-Korruption.
- Targets müssen eindeutig sein (Zeile 126-132), sonst Skip + Warning.
- `01` vs `1` werden als gleicher Pin behandelt (`_pin_number_matches`, Zeile 40).
- `footprint_pad_remap.apply_template_pin_map_to_footprint` (Zeile 74) existiert, ist aber **nur für Tests** — darf NICHT in den Import-Pfad zurückverdrahtet werden ohne explizite Produktentscheidung.

🟢 ENTSCHIEDEN: Symbol-Pin-Remap-Architektur (Symbol-`number` rewrite, Footprint unverändert) bleibt der V3-Standard. KiCad-konform und bereits getestet.

---

## 3. Metadata-as-Labels — das exakte Mapping (IMPLEMENTIERT — übernehmen)

### 3.1 Stufe 1: Content-Script-Scrape (`lcscPageSnapshot.js:66`)
`extractPageData()` läuft **strukturell** über *alle* `<table>`-Elemente (nicht klassenbasiert, robust gegen LCSC-Tailwind-Migration):
- Überspringt Pricing-Tables (`looksLikePricingTable`, Zeile 43).
- Nimmt 2-/3-spaltige Zeilen `Label → Value`, last-write-wins (Spec-Table überschreibt Header-Card).
- Liefert: `category` (normalisiert), `package`, `params{}` (alle Label→Value-Paare), `description`, `datasheetUrl`, `valueParamOptions[]`.
- Multilinguale Schlüssel-Labels in `PAGE_SCRAPE_LABELS` (Zeile 24): Category/Package/Description/Datasheet in DE/EN/FR/ZH.

### 3.2 Stufe 2: Param-Mapping + Value-Param (`background.js`)
**LCSC→Canonical-Key-Mapping** (`LCSC_PARAMS_MAP`, `background.js:8-31`), z.B.:
| LCSC-Seiten-Label | Canonical-Key |
|---|---|
| `Power(Watts)`, `Rated Power`, `Power Dissipation`, `Rated Power (Watts)` | `Power` |
| `Tolerance (±)`, `Resistance Tolerance`, `Capacitance Tolerance` | `Tolerance` |
| `Temperature Coefficient` | `Temp. Coefficient` |
| `Operating/Storage Temperature` | `Operating Temp.` / `Storage Temp.` |
| `Voltage Rating - DC` u.a. (5 Varianten) | `Voltage Rating` |
| `DC Resistance (DCR) (Max)`, `DC Resistance` | `DCR` |
| `Saturation Current (Isat)` | `Sat. Current` |
| `Self Resonant Frequency` | `Self Res. Freq.` |
| `Manufacturer Part Number` | `MPN` |
| `Mounting Type` | `Mounting` |

**Value-Param-Logik** (`background.js:1304-1366`): Pro Kategorie (Settings) ist ein `valueParam` definiert (z.B. Resistors → `"Resistance"`). Daraus:
- `symbol_value_override` = `normalizeSymbolValue(params[valueParam], valueParam)` — für `Resistance` wird `Ω` gestrippt: `"10kΩ"`→`"10k"` (`background.js:37-44`).
- `symbol_value_param_key` = `mapParamKey(valueParam)` — der Value-Param-Key wird aus `symbol_params` **ausgeschlossen** (kein Duplikat), aber gemerkt, falls ein Template ein zweites Feld mit diesem Namen hat.
- `symbol_params{}` = alle übrigen Params (gemappt), **exklusive** valueParam und exklusive `Datasheet` (Zeile 1334-1338, LCSC-Datasheet-Zeile ist Link-Text, nicht URL). Plus injiziertes `Package` aus `componentPackage` (Zeile 1344).

> ⚠️ BUG GEFUNDEN: `background.js:39` enthält `\ Resistor values:` (Backslash) statt `//`-Kommentar. In JS ist `\` am Zeilenanfang ein Syntaxfehler bzw. line-continuation und würde die Datei brechen, falls nicht durch ein Build-Tooling toleriert. **In V3 fixen** → `// Resistor values: strip the Ohm symbol`.

### 3.3 Stufe 3: Backend-Property-Erzeugung (Direkt-Export & Template-Merge)
**Standard-Property-Keys** (`parameters_kicad_symbol.py:121-132`, `STANDARD_SYMBOL_PROPERTY_KEYS`): `Reference, Value, Footprint, Datasheet, Description, Manufacturer, LCSC Part, JLC Part`. LCSC-Param-Rows mit diesen Namen werden nicht dupliziert.

**Direkt-Export** (`KiSymbolInfo.export_v6`, `parameters_kicad_symbol.py:155-242`): emittiert Reference/Value/Footprint/Datasheet/Description (+Manufacturer/LCSC Part/JLC Part wenn vorhanden), dann alle `symbol_params` als sichtbare Properties unter dem Body.

**Template-Merge Value-Map** (`template_merger.py:_build_value_map`, Zeile 221-258):
| KiCad-Property | Quelle |
|---|---|
| `Value` | `value_override` sonst `name` |
| `Footprint` | `package` (mit `<lib>:` Prefix via `tune_footprint_ref_path`) |
| `Datasheet` | `datasheet` (= `symbol_datasheet_url` falls von Seite gescraped, `export_kicad_symbol.py:282`) |
| `Description` | `symbol_description` sonst Fallback |
| `Manufacturer` | `manufacturer` (wenn vorhanden) |
| `LCSC Part` | `lcsc_id` |
| `JLC Part` | `jlc_id` |
| *(flach aus `symbol_params`)* | `Tolerance`, `Package`, `Power`, `Voltage Rating`, … (außer STANDARD-Keys) |
| *(value_param_key)* | falls Template ein gleichnamiges Feld hat → selber Wert wie `Value` |

### 3.4 Unicode-/Alias-Normalisierung (`kicad_text_normalize.py`)
- `normalize_for_kicad_text` (Zeile 26): NFKC, Dash-Varianten→`-`, `℃`→`°C`, `℉`→`°F`, Zero-Width/BOM entfernt. Grund: KiCad-Default-Fonts fehlen Single-Codepoint-Kompat-Zeichen.
- `normalize_property_key_for_match` (Zeile 46): casefold + Whitespace-Kollaps für Key-Matching.
- `LCSC_CANONICAL_TO_PAGE_LABEL_ALIASES` (Zeile 59-82): **Reverse** der `background.js`-Map — Templates verwenden oft das Original-LCSC-Wording (`Temperature Coefficient`), die Extension sendet aber den Canonical-Key (`Temp. Coefficient`). `normalized_match_keys_for_lcsc_param` (Zeile 85) liefert beide Formen, damit der Merge das richtige Template-Feld trifft.

### 3.5 Beispiel: Widerstand 50 R, ±1 %, 0603
LCSC-Seite liefert `params = { Resistance: "50Ω", "Tolerance (±)": "±1%", … }`, `componentPackage = "0603"`. Settings Kategorie `Passives/Resistors` → `valueParam: "Resistance"` (`background.js:120`).
Ergebnis-Payload:
```
symbol_value_override  = "50"          (Ω gestrippt)
symbol_value_param_key = "Resistance"
symbol_params          = { "Tolerance": "±1%", "Package": "0603", … }   (Resistance ausgeschlossen)
```
Im Template `Template_Resistor` (`template_merger.py:37-42`, KNOWN_TEMPLATE_NAMES):
```
Value      = "50"            (→ KiCad-Label, sichtbar)
Tolerance  = "+-1%"          (Dash normalisiert; an Template-Feld "Tolerance")
Package    = "0603"
Reference  = "R"             (Template-Prefix, NICHT EasyEDAs "U")
```

---

## 4. Footprint-Template-Override + Pin-Map-Sidecar (NEU für V3 — NOCH NICHT verdrahtet)

### 4.1 Aktueller Stand: abgelehnt
`native_host/phase2.py:139-144` (`_validate_overrides`) wirft hart:
```
"footprint template override is not yet wired
 (needs Pin-Map Sidecar #9 + 3D follows Footprint #6)"
```
Grund: Symbol-Template merged Pins gegen EasyEDA, aber ein **Template-Footprint** hat ein **eigenes**, festes Pad-Set, das nicht mit EasyEDA-Pins übereinstimmen muss. Ohne persistierte Pin↔Pad-Zuordnung würde die Schematic↔PCB-Verbindung brechen.

### 4.2 Pin-Map-Sidecar (KONZEPT §13, `docs/KONZEPT.md:1058-1109`)
**Wann nötig:** Symbol-Pin-Count ≠ Footprint-Pad-Count (z.B. 8-Pin-Logiksymbol auf DIP14 mit NC-Pads), oder Labels disjunkt.

**Resolution-Reihenfolge** (KONZEPT §13.2):
1. Sidecar existiert → direkt benutzen, keine UI.
2. Sym-Pin-Count == FP-Pad-Count + numerischer Match → triviales 1:1, keine UI.
3. Sonst → Pin↔Pad-Sub-UI im Override Panel (`pinPadSubPanel.js`, KONZEPT §8.2.4 / §13.3).

**Sidecar-Pfad:** `<TemplateLibrary>/pin_maps/<symbol>__<footprint>.json` (KONZEPT §10.2 / §13).
**Format** (KONZEPT §13.4):
```json
{
  "version": 1,
  "symbol":    { "libPath": "…/MyTemplates.kicad_sym", "name": "Resistor_SMT" },
  "footprint": { "libPath": "…/MyTemplates.kicad_sym", "name": "SMD_0603" },
  "mapping":   [ {"pin": "1", "pad": "1"}, {"pin": "2", "pad": "2"} ],
  "created":   "2026-05-29T12:34:56Z"
}
```

### 4.3 Was V3 implementieren muss (Backend)
1. **Neues Modul `native_host/pin_map.py`** (KONZEPT §6, Zeile 585): Sidecar-Lookup + atomic-write (temp+rename, gleiches Pattern wie Symbol-Lib-Writes; KONZEPT §17 Zeile 1269).
2. **`phase2.py`-Gate öffnen:** `_validate_overrides` (Zeile 139-144) so erweitern, dass `footprint.source == "template"` akzeptiert wird, sobald Sidecar resolved oder triviales Mapping vorliegt.
3. **`ConversionRequest` erweitern** um `footprint_template_*` Felder (analog `template_name`/`template_lib_path`) + `pin_map`-Mapping (`pin→pad`). `template_pin_map` (conversion.py:79) ist bereits vorhanden, aber als **Symbol**-Number-Remap definiert — die Sidecar-`mapping` muss in genau dieses `template_pin_map`-Format übersetzt werden (Key = Symbol-Pin, Value = Footprint-Pad).
4. **Template-Assembly-Pipeline** (KONZEPT §9.2, Zeile 828-849): Wenn **beide** Layer `template` und der Template-Footprint eine `(model …)`-Ref hat → **kein EasyEDA-Call**: Symbol von Disk, Footprint von Disk, 3D-Carry-Over (ADR-0005 / §11.2), Pin-Map-Resolve, dann schreiben.
5. **Footprint-Datei kopieren** in Active-Lib `.pretty/` mit umgeschriebener `(model …)`-Ref (KONZEPT §9.1 Schritt 10-11).

🔴 BRAUCHT DICH: siehe userOnlyQuestions (Reset-Pin-Map-Button, Footprint-SVG-Render-RPC).

### 4.4 Footprint-Template-Listing (bereits vorhanden)
`native_host/templates.py:list_templates` (Zeile 44) listet bereits Symbol- **und** Footprint-Namen einer Template-Library (`.kicad_sym` + Sibling `.pretty/*.kicad_mod`). Die Override-Panel-Dropdowns können also schon befüllt werden; nur der Assembly-/Write-Pfad fehlt.

---

## 5. Always-Re-Resolve (IMPLEMENTIERT — Policy verbindlich)

**Policy** (KONZEPT §4 Zeile 58, §8.4, §10.5, §13): Templates werden bei **jedem** Import frisch von Disk gelesen — keine Snapshots, kein Caching, kein Versions-Pinning. Der User editiert `.kicad_sym`/`.kicad_mod` in KiCad und sieht die Änderung beim nächsten Import.

**Wo erfüllt:**
- `_export_symbol_from_template` (`conversion.py:306`) liest das Template-File via `extract_symbol_from_lib(str(template_lib), …)` (`helpers.py:150`) **bei jedem Aufruf** frisch von Disk — keine Cache-Schicht. Bestätigt in `phase2.py:33-36`-Docstring.
- Template-Listing (`templates.py`) liest ebenfalls jedes Mal frisch.

🟢 ENTSCHIEDEN: Always-Re-Resolve ist bereits korrekt umgesetzt; in V3 nur per Mock-FS-Test absichern (zwei Reads → unterschiedlicher Inhalt; KONZEPT §8.4 / §10.5 Acceptance Criteria).

---

## 6. Behalten / Verbessern / Neu — Zusammenfassung

**BEHALTEN (eingefroren übernehmen):**
- `template_merger.py` komplett (Symbol-Merge, Value-Map, Pin-Reconciliation, Hidden-Props).
- `symbol_pin_remap.py` (Symbol-Number-Remap, Zwei-Phasen-Rename).
- `kicad_text_normalize.py` (Unicode + Alias-Map).
- `parameters_kicad_symbol.py` Property-Erzeugung + `STANDARD_SYMBOL_PROPERTY_KEYS`.
- `lcscPageSnapshot.js` Scrape + `background.js` `LCSC_PARAMS_MAP`/Value-Param-Logik.
- Always-Re-Resolve-Verhalten.

**VERBESSERN:**
- **BUG `background.js:39`**: `\ Resistor values:` → `// Resistor values:` fixen.
- `value_param_key`-Pfad testen (es gab keine direkten Unit-Tests für „Template-Feld == Value-Param-Name").
- `_replace_property_value` (`template_merger.py:75-83`) nutzt Regex auf S-Expressions; bei Werten mit eingebetteten Backslashes/Sonderzeichen Edge-Cases mit Golden-File-Tests absichern (S1-Strategie: Golden-Corpus).

**NEU (V3):**
- Footprint-Template-Override-Pfad (`phase2.py`-Gate, Template-Assembly-Pipeline §9.2).
- `native_host/pin_map.py` (Sidecar-Lookup/Write, atomic).
- Pin↔Pad-Sub-UI-Integration ins Override Panel (gehört zum UI-Bereich, hier nur Backend-Contract).
- 3D-Carry-Over-Kopplung beim Footprint-Template (ADR-0005, gehört zum 3D-Bereich).

---

## 7. Inputs / Outputs (Backend-Contract)

**Input (Phase-2-RPC `convert`, via `native_host/phase2.py`):**
```
{ lcscId, libraryPath,
  overrides: {
    symbol:    {source:"easyeda"} | {source:"template", libPath, name},
    footprint: {source:"easyeda"} | {source:"template", libPath, name}   // template: NEU
  },
  // abgeleitet aus Category-Rules + Scrape:
  hide_pin_numbers, hide_pin_names,
  symbol_value_override, symbol_value_param_key,
  symbol_params{}, symbol_description, symbol_datasheet_url,
  template_pin_map{}   // Symbol-Pin → Footprint-Pad (aus Sidecar abgeleitet)
}
```
**Output:** `{ lcscId, libraryPath, symbolPath, footprintPath, messages[] }` (`phase2.py:213-219`) + gestreamte Progress-Frames.

---

## 8. Acceptance Criteria (für autonomen Coding-Agenten)

- [ ] Symbol-Template-Merge erhält Graphik/Positionen/Reference-Prefix; nur Werte getauscht (Golden-File `Template_Resistor` + Beispiel 50R/±1%/0603).
- [ ] Pin-Reconciliation: fehlende EasyEDA-Pins @ (0,0) hinzugefügt, Template-only entfernt; Sonderfall „gleiche Anzahl, disjunkte Labels" lässt Template-Pins unverändert.
- [ ] PAD-Map schreibt nur Symbol-`(number …)`, nie Pad/Pin-Name; duplizierte Targets → Skip+Warning.
- [ ] Param-Mapping: `Power(Watts)`→`Power`, `Tolerance (±)`→`Tolerance`, Value-Param ausgeschlossen, `Package` injiziert, `Datasheet`-Row excluded.
- [ ] Unicode: `℃`→`°C`, Dash-Varianten→`-`, `±` bleibt; Alias-Map matched `Temperature Coefficient` ↔ `Temp. Coefficient`.
- [ ] Always-Re-Resolve: Mock-FS-Test, zwei Reads, unterschiedlicher Inhalt.
- [ ] `background.js:39` Syntax-Bug gefixt.
- [ ] Footprint-Template: Sidecar resolved → keine UI; Sym≠Pad ohne Sidecar → Sub-UI-Trigger; Assembly-Pipeline ohne EasyEDA-HTTP-Call.

---

## 3. 3D-Layer

## Feature-Block F — 3D-Layer (V3, final, buildable)

Reconciliation note: Diese Spec verfeinert ADR-0005 + KONZEPT §11 und integriert die User-Ergänzungen (Footprint↔3D-Association, Missing-Pieces/Perfect-Assembly). Wo KONZEPT §11 von „fünf/sechs Pfaden" spricht, ist die untenstehende 7-Fall-Tabelle die **maßgebliche** Verfeinerung (KONZEPT §11.1 hatte 6 Zeilen, eine Inkonsistenz im Fließtext „die fünf 3D-Pfade" → 🟢 hier auf 7 normalisiert, inkl. expliziter Association-Reuse-Fall).

### F.0 Leitprinzip (aus ADR-0005)
**3D folgt dem Footprint — deterministisch, nicht user-overridebar.** Es gibt kein „3D-Quelle"-Dropdown im Override Panel. Wer den Footprint wählt (EasyEDA vs. Template), legt damit implizit die 3D-Quelle fest. Begründung steht in ADR-0005 §a-c und bleibt verbindlich.

🟢 ENTSCHIEDEN (F-DEC-1): 3D bleibt eine **implizite dritte Schicht ohne eigenes UI**. Keine Erweiterung des Override Panels um 3D. Alles, was der User über 3D steuert, läuft über die Footprint-Wahl (Override Panel / Category-Rule).

---

### F.1 Wer liefert das 3D — deterministische Resolution Order

Genau ein 3D-Provider gewinnt, ausgewertet **in dieser Reihenfolge** (erste zutreffende Zeile entscheidet):

| # | Footprint-Quelle | Bedingung | Provider / Resultat |
|---|---|---|---|
| 1 | **Template-FP** | hat ≥1 `(model ...)`-Ref **auf Template-internes File** | **Carry-Over** (F.2): Copy mit SHA-256-Dedup nach `<ActiveLib>.3dshapes/`, Ref-Rewrite auf `${KIPRJMOD}/<ActiveLib>.3dshapes/<basename>`. |
| 2 | **Template-FP** | hat ≥1 `(model ...)`-Ref **auf KiCad-System-Variable** (`${KICAD9_3DMODEL_DIR}`, `${KISYS3DMOD}`, generisch `\$\{[A-Z][A-Z0-9_]*\}`) | Ref **verbatim** belassen, **kein** Copy. |
| 3 | **Template-FP** | hat ≥1 `(model ...)`-Ref **auf absoluten Pfad außerhalb der Template-Lib** | Ref **verbatim** belassen, **kein** Copy. |
| 4 | **Template-FP** | **keine** `(model ...)`-Ref **+ Active-Lib hat bereits passendes 3D** (Association, F.3) | **Reuse**: existierendes `<ActiveLib>.3dshapes/<basename>` referenzieren, `(model ...)` an Template-FP **anhängen**, kein Download. |
| 5 | **Template-FP** | **keine** `(model ...)`-Ref **+ EasyEDA hat 3D** | **Fallback**: EasyEDA-3D pullen (wie Fall 6), in `<ActiveLib>.3dshapes/` schreiben, `(model ...)` an Template-FP **anhängen**. |
| 6 | **EasyEDA-FP** | EasyEDA hat 3D (`model_3d` ≠ None bzw. 3D-UUID downloadbar) | EasyEDA-Pipeline (V2-Verhalten): WRL+STEP nach `<ActiveLib>.3dshapes/`, `(model ...)` mit `${KIPRJMOD}/<ActiveLib>.3dshapes/...`. |
| 7 | **beide** | **kein** Model-Ref, **kein** EasyEDA-3D | `progress("no 3D model available", …)`, Footprint **ohne** `(model ...)` schreiben. **KEIN Fehler** (Remove-Case). |

🟢 ENTSCHIEDEN (F-DEC-2): **Genau eine `(model ...)`-Form pro Footprint** im Endresultat (KiCad erlaubt mehrere, aber alle unsere Provider liefern eines). Hat ein Template-FP *mehrere* `(model ...)`-Refs, behandelt Carry-Over **jede** Ref einzeln nach F.2-Klassifikation (eine kann verbatim bleiben, eine kopiert werden) — die Refs bleiben in Anzahl/Reihenfolge erhalten, nur Pfade werden ggf. umgeschrieben. Fall 4/5 (Anhängen) greifen nur bei **null** vorhandenen Refs.

🟢 ENTSCHIEDEN (F-DEC-3): Fall 4 (Association-Reuse) **vor** Fall 5 (EasyEDA-Fallback). Wenn die Active-Lib bereits ein passendes 3D hat, ist Offline-Reuse schneller und vermeidet einen unnötigen EasyEDA-Roundtrip — exakt der „library has matching footprint/3D"-Wunsch des Users. Detektion siehe F.3.

🔴 (siehe userOnlyQuestions F-Q1): Verhalten bei **Hash-Collision** im Carry-Over — hart abbrechen vs. neuer Suffix-Name.

---

### F.2 Template-3D Carry-Over — Mechanik (NEUER Code)

**Status: nicht implementiert.** Heute existiert nur die EasyEDA-Seite: `export_kicad_3d_model.py` (OBJ→WRL/STEP) und der `(model ...)`-Emit in `export_kicad_footprint.py:964-987`. Carry-Over ist neu zu bauen.

Neues Modul: 🟢 ENTSCHIEDEN (F-DEC-4) `easyeda2kicad/kicad/template_3d_carryover.py` (im gefrorenen Engine-Paket, neben `template_merger.py`/`footprint_pad_remap.py`). So bleibt die ganze Template-Mechanik beieinander; phase2.py orchestriert nur.

#### F.2.1 Inputs / Outputs
- **Inputs:** `template_fp_path: Path` (Quell-`.kicad_mod` in `<TemplateLib>.pretty/`), `template_lib_dir: Path` (Verzeichnis der Template-Lib = `template_fp_path.parent.parent`), `active_lib_prefix: Path` (z.B. `.../MyLib`, ohne Suffix), `active_lib_name: str` (= `active_lib_prefix.name`).
- **Outputs:** `rewritten_fp_text: str` (der `.kicad_mod`-Inhalt mit umgeschriebenen Refs; der **Caller** schreibt ihn atomar nach `<ActiveLib>.pretty/<name>.kicad_mod`), `copied_files: list[Path]` (0..N in `<ActiveLib>.3dshapes/`), `messages: list[str]`.

#### F.2.2 Parsing der `(model ...)`-Refs
🟢 ENTSCHIEDEN (F-DEC-5): **Regex-Extraktion statt Full-S-Expr-Parser** für den Pfad-String. Eine `(model "<path>" ...)`-Form beginnt mit `(model` gefolgt von einem quoted-or-bare Pfad-Token; nur dieses erste Token wird ersetzt, der Rest der Form (`offset/scale/rotate`) bleibt byte-für-byte erhalten. KONZEPT §11.2.2 sagt „S-Expression-Parser" — das ist **überdimensioniert** und riskiert, hand-kuratierte Template-Footprints durch Roundtrip-Reformatierung zu verändern (Whitespace, Kommentare, KiCad-9-`(model_3d ...)`-Varianten). Surgical Regex-Replace bewahrt die Datei.

Pattern (Python, `re.DOTALL` nicht nötig, Pfad ist single-line):
```python
# Erkennt: (model "PATH" ...   ODER  (model PATH ...   (KiCad quoted/unquoted)
_MODEL_RE = re.compile(r'(\(\s*model\s+)("(?:[^"\\]|\\.)*"|\S+)')
```
Für jeden Match: `path_raw` = Group 2 (mit/ohne Quotes); entquoten → klassifizieren (F.2.3) → ggf. neuen Pfad einsetzen, Quotes/Whitespace-Stil des Originals beibehalten.

#### F.2.3 Klassifikation eines Pfads (entscheidet Fall 1 vs 2/3)
```
norm = path.replace("\\", "/")
1. Variable-Form:  ^\$\{[A-Z][A-Z0-9_]*\}      → VERBATIM  (Fall 2)
                   (deckt ${KICAD9_3DMODEL_DIR}, ${KISYS3DMOD}, ${KICAD8_...}, ${KIPRJMOD} ab)
2. Resolve gegen template_lib_dir:
   - relativ ("SOT-23.step", "../shapes/x.wrl", "${KIPRJMOD}/..")  → join mit template_lib_dir
   - absolut ("C:/..", "/usr/..")                                  → as-is
   resolved = (template_lib_dir / norm).resolve()  (für relative)
3. Liegt resolved INNERHALB template_lib_dir (Path.is_relative_to)?
   UND Source-File existiert?                       → CARRY-OVER  (Fall 1)
   sonst (außerhalb / existiert nicht)              → VERBATIM    (Fall 3)
```
🟢 ENTSCHIEDEN (F-DEC-6): `${KIPRJMOD}` zählt als **Variable** → verbatim. Ein Template-FP, der schon `${KIPRJMOD}/...` referenziert, ist bewusst projekt-relativ; nicht anfassen. (Edge-Case, der in KONZEPT §11.2.2 nicht explizit war.)

🟢 ENTSCHIEDEN (F-DEC-7): Existiert das als Carry-Over klassifizierte **Source-File nicht** auf Disk, wird die Ref **verbatim belassen + Warn-Message** („template 3D model not found on disk: <path> — left as-is"), **kein Abbruch**. Ein fehlendes 3D darf den Symbol/Footprint-Import nicht killen (gleiche Toleranz wie Fall 7).

#### F.2.4 Copy + SHA-256-Dedup (nur Fall 1)
```
basename   = Path(resolved).name                  # z.B. "SOT-23.step"
target_dir = <ActiveLibDir>/<ActiveLibName>.3dshapes/     # mkdir(exist_ok=True)
target     = target_dir / basename
src_hash   = sha256(resolved bytes)

if target existiert:
    if sha256(target) == src_hash:  → SKIP copy (idempotent)   ✅
    else:                           → HASH-COLLISION (siehe F-Q1)
else:
    shutil.copy2(resolved, target)  → copied_files.append(target)

# Rewrite (immer, auch bei skip): Ref → ${KIPRJMOD}/<ActiveLibName>.3dshapes/<basename>
new_ref = f"${{KIPRJMOD}}/{active_lib_name}.3dshapes/{basename}"
```
🟢 ENTSCHIEDEN (F-DEC-8): Dedup-Key = **Dateiname + Content-Hash**, nicht Hash allein. Zwei verschiedene Modelle gleichen Namens (`SOT-23.step` aus zwei Template-Libs mit anderem Inhalt) sind die Collision aus F-Q1; zwei gleiche Inhalte gleichen Namens sind idempotenter Skip. Inhaltsgleiche Files **unterschiedlichen** Namens werden bewusst **nicht** dedupliziert (zwei Dateien) — KiCad-Refs sind namensbasiert, Cross-Name-Dedup würde Refs brechen.

🟢 ENTSCHIEDEN (F-DEC-9): Rewrite-Ziel ist **immer** `${KIPRJMOD}/<ActiveLibName>.3dshapes/<basename>` (projekt-relativ), konsistent mit der EasyEDA-Pipeline-Default und ADR-0005. Konsequenz: die Active-Lib muss im KiCad-Projekt liegen, in dem importiert wird — das ist die V3-Grundannahme (Single Active Library, KONZEPT §3).

#### F.2.5 Wireframe — Carry-Over Datenfluss
```
 <TemplateLib>.pretty/SOT-23-3.kicad_mod          <ActiveLib>.pretty/SOT-23-3.kicad_mod
   (model "SOT-23.step" ...)        ──parse──┐       (model "${KIPRJMOD}/MyLib.3dshapes/SOT-23.step" ...)
                                             │                          ▲
 <TemplateLib>.3dshapes/SOT-23.step          │ sha256 + copy            │ rewrite
        │  bytes ─────────────────────────────┴──────────► <ActiveLib>.3dshapes/SOT-23.step
        │                                       (skip wenn Hash gleich)
        └─ KONZEPT §11.2: idempotent, content-hash-dedupliziert
```

---

### F.3 Footprint↔3D-Association (User-Wunsch: „Lib hat schon passendes 3D")

**Zweck:** Erkennen, dass die Active Library für den anstehenden Import bereits einen passenden Footprint und/oder ein 3D besitzt, und es **wiederverwenden** statt neu zu erzeugen/downloaden. Adressiert User-Vision #5.

🟢 ENTSCHIEDEN (F-DEC-10): **Association läuft über den Footprint-Basename als Schlüssel** — die KiCad-native Verbindung Footprint→3D ist der `(model ...)`-Eintrag im `.kicad_mod`; ein „matching 3D" ist deterministisch das File, dessen Basename der Footprint referenziert bzw. das gleich heißt wie der Footprint. Kein semantisches Geometrie-Matching (zu fragil, kein Mehrwert für den deterministischen Pfad).

Konkrete Detektion (Fall 4, reine Disk-Inspektion, offline):
```
1. Active-FP-Name bestimmen (= Template-FP-Name, der geschrieben wird).
2. Existiert <ActiveLib>.pretty/<fpName>.kicad_mod schon?
   → parse dessen (model ...)-Ref → basename B.
   → existiert <ActiveLib>.3dshapes/B ?  → REUSE: an den neu zu schreibenden
     Template-FP dieselbe ${KIPRJMOD}/...-Ref hängen. Kein Download.
3. Sonst: gibt es <ActiveLib>.3dshapes/<fpName>.{step,wrl} ?
   → REUSE per Namensgleichheit (FP-Name == Modell-Basename).
4. Sonst: kein Reuse → weiter zu Fall 5 (EasyEDA-Fallback).
```
🟢 ENTSCHIEDEN (F-DEC-11): Association-Reuse greift **nur im Template-FP-ohne-eigene-Ref-Pfad** (Fall 4). Hat der Template-FP eine eigene Ref → Fall 1-3 (Carry-Over) hat Vorrang, weil die Template-Intention explizit ist. Hat der User EasyEDA-FP gewählt → Fall 6 (EasyEDA-3D gehört zum EasyEDA-FP); kein Reuse eines fremden Template-3D, das würde Geometrie-Misalignment riskieren (ADR-0005 Caveat).

🟢 ENTSCHIEDEN (F-DEC-12): „Footprint schon in Lib + `overwrite=False`" (heute `conversion.py:596-600` und §F.2.4-Idempotenz) bedeutet implizit Association-Reuse — der existierende FP **mit** seiner 3D-Ref bleibt stehen, 3D wird nicht neu geschrieben. Das ist bereits korrektes Verhalten und wird durch F.3 nur für den **neu schreibenden** Fall ergänzt.

---

### F.4 Missing-Pieces / Perfect-Assembly für 3D

**Perfect-Assembly (User-Vision #5, „PERFEKTER Fall"):** Category-Rule oder Override Panel wählt **beide** Layer = Template, der Template-FP **bringt sein 3D mit** (Fall 1). Dann greift **Template-Assembly** (KONZEPT §9.2): *kein* EasyEDA-Call, Symbol-Properties kommen aus Phase-1-Metadaten, Footprint + Carry-Over-3D aus der Template-Lib. Das ist der zentrale „LCSC kennt das Bauteil, EasyEDA hat weder Symbol noch Footprint, aber meine Template-Lib hat alles drei"-Use-Case.

**Missing-Pieces-Matrix für 3D** (was, wenn ein Stück fehlt):

| Symbol | Footprint | 3D-Resultat | Flow |
|---|---|---|---|
| Template | Template+Ref | Carry-Over (Fall 1) — **Perfect-Assembly**, kein EasyEDA-Call | §9.2 |
| Template | Template, keine Ref | Association-Reuse (4) → EasyEDA-Fallback (5) → „no 3D" (7) | §9.2/§9.1 |
| Template | EasyEDA | EasyEDA-3D (Fall 6) | §9.1 |
| EasyEDA | EasyEDA | EasyEDA-3D (Fall 6) oder „no 3D" (7) | §9.1 |
| Template | — *(EasyEDA hat keinen FP)* | siehe F-DEC-13 | Multi-Dialog |

🟢 ENTSCHIEDEN (F-DEC-13): Wenn **kein** Footprint resolvebar ist (weder Template gewählt noch EasyEDA liefert einen), gibt es **kein** 3D — 3D folgt dem Footprint, ohne Footprint kein Anker. Resultat: Symbol-only-Import, `progress("no footprint → no 3D", …)`, **kein Fehler**. Die „what now?"-Multi-Dialog-Entscheidung (User-Vision #7) ist **UI-Sache des Override-Panel-Areas**, nicht des 3D-Layers; der 3D-Layer reagiert nur deterministisch auf die getroffene Footprint-Wahl.

🟢 ENTSCHIEDEN (F-DEC-14): Der **Remove-Case** (Fall 7, „kein Model-Ref, kein EasyEDA-3D") ist ein **First-Class-Erfolgspfad**, kein Degraded-Mode: Footprint wird sauber ohne `(model ...)` geschrieben, Import gilt als erfolgreich. KiCad öffnet solche Footprints normal (nur ohne 3D-Body). Test F-AC-7 deckt das ab.

---

### F.5 Integration in phase2.py (heute deaktiviert)

Heute setzt `phase2.py:191` hart `generate_model=False` und `_validate_overrides` (`phase2.py:139-143`) **rejected** `footprint.source == "template"` explizit mit „needs … 3D follows Footprint #6". **Dieser Area (#6) hebt beide Sperren auf.**

Zu ändern (für den implementierenden Agenten):
1. **`phase2.py:191`** `generate_model=False` → `generate_model=True`, sobald ein Footprint geschrieben wird (EasyEDA-FP → Fall 6; Template-FP → Carry-Over übernimmt, `generate_model` bleibt für den EasyEDA-Fallback Fall 5 relevant).
2. **`phase2.py:139-143`** Footprint-Template-Reject entfernen; stattdessen Footprint-Override an die Conversion durchreichen (analog `symbol_override`). Neue Felder auf `ConversionRequest`: `footprint_use_template: bool`, `footprint_template_name`, `footprint_template_lib_path`.
3. **`conversion.py` `generate_footprint`-Block (558-611)**: Verzweigung
   - EasyEDA-FP → bestehender Pfad (`ExporterFootprintKicad(...).export(...)`, Fall 6), danach `generate_model`-Block (613-664) wie heute.
   - Template-FP → **statt** `ExporterFootprintKicad`: Template-`.kicad_mod` von Disk lesen → `template_3d_carryover.process(...)` (F.2) → Resultat-Text atomar nach `<ActiveLib>.pretty/` schreiben. Für Fall 4/5 (keine Ref) ggf. Association-Reuse (F.3) bzw. EasyEDA-Fallback (Model aus `Easyeda3dModelImporter`, `(model ...)` an FP anhängen via `KI_MODEL_3D`-Format aus `parameters_kicad_footprint.py:56`).
4. Progress-Events: mind. eines pro 3D-Pfad — „carrying over 3D model…" (Fall 1), „reusing existing 3D…" (Fall 4), „downloading EasyEDA 3D…" (Fall 5/6), „no 3D model available" (Fall 7). Wired durch den bestehenden `_progress_cb` / `emit` (phase2.py:202-207).

#### F.5.1 Bug-Fix-Hinweis im bestehenden `(model ...)`-Emit
In `export_kicad_footprint.py:964-987` ist die `file_3d`-Konstruktion fragil: bei `model_3d_path_is_explicit=False` wird `file_3d` **nur** in den `elif`-Zweigen (972/975/977) gesetzt; fällt der Pfad-String durch alle (theoretisch unmöglich, aber nicht garantiert), ist `file_3d` ungebunden → `UnboundLocalError`. 🟢 ENTSCHIEDEN (F-DEC-15): Beim Verdrahten des Template-Pfads diesen Emit **nicht** wiederverwenden für Carry-Over (Carry-Over schreibt seinen eigenen Ref-String direkt in den Template-FP-Text). Der Emit bleibt nur für die EasyEDA-Pipeline (Fall 6) zuständig; ein defensives `file_3d = f"..{model_path}/{model_base_name}.wrl"`-Default vor dem `if`-Block schließt den UnboundLocal-Gap (kleiner Backport-würdiger Fix).

---

### F.6 Acceptance Criteria (verfeinert ggü. KONZEPT §11.4)

Golden-File-Tests gegen Fixture-Footprints + Sample-LCSC-Parts (Test-Korpus, S1-Strategie):
- [ ] F-AC-1 Fall 6: EasyEDA-FP + EasyEDA-3D → `.wrl`+`.step` in `<ActiveLib>.3dshapes/`, `(model "${KIPRJMOD}/<lib>.3dshapes/...")` im FP.
- [ ] F-AC-2 Fall 1: Template-FP mit interner Ref → Carry-Over kopiert File, Ref umgeschrieben auf `${KIPRJMOD}/...`.
- [ ] F-AC-3 Fall 1 idempotent: zweiter Import desselben Parts → **kein** zweiter Copy (Hash gleich → skip), FP byte-identisch.
- [ ] F-AC-4 Fall 2: `${KICAD9_3DMODEL_DIR}`-Ref → verbatim, kein Copy, kein File in `.3dshapes/`.
- [ ] F-AC-5 Fall 3: absoluter externer Pfad → verbatim.
- [ ] F-AC-6 Fall 4: Active-Lib hat schon `<fp>.step` → Reuse, **kein** EasyEDA-Call.
- [ ] F-AC-7 Fall 5: Template-FP ohne Ref + EasyEDA-3D → Fallback-Download, `(model ...)` angehängt.
- [ ] F-AC-8 Fall 7: kein Ref + kein EasyEDA-3D → FP ohne `(model ...)`, Import **success**, kein Fehler.
- [ ] F-AC-9 Multi-Ref-Template-FP: eine interne + eine `${KISYS3DMOD}`-Ref → erste kopiert+rewritten, zweite verbatim, Anzahl/Reihenfolge erhalten.
- [ ] F-AC-10 Hash-Collision: gleicher Basename, anderer Inhalt → Verhalten gemäß F-Q1-Entscheid (Test folgt der gewählten Option).
- [ ] F-AC-11 Source-File fehlt (F-DEC-7): Ref verbatim + Warn-Message, kein Abbruch.
- [ ] F-AC-12 Perfect-Assembly: beide Template + Template-FP-3D → **kein** EasyEDA-HTTP-Call (Mock-API zählt 0 Calls), 3D korrekt carried over.
- [ ] F-AC-13 Manueller pcbnew-Smoke: Footprint öffnet, 3D-Body sichtbar (Fall 1, 4, 6).


---

## 4. Transport & RPC-Vertrag (Native Messaging)

… (see below) …

# Transport & RPC-Contract — Native Messaging + SW↔Content-Script

> **Status:** Finalisierte, baubare Spezifikation. Ersetzt vollständig `chrome_extension/EXTENSION_WS_RPC_CONTRACT.md` (V2 WebSocket/JSON-RPC). Grundlage: `native_host/host.py`, `native_host/phase1.py`, `native_host/phase2.py`, `native_host/templates.py`, `native_host/install.py`, `chrome_extension/background.js`, `chrome_extension/src/content/rpc.js`, `chrome_extension/src/content/phase2Convert.js`, `easyeda2kicad/api/server.py` (Legacy-Verbquelle für `fs_*` / `templates_*` / `lcsc_footprint_preview`), `easyeda2kicad/service/conversion.py`, `easyeda2kicad/service/lcsc_preview.py`. ADR-0001 (Native Messaging), ADR-0004 (Streamed progress, no Job state).

Es gibt **zwei** Hops, jeder mit eigenem Envelope:

```
 Content-Script  ──(A) chrome.runtime msg ──▶  Service Worker  ──(B) Native-Messaging frame ──▶  Python Host
 (Anchor Card,        {type, …}                 (background.js)      4-byte len + JSON              (host.py)
  Override Panel)  ◀── {ok, data}|{ok, error} ──               ◀── {id, ok, …}|{id, type:"progress"} ──
```

- **(A)** SW↔Content/Popup: `chrome.runtime.sendMessage` (request/response) plus broadcast pushes für Streaming.
- **(B)** SW↔Host: Chrome Native Messaging (length-prefixed JSON über stdio). **Nur der Service Worker** darf `connectNative` aufrufen (ADR-0001); Popup und Content-Script gehen immer über Hop (A).

---

## 1. Hop B — Native-Messaging Wire-Protokoll

### 1.1 Framing (4-Byte Length-Prefix)

Implementiert in `native_host/host.py:61-80` (`_read_message`/`_write_message`).

- Jeder Frame: **`uint32` Little-Endian Längen-Präfix** + genau so viele Bytes UTF-8-JSON.
  `struct.pack("<I", len(encoded))` + `encoded`. 🟢 ENTSCHIEDEN: Little-Endian beibehalten — Chrome Native Messaging schreibt/erwartet native byte order, auf allen Zielplattformen (win/mac/linux x86/arm) Little-Endian; kein Grund für Netzwerk-Byte-Order.
- **Chrome→Host** Frame-Limit: **1 MB** (Chrome-Hard-Limit). **Host→Chrome** Limit: **1 MB** pro Frame.
  → 🔴 Konsequenz: SVG/Datasheet-Payloads müssen unter 1 MB bleiben (siehe `renderFootprintSvg`/`fetchDatasheet` unten, base64-Gating).
- EOF (stdin `read(4)` liefert < 4 Bytes) ⇒ Host beendet sauber mit Exit-Code 0 (`host.py:226-229`). Das passiert, wenn Chrome `port.disconnect()` ruft oder der SW stirbt.
- Längenpräfix `0` ⇒ leerer Frame `{}` (Defensive; `host.py:67-68`).

### 1.2 Request-Envelope (SW → Host)

```jsonc
{ "id": <number>, "verb": "<string>", "params": { … } }   // params optional, je Verb
```

- `id`: monoton genug, dass Antworten zugeordnet werden können. Heute `Date.now()` (`background.js:1657` u.a.). 🟢 ENTSCHIEDEN: `id` wird auf einer **persistenten Warm-Verbindung** (§1.6) zum **Korrelations-Schlüssel** — Pflicht, eindeutig pro offenem Port. Empfehlung: monoton steigender Zähler `++seq` statt `Date.now()` (vermeidet Kollisionen bei zwei Frames in derselben ms).
- `verb`: einer aus der Tabelle in §1.4. Unbekannt ⇒ Fehler `unknown_verb`.
- `params`: Objekt. Fehlt/`null`/kein-Objekt ⇒ Host behandelt als `{}` (`host.py:142-146`).

### 1.3 Response-Envelope (Host → SW)

**Terminal — Erfolg:**
```jsonc
{ "id": <number>, "ok": true, "result": { … } }
```
> Hinweis: `ping` antwortet historisch flach (`{id, ok:true, version}`, `host.py:139`) statt mit `result`. 🟢 ENTSCHIEDEN: `ping` so belassen (eingespielt, vom SW so gelesen `background.js:1645`); alle **anderen** Verbs liefern Nutzdaten unter `result`.

**Terminal — Fehler:**
```jsonc
{ "id": <number>, "ok": false, "error": { "code": "<string>", "message": "<string>" } }
```
> 🔴→🟢 ENTSCHEIDUNG (Vertragsbruch zur Verbesserung): **Strukturiertes Fehlerobjekt** `{code, message}` einführen. Heute liefert der Host `"error": "<freitext>"` (`host.py:154,159,208`) und der SW liest `msg.error` als String (`background.js:1648,1772,1869`). Der maschinenlesbare `code` ist nötig, damit Content-Script-Dialoge ("kein Footprint → was nun?") deterministisch verzweigen können statt Strings zu parsen. Migration: Host packt künftig `{code, message}`; SW-Bridges lesen `msg.error.message` für Anzeige und `msg.error.code` für Logik. Abwärtskompatibler Shim im SW: `const e = typeof msg.error === "string" ? {code:"unknown", message:msg.error} : msg.error;`.

**Streaming — Progress (nur `convert`), nicht-terminal:**
```jsonc
{ "id": <number>, "type": "progress", "message": "<string>", "progress": <0..100|absent> }
```
- `type:"progress"`-Frames halten den Port offen; **nur** ein Frame mit `ok` (true/false) ist terminal (`background.js:1856-1870`, `host.py:170-186`). Erzeugt vom `emit`-Callback (`host.py:234`) → `phase2.run_phase2_conversion` (`phase2.py:202-211`).
- `progress` ist optional; fehlt es, rendert die UI nur `message` (`phase2Convert.js:43-51`).
- 🟢 ENTSCHIEDEN: Reservierte Frame-`type`-Werte: `"progress"` (jetzt), `"warning"` (künftig, nicht-terminal, soll **nicht** als Fehler resolven — Code im SW matcht bereits explizit auf `type==="progress"`, alles andere mit `ok` ist terminal; ein `warning`-Frame ohne `ok` würde heute ignoriert, das ist das gewünschte Verhalten). Jeder nicht-terminale Frame MUSS ein `type` führen; jeder terminale Frame MUSS `ok` führen und **kein** `type`.

### 1.4 Verb-Übersicht

| Verb | Phase / Zweck | Streaming? | Single-Flight (`busy`)? | Heute implementiert |
|------|----------------|-----------|--------------------------|---------------------|
| `ping` | Liveness / Pre-Warm | nein | nein | ✅ `host.py:138` |
| `fetchMetadata` | Phase 1 Fetch | nein | **ja** | ✅ `host.py:141` |
| `convert` | Phase 2 Conversion | **ja** | **ja** | ✅ `host.py:165` |
| `listTemplates` | Override-Panel Quellen | nein | nein | ✅ `host.py:203` |
| `fetchDatasheet` | Datasheet-Bytes (Host-Pfad, optional) | nein | nein | ❌ neu (siehe §1.5.6) |
| `renderFootprintSvg` | FP-Preview SVG + Pads | nein | nein | ❌ neu — portiert `lcsc_footprint_preview` (`server.py:274`) |
| `pinMapRead` | Pin↔Pad Sidecar lesen | nein | nein | ❌ neu (#9) |
| `pinMapWrite` | Pin↔Pad Sidecar schreiben | nein | nein | ❌ neu (#9) |
| `fsRoots` | File-Explorer Wurzeln | nein | nein | ❌ neu — portiert `_fs_roots` (`server.py:719`) |
| `fsList` | File-Explorer Verzeichnis | nein | nein | ❌ neu — portiert `_fs_list_directory` (`server.py:760`) |
| `fsCheck` | Pfad-Prüfung | nein | nein | ❌ neu — portiert `_fs_check` (`server.py:808`) |

> 🟢 ENTSCHIEDEN — **Verb-Naming `camelCase`**: Die V3-Native-Host-Verbs sind bereits camelCase (`fetchMetadata`, `listTemplates`); die portierten Legacy-Verbs werden von `snake_case` (`fs_roots`) auf camelCase (`fsRoots`) umbenannt, damit die Wire-Sprache einheitlich ist. Der Python-Dispatcher in `host.py:handle` mappt camelCase-Verb → Handler; die portierten Implementierungen aus `server.py` bleiben funktional unverändert (nur ohne FastAPI/`HTTPException` — Fehler werden zu `{code,message}`).

### 1.5 Verb-Detailverträge

#### 1.5.1 `ping`
**Request:** `{ "id": n, "verb": "ping" }`
**Response (Erfolg):** `{ "id": n, "ok": true, "version": "0.0.1" }` (flach, `host.py:139`, `HOST_VERSION`).
**Fehler:** keine (kann nicht `busy` werden — kein Lock).
**Nutzung:** Pre-Warm (`background.js:1624 pingNativeHostOnce`), Keep-Alive-Alarm alle 25 s (`background.js:1621`), Status-Badge `online`/`offline`/`checking` (`background.js:1669`).

#### 1.5.2 `fetchMetadata` (Phase 1)
**Request:**
```jsonc
{ "id": n, "verb": "fetchMetadata",
  "params": { "lcscId": "C25804", "pageHints": { "categoryPath": "Resistors/...", "datasheetUrl": "https://…" } } }
```
- `lcscId` Pflicht, `^C\d+$` (case-insensitive, getrimmt, upper-cased; `phase1.py:35-43`).
- `pageHints` optional; `categoryPath` + `datasheetUrl` aus dem **LCSC Page Snapshot** (Content-Script). `categoryPath` wird Host-seitig via `normalize_category_path` normalisiert (drift-frei zur JS-Seite, `phase1.py:140`).

**Response (Erfolg):**
```jsonc
{ "id": n, "ok": true,
  "result": { "lcscId": "C25804", "categoryPath": "Resistors/Chip Resistor - Surface Mount",
              "pinCount": 2, "datasheetUrl": "https://…|null" } }
```
Felder außer `lcscId` dürfen `null`/`0` sein (`phase1.py:149-154`).

**Fehler:**
- `invalid_lcsc_id` — fehlend/malformed (heute `ValueError` → `{ok:false,error:"invalid lcscId: …"}`, `host.py:153`).
- `busy` — Single-Flight (Phase 1 ODER Phase 2 läuft; gemeinsamer Lock, `host.py:55-58`).
- `internal` — sonstige Exception (`host.py:155-160`).
> Robustheit: EasyEDA-API-Ausfall ist **kein** Fehler — `phase1.py:126-129` fängt ab und liefert `pinCount:0` + Hint-Datasheet. Die Funktion wirft nur bei kaputter `lcscId`.

#### 1.5.3 `convert` (Phase 2, **streamt**)
**Request:**
```jsonc
{ "id": n, "verb": "convert",
  "params": {
    "lcscId": "C25804",
    "libraryPath": "D:/KiCad/MyLib",          // ohne .kicad_sym-Suffix; Host trimmt ihn ggf. (phase2.py:88-93)
    "overrides": {                             // optional (Override Panel #5)
      "symbol":    { "source": "easyeda" } | { "source": "template", "libPath": "…/Templates.kicad_sym", "name": "Template_Resistor" },
      "footprint": { "source": "easyeda" } | { "source": "template", "libPath": "…", "name": "…" }
    }
  } }
```
- Validierung: `lcscId` (`^C\d+$`), `libraryPath` Pflicht, `overrides` Shape (`phase2.py:96-144`). `footprint.source==="template"` ist **noch** abgelehnt (`phase2.py:139-143`) bis Pin-Map (#9) + 3D (#6) stehen → Fehler `not_implemented`.

**Streaming-Frames (0..n):**
```jsonc
{ "id": n, "type": "progress", "message": "Connecting to EasyEDA…", "progress": 20 }
```
- Quelle: `ConversionStage` treibt `progress` (Stage-Enum `conversion.py:36-44`: QUEUED→FETCHING→EXPORT_SYMBOL→EXPORT_FOOTPRINT→EXPORT_MODEL→FINALISING→COMPLETED), `message` ist der menschenlesbare Text (`phase2.py:202-207`). Erster Frame `"Starting Phase 2 conversion…" (0)`, letzter vor Terminal `"Conversion finished." (100)` (`phase2.py:209-211`).

**Response (terminal — Erfolg):**
```jsonc
{ "id": n, "ok": true,
  "result": { "lcscId": "C25804", "libraryPath": "D:/KiCad/MyLib",
              "symbolPath": "D:/KiCad/MyLib.kicad_sym",
              "footprintPath": "D:/KiCad/MyLib.pretty/R0603.kicad_mod",
              "messages": ["…"] } }
```
(`phase2.py:213-219`; 3D-`model_paths` folgen mit #6.)

**Fehler:**
- `invalid_lcsc_id`, `invalid_library_path`, `invalid_overrides` — Param-Validierung (`phase2.py`).
- `not_implemented` — Footprint-Template-Override (`phase2.py:139`).
- `busy` — Single-Flight.
- `conversion_failed` — `ConversionError`/Pipeline-Exception (`host.py:192-198`). `message` trägt EasyEDA-Detail (z. B. `"Failed to fetch data for C99999: HTTP 404"`).
- `timeout` — **SW-seitig**, nicht vom Host: 60 s Envelope (`NATIVE_HOST_CONVERT_TIMEOUT_MS`, `background.js:1613`).

#### 1.5.4 `listTemplates`
**Request:** `{ "id": n, "verb": "listTemplates", "params": { "libPath": "…/Templates.kicad_sym" } }`
**Response:** `{ "id": n, "ok": true, "result": { "libPath": "…", "symbols": ["Template_Resistor", …], "footprints": ["R0603", …] } }` (`templates.py:44-69`). Beide Listen können leer sein (Layer fehlt) — die UI degradiert auf "nur EasyEDA".
**Fehler:** `invalid_lib_path` (fehlend/leer, `templates.py:60`); kein `busy` (read-only, schnell).
> 🟢 ENTSCHIEDEN: `listTemplates` bleibt **außerhalb** des Busy-Locks — es darf während einer laufenden Phase-1/2-Operation nicht blockieren, da das Override-Panel die Dropdowns parallel füllt. Read-only Disk-Listing ist nebenwirkungsfrei.

#### 1.5.5 `renderFootprintSvg` (neu — portiert `lcsc_footprint_preview`)
**Request:** `{ "id": n, "verb": "renderFootprintSvg", "params": { "lcscId": "C25804" } }`
**Response:**
```jsonc
{ "id": n, "ok": true,
  "result": { "ok": true, "footprintSvg": "<svg …>|null", "footprintName": "R0603",
              "pads": [ { "number":"1","x":…,"y":…,"width":…,"height":…,"shape":"…","type":"…", … } ],
              "easyedaPins": [ { "number":"1", "name":"…" } ] } }
```
Direkt aus `run_lcsc_footprint_preview` / `footprint_preview_bundle` (`server.py:274-296`, `lcsc_preview.py:33-67`). 🟢 ENTSCHIEDEN: Render-Größe **960×960** wie Legacy (`server.py:288`) — gut genug für die Override-Panel-Vorschau, bleibt unter dem 1-MB-Frame-Limit.
**Fehler:** `invalid_lcsc_id`; `fetch_failed` (EasyEDA nicht erreichbar). Kein `busy`.

#### 1.5.6 `fetchDatasheet` (neu, optional)
> 🟢 ENTSCHIEDEN: **Primärpfad bleibt im Service Worker** (`fetchDatasheetBlob`, `background.js:2323-2620`) — der SW kann LCSC-Cookies senden (`credentials:"include"`), HTML-Shells nach der echten `.pdf`-URL durchsuchen und Progress an die Tab streamen; der Host kann das nicht. Dieser Host-Verb ist nur **Fallback** für Setups, in denen `host_permissions` für `datasheet.lcsc.com` fehlen oder eine reine Host-Auslieferung gewünscht ist.
**Request:** `{ "id": n, "verb": "fetchDatasheet", "params": { "url": "https://…pdf" } }`
**Response:** `{ "id": n, "ok": true, "result": { "contentType": "application/pdf", "base64": "…", "byteLength": 12345 } }`
**Fehler:** `invalid_url` (kein http(s)); `too_large` (> 900 KB nach base64, wegen 1-MB-Frame-Limit — strenger als der SW-Pfad mit 24 MB!); `fetch_failed`. Kein `busy`.
> 🔴 BRAUCHT DICH: Ob der Host-Datasheet-Fallback überhaupt gebaut wird, hängt davon ab, ob du große Datasheets über Native Messaging zulassen willst (1-MB-Frame-Cap zwingt zu Chunking/Tempfile). Default-Empfehlung: **weglassen**, SW-Pfad genügt.

#### 1.5.7 `pinMapRead` / `pinMapWrite` (neu, #9)
Pin↔Pad-Sidecar pro Template-Symbol (persistiert die Zuordnung „merged symbol pin number → footprint pad name", `models.py:62-69 template_pin_map`).
**`pinMapRead` Request:** `{ "id": n, "verb": "pinMapRead", "params": { "libPath": "…/Templates.kicad_sym", "name": "Template_Resistor" } }`
**Response:** `{ "id": n, "ok": true, "result": { "libPath":"…", "name":"…", "pinMap": { "1":"1", "2":"2" }, "exists": true } }`
**`pinMapWrite` Request:** `{ …, "params": { "libPath":"…", "name":"…", "pinMap": { "1":"A", "2":"K" } } }`
**Response:** `{ "id": n, "ok": true, "result": { "written": true, "path": "…/Templates.pinmap.json" } }`
> 🟢 ENTSCHIEDEN: Sidecar-Format **JSON neben der `.kicad_sym`** (`<lib>.pinmap.json`, Map `{symbolName: {pinNumber: padName}}`). Begründung: menschenlesbar, versionierbar, keine Mutation der KiCad-Datei, einfaches atomares Schreiben (temp+rename). Schlüssel/Werte sind Strings (Pin-Nummern können Buchstaben enthalten).
**Fehler:** `invalid_lib_path`, `invalid_name`, `write_failed` (Permission/IO). Kein `busy`.

#### 1.5.8 `fsRoots` / `fsList` / `fsCheck` (neu — portiert für den File-Explorer-Pfadpicker)
Portiert 1:1 aus `server.py:719-826`. UX-Prinzip „wie ein Datei-Explorer" (Vision §7): `fsList` liefert `entries` + `breadcrumbs` + `parent`, was Hierarchie-Navigation, Breadcrumbs und Zurück abdeckt.

**`fsRoots`** Request: `{ "id": n, "verb": "fsRoots" }`
Response: `{ "id": n, "ok": true, "result": { "roots": [ { "path":"C:\\", "label":"C:\\" }, { "path":"…/Documents", "label":"…/Documents" } ] } }`
> 🟢 ENTSCHIEDEN: Legacy gibt das nackte Array zurück (`server.py:1163`); im V3-Vertrag wird es in `result.roots` gewrappt — alle `result`-Payloads sind Objekte (konsistenter SW-Code, leichter erweiterbar).

**`fsList`** Request: `{ …, "params": { "path": "C:\\Users\\me" } }`
Response: `{ "id": n, "ok": true, "result": { "path":"…", "parent":"…|null", "entries":[ {"name","path","is_dir","is_symlink"} ], "breadcrumbs":[ {"label","path"} ] } }` (`server.py:760-805`).
Fehler: `invalid_path`, `not_found`, `not_a_directory`, `access_denied` (mappt die Legacy-`HTTPException`-Status auf Codes: 400→`invalid_path`/`not_a_directory`, 404→`not_found`, 403→`access_denied`).

**`fsCheck`** Request: `{ …, "params": { "path": "D:\\KiCad\\MyLib.kicad_sym" } }`
Response: `{ "id": n, "ok": true, "result": { "requested","resolved","exists","is_dir","writable" } }` (`server.py:808-826`).
Fehler: `invalid_path`.

### 1.6 Persistente Warm-Verbindung (Performance-Hebel) — **wichtigste Änderung**

**Heute:** jeder RPC öffnet einen **frischen** Port (`connectNative` → `postMessage` → `onMessage` → `disconnect`), siehe `nativeHostFetchMetadata` (`background.js:1748-1789`), `nativeHostConvert` (`background.js:1832-1888`), `nativeHostListTemplates` (`background.js:843-882`), `pingNativeHostOnce` (`background.js:1626-1661`). Das **spawnt pro RPC einen neuen Python-Prozess** (PyInstaller-Bootstrap + Imports ≈ 0,3–1,5 s Kaltstart-Overhead **jedes Mal**).

🟢 ENTSCHIEDEN: **Genau einen Port warm halten** (`connectNative` einmal, wiederverwenden), statt spawn-per-RPC. Konkret:

- SW hält ein Singleton `hostPort` + eine `pending: Map<id, {resolve, onProgress, timer}>`. `ensureHostPort()` öffnet bei Bedarf, registriert **einen** `onMessage`-Listener, der per `msg.id` in `pending` dispatcht.
- `onDisconnect` (Host-Crash, Chrome-Idle-Kill): alle `pending` mit `{ok:false, error:{code:"host_disconnected", message}}` rejecten, `hostPort=null`; nächster Call öffnet neu (lazy reconnect).
- **Keep-Alive** behält seine Doppelrolle (ADR/`background.js:1614-1622`): der 25-s-`ping` läuft jetzt **auf demselben warmen Port** und hält damit zusätzlich den Python-Prozess am Leben (Chrome killt einen NM-Host nicht, solange der Port offen ist — der Prozess bleibt also über die ganze Sitzung warm → Phase 1 & 2 ohne Kaltstart).
- **id-Korrelation wird Pflicht** (heute ignoriert, weil 1 Port = 1 Call): `seq` Zähler, `pending.get(msg.id)`. Progress-Frames (`type:"progress"`) routen über `msg.id` an den `onProgress` des laufenden `convert`.

**Verträglich mit Single-Flight:** Der Host-Busy-Lock (`host.py:55-58`) bleibt die Wahrheit. Über den Warm-Port **dürfen** mehrere schnelle read-only Verbs (`listTemplates`, `fsList`, `renderFootprintSvg`, `pinMapRead`) **gleichzeitig** in-flight sein (kein Lock); `fetchMetadata`/`convert` sind durch den Lock serialisiert und liefern dem Zweitaufrufer sofort `busy`. → Der Host muss bei langlaufendem `convert` weiterhin **eingehende read-only Frames bedienen können**.
> 🔴 BRAUCHT DICH (Architektur-Tradeoff): Der heutige Host ist **single-threaded** (`host.py:226 while True: read→handle→write`) — er liest erst den nächsten Frame, wenn der aktuelle fertig ist. Mit Warm-Port + parallelen read-only-Verbs während eines laufenden `convert` braucht der Host einen **Reader-Thread + Worker** (Frame-Lesen entkoppelt von Handler-Ausführung), sonst blockiert ein 10-s-`convert` alle anderen Frames. Entscheidung nötig: (a) **Host multi-threaded** machen (mehr Code, aber echte Parallelität für Panel-Reads während Conversion) **oder** (b) Warm-Port **strikt seriell** lassen (read-only-Verbs warten hinter `convert` — einfacher, aber Override-Panel-Interaktion friert während einer Conversion ein). Empfehlung des Agenten: **(a)** Reader-Thread + `concurrent.futures`-Worker, weil die ganze UX-Vision auf flüssiger Panel-Interaktion beruht; aber das ist eine echte Aufwands-/Komplexitätsentscheidung für dich.

### 1.7 Single-Flight (`busy`) — Semantik

- Gemeinsamer Lock für `fetchMetadata` **und** `convert` (`host.py:55-58,99-108`): eine Phase-1 in-flight blockt Phase-2 und umgekehrt (ADR-0004 — keine Queue).
- Host-seitig: Zweitaufruf bekommt sofort `{ok:false, error:{code:"busy", …}}` ohne Arbeit zu starten.
- SW-seitig **zusätzlich** vorgelagert (spart Port-Roundtrip): `nativeHostPhase1InFlight` / `nativeHostConvertInFlight` Flags (`background.js:1724,1792`). Bei Warm-Port (§1.6) bleiben diese Flags als schnelle lokale Vorprüfung; sie müssen mit der Port-Reconnect-Logik zurückgesetzt werden.
- 🟢 ENTSCHIEDEN: `busy` ist ein **erwarteter** Zustand, kein Crash — UI zeigt „Ein Import läuft bereits in einem anderen Tab" (nicht-rot/Hinweis), nicht als Fehler-Toast.

---

## 2. Hop A — Service-Worker ↔ Content-Script / Popup

### 2.1 Request/Response-Envelope

Implementiert in `background.js:2668-2687` (`onMessage`-Listener) + `rpc.js:57-90` (Client).

**Request (Content/Popup → SW):** `chrome.runtime.sendMessage({ type: "<handlerName>", …fields })`
- `type` indexiert `RUNTIME_MESSAGE_HANDLERS` (`background.js:1895`). Unbekannt ⇒ Handler liefert `null` → Antwort `{ok:true, data:null}`.

**Response (SW → Caller):**
```jsonc
{ "ok": true,  "data": <handler-return> }     // background.js:2677
{ "ok": false, "error": "<message-string>" }  // background.js:2684 (catch)
```
- Der Listener gibt `return true` zurück (async `sendResponse`, `background.js:2686`).
- Client `rpc.js` (`contentRpc`/`sendRuntimeMessage`) hat eine **Retry-Schicht** (3× / 250 ms) gegen MV3-„service worker noch nicht wach"/`receiving end does not exist` (`rpc.js:74-77`) und erkennt „Extension context invalidated" (Reload) → zeigt Refresh-Banner (`rpc.js:65-72`).
> 🟢 ENTSCHIEDEN: Hop-A-Envelope bleibt `{ok, data}` / `{ok, error: string}` (eingespielt, von `popup.js:2044` und `phase2Convert.js` so konsumiert). Der **strukturierte** `{code,message}`-Fehler aus Hop B wird im SW-Bridge zu einem Anzeige-String **plus** optionalem `code` verflacht: für Verbs, deren Content-Script-UI auf den Code verzweigen muss (Override/Pin-Map-Dialoge), liefert der Handler `data:{ok:false, error:{code,message}}` **innerhalb** von `{ok:true, data:…}` (Hop-A-`ok` = „Nachricht wurde verarbeitet", Hop-B-Ergebnis steckt in `data`). Genau dieses Muster nutzen `v3FetchMetadata`/`v3Convert` heute schon (`background.js:2650-2665`): sie geben das ganze `{ok, result|error}`-Envelope als `data` zurück.

### 2.2 Streaming-Progress auf Hop A (kein Antwort-Kanal, sondern Broadcast)

Native-Messaging-Progress kann nicht durch `sendResponse` (nur eine Antwort). Deshalb:

1. Host streamt `type:"progress"` an SW (Hop B).
2. SW broadcastet **pro Frame** an alle LCSC-Tabs: `chrome.tabs.sendMessage(tab, { type:"v3ConvertProgress", lcscId, message, progress })` (`background.js:1856-1863`, `broadcastToLcscContentTabs` `background.js:1191`).
3. Content-Script filtert nach **eigener** `lcscId` und rendert (`phase2Convert.js:84-108 subscribeConvertProgress`). Nach dem Terminal-Frame `unsubscribe()` (`phase2Convert.js:146-158`) — verhindert, dass ein späterer Import in denselben Listener leckt.

> Warum `chrome.tabs.sendMessage` und nicht `chrome.runtime.sendMessage`: Content-Scripts empfangen **keine** `runtime.sendMessage` vom SW; nur `tabs.sendMessage` auf einem konkreten Tab erreicht sie (`background.js:1187-1190`). Popup/Extension-Pages dagegen empfangen `runtime.sendMessage` — deshalb broadcastet der SW Status-Updates über **beide** Wege (`broadcastNativeHostStatus` `background.js:1672-1678`).

🟢 ENTSCHIEDEN: **Korrelation per `lcscId`** statt Job-ID (ADR-0004 hat keine Job-IDs). Single-Flight garantiert ohnehin ≤1 laufenden `convert`, der `lcscId`-Filter ist Defense-in-Depth gegen Cross-Tab-Bleed.

### 2.3 Alternative: `chrome.runtime.connect`-Port für Streaming

> 🟢 ENTSCHIEDEN: **Broadcast (§2.2) beibehalten, KEIN dedizierter `runtime.connect`-Port** für Content↔SW-Progress. Begründung: (1) Es läuft per Single-Flight nur **ein** `convert`; ein Multiplex-Port bringt keinen Vorteil. (2) Der Broadcast-Weg ist bereits implementiert und getestet (`phase2Convert.js`). (3) Ein langlebiger `connect`-Port aus einem MV3-Content-Script hält den SW künstlich am Leben und verkompliziert das Lifecycle. **Ausnahme/Reserve:** Falls künftig parallele Conversions zugelassen werden (ADR-0004 müsste fallen), wäre `runtime.connect` mit Port-pro-Conversion der Upgrade-Pfad — bis dahin nicht bauen.

### 2.4 Hop-A Verb-Map (relevante V3-Einträge)

| `type` | Bridge → Hop B | Rückgabe `data` |
|--------|----------------|------------------|
| `pingNativeHost` | `pingNativeHostOnce` → `ping` | `{online, version|error}` |
| `prewarmNativeHost` | dito + Keep-Alive-Alarm | `{state, version, error, updatedAt}` |
| `getNativeHostStatus` | cache, kein Port | `{state, …}` |
| `v3FetchMetadata` | `fetchMetadata` | `{ok, result|error}` |
| `v3Convert` | `convert` (streamt via §2.2) | `{ok, result|error}` |
| `v3ListTemplates`* | `listTemplates` | `{symbols, footprints, error?}` |
| `v3RenderFootprintSvg`* | `renderFootprintSvg` | `{ok, result|error}` |
| `v3PinMapRead`/`v3PinMapWrite`* | `pinMap*` | `{ok, result|error}` |
| `fs:listRoots` / `fs:listDirectory` / `fs:check` | **heute Legacy-WS** (`background.js:2622-2624`) → **migrieren** auf `fsRoots`/`fsList`/`fsCheck` (Hop B) | wie §1.5.8 |

\* neue Hop-A-Handler, analog zu `v3Convert` (`background.js:2661`) zu bauen.
> 🟢 ENTSCHIEDEN: `fs:listRoots`/`fs:listDirectory`/`fs:check` von der Legacy-WS-Bridge (`fetchRoots`/`fetchDirectory`/`checkPath`, die noch `sendExtensionRpc` nutzen) auf die neuen Native-Host-`fs*`-Verbs umstellen — der V3-Clean-Break (ADR-0003) entfernt den WS-Server vollständig, also müssen **alle** noch WS-gebundenen Hop-A-Handler (`fs:*`, `templates*`, `lcscFootprintPreview`, `submitJob`/`quickDownload`-Pfad, `checkComponentExists`, `validateLibrary`) auf Native-Messaging-Verbs portiert werden. Diese Migration ist groß, aber der Transport-Vertrag hier definiert die Zielverben dafür.

---

## 3. Vollständiger Fehlercode-Katalog (verbindlich)

| `code` (Hop B `error.code`) | Wo erzeugt | Wo sichtbar | Bedeutung |
|------|------------|-------------|-----------|
| `busy` | Host-Lock + SW-Flag | Anchor-Card-Status (Hinweis, nicht rot) | Andere Phase-1/2 läuft |
| `invalid_lcsc_id` | `phase1.py`/`phase2.py` Validierung | Inline am Anchor | `lcscId` fehlt/`^C\d+$` verletzt |
| `invalid_library_path` | `phase2.py:82` | Phase-2-Status | `libraryPath` leer |
| `invalid_overrides` | `phase2.py:96-138` | Override-Panel | Override-Shape kaputt |
| `not_implemented` | `phase2.py:139` | Override-Panel | Footprint-Template noch nicht verdrahtet (#6/#9) |
| `invalid_lib_path` | `templates.py:60` | Override-Panel | `listTemplates`/`pinMap` ohne `libPath` |
| `invalid_name` | `pinMap*` | Pin-Map-Dialog | `name` fehlt |
| `invalid_path` | `fsList`/`fsCheck` | File-Explorer | Pfad ungültig (Legacy 400) |
| `not_found` | `fsList` | File-Explorer | Pfad existiert nicht (Legacy 404) |
| `not_a_directory` | `fsList` | File-Explorer | Pfad ist Datei (Legacy 400) |
| `access_denied` | `fsList` | File-Explorer | Permission (Legacy 403) |
| `invalid_url` | `fetchDatasheet` | Datasheet-Preview | kein http(s) |
| `too_large` | `fetchDatasheet`/SVG | Preview | > 1-MB-Frame-Cap |
| `fetch_failed` | `renderFootprintSvg`/`fetchDatasheet` | Preview | EasyEDA/HTTP-Ausfall |
| `conversion_failed` | `host.py:192-198` | Phase-2-Status (rot) | Pipeline-Exception; `message` = EasyEDA-Detail |
| `write_failed` | `pinMapWrite` | Pin-Map-Dialog | IO/Permission beim Sidecar |
| `unknown_verb` | `host.py:218-222` | nur Logs/Dev | Vertragsbruch Extension↔Host (Versionsdrift) |
| `internal` | `host.py:155-160` | Status (rot) | unklassifizierte Exception |
| **SW-only (Hop A)** | | | |
| `timeout` | SW-Timer (`background.js:1640/1764/1848`) | Status | Host antwortet nicht in 5 s (ping/meta) / 60 s (convert) |
| `host_disconnected` | SW `onDisconnect` (§1.6) | Status | Port weg (Host-Crash/Idle-Kill) |
| `connectNative threw` | SW `connectNative`-catch | Status | Host nicht registriert/Manifest fehlt |

🟢 ENTSCHIEDEN: Alle `code`-Strings sind `snake_case`, stabil, Teil des öffentlichen Vertrags. Neue Codes nur additiv. `message` ist frei und nur für Anzeige/Logs (nie für Logik geparst).

---

## 4. Timeouts & Konstanten (SW-seitig, `background.js:1607-1622`)

| Konstante | Wert | Zweck |
|-----------|------|-------|
| `NATIVE_HOST_NAME` | `"com.kicad_parts_importer.host"` | NM-Host-ID (muss == `install.py:28 HOST_NAME`) |
| `NATIVE_HOST_PING_TIMEOUT_MS` | 5000 | ping/prewarm |
| `NATIVE_HOST_FETCH_METADATA_TIMEOUT_MS` | 5000 | Phase 1 |
| `NATIVE_HOST_CONVERT_TIMEOUT_MS` | 60000 | Phase 2 (5–10 s typisch, 60 s Envelope für kalt/Netz) |
| `NATIVE_HOST_KEEPALIVE_ALARM` / `…_PERIOD_MIN` | `v3-native-host-keepalive` / 25 s | Pre-Warm-Heartbeat + Freshness |
| (neu) `LIST_TEMPLATES`/`FS`/`SVG`-Timeout | 5000 | read-only Verbs |
| (neu) `PIN_MAP_WRITE`-Timeout | 5000 | Sidecar-Schreiben |

🟢 ENTSCHIEDEN: Timeouts so belassen. Mit Warm-Port (§1.6) entfällt der Kaltstart-Overhead aus dem kritischen Pfad, sodass selbst 5 s für `fetchMetadata` großzügig sind.

---

## 5. Was bleibt / was sich ändert / was neu ist (Zusammenfassung für den Implementierer)

**Behalten (1:1):** Framing `uint32 LE + JSON` (`host.py`); `ping` flach; `fetchMetadata`/`convert`/`listTemplates` Request-Shapes; Streaming-Modell `type:"progress"` bis `ok`-Terminal; Single-Flight-Lock; Hop-A `{ok,data}`/`{ok,error}`; `lcscId`-Broadcast-Korrelation; SW-Retry-Schicht (`rpc.js`); Keep-Alive-Alarm.

**Ändern:** (1) **Strukturierter Fehler** `error:{code,message}` statt `error:"string"` (Host + SW-Shim). (2) **Persistenter Warm-Port** statt spawn-per-RPC (§1.6) — größter Speed-Hebel; bedingt Host-Threading-Entscheidung (§1.6 🔴). (3) `id` wird Korrelations-Pflicht (monotoner `seq`). (4) `result`-Payloads immer Objekte (auch `fsRoots`→`{roots:[…]}`). (5) Legacy-WS-Verbnamen `snake_case`→`camelCase` beim Portieren.

**Neu bauen:** `renderFootprintSvg`, `pinMapRead`, `pinMapWrite`, `fsRoots`/`fsList`/`fsCheck` (portiert aus `server.py`), optional `fetchDatasheet`; je ein Hop-A-Bridge-Handler (`v3*`) im `RUNTIME_MESSAGE_HANDLERS`.

**Löschen (ADR-0003 Clean Break):** gesamter WS-Pfad (`easyeda2kicad/api/server.py` `/ws/extension`, `extensionWsClient.js`, `sendExtensionRpc`, `submitJob`/`enqueue_task`/`task_update`/`list_tasks`/`subscribe_task`, Job-State-Maschine `state.jobs`/`jobMeta`/`finalizeTerminalJob`). Deren Funktionalität wandert in die obigen Native-Verbs bzw. den `convert`-Stream.


---

## 5. UI/UX — On-Page-Flow (LCSC-Seite)

## UI/UX — On-Page Flow (Feature-Block A/C/H/J + State Inventory)

Ganzheitliche, baubare UI/UX-Spezifikation für alles, was auf der LCSC-Produktseite passiert: Anchor-Card, inline Override Panel in allen bedingten Konfigurationen, Auto-Suggest-Präsentation, Multi-Dialog-Entscheidungsflüsse bei fehlenden Layern, Pin↔Pad-Sub-UI, Datasheet-Preview und das vollständige State-Inventar inkl. 7 Fehlercodes → User-Texte.

Grounding: `chrome_extension/src/content/anchorCard.js`, `overridePanel.js`, `phase1Fetch.js`, `phase2Convert.js`, `dialog.js`, `lcscValueParamDialogs.js`, `lcscCategoryDialog.js`, `datasheetPanel.js`; KONZEPT §6/§8/§12/§13/§14/§15/§16; Fehlercodes aus KONZEPT §5.2.4 + `native_host/host.py` (`busy`). Transport = Native Messaging (SW-Relay `background.js` → Native-Host-RPC `fetchMetadata`/`convert`/`ping`/`listTemplates`), NICHT gRPC — KONZEPT-Texte, die noch „gRPC" sagen, sind in diesem Bereich als Native-Host-RPC zu lesen.

> Konvention: Alle neuen Strings liegen im COPY-DECK (§U6) unter stabilen Keys `k2c.*`. Code referenziert Keys, nicht Literale. DE ist Default; EN-Spalte ist optional und kann in Slice 2 nachgezogen werden. 🟢 ENTSCHIEDEN.

---

### U0. Globale UX-Prinzipien (gelten für alle Sub-UIs)

1. **Eine Status-Oberfläche pro Karte.** Es gibt genau einen Status-Span (`data-k2c-phase1-status`, von Phase 1 + Phase 2 geteilt — siehe `phase1Fetch.js:52` / `phase2Convert.js:27`). Idle/Loading/OK/Error rendern alle in dasselbe Element. 🟢 ENTSCHIEDEN: nicht zwei konkurrierende Status-Knoten.
2. **Inline vor Modal.** Reihenfolge der Eskalation: (a) Inline-Status im `<tr>` → (b) inline Override Panel als zweite `<tr>` → (c) Sub-Pane *innerhalb* des Panels (Pin↔Pad, Datasheet) → (d) Vollbild-Modal NUR für die „was nun?"-Entscheidungsflüsse bei fehlenden Layern (§U4). Modals stehlen den Fokus; sie sind das letzte Mittel. 🟢 ENTSCHIEDEN.
3. **Auto-Suggest ist vorausgefüllt, nicht aufgezwungen.** Best-Guess-Quellen sind im Panel bereits selektiert + mit Confidence-Badge markiert; der User muss nur „Bestätigen". Auto-Apply (Skip-Panel) überspringt das Panel nur bei `autoConfirm`+High-Confidence (§U3.4). 🟢 ENTSCHIEDEN.
4. **Dismiss-Konsistenz.** Esc + Backdrop-Klick schließen Modals (`mountCsModal`, `dialog.js:288`); Cancel/Esc auf dem Panel = identisch zu „Abbrechen" (kein Phase 2). Jeder Dismiss zählt als „Cancel"-Outcome.
5. **Idempotenz.** Jeder Render (Panel, Sub-Pane, Dialog, Status-Node) ist idempotent gegen LCSC-React-Reflows — bestehender Knoten wird wiederverwendet, keine Doppel-Listener (Muster aus `anchorCard.js:139`, `phase1Fetch.js:102`, `overridePanel.js:221`).
6. **Busy ist global.** Native Host ist Single-Flight (`host.py:_busy`). Solange ein Convert/Fetch läuft, sind ALLE Download-/Customize-/Confirm-Buttons (auch in anderen Tabs) disabled mit Busy-Hint.

---

### U1. Anchor-Card `<tr>` (Feature-Block A)

Erweitert die heute existierende Scaffold-Zeile (`anchorCard.js:88 buildAnchorCardRow`) um Host-Status-Dot, geteilten Status-Span und Disabled-States. Heute: 2 Buttons (`data-k2c-action="download"`, `="customize"`) + Status-Span aus Phase 1. Soll-Zustand:

```
ANCHORED CASE (in der Header-Card-Tabelle, als letzte <tr>):
┌──────────┬─────────────────────────────────────────────────────────────┐
│ KiCad    │  ● [ In KiCad importieren ]  [ ⚙ Anpassen ]   <status-span>  │
│ (label)  │  ▲dot                                                        │
└──────────┴─────────────────────────────────────────────────────────────┘
  data-k2c-anchor-label   data-k2c-host-status  data-k2c-action=download/customize  data-k2c-phase1-status
```

```
FLOAT FALLBACK (kein Anchor gefunden, position:fixed bottom-right, Shadow-DOM):
                          ┌───────────────────────────────┐
                          │ ● KiCad Parts Importer        │
                          │ [ In KiCad importieren ]      │
                          │ [ ⚙ Anpassen ]                │
                          │ <status-span>                 │
                          └───────────────────────────────┘
```

**Elemente & Verhalten:**

| Element | Attribut | Verhalten |
|---|---|---|
| Label-Cell | `data-k2c-anchor-label` | statisch „KiCad" |
| Host-Status-Dot | `data-k2c-host-status` | 🟢 online / 🟡 checking / 🔴 offline; Tooltip = `k2c.host.tooltip.<state>` (KONZEPT §16.4) |
| Primär-Button | `data-k2c-action="download"` | Label `k2c.btn.import`. Startet Phase 1 → (Skip-Flow ODER Panel). Im Default-Click NICHT `forcePanel`. |
| Sekundär-Button | `data-k2c-action="customize"` | Label `k2c.btn.customize`. Startet Phase 1 mit `forcePanel=true` → Panel rendert IMMER, auch bei vollem Auto-Resolve (KONZEPT §12.5). |
| Status-Span | `data-k2c-phase1-status` | geteilt P1/P2; `data-…-status`-Attribut trägt den State-Namen (idle/loading/ok/error/suggesting/…) für CSS-Hooks. |

**Button-Disabled-Matrix:**

| Host-Status | Active-Library gesetzt? | Busy? | Download | Customize |
|---|---|---|---|---|
| offline/checking | — | — | disabled, Hint `k2c.status.offline` | disabled |
| online | nein | — | disabled, Hint `k2c.status.noActiveLib` + Inline-Link „Bibliothek wählen" (öffnet Popup-Tab Library) | disabled |
| online | ja | ja | disabled, Hint `k2c.status.busy` | disabled |
| online | ja | nein | **enabled** | **enabled** |

🟢 ENTSCHIEDEN: Customize ist gleich disabled wie Download (gleiche Vorbedingungen) — kein „halb-aktiver" Zustand, der den User verwirrt.

🟢 ENTSCHIEDEN: Kein MutationObserver (KONZEPT §6.5). Einmaliger Walk bei `document_idle`. Geht der Trigger durch React-Reflow verloren, ist das ein sichtbares Symptom → Reload. Re-Inject-Schutz via Idempotenz.

🟢 ENTSCHIEDEN: Float-Fallback nutzt Shadow-DOM-Isolation (KONZEPT §6.4) — die Anchor-`<tr>` dagegen NICHT (sie muss LCSCs Tabellen-CSS erben, um nicht als Fremdkörper zu wirken). Inline-Styles auf der `<tr>` reichen.

---

### U2. Override Panel — Layout & alle bedingten Sektionen (Feature-Block C)

Erweitert `overridePanel.js` (heute nur Symbol/Footprint-Dropdown + Cancel/Confirm). Panel = `<div data-k2c-override-panel>`, in der Anchored-Variante gewrappt in `<tr data-k2c-override-panel-row><td colspan>` direkt UNTER der Anchor-`<tr>` (`overridePanel.js:230`).

**Vollständiges Panel (alle Sektionen sichtbar, Maximalfall):**

```
┌─ ÜBERSCHREIBEN ─────────────────────────────────  Modus: ▣ Template-Assembly ─┐
│                                                                                │
│  Symbol     [ Resistor_SMT ▾ ]   ✨ Vorschlag (hoch) · aus Regel Passives/…   │
│             └─ Keep EasyEDA / ──Lib: MyTemplates── Resistor_SMT, Cap_… ────┘   │
│                                                                                │
│  Footprint  [ R_0603_1608Metric ▾ ]  ✨ Vorschlag (hoch) · Paket 0603         │
│             └─ Keep EasyEDA / ──Lib: MyTemplates.pretty── R_0603_…, R_0805 ┘   │
│                                                                                │
│  ┌─ Pin↔Pad ────────────────────────────────────────────── (conditional) ─┐  │
│  │  2 Pins ⟷ 2 Pads · automatisch 1:1   [ Zuordnung bearbeiten ]           │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ┌─ Datenblatt ─────────────────────────────────────────── (conditional) ─┐  │
│  │  [ Vorschau einblenden ]   datasheet.pdf · 1.2 MB                        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ⚠ Bauteil existiert bereits in der Bibliothek.    (conditional)              │
│     [✓] Überschreiben                                                          │
│                                                                                │
│  Wird angelegt: Value=50R · Tolerance=±1% · Package=0603 · MPN=… (Labels)     │
│                                                                                │
│                                          [ Abbrechen ]   [ Importieren ]       │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Sektionen top-to-bottom (Reihenfolge ist verbindlich):**

#### U2.1 Header + Modus-Indikator
- Titel-Zeile `k2c.panel.heading` („Überschreiben"/„Quellen wählen").
- Rechts: **Modus-Badge** `data-k2c-mode-badge`, berechnet live aus beiden Dropdowns:
  - beide `easyeda` → „EasyEDA-Pipeline" (neutrales Grau).
  - mind. ein `template` → „Template-Assembly" (Akzent-Blau `CS_DIALOG.primaryBg`).
  - Begründung der Branch-Logik: KONZEPT §9 (Pipeline-Wahl).
- 🟢 ENTSCHIEDEN: Badge ist read-only Informations-Cue, kein Steuerelement — sonst zwei Wege, dasselbe einzustellen.

#### U2.2 Symbol-Source-Dropdown
- `<select data-k2c-override-symbol>` (existiert). Optionen: `Keep EasyEDA` + optgroup pro **aktiver** Template-Library mit Symbol-Namen (`populateSelect`, `overridePanel.js:47`).
- Style: `applyDialogStyleSelect` (`dialog.js:40`) statt Browser-Default — visuelle Konsistenz mit den Modal-Dialogen. 🟢 ENTSCHIEDEN (heute roher `<select>`; upgraden).
- Default-Selektion: Auto-Suggest (§U3) — sonst `Keep EasyEDA`.
- Confidence-Badge rechts daneben (§U3.2).

#### U2.3 Footprint-Source-Dropdown
- `<select data-k2c-override-footprint>` (existiert). Quelle der Namensliste ist **getrennt** vom Symbol-Dropdown: kommt aus der Sibling-`.pretty/`-Direktorei (KONZEPT §8.2.3 / §10.2), heute via `opts.templateLibsFootprints` (`overridePanel.js:117`).
- Acceptance: Footprint-Dropdown zeigt Footprint-Namen, NICHT Symbol-Namen (KONZEPT §8.6).

#### U2.4 Pin↔Pad-Sektion (conditional — Detail §U5)
- Erscheint NUR, wenn die kombinierte Auswahl Pin↔Pad-Resolution braucht (KONZEPT §13.2): kein Sidecar UND Sym-Pin-Count ≠ FP-Pad-Count.
- Bei trivialem 1:1 (Counts gleich) → Kompakt-Zeile „N Pins ⟷ N Pads · automatisch 1:1" + optionaler „Zuordnung bearbeiten"-Button (öffnet Sub-UI manuell).
- Bei Count-Mismatch → Sektion zeigt rote Hint-Zeile + Button `k2c.pinpad.openRequired` und **blockiert Confirm**, bis Mapping vollständig ist.

#### U2.5 Datasheet-Sektion (conditional — Detail §U7)
- Erscheint nur wenn `datasheetUrl` aus Phase 1 vorhanden (KONZEPT §8.2.5 / §15.3).
- Collapsed by default: Button `k2c.datasheet.show` + Dateigröße. Klick → Sub-Pane mit `pdf_viewer.html`-iframe (Wiederverwendung `datasheetPanel.js DatasheetPanel`).
- 🟢 ENTSCHIEDEN: collapsed default — ein 5–20 MB PDF darf das Panel nicht beim Öffnen aufblähen/laden (Lazy-Load erst bei Klick). KONZEPT §5.2.3 nennt PDF-Größe als Grund.

#### U2.6 Overwrite-Warning (conditional)
- Erscheint, wenn `symbol_exists_in_active_lib` ODER `footprint_exists_in_active_lib` (Phase 1, KONZEPT §14).
- Text `k2c.overwrite.warn` + Toggle `data-k2c-overwrite`. Toggle-Default aus Settings `defaultOverwritePolicy`:
  - `ask` → Toggle OFF (User muss aktiv ankreuzen).
  - `overwrite` → Toggle ON.
  - `skip` → KEIN Toggle; stattdessen rote Block-Zeile `k2c.overwrite.skipBlock` + Confirm disabled.
- Danger-Styling: `CS_DIALOG.dangerBg/dangerBorder/dangerText` (`dialog.js:30`).

#### U2.7 Metadata-as-Labels Vorschau (NEU, read-only)
- Eine einzeilige, gekürzte Vorschau der Properties, die Phase 2 ins Symbol schreibt (KONZEPT §9.2 Schritt 6): `Value`, `Tolerance`, `Package`, `MPN`, `Manufacturer`, `Datasheet`, `LCSC`. Quelle = Phase-1-Metadaten + Content-Script-Param-Scrape (`lcscPageSnapshot.js`).
- Format: `Wird angelegt: Value=50R · Tolerance=±1% · Package=0603 · MPN=RC0603FR-0750RL …`
- 🟢 ENTSCHIEDEN: read-only Vorschau (kein Inline-Editor in Slice 1) — die Property-Mapping-Konfiguration lebt in den Settings/Category-Rule, nicht pro Import. Verhindert Scope-Explosion. Die User-Vision „Value=50R, Tolerance=±1% als Labels" wird so transparent sichtbar, ohne ein Formular zu sein.

#### U2.8 Actions
- `[ Abbrechen ]` (`data-k2c-override-cancel`) — entfernt Panel-Wrapper, kein Phase 2.
- `[ Importieren ]` (`data-k2c-override-confirm`) — packt `selectionToOverrides` (`overridePanel.js:154`) + `overwrite`-Flag + ggf. Pin-Map → ruft Phase 2. Disabled solange Pin↔Pad-Mismatch ungelöst oder Overwrite-Skip-Block aktiv.
- Button-Styles: `dialogButtonStyle("secondary","wide")` / `("primary","wide")`.

**Encoding der Selektion** (unverändert, `overridePanel.js:154`): `"easyeda"` → `{source:"easyeda"}`; `"template:<libPath>:<name>"` → `{source:"template",libPath,name}`. Parser anchored am `.kicad_sym`-Suffix (Windows-Drive-Letter + Doppelpunkte im Namen überleben).

---

### U3. Auto-Suggest-Präsentation (das neue Herzstück)

Verbindet die User-Vision Punkt 3 (Kategorie + Pin-Count + Paketform → Vorschlag) mit der Skip-Panel-Logik (KONZEPT §12). Die **Suggestion-Engine** (Matching-Logik) ist NICHT mein Bereich — ich spezifiziere ihre **Präsentation** und das Datenformat, das sie an die UI liefert.

#### U3.1 Suggestion-Eingabevertrag (von der Engine an die UI)
```js
type Suggestion = {
  layer: "symbol" | "footprint",
  choice: LayerChoice,            // {source:"template",libPath,name} | {source:"easyeda"}
  confidence: "high" | "medium" | "low",
  reason: string,                 // i18n-Key + Args, z.B. k2c.suggest.reason.rule / .package / .pincount
  reasonArgs?: object,            // {category:"Passives/Resistors", package:"0603", pins:2}
  ruleAutoConfirm?: boolean,      // aus matched Category Rule (KONZEPT §12.2)
}
```
🟢 ENTSCHIEDEN: Confidence ist ein 3-stufiges Enum (high/medium/low), kein Float — Float-Prozente suggerieren Scheingenauigkeit und sind für den User nicht handlungsleitend. Schwellen/Float bleiben intern in der Engine.

#### U3.2 Confidence-Badge (im Panel, neben jedem Dropdown)
```
✨ Vorschlag (hoch)   · aus Regel Passives/Resistors/SMD     ← grün, confidence=high
✨ Vorschlag (mittel) · Paket 0603 erkannt                  ← amber, confidence=medium
✨ Vorschlag (niedrig)· 2 Pins → evtl. Widerstand           ← grau, confidence=low
```
- Badge-Attribut `data-k2c-suggest-badge` + `data-confidence`. Farbe: high=grün, medium=`dangerText`-amber-Variante, low=`panelMuted`.
- `reason`-Text aus dem Key gerendert. Mehrere Gründe → der stärkste (höchste Priorität: Regel > Paket > Pin-Count).
- Der Dropdown ist bereits auf `choice` vorselektiert. Ändert der User die Selektion manuell, verschwindet das Badge (es war ja ein Vorschlag, der nun überstimmt wurde) und ein dezentes `✎ manuell` erscheint.

#### U3.3 „One-Click-Accept"
- Bei vorhandenem Suggest sind die Dropdowns bereits gesetzt → der „One-Click" IST der `[ Importieren ]`-Button. Kein separater Accept-Button (das wäre ein zweiter Confirm). 🟢 ENTSCHIEDEN: kein doppelter Accept; Vorbelegung + ein Confirm = ein Klick.

#### U3.4 Auto-Apply (Skip-Panel-Flow, KONZEPT §12.4)
Panel wird GAR NICHT gemountet, Phase 2 startet direkt, wenn ALLE gelten:
1. Winning Category Rule existiert.
2. `rule.autoConfirm == true`.
3. Pin-Map auflösbar ohne UI (Sidecar existiert ODER Sym-Pin == FP-Pad).
4. Keine Overwrite-Warnung (oder `defaultOverwritePolicy == overwrite`).
5. Master-Toggle `alwaysShowOverridePanel == false`.
6. `forcePanel != true` (Customize-Button setzt es; siehe §U1).

Inline-Status zeigt dann den Auto-Pfad transparent (NIE stilles Handeln):
```
<status-span>:  ✨ Auto: Resistor_SMT → R_0603_1608Metric · importiere…
```
🟢 ENTSCHIEDEN: Auto-Apply zeigt IMMER, was es tut (Quelle Symbol → Footprint), bevor/während es schreibt. „Magie ohne Sichtbarkeit" verletzt das Vertrauensprinzip. Der Customize-Button (§U1) ist die jederzeit erreichbare Eskape-Luke zum vollen Panel.

---

### U4. Multi-Dialog-Entscheidungsflüsse bei fehlenden Layern („was nun?")

Greift, wenn EasyEDA für dieses Part **keinen** Symbol- bzw. Footprint-Layer liefert und auch keine Auto-Suggestion mit Confidence ≥ medium existiert. Diese Flüsse sind die EINZIGEN Vollbild-Modals im On-Page-Flow (Begründung §U0.2). Sie nutzen `mountCsModal` (`dialog.js:288`) — gleiche Shell wie die V2-Value-Param-Dialoge.

#### U4.1 „Kein Footprint gefunden — was nun?"
```
┌─────────────────────────────────────────────────────────┐
│  Kein Footprint gefunden                            (×)  │
│                                                          │
│  EasyEDA liefert für dieses Bauteil keinen Footprint.   │
│  Wie möchtest du fortfahren?                             │
│                                                          │
│  ○ Template-Footprint wählen     (empfohlen)            │
│      [ R_0603_1608Metric ▾ ]   ✨ Paket 0603            │
│  ○ EasyEDA-Symbol ohne Footprint anlegen               │
│  ○ Footprint später manuell zuordnen (nur Symbol)      │
│  ○ Import abbrechen                                     │
│                                                          │
│              [ Abbrechen ]        [ Weiter ]            │
└─────────────────────────────────────────────────────────┘
```
**Optionen → Outcome:**
| Option | Outcome |
|---|---|
| Template-Footprint wählen | inline-Dropdown (gleiche Quelle wie Panel-Footprint); Confirm setzt `footprint:{source:"template",…}` und kehrt zum Panel zurück |
| EasyEDA ohne Footprint | `footprint:{source:"easyeda"}` — Phase 2 schreibt Symbol, kein Footprint; Symbol-`Footprint`-Property bleibt leer |
| Später manuell zuordnen | wie oben, plus Status-Hint `k2c.missing.fp.manualLater` |
| Abbrechen | kein Phase 2 |

#### U4.2 „Kein Symbol gefunden — was nun?"
Analog, Optionen: **Template-Symbol wählen** (empfohlen, mit Suggest) / **Manuell zusammenklicken** (öffnet Panel mit beiden Dropdowns leer-vorbelegt + Pin↔Pad-Sub-UI direkt) / **Abbrechen**. „EasyEDA ohne Symbol" entfällt — ein Footprint ohne Symbol ist in KiCad nutzlos; diese Option wird NICHT angeboten. 🟢 ENTSCHIEDEN.

#### U4.3 „Voll-manuell" (perfekter-Fall-Fallback, User-Vision Punkt 5)
Wenn LCSC-Specs da sind, aber WEDER Symbol NOCH Footprint NOCH 3D von EasyEDA: ein kombinierter Modal „Bauteil manuell zusammenstellen" mit drei Pickern (Symbol / Footprint / [3D folgt dem Footprint]) + Live-Vorschau-Counts. Confirm baut ein reines Template-Assembly (kein EasyEDA-Call). 🟢 ENTSCHIEDEN: 3D ist KEIN eigener Picker (3D folgt dem Footprint per ADR-0005 / KONZEPT §11.3 „nicht user-overridbar") — nur ein read-only Status „3D: aus Footprint übernommen / kein 3D verfügbar".

**Flow-Reihenfolge bei beidseitig fehlend:** zuerst Symbol-Dialog (§U4.2), dann Footprint-Dialog (§U4.1), dann Panel mit den getroffenen Vorbelegungen — ODER direkt §U4.3 wenn die Engine „beide fehlen + Specs vorhanden" meldet. 🟢 ENTSCHIEDEN: §U4.3 bevorzugt, wenn beide fehlen (eine Entscheidung statt Dialog-Kaskade — genau die Kaskade, die das Override Panel laut KONZEPT §8.1 ablösen soll).

#### U4.4 V2-Wiederverwendung (Value-Param)
Die V2-Value-Param-Dialoge (`lcscValueParamDialogs.js`) bleiben als ORTHOGONALE Schicht erhalten: sie betreffen die `Value`-Property-Quelle, nicht den Symbol/Footprint-Layer. Sie laufen VOR dem Panel/Auto-Apply, wenn `needsValueParamFromPage` bzw. ein Rule-Mismatch (`isConfiguredValueParamPresentOnPage`) zutrifft. Outcomes: `default`/`configure`/`cancel` (bereits implementiert). 🟢 ENTSCHIEDEN: nicht neu bauen, nur in den V3-Flow einhängen (vor Panel-Render).

---

### U5. Pin↔Pad-Sub-UI (Feature-Block H)

Sub-Pane INNERHALB des Override Panels (kein eigenes Modal), Modul `pinPadSubPanel.js` (KONZEPT §4.4-Modulliste). Erscheint per §U2.4-Bedingung.

```
┌─ Pin ↔ Pad Zuordnung ───────────────────────────────────────────────┐
│  Symbol-Pins (3)              Footprint-Pads (R_0603)                 │
│  ┌──────────────┐             ┌─────────────────────────────────┐    │
│  │ ●1  IN       │── (1) ────▶ │     ┌───┐         ┌───┐          │    │
│  │ ○2  GND      │             │     │ 1 │         │ 2 │          │    │
│  │ ●3  OUT      │── (2) ────▶ │     └───┘         └───┘          │    │
│  └──────────────┘             │   (klickbares Footprint-SVG)     │    │
│                               └─────────────────────────────────┘    │
│  ⚠ 3 Pins ⟷ 2 Pads — 1 Pin ohne Pad                                 │
│  [ Zurücksetzen ]        [✓ ohne Verbindung: GND ]                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Interaktion:**
1. Linke Spalte: nummerierte Symbol-Pin-Liste (Nummer + Pin-Name).
2. Rechte Spalte: vom Native Host vorgerendertes Footprint-SVG (RPC liefert SVG-String; KONZEPT §13.3 — 🔴 ob separater `renderFootprintSvg`-RPC oder Teil von `listTemplates`, ist Backend-Entscheidung). Pads klickbar, Pad-Label überlagert.
3. **Set-Mapping:** Klick Symbol-Pin (highlight) → Klick Pad → Verbindungslinie gezeichnet, Pin bekommt `●`-Marker. 
4. **Clear-Mapping:** erneuter Klick auf einen gemappten Pin → Mapping gelöscht (`○`).
5. **„ohne Verbindung":** Checkbox markiert einen Pin explizit als unbelegt (z.B. GND auf NC) → kein Count-Fehler mehr.
6. **Count-Mismatch-Handling:** Live-Zähler „N Pins ⟷ M Pads"; rote Hint solange ungemappte Pins existieren (außer explizit „ohne Verbindung"). **Confirm im Panel bleibt disabled**, bis jeder Pin entweder gemappt oder „ohne Verbindung" ist.
7. **Reset:** `[ Zurücksetzen ]` löscht alle Mappings (zurück auf leer ODER auf trivial-1:1 wenn Counts passen).
8. **Persistenz:** Confirm schreibt Sidecar `<TemplateLibrary>/pin_maps/<symbol>__<footprint>.json` (Format KONZEPT §13.4). Re-Import liest Sidecar → keine UI (KONZEPT §13.2).

🟢 ENTSCHIEDEN: „Reset Pin Map"-Button GEHÖRT ins Panel (KONZEPT §13.5 markierte das als offen) — sonst muss der User die Sidecar-Datei von Hand löschen, was das Intuitivitäts-Prinzip (User-Vision Punkt 7) bricht. Kosten: ein Button. Klarer Gewinn.

🟢 ENTSCHIEDEN: Sub-UI ist inline im Panel (nicht Modal) — sie braucht Sichtkontakt zu den Dropdowns darüber (welches Symbol/welcher Footprint gerade gewählt ist), und ein Modal über dem Panel wäre eine UI-über-UI-Stapelung.

---

### U6. Datasheet-Preview (Feature-Block J)

Wiederverwendung der V2-`DatasheetPanel`-Klasse (`datasheetPanel.js`) — iframe `pdf_viewer.html` + postMessage-Protokoll + Stall-Timeout (25 s) + Blob-URL-Housekeeping sind fertig. Neu ist nur das Einhängen als collapsibles Sub-Pane im Override Panel (§U2.5).

**Flow:** Klick `[ Vorschau einblenden ]` → SW-RPC `fetchDatasheet` (KONZEPT §15.2, Variante A — Bytes via separater RPC, NICHT Content-Script-Fetch wegen CORS) → Bytes in `DatasheetPanel.mountViewer(scrollHost, bytes)`. 
**Edge Cases (KONZEPT §15.3):** keine `datasheetUrl` → Sektion nicht gemountet; PDF.js scheitert → `mountFailurePlaceholder` (`datasheetPanel.js:241`) zeigt „In Tab öffnen", restliches Panel bleibt nutzbar.

🟢 ENTSCHIEDEN: Variante A (separate `fetchDatasheet`-RPC). KONZEPT §5.2.3 ließ das offen; CORS (LCSC-CDN ohne ACAO) schließt Content-Script-Fetch aus, und das Trennen der schnellen Metadaten (~1 s) vom 5–20 MB-PDF ist die saubere Lösung.

---

### U7. State-Inventar — vollständig

Single State-Machine pro Anchor-Card. `data-k2c-phase1-status`-Attribut trägt den State-Namen als CSS-Hook.

#### U7.1 States → visuelle Behandlung + Copy

| State | Visuell (Status-Span / Buttons) | Copy-Key |
|---|---|---|
| `idle` | Span leer/blass; Buttons enabled (wenn Vorbedingungen ok) | — |
| `checking` | Dot 🟡; Buttons disabled; Span „Service wird geprüft…" | `k2c.status.checking` |
| `offline` | Dot 🔴; Buttons disabled; Span + Tooltip „Lokaler Service nicht erreichbar — Installer ausgeführt?" | `k2c.status.offline` |
| `noActiveLib` | Dot 🟢; Download disabled; Span „Keine aktive Bibliothek" + Link | `k2c.status.noActiveLib` |
| `loading` (Phase 1) | Span „Metadaten werden geladen…"; Buttons disabled | `k2c.p1.loading` |
| `suggesting` | Span „Vorschlag wird ermittelt…" (kurz, optional); | `k2c.suggest.computing` |
| `panel-open` | Panel-`<tr>` sichtbar; Anchor-Buttons → Customize bleibt, Download disabled | — |
| `converting` | Span „Phase 2: <message> (NN%)" (`formatPhase2Progress`, `phase2Convert.js:43`); alle Buttons disabled | `k2c.p2.progress` |
| `success` | Span grün „Fertig · <libPath>" (`formatPhase2Terminal`); Panel entfernt; Buttons re-enabled | `k2c.p2.done` |
| `error` | Span rot „<user-message>" (§U7.3); Buttons re-enabled für Retry | `k2c.error.*` |
| `busy` | Span „Service ist beschäftigt — bitte warten"; Buttons disabled | `k2c.status.busy` |

#### U7.2 Erlaubte Transitions
```
idle ─Download──▶ loading
idle ─Customize─▶ loading(forcePanel)
checking ─ping ok──▶ idle | noActiveLib
checking ─ping fail─▶ offline
offline ─ping ok───▶ idle            (host-status-tick, KONZEPT §16.3)
loading ─P1 ok─────▶ suggesting
loading ─P1 err────▶ error
loading ─concurrent▶ busy
suggesting ─autoApply(§U3.4)──▶ converting
suggesting ─needPanel─────────▶ panel-open
suggesting ─missing-layer─────▶ (Modal §U4) ─▶ panel-open | converting | idle(cancel)
panel-open ─Confirm──▶ converting
panel-open ─Cancel/Esc▶ idle
converting ─progress─▶ converting    (self-loop, ≥3 frames KONZEPT §9.4)
converting ─done─────▶ success
converting ─error────▶ error
success ─Download────▶ loading       (neuer Import)
error   ─Download────▶ loading       (Retry)
busy    ─tick/release▶ idle
```

#### U7.3 7 Fehlercodes → User-Texte (KONZEPT §5.2.4 + `host.py`)

| Code | DE User-Text (`k2c.error.*`) | Recovery-Hint |
|---|---|---|
| `busy` | „Der lokale Service ist gerade beschäftigt. Bitte warte, bis der laufende Import fertig ist." | Buttons re-enable nach Release |
| `easyeda_unavailable` | „EasyEDA ist nicht erreichbar. Prüfe deine Internetverbindung und versuche es erneut." | Retry-Button |
| `template_not_found` | „Die gewählte Template-Bibliothek wurde nicht gefunden. Wurde sie verschoben oder gelöscht?" | öffnet Override Panel zur Neuwahl |
| `overwrite_refused` | „Das Bauteil existiert bereits. Aktiviere „Überschreiben", um es zu ersetzen." | öffnet Panel mit Overwrite-Toggle sichtbar |
| `pin_pad_mismatch` | „Pin-Anzahl des Symbols passt nicht zu den Pads des Footprints. Bitte ordne die Pins manuell zu." | öffnet Pin↔Pad-Sub-UI |
| `lib_write_failed` | „Schreiben in die Bibliothek fehlgeschlagen. Ist die Datei in KiCad geöffnet oder schreibgeschützt?" | Retry-Button |
| `internal` | „Ein interner Fehler ist aufgetreten. Bitte versuche es erneut; aktiviere Debug-Logs in den Einstellungen für Details." | Retry + Hinweis Debug-Logs |

Plus Transport-/Vorbedingungs-Pseudo-Fehler (kommen aus `background.js`, nicht aus den 7 Backend-Codes, aber dieselbe Error-Oberfläche):
| Quelle | DE-Text | Key |
|---|---|---|
| Host nicht installiert / `disconnected` / `Specified native messaging host not found` | „Der lokale Service ist nicht installiert. Bitte führe den Installer aus." | `k2c.error.hostNotInstalled` |
| `timeout` | „Zeitüberschreitung — der Service hat nicht rechtzeitig geantwortet." | `k2c.error.timeout` |
| `no Active library selected` (`background.js:1821`) | „Keine aktive Bibliothek gewählt. Bitte wähle zuerst eine Zielbibliothek." | `k2c.error.noActiveLib` |

🟢 ENTSCHIEDEN: Fehlertexte sind handlungsorientiert (jeder hat einen Recovery-Hint/Button), nie ein roher Code. Der rohe Code wandert in `console.debug`, nicht in die UI. Der einzige Ort, an dem ein roher Backend-String durchgereicht wird, ist `internal` (catch-all) — und auch der bekommt einen freundlichen Wrapper.

#### U7.4 Offline / Host-not-installed Unterscheidung
- `checking` → `offline`: Ping schlug fehl, aber Channel-Setup ging (Host registriert, aber down). Text: „nicht erreichbar — läuft der Service?"
- `disconnected`/„host not found": Host gar nicht registriert. Text: „nicht installiert — Installer ausführen". 
🟢 ENTSCHIEDEN: Diese zwei Fälle bekommen UNTERSCHIEDLICHE Texte — „starte neu" vs. „installiere zuerst" sind verschiedene Handlungen. Heuristik = `chrome.runtime.lastError.message` enthält „not found"/„Specified" → not-installed, sonst → offline.

---

### U8. COPY-DECK (DE, verbindlich; EN optional)

| Key | DE |
|---|---|
| `k2c.btn.import` | In KiCad importieren |
| `k2c.btn.customize` | Anpassen |
| `k2c.panel.heading` | Quellen überschreiben |
| `k2c.panel.symbol` | Symbol |
| `k2c.panel.footprint` | Footprint |
| `k2c.panel.keepEasyeda` | EasyEDA übernehmen |
| `k2c.panel.cancel` | Abbrechen |
| `k2c.panel.confirm` | Importieren |
| `k2c.mode.easyeda` | EasyEDA-Pipeline |
| `k2c.mode.template` | Template-Assembly |
| `k2c.suggest.high` | Vorschlag (hoch) |
| `k2c.suggest.medium` | Vorschlag (mittel) |
| `k2c.suggest.low` | Vorschlag (niedrig) |
| `k2c.suggest.reason.rule` | aus Regel {category} |
| `k2c.suggest.reason.package` | Paket {package} erkannt |
| `k2c.suggest.reason.pincount` | {pins} Pins erkannt |
| `k2c.suggest.manual` | ✎ manuell |
| `k2c.suggest.autoLine` | ✨ Auto: {symbol} → {footprint} · importiere… |
| `k2c.pinpad.heading` | Pin ↔ Pad Zuordnung |
| `k2c.pinpad.trivial` | {n} Pins ⟷ {m} Pads · automatisch 1:1 |
| `k2c.pinpad.edit` | Zuordnung bearbeiten |
| `k2c.pinpad.openRequired` | Zuordnung erforderlich |
| `k2c.pinpad.mismatch` | {n} Pins ⟷ {m} Pads — {k} Pin(s) ohne Pad |
| `k2c.pinpad.noconn` | ohne Verbindung |
| `k2c.pinpad.reset` | Zurücksetzen |
| `k2c.datasheet.show` | Vorschau einblenden |
| `k2c.datasheet.hide` | Vorschau ausblenden |
| `k2c.datasheet.openTab` | In Tab öffnen |
| `k2c.datasheet.failed` | Datenblatt konnte nicht angezeigt werden. |
| `k2c.overwrite.warn` | Bauteil existiert bereits in der Bibliothek. |
| `k2c.overwrite.toggle` | Überschreiben |
| `k2c.overwrite.skipBlock` | Bauteil existiert — wird übersprungen (Richtlinie: Skip). |
| `k2c.labels.preview` | Wird angelegt: {pairs} |
| `k2c.missing.fp.title` | Kein Footprint gefunden |
| `k2c.missing.fp.body` | EasyEDA liefert für dieses Bauteil keinen Footprint. Wie möchtest du fortfahren? |
| `k2c.missing.fp.optTemplate` | Template-Footprint wählen |
| `k2c.missing.fp.optNone` | EasyEDA-Symbol ohne Footprint anlegen |
| `k2c.missing.fp.manualLater` | Nur Symbol angelegt — Footprint später zuordnen. |
| `k2c.missing.sym.title` | Kein Symbol gefunden |
| `k2c.missing.sym.optTemplate` | Template-Symbol wählen |
| `k2c.missing.sym.optManual` | Manuell zusammenklicken |
| `k2c.missing.both.title` | Bauteil manuell zusammenstellen |
| `k2c.missing.threed.fromFp` | 3D: aus Footprint übernommen |
| `k2c.missing.threed.none` | 3D: kein Modell verfügbar |
| `k2c.status.checking` | Service wird geprüft… |
| `k2c.status.offline` | Lokaler Service nicht erreichbar — Installer ausgeführt? |
| `k2c.status.noActiveLib` | Keine aktive Bibliothek — jetzt wählen |
| `k2c.status.busy` | Service ist beschäftigt — bitte warten |
| `k2c.p1.loading` | Metadaten werden geladen… |
| `k2c.suggest.computing` | Vorschlag wird ermittelt… |
| `k2c.p2.progress` | Phase 2: {message} ({pct}%) |
| `k2c.p2.done` | Fertig · {libPath} |
| `k2c.host.tooltip.online` | Lokaler Service online |
| `k2c.host.tooltip.checking` | Status wird geprüft… |
| `k2c.host.tooltip.offline` | Offline — Installer ausführen |
| `k2c.error.busy` … `k2c.error.internal` | siehe §U7.3-Tabelle |

---

### U9. Implementierungs-Reihenfolge (für den Coding-Agent)
1. Anchor-Card-Erweiterung (Host-Dot, Disabled-Matrix, geteilter Status) — `anchorCard.js` + `nativeHostStatusButton.js`.
2. Panel-Sektionen einbauen (Modus-Badge, Style-Upgrade `applyDialogStyleSelect`, Overwrite, Labels-Preview) — `overridePanel.js`.
3. Suggestion-Präsentation (Badges, Vorbelegung, Auto-Apply-Status) — neuer Renderer in `overridePanel.js`, Eingabevertrag §U3.1.
4. Missing-Layer-Modals — neues Modul `missingLayerDialogs.js` auf `mountCsModal`.
5. Pin↔Pad-Sub-Pane — `pinPadSubPanel.js`.
6. Datasheet-Sub-Pane — `datasheetSubPanel.js` (wrappt `DatasheetPanel`).
7. State-Machine + Error-Mapping zentralisieren — neues Modul `cardState.js` (Single-Source der States/Transitions/Copy-Keys).
8. COPY-DECK als `i18n/de.json` + Key-Lookup.

---

## 6. UI/UX — Popup, Settings & Datei-Picker

## UI/UX — Popup, Settings & File-Explorer Path Picker (V3)

Ziel: Das Extension-Popup vom V2-Stand (3 Tabs: Categories / Library / Settings, Bootstrap 5.3, Light/Dark) zum **Auto-Suggestion-Cockpit** der Produktvision weiterentwickeln. Drei Tabs bleiben, werden aber inhaltlich vertieft: (1) **Rules** (vorher „Categories") = Auto-Suggestion-Regel-Editor, (2) **Library** = aktive Lib + Template-Libs mit Asset-Counts, (3) **Settings** = globale Toggles + Host-Status. Plus ein intuitiver **File-Explorer-Pfad-Picker** für Library-/Template-Zuweisung und **First-Run/Onboarding-Empty-States**.

Grounding (V2-Ist, file:line):
- `chrome_extension/popup.html:31-38` Tab-Buttons; `:41-105` Categories+Library-Sections; `:107-228` Settings-Form; `:309-337` Picker-Modal; `:253-307` Add-Library-Modal; `:339-350` Shared-Confirm-Overlay.
- `chrome_extension/popup.js:997-1316` Category-Render/CRUD (heutiges Modell: nur `valueParam`, `hidePinNumbers`, `hidePinNames`); `:627-875` Library-Render (Activate-Pill, Template-Switch, Asset-Badges `:877-884`); `:981-996` Settings-Render; `:1710-1983` Picker (openDirectoryPicker / loadRoots / loadDirectory / renderPickerPathBreadcrumb / renderPickerList / Keyboard `:1890-1915` / applyPickerSelection).
- FS-RPC-Contract: `easyeda2kicad/api/server.py:719` `_fs_roots()`, `:760` `_fs_list_directory()`, `:808` `_fs_check()`. Background-Wrapper: `background.js:1589-1599` (`fs_roots`/`fs_list`/`fs_check`).
- Konzept-Ist: `docs/KONZEPT.md` §4.3 (Popup-Tabs), §12 (Rule-Type + Deepest-Prefix-Match), §8 (Override Panel).
- Metadata-Label-Quelle (Vision-Punkt 6, schon implementiert): `easyeda2kicad/kicad/template_merger.py:235-261` (Datasheet, Manufacturer, Tolerance, Package, Power, Voltage Rating, valueParam → Symbol-Properties); Standard-Keys: `parameters_kicad_symbol.py:121-132`.

---

### 0. Globaler Popup-Rahmen (Header + Status)

🟢 ENTSCHIEDEN (D-UI-1): Popup-Breite **fix 420 px** (Chrome-Action-Popup-Max ~800 px, aber 420 px ist die bequeme Lesebreite für File-Explorer + Regelzeilen; V2 nutzt Bootstrap-`container` ohne feste Breite → auf Schmalgeräten gequetscht). Höhe `min(640px, viewport)`, innerer Scroll pro Tab-Panel (V2 scrollt schon `#categories-card-body`, `popup.js:1054`).

🟢 ENTSCHIEDEN (D-UI-2): Header zeigt **eine** Status-Zeile mit **Host-Status** (Native Messaging, V3-Transport) — die V2-Zeile „Backend: ●" (WebSocket, `popup.html:20-28`) entfällt, weil V3 keine WS-Verbindung mehr ist (Ground Truth: Native Messaging). Tri-State `checking / online / offline` aus `nativeHostStatus` (`background.js:1669`), gespiegelt per `v3NativeHostStatusUpdate`-Broadcast (`background.js:1672-1677`).

```
┌──────────────────────────────────────────────────────────┐
│  KiCad Parts Importer            ● Host: online · v0.0.1  │  ← grün=online / grau=checking / rot=offline
│  ➜ Active library:  MyProject_RC                          │  ← aus getActiveLibrary(), popup.js:1985
├──────────────────────────────────────────────────────────┤
│  [ Rules ]  [ Library ]  [ Settings ]                     │  ← Tab-Buttons (role=tablist), popup.html:31
└──────────────────────────────────────────────────────────┘
```

Copy:
- Host online: `● Host: online · v{version}` (version aus Ping-Response `host.py:139`).
- Host checking: `◌ Host: checking…`
- Host offline: `● Host: offline` + Klick öffnet Inline-Hint (siehe §6 Onboarding). Tooltip: „Native Host nicht erreichbar. Installer ausführen und Seite neu laden." (KONZEPT §20.1, Zeile 1308).

---

### 1. TAB „RULES" — Auto-Suggestion-Regel-Editor (Kern der neuen Vision)

Ersetzt den V2-Tab „Categories". Jede Zeile = eine **Rule**, gematcht per **Deepest-Prefix** gegen den Phase-1-Category-Path (KONZEPT §12.3). Die Vision (Punkt 3+4+6) verlangt pro Regel deutlich mehr Felder als V2 (`popup.js:1073-1255` kennt nur valueParam/hidePins). 

🟢 ENTSCHIEDEN (D-RULES-1): **Erweitertes Rule-Datenmodell** (Superset des KONZEPT §12.2-`Rule` — additiv, abwärtskompatibel zu V2-`categorySettings`). Persistenz bleibt `chrome.storage.local`; Migration: V2 `categorySettings{key:{valueParam,hidePinNumbers,hidePinNames}}` wird beim ersten V3-Load in `rules[]` gemappt (key→categoryPath, Pin-Flags → `pinDisplay`), siehe D-RULES-7.

```ts
type Rule = {
  id: string;                       // stabil, für Edit/Remove
  categoryPath: string;             // normalizeCategoryPath, z.B. "Passives/Resistors/SMD"  (KONZEPT §7.3)
  // — Matching-Verschärfer (Vision Punkt 3: nicht nur Kategorie, auch Pin/Package) —
  match: {
    pinCount?: number | null;       // optional; exakter Pin-Count-Filter (z.B. 2 für R/C/D)
    packageForm?: string | null;    // optional; z.B. "0402","0603","SOT-23"; case-insensitiv, aus Page-Param "Package"
  };
  // — Layer-Quellen (KONZEPT §12.2 LayerChoice, erweitert um model) —
  symbolSource:    LayerChoice;     // EasyEDA | Template-Symbol
  footprintSource: LayerChoice;     // EasyEDA | Template-Footprint (3D folgt Footprint, ADR-0005)
  model3dSource:   "follow-footprint" | "easyeda";  // default follow-footprint (ADR-0005)
  // — Verhalten —
  action: "auto-apply" | "ask";     // auto-apply ⇒ Skip-Panel-Flow (KONZEPT §12.4 autoConfirm:true)
  // — Symbol-Darstellung (V2-Erbe) —
  pinDisplay: { hideNumbers: boolean; hideNames: boolean };
  valueParam?: string | null;       // LCSC-Spaltentitel → Symbol-Value (z.B. "Resistance")
  // — Metadata-as-Labels (Vision Punkt 6) —
  labelMap: Array<{ lcscParam: string; symbolProp: string; visible: boolean }>;
}
type LayerChoice =
  | { source: "easyeda" }
  | { source: "template", libPath: string, name: string };
```

🟢 ENTSCHIEDEN (D-RULES-2): `action` ist ein **2-Wege-Segment** „Ask / Auto-apply" statt der KONZEPT-`autoConfirm`-Checkbox — klarer, weil es die zwei realen Outcomes benennt (Panel zeigen vs. direkt importieren). Mapping auf KONZEPT: `auto-apply ≡ autoConfirm:true`. (Die globale Bremse „Always show panel", §3, sticht jede `auto-apply`-Regel.)

🟢 ENTSCHIEDEN (D-RULES-3): **Accordion-Zeilen bleiben** (V2 `cat-item`, `popup.js:1073`) — eine zusammengeklappte Zeile zeigt Path-Breadcrumb + Summary-Chips; aufgeklappt der volle Editor. Begründung: skaliert auf viele Regeln, V2-Muster ist erprobt, kein Modal-Zwang. **Kein** separates „Edit"-Modal (KONZEPT §4.3.1 nennt „Edit", aber Inline-Accordion ist intuitiver und schon gebaut).

**1a. Liste (zusammengeklappt):**
```
┌── Rules ─────────────────────────────────  (ⓘ)   [ + Add rule ] ──┐
│  Auto-suggest symbol, footprint & labels per LCSC category.        │
│  Deepest matching path wins.                          🔎 [filter…] │
├───────────────────────────────────────────────────────────────────┤
│ ▾  Passives / Resistors / SMD                                  ✕  │
│    🟩 Auto-apply   ⚙ R_Std   ⬡ R_0603   🏷 4 labels   pins:2     │
├───────────────────────────────────────────────────────────────────┤
│ ▾  Passives / Capacitors                                       ✕  │
│    🟨 Ask          ⚙ EasyEDA  ⬡ EasyEDA  🏷 2 labels             │
├───────────────────────────────────────────────────────────────────┤
│ ▾  ICs / Logic / 74-Series                                     ✕  │
│    🟨 Ask          ⚙ EasyEDA  ⬡ EasyEDA   ⚠ pin≠pad (sidecar)   │
└───────────────────────────────────────────────────────────────────┘
```
Chips (Summary, erweitert `updateCatSummary` `popup.js:1287`): `🟩 Auto-apply`/`🟨 Ask`, `⚙ {symbolSource}`, `⬡ {footprintSource}`, `🏷 {n} labels`, optional `pins:{n}`, `pkg:{form}`, Warn-Chip `⚠ pin≠pad` wenn Pin/Pad-Mismatch ohne Sidecar (KONZEPT §13).

**1b. Zeile aufgeklappt (Editor):**
```
┌─ ▾  Passives / Resistors / SMD ──────────────────────────────  ✕ ─┐
│                                                                    │
│  LCSC category path                                                │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Passives/Resistors/SMD                                       │ │  ← textarea, normalizeCategoryPath (popup.js:1094)
│  └──────────────────────────────────────────────────────────────┘ │
│  Passives › Resistors › SMD            (live breadcrumb preview)   │
│                                                                    │
│  Match also by … (optional)                                        │
│   Pin count [ 2 ▾ ]   Package form [ 0603        ]                 │
│                                                                    │
│  When a part matches →                                             │
│   ◉ Ask (show panel)     ◯ Auto-apply (import directly)            │
│                                                                    │
│  Symbol source     [ Template: R_Std (MyTemplates)        ▾ ]      │
│  Footprint source  [ Template: R_0603 (MyTemplates)       ▾ ]      │
│  3D model          [ ✔ Follow footprint ]  (ADR-0005)             │
│                                                                    │
│  Value from LCSC param  [ Resistance              ]   (→ Value)   │
│  ☐ Hide pin numbers     ☐ Hide pin names                          │
│                                                                    │
│  ▸ Metadata labels (4)                                            │
│  ┌─ LCSC param ───────┬─ Symbol property ──┬ show ┬   ┐           │
│  │ Tolerance          │ Tolerance          │  ☑   │ ✕ │           │
│  │ Power(Watts)       │ Power              │  ☑   │ ✕ │           │
│  │ Manufacturer       │ Manufacturer       │  ☐   │ ✕ │           │
│  │ Datasheet          │ Datasheet          │  ☐   │ ✕ │           │
│  └────────────────────┴────────────────────┴──────┴───┘           │
│  [ + Add label ]   [ Suggest from this page ]                     │
│                                                                    │
│  ⚠ R_Std nicht in aktiver Template-Library gefunden (Warn-Icon)   │
└────────────────────────────────────────────────────────────────────┘
```

🟢 ENTSCHIEDEN (D-RULES-4): **Symbol-/Footprint-Source-Dropdowns** werden aus den **Template-Libraries** befüllt (Libs mit `isTemplateLibrary=true`, `background.js:823-829`) via Native-Host-`listTemplates` (`templates.py:44`, liefert `{symbols[], footprints[]}`). Option-Gruppen: `── EasyEDA (keep) ──` (default) und pro Template-Lib eine `<optgroup>` mit deren Symbol- bzw. Footprint-Namen. Fehlt der gespeicherte Name in der aktiven Lib → **Warn-Icon** + Option bleibt selektierbar (graceful, kein Hard-Reset; KONZEPT §4.3.1 Validierung).

🟢 ENTSCHIEDEN (D-RULES-5): **3D-Layer ist KEIN freies Dropdown**, sondern ein einzelner Toggle „Follow footprint" (default an), passend zu ADR-0005 (3D folgt Footprint, Carry-Over) und MEMORY `project_v3_3d_layer`. „EasyEDA-3D" nur, wenn der Toggle aus ist (Fallback). Kein Pro-Datei-3D-Picker in den Rules — das hält die Regel einfach.

🟢 ENTSCHIEDEN (D-RULES-6): **Metadata-Label-Mapping-UI** (Vision Punkt 6) = editierbare Tabelle `{lcscParam → symbolProp, visible}`. Vorbelegung „Suggest from this page": liest die zuletzt vom Content-Script gescrapten Page-Params (`lcscPageSnapshot`) und schlägt Mappings vor, wobei `symbolProp` aus `STANDARD_SYMBOL_PROPERTY_KEYS` (`parameters_kicad_symbol.py:121`: Manufacturer, Datasheet, Description, LCSC Part, JLC Part …) per Fuzzy-Match (`normalize_property_key_for_match`, `template_merger.py:27`) gezogen wird; unbekannte Keys landen als **hidden custom property** (genau wie `template_merger.py:261` `_make_hidden_property`). `visible`-Spalte steuert das `hide`-Flag im S-Expr. Beispiel-Ziel der Vision (R mit Value=50R, Tolerance=±1%, Package=0603) ist damit 1:1 abbildbar.

🟢 ENTSCHIEDEN (D-RULES-7): **Migration & Defaults.** Beim ersten V3-Start werden V2-`categorySettings` (`background.js:118-121`) zu `rules[]` migriert: `{ "Passives/Resistors": {valueParam:"Resistance", hidePinNumbers:true, hidePinNames:true} }` → `Rule{ categoryPath:"Passives/Resistors", valueParam:"Resistance", pinDisplay:{hideNumbers:true,hideNames:true}, symbolSource:{source:"easyeda"}, footprintSource:{source:"easyeda"}, model3dSource:"follow-footprint", action:"ask", labelMap:[] }`. Ein Seed-Beispiel-Rule (Resistors) bleibt als „so sieht eine Regel aus"-Vorlage erhalten.

**Validierung / Inline-Fehler (live, debounced wie V2 `popup.js:1117-1123`):**
- Doppelter `categoryPath` → Inline-Banner „Regel für diesen Pfad existiert bereits". (KONZEPT §4.3.1 „überschreiben?" → 🟢 D-RULES-8: **kein** Overwrite-Prompt, stattdessen Live-Merge-Hinweis + Sprung zur existierenden Zeile; Doppelte werden wie in V2 dedupliziert, `popup.js:1318-1347`.)
- `symbolSource`-Template fehlt → Warn-Icon, nicht blockierend.
- `pinCount` non-numeric → Feld rot, Save übersprungen für dieses Feld.

Inputs: User-Eingaben + (read-only) aktuelle Template-Listen + letzter Page-Snapshot. Outputs: `chrome.storage.local.rules` (broadcast → Content-Script `categoryRuleMatcher`, KONZEPT §4.4 / §12).

---

### 2. TAB „LIBRARY" — Aktive Lib + Template-Libs

Übernimmt V2 weitgehend (`popup.js:627-875`), verfeinert die Asset-Counts und das First-Run-Empty.

```
┌── Libraries ─────────────────────────────  (ⓘ)  [ + Add ]  🔎 […] ─┐
│  Symbols: 128 · Footprints: 96 · 3D: 84                            │  ← libraryTotals (popup.js:653)
├───────────────────────────────────────────────────────────────────┤
│ ▾ ● MyProject_RC                           [ Active ]          ✕   │  ← active pill (popup.js:769)
│     ⚙ Symbol (128)  ⬡ Footprint (96)  ◳ 3D (84)    [⚪ Template]   │  ← asset badges (popup.js:814) + template switch
│     D:\KiCad\libs\MyProject_RC.kicad_sym                           │
├───────────────────────────────────────────────────────────────────┤
│ ▾   MyTemplates                  [ Activate ]   [TEMPLATE]     ✕   │  ← template badge (popup.js:749)
│     ⚙ Symbol (12)  ⬡ Footprint (18)  ◳ 3D (18)     [🟢 Template]   │
│     D:\KiCad\libs\MyTemplates.kicad_sym                            │
│        ▾ details:  Footprint dir: …\MyTemplates.pretty            │  ← buildLibraryDetailsPanel (popup.js:926)
│                    3D dir:        …\MyTemplates.3dshapes          │
├───────────────────────────────────────────────────────────────────┤
│ ▾ ⚠ OldLib                       [ Missing ]                  ✕   │  ← missing pill (popup.js:780)
└───────────────────────────────────────────────────────────────────┘
```

🟢 ENTSCHIEDEN (D-LIB-1): Asset-Badges behalten Count + Farbe (grün=hat Einträge, grau=leer, `popup.js:877-884`), Labels werden zu **Icon+Count** (`⚙ Symbol (128)`) für Kompaktheit. Template-Switch (`popup.js:818-842`) bleibt pro Zeile — eine Lib ist gleichzeitig Active **und** Template möglich (V2-Verhalten beibehalten), aber 🟢 D-LIB-2: **Warnung**, wenn dieselbe Lib Active+Template ist (KONZEPT §4.3.2 „Active Library ≠ Template Library"): kleines `⚠`-Tooltip „Active library als Template kann sich selbst überschreiben".

🟢 ENTSCHIEDEN (D-LIB-3): **„Add"** öffnet das bestehende Add-Library-Modal (`popup.html:253`) mit **Create**-Form (Name + Base-Folder via Picker, Häkchen .kicad_sym/.pretty/.3dshapes) und **Import** (vorhandene `.kicad_sym` wählen). Der **Base-Folder-Button** und der **Import-Button** rufen beide den File-Explorer-Picker (§4) — Create im `mode:"folder"`, Import im `mode:"import"` (Filter `.kicad_sym`, `popup.js:1721`).

Inputs: Library-Records (`background.js` `libraries[]`), `libraryTotals`, Counts via FS-Scan. Outputs: `chrome.storage.local` (active flag, isTemplateLibrary, add/remove).

---

### 3. TAB „SETTINGS" — Globale Toggles + Host-Status

Baut auf V2-Settings-Form (`popup.html:107-228`). Die V2-Sektion „Backend / API base URL" (`popup.html:111-133`) **entfällt** (kein WS in V3), ersetzt durch **Host-Status + Re-Check** (Native Messaging).

```
┌── Settings ───────────────────────────────────────────────────────┐
│  Native Host                                                  (ⓘ)  │
│   ● online · v0.0.1                              [ Re-check ]      │  ← ping (host.py:139), prewarm (background.js:1685)
│   Offline?  → Install host once, then reload the LCSC page.       │  ← link to onboarding (§6)
│                                                                    │
│  Appearance                                                  (ⓘ)  │
│   Color theme   [ Light ] [ Dark ]                               │  ← popup.html:148-158
│                                                                    │
│  Import behaviour                                            (ⓘ)  │
│   ☐ Always show Override Panel (disables auto-apply globally)     │  ← KONZEPT §4.3.3 master toggle
│   Default overwrite policy   ◉ Ask  ◯ Overwrite  ◯ Skip          │  ← replaces 2 V2 switches, see D-SET-1
│   ☐ Use project-relative 3D paths  ${KIPRJMOD}[ ../../library ]   │  ← popup.html:185-198
│                                                                    │
│  Diagnostics                                                 (ⓘ)  │
│   ☐ Enable debug logging                                          │  ← popup.html:218-221
└───────────────────────────────────────────────────────────────────┘
```

🟢 ENTSCHIEDEN (D-SET-1): Die zwei V2-Overwrite-Switches („Overwrite footprints & symbols", „Overwrite 3D models", `popup.html:176-184`) werden zu **einer 3-Wege-Policy** `Ask | Overwrite | Skip` zusammengeführt (KONZEPT §4.3.3 „Default overwrite policy"). Begründung: vereinheitlicht mit dem Override-Panel-Overwrite-Verhalten (KONZEPT §12.4 Schritt 4) und reduziert kognitive Last. Migration: V2 `overwriteFootprints=true ⇒ "overwrite"`, sonst `"ask"`; 3D-Overwrite separat als Unter-Detail nur sichtbar bei Policy=Overwrite.

🟢 ENTSCHIEDEN (D-SET-2): **„Always show Override Panel"** (Master-Bremse, KONZEPT §12.4-5) ist der wichtigste neue Settings-Toggle und steht ganz oben in „Import behaviour", default **OFF**. ON ⇒ jede `auto-apply`-Regel wird trotzdem als Panel gezeigt (kein Skip-Flow). Spiegelt sich im Content-Script.

🟢 ENTSCHIEDEN (D-SET-3): **System-Theme-Option** (KONZEPT §4.3.3 nennt „system") wird **NICHT** in V1 aufgenommen — V2 hat nur Light/Dark (`popup.html:151-156`), und „system" addiert `prefers-color-scheme`-Logik ohne klaren Nutzen für ein Tool-Popup. Bleibt 2-Wege.

🟢 ENTSCHIEDEN (D-SET-4): „Re-check"-Button triggert `prewarmNativeHost` (`background.js:1685`) und aktualisiert die Status-Zeile + Header-Dot. Ersetzt V2 „Test" (`popup.html:129`).

Inputs/Outputs: `chrome.storage.local` (theme, overwritePolicy, alwaysShowPanel, projectRelative, projectRelativePath, debugLogs). Host-Status read-only aus Broadcast.

---

### 4. FILE-EXPLORER PATH-PICKER (Modal) — der zentrale Komfort-Baustein

Vision-Punkt 7: Pfad-Auswahl wie ein **echter Datei-Explorer**. V2 hat bereits ein brauchbares Grundgerüst (`#picker-modal`, `popup.html:309-337`; Logik `popup.js:1710-1983`): Manual-Path-Input, Breadcrumb-Row, Roots, Liste mit Ordner/Datei-Icons, Pfeiltasten-Navigation. Das wird zum vollwertigen Explorer ausgebaut.

🟢 ENTSCHIEDEN (D-PICK-1): **FS-RPCs in den Native Host portieren.** Heute existieren `fs_roots`/`fs_list`/`fs_check` NUR im Legacy-WS-Server (`server.py:719/760/808`) und der Picker ruft `fs:listRoots`/`fs:listDirectory` über WS (`popup.js:1762/1769`, `background.js:1589-1599`). Da V3 die WS-Transport droppt (Ground Truth), MÜSSEN diese drei Verben als Native-Messaging-Verben in `native_host/host.py` (analog `listTemplates`, `host.py:203`) nachgezogen werden — **das ist eine Voraussetzung, sonst funktioniert der Picker in V3 nicht.** Datencontract 1:1 übernehmen (siehe unten), Logik aus `server.py:719-826` in ein `native_host/fs.py` extrahieren. Siehe Open Risk R1.

**FS-RPC-Contract (unverändert übernehmen):**
- `fs_roots → [{ path, label }]` — Windows: Laufwerke `C:\ … Z:\` + Home + Documents/Downloads/Desktop (`server.py:719-757`).
- `fs_list({path}) → { path, parent, entries:[{name,path,is_dir,is_symlink}], breadcrumbs:[{label,path}] }` (`server.py:760-805`). Sortierung: Ordner zuerst, dann case-insensitive Name (`server.py:788`).
- `fs_check({path}) → { requested, resolved, exists, is_dir, writable }` (`server.py:808-826`) — für **Live-Validierung** des Manual-Path-Inputs und des Ziel-Ordners (Schreibrecht!).

**Wireframe (ausgebaut):**
```
┌─ Select folder ───────────────────────────────────────────────  ✕ ─┐
│  [◀]  [▶]  [↑ Up]            Path: [ D:\KiCad\libs\MyTemplates    ] │  ← back/fwd history + up + manual entry
│                                                                     │  ← fs_check live: ✔ writable / ✖ no write
│  📍 Quick access:  [🖳 This PC] [🏠 Home] [📄 Documents] [⬇ Downloads]│  ← from fs_roots labels (server.py:749)
│                                                                     │
│  ▸ D:\  ›  KiCad  ›  libs  ›  MyTemplates                           │  ← breadcrumb (clickable, popup.js:1804)
│                                                                     │
│  🔎 [ filter contents…                                            ] │  ← client-side filter of entries
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 📁 ..                                                         │  │  ← parent shortcut (data.parent)
│  │ 📁 0402                                                       │  │
│  │ 📁 0603                                            (selected) │  │  ← arrow-key + click select (popup.js:1956)
│  │ 📁 SOT-23                                                     │  │
│  │ 📄 MyTemplates.kicad_sym                       (import mode)  │  │  ← only in import mode, ext filter (popup.js:1839)
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Selected:  D:\KiCad\libs\MyTemplates\0603   ✔ writable            │
│                                       [ Cancel ]   [ Select ]      │
└─────────────────────────────────────────────────────────────────────┘
```

🟢 ENTSCHIEDEN (D-PICK-2): **Quick-Access-Leiste** (This PC / Home / Documents / Downloads) aus `fs_roots`-Labels (`server.py:743-755`) — ein Klick springt direkt dorthin. Das ist die „file explorer"-Komfortzone der Vision; V2 lädt Roots nur als Start-Verzeichnis, zeigt sie aber nicht als Schnellzugriff.

🟢 ENTSCHIEDEN (D-PICK-3): **Back/Forward/Up-Historie.** Picker hält einen In-Session-Navigations-Stack (`history[]`, `index`). `◀`/`▶` springen darin, `↑ Up` lädt `data.parent` (`popup.js:1772`). V2 hat nur Breadcrumbs (kein back/forward) — die Vision verlangt explizit „back/forward". Tastatur: `Alt+←`/`Alt+→` = back/fwd, `Backspace` = up.

🟢 ENTSCHIEDEN (D-PICK-4): **Client-seitiger Inhalts-Filter** (`🔎 filter contents`) blendet `entries` live aus (substring, case-insensitiv) — kein Server-Roundtrip. Für große Verzeichnisse essenziell. (V2 hat keinen Picker-Filter.)

🟢 ENTSCHIEDEN (D-PICK-5): **Live-Pfad-Validierung** via `fs_check`: beim Manual-Input (debounced, V2 `popup.js:1917-1940`) und bei Auswahl zeigt der Footer `✔ writable` / `✖ kein Schreibrecht hier` / `… existiert nicht (wird angelegt)`. „Select" ist disabled bei `writable=false` für Schreib-Ziele (Library-Create). Begründung: verhindert die häufigste Frustration (Lib in nicht-schreibbarem Pfad anlegen).

🟢 ENTSCHIEDEN (D-PICK-6): **Vollständige Tastatur-Unterstützung & A11y** (WCAG 1.3.1; W3C-APG-Breadcrumb-Pattern): Liste ist `role=listbox` (V2 nutzt `<ul tabindex=0>`, `popup.html:327`), `↑/↓` Auswahl + Fokus (V2 `popup.js:1890-1915`), `Enter` = Ordner öffnen / Datei wählen, `Esc` = Cancel, `Tab` durch Breadcrumbs (jeder Crumb ein `<button>`, `popup.js:1817`), aktueller Crumb `disabled`+`aria-current="page"`. Visuelle Separatoren (`›`/`/`) via CSS, **nicht** im Accessibility-Tree (sonst Screenreader-Lärm — APG-Empfehlung). Picker-Modal `role=dialog`, `aria-modal`, Fokus-Trap, Fokus zurück auf den auslösenden „Browse…"-Button beim Schließen.

🟢 ENTSCHIEDEN (D-PICK-7): **Zwei Picker-Modi bleiben** (V2 `popup.js:1721-1722`): `mode:"folder"` (Library-Base, Template-Ordner, 3D-Pfad — wählt Verzeichnis) und `mode:"import"` (wählt `.kicad_sym`-Datei, Extension-Filter). Doppelklick auf Ordner = öffnen, auf Datei = wählen+bestätigen (V2 `popup.js:1879-1888`). Apply-Guard: Import erzwingt File-Selektion (`popup.js:1977`).

Warum kein OS-Dialog? Der native `<input type=file>`/`showDirectoryPicker` kann in MV3-Popups keine Ordner zuverlässig wählen und gibt keine echten absoluten Pfade an den lokalen Host — daher der Server-seitige Browse über FS-RPCs (bereits die V2-Designentscheidung; ADR-mäßig konsistent).

---

### 5. Empty-States in Tabs (kein Onboarding-Vollbild)

🟢 ENTSCHIEDEN (D-EMPTY-1): Jeder Tab hat einen **inhaltlichen Empty-State** statt nur „No libraries yet" (V2 `popup.js:683`):
```
Library-Tab leer:
   ┌───────────────────────────────────────────┐
   │   ◳  Noch keine Library                    │
   │   Lege eine an oder importiere eine        │
   │   bestehende .kicad_sym.                    │
   │          [ + Library anlegen ]             │
   └───────────────────────────────────────────┘

Rules-Tab leer:
   ┌───────────────────────────────────────────┐
   │   ⚙  Noch keine Regeln                     │
   │   Regeln schlagen Symbol/Footprint/Labels  │
   │   automatisch vor — pro LCSC-Kategorie.    │
   │          [ + Erste Regel ]                 │
   │   Tipp: Regeln brauchen eine Template-Lib. │
   └───────────────────────────────────────────┘
```

---

### 6. First-Run / Onboarding (Host fehlt oder keine Library)

🟢 ENTSCHIEDEN (D-ONB-1): **Geführtes 2-Schritt-Banner** oben im Popup (über den Tabs), sobald (a) Host offline ODER (b) keine Library. Nicht-modal, dismissable, re-evaluiert bei jedem Öffnen.

```
┌─ Erste Schritte ──────────────────────────────────────────────────┐
│  ① Native Host installieren        ●  ausstehend / ✔ erledigt    │  ← host-status (background.js:1669)
│     Installer von der Extension-Detailseite ausführen,            │
│     dann diese Seite (oder LCSC) neu laden.   [ Re-check ]        │
│                                                                    │
│  ② Erste Library anlegen           ●  ausstehend / ✔ erledigt    │  ← getActiveLibrary (popup.js:1985)
│     [ Library anlegen ]                                           │
└────────────────────────────────────────────────────────────────────┘
```
Schritt ① ✔ wenn `nativeHostStatus.state==="online"`. Schritt ② ✔ wenn ≥1 nicht-fehlende Library existiert. Banner verschwindet, wenn beide ✔. Schritt ③ (optional, nur Hinweis): „Template-Library hinzufügen, um Auto-Suggestions zu nutzen" — verlinkt Library-Tab.

🟢 ENTSCHIEDEN (D-ONB-2): Beim **allerersten Import-Klick ohne Host** (Content-Script-Seite) bleibt der Status-Dot rot + Tooltip → Popup-Onboarding (KONZEPT §20.1, Zeile 1308). Das Popup ist der einzige Onboarding-Ort; kein separates Onboarding-Tab.

---

### 7. Copy-Deck (DE primär, EN-Strings für i18n-Keys)

🟢 ENTSCHIEDEN (D-COPY-1): Popup-UI auf **Deutsch** als Primärsprache (User-Profil: FH Zwickau, KONZEPT.md ist deutsch), technische Begriffe englisch (Footprint, Template, LCSC, Symbol). i18n-Keys vorbereiten, aber V1 nur DE-Strings.

| Key | DE |
|---|---|
| `tab.rules` | „Regeln" |
| `tab.library` | „Library" |
| `tab.settings` | „Einstellungen" |
| `rules.add` | „+ Regel hinzufügen" |
| `rules.intro` | „Schlägt Symbol, Footprint & Labels automatisch vor — pro LCSC-Kategorie. Tiefster Treffer gewinnt." |
| `rules.action.ask` | „Nachfragen (Panel zeigen)" |
| `rules.action.auto` | „Automatisch übernehmen" |
| `rules.symbolSource` | „Symbol-Quelle" |
| `rules.footprintSource` | „Footprint-Quelle" |
| `rules.follow3d` | „3D folgt Footprint" |
| `rules.valueParam` | „Value aus LCSC-Parameter" |
| `rules.labels` | „Metadaten-Labels" |
| `rules.suggestLabels` | „Aus dieser Seite vorschlagen" |
| `rules.tplMissing` | „Template nicht in aktiver Library gefunden" |
| `lib.add` | „+ Hinzufügen" |
| `lib.active` | „Aktiv" |
| `lib.activate` | „Aktivieren" |
| `lib.missing` | „Fehlt auf Disk" |
| `lib.template` | „Template" |
| `lib.summary` | „Symbole: {s} · Footprints: {f} · 3D: {m}" |
| `set.host.online` | „● Host: online · v{v}" |
| `set.host.offline` | „● Host: offline" |
| `set.host.recheck` | „Neu prüfen" |
| `set.alwaysPanel` | „Override-Panel immer zeigen (deaktiviert Auto-Übernahme global)" |
| `set.overwrite` | „Standard-Überschreib-Policy" |
| `set.theme` | „Farbschema" |
| `picker.title.folder` | „Ordner wählen" |
| `picker.title.file` | „Datei wählen" |
| `picker.quickAccess` | „Schnellzugriff" |
| `picker.writable` | „✔ beschreibbar" |
| `picker.notWritable` | „✖ kein Schreibrecht hier" |
| `picker.willCreate` | „existiert nicht — wird angelegt" |
| `onboard.step1` | „① Native Host installieren" |
| `onboard.step2` | „② Erste Library anlegen" |

---

### 8. Was bleibt / was wird verbessert / was entfällt (Zusammenfassung)

KEEP: 3-Tab-Layout, Accordion-Regelzeilen, Library-Activate/Template-Switch/Asset-Badges, Picker-Grundgerüst (Breadcrumbs, Manual-Input, Pfeiltasten), Shared-Confirm-Overlay, Light/Dark.
VERBESSERN: Category→Rules (Pin/Package-Match, Source-Dropdowns, action, Label-Mapping), Picker (Quick-Access, back/fwd/up, Filter, fs_check-Validierung, volle A11y), Settings (Host-Status statt WS-URL, Overwrite-Policy-3-Wege, Always-Show-Panel), Empty-States, Onboarding-Banner, Asset-Badges mit Icons.
ENTFÄLLT: WS-„Backend"-Sektion + „Test"-Button (`popup.html:111-133`), WS-Status-Dot im Header (`popup.html:20-23`), separate 2 Overwrite-Switches (→ Policy), „system"-Theme.
VORAUSSETZUNG (nicht UI, aber blockierend): fs_roots/fs_list/fs_check als Native-Host-Verben (D-PICK-1).

Quellen (Picker-/A11y-Recherche): [W3C APG Breadcrumb](https://www.w3.org/WAI/ARIA/apg/patterns/breadcrumb/), [Accessible Breadcrumbs – Aditus](https://www.aditus.io/patterns/breadcrumbs/), [UX Patterns – Breadcrumb](https://uxpatterns.dev/patterns/navigation/breadcrumb).

---

## 7. Installation & Distribution

## 18. Installation & Distribution (V3 — Native Messaging)

> Ersetzt den V2-Stand (WebSocket-Server + `run_server.py` + „API base URL"). V3 hat **keinen Port, keinen Server, keine URL**: Chrome startet den Python-Host on-demand via Native Messaging und killt ihn beim Disconnect (ADR-0001). Dieser Abschnitt ist die finale, baubare End-User-Install-Spezifikation.

### 18.0 Architektur-Überblick (drei Artefakte)

```
┌──────────────────────────┐     installiert via      ┌───────────────────────────┐
│  Chrome Web Store          │ ───────────────────────► │  Extension (MV3)            │
│  Listing (signiert)        │   automatisches Update    │  feste Extension-ID         │
└──────────────────────────┘                           │  permission: nativeMessaging│
                                                        └─────────────┬─────────────┘
                                                                      │ connectNative(
                                                                      │  "com.kicad_parts_importer.host")
                                                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Per-User-Installer  (download von Web-Store-Detail-Seite / GitHub Releases)        │
│   1. legt self-contained Host-Binary ab  ……  <user-dir>/kicad-parts-importer-host.exe │
│   2. schreibt Native-Host-Manifest JSON (mit eingebrannter Web-Store-Extension-ID)   │
│   3. registriert Manifest am OS-Ort (HKCU-Registry / ~/Library / ~/.config)          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Drei Artefakte, drei Lieferwege:
1. **Extension** → Chrome Web Store (auto-update, von Google signiert).
2. **Host-Binary** → PyInstaller-`--onefile`-Exe, Entry-Point = `native_host/host.py` (NICHT `run_server.py`).
3. **Installer** → dünner per-User-Self-Register-Wrapper um (2), der das Manifest schreibt + registriert.

🟢 ENTSCHIEDEN: Host-Binary und Installer werden **als ein einziges Artefakt** ausgeliefert. Der Installer IST das Host-Binary mit zwei Modi: ohne stdin-Pipe (= vom User per Doppelklick gestartet) führt es Self-Register aus; mit aktiver Native-Messaging-Pipe (= von Chrome gestartet) läuft die Host-Loop. So gibt es nur **eine** Datei zum Download, kein separater Installer + Binary. Erkennung siehe §18.5.

---

### 18.1 Extension via Chrome Web Store — feste Extension-ID (kritisch)

Native Messaging verlangt, dass das Native-Host-Manifest die Extension explizit in `allowed_origins` listet (`chrome-extension://<ID>/`). Der Installer muss diese ID kennen, **bevor** der User die Extension das erste Mal lädt — er kann sie nicht zur Laufzeit erfragen.

**Problem heute:** `native_host/install.py` nimmt die ID per `--extension-id` CLI-Arg (Dev-Workflow: unpacked laden → ID ablesen → Installer aufrufen). Das generierte Manifest (`native_host/_generated/com.kicad_parts_importer.host.json:7`) trägt aktuell die **unpacked Dev-ID** `abajaljldgbmlgblpkhlhklmhckglmkj`. Für End-User ist das unzumutbar.

🟢 ENTSCHIEDEN: **Web-Store-Extension-ID wird in den Installer eingebrannt** (gebaked). Die ID ist nach erstem Web-Store-Upload stabil und ändert sich nie. `install.py` bekommt eine Konstante `WEBSTORE_EXTENSION_ID` als Default; `--extension-id` bleibt nur als Dev-Override erhalten.

🟢 ENTSCHIEDEN: Um **gleichzeitig** Web-Store-Build und unpacked-Dev zu unterstützen, listet das Manifest **mehrere** `allowed_origins` (Chrome erlaubt eine Liste): die feste Web-Store-ID **plus** optional eine per Umgebungsvariable/Arg gesetzte Dev-ID. So funktioniert dieselbe Host-Installation für beide Lade-Arten — kein Re-Install beim Wechsel.

Konkrete Änderung in `native_host/install.py` `build_manifest()` (heute Zeile 32–40):
```python
WEBSTORE_EXTENSION_ID = "ojkpgmndjlkghmaccanfophkcngdkpmi"  # final nach erstem Upload fixieren
def build_manifest(host_path, extension_ids: list[str]) -> dict:
    return {
        "name": HOST_NAME,
        "description": "KiCad Parts Importer native host",
        "path": str(host_path.resolve()),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{eid}/" for eid in extension_ids],
    }
```
🔴 BRAUCHT DICH: finale Web-Store-Extension-ID (V3-Listing). Die V2-Listing-ID im README (`ojkpgmndjlkghmaccanfophkcngdkpmi`) ist nur Platzhalter, falls das V3-Listing neu ist (Clean Break, ADR-0003 / Memory `project_v3_clean_break`). → siehe userOnlyQuestions `webstore-id`.

> Permissions im Extension-Manifest sind bereits korrekt: `chrome_extension/manifest.json:6-10` listet `nativeMessaging` + `alarms`. Beim Clean Break sollte die V2-Reliquie `host_permissions: http://localhost:8087/*` (`manifest.json:12`) **entfernt** werden — V3 hat keinen localhost-Server. 🟢 ENTSCHIEDEN: localhost-host_permission streichen.

---

### 18.2 Host-Binary — PyInstaller, Entry-Point-Fix (CI-Bug)

**Bug in der CI gefunden.** `.github/workflows/build-backend.yml` friert an drei Stellen den **falschen** Entry-Point ein:
- Zeile 84 (Linux): `pyinstaller --onefile --name "$APP_NAME" run_server.py`
- Zeile 89 (macOS): `… run_server.py`
- Zeile 95 (Windows): `… run_server.py`

`run_server.py` ist der **V2-Legacy-WebSocket-Server** (in V3 gedroppt, ADR-0001 „loses listening port and API base URL"). Ein daraus gebautes Binary spricht NICHT das Native-Messaging-stdin/stdout-Protokoll → Chrome's `connectNative` würde sofort disconnecten, der Onboarding-Button bliebe permanent `offline`. Das ist ein release-blockierender Fehler.

🟢 ENTSCHIEDEN: **Entry-Point auf `native_host/host.py` umstellen** in allen drei Build-Steps. Da `host.py` bereits `if __name__ == "__main__": sys.exit(main())` (`host.py:244-245`) hat und die Native-Messaging-Loop fährt, ist es direkt PyInstaller-tauglich.

🟢 ENTSCHIEDEN: **Artefakt-Name umbenennen** von „KiCad Parts Importer" zu `kicad-parts-importer-host` (klein, ohne Spaces). Begründung: (a) der Manifest-`path` und die HKCU-Registrierung vertragen Spaces zwar (sind gequotet), aber ein Space-freier Name vermeidet Shell-Quoting-Fallen im Self-Register-Pfad; (b) der Name beschreibt jetzt korrekt einen Host, keinen „App"-Server. Das Icon-Handling (`build_windows_ico.py`, `build_macos_icns.sh`) bleibt unverändert nutzbar.

Konkrete CI-Diffs (Build-Step Windows als Beispiel, analog Linux/macOS):
```yaml
# build-backend.yml:91-95 — VORHER:  run_server.py
- name: Build PyInstaller binary (Windows)
  run: pyinstaller --onefile --icon "build\pyinstaller\app.ico" `
       --name "kicad-parts-importer-host" native_host\host.py
```
🟢 ENTSCHIEDEN: PyInstaller braucht das `easyeda2kicad`-Package als Hidden-Import/Collect. `host.py` importiert `native_host.phase1/phase2/templates`, die wiederum `easyeda2kicad` ziehen. Da `--onefile` von der `host.py`-Quelle aus startet, muss der Build mit `pip install -e .` (Repo als editable Package) oder via `--paths .` + `--collect-submodules easyeda2kicad` laufen, damit der sys.path-Hack in `host.py:45-47` (der im Frozen-Modus ins Leere zeigt) nicht gebraucht wird. **Frozen-Erkennung ergänzen:** in `host.py` den `_REPO_ROOT`-sys.path-Insert mit `if not getattr(sys, "frozen", False):` gaten, damit der Hack nur im Dev-Modus greift.

> Acceptance: `kicad-parts-importer-host.exe` (ohne Argument, ohne stdin-Pipe) per Doppelklick → führt Self-Register aus (§18.5). Von Chrome gestartet → antwortet auf `{"verb":"ping"}` mit `{"ok":true,"version":...}`.

---

### 18.3 Die `.venv`-Python-Launcher-Lücke (heute kaputt für End-User)

`native_host/install.py` ist **kein** Produktions-Installer — es ist der Dev-Self-Register. Es schreibt ein `.bat`-Shim (`install.py:60-77`), das `sys.executable` (= die Python.exe, mit der `install.py` lief) einbrennt:
```
# native_host/_generated/host-launcher.bat (real, heute):
"D:\Projects\…\.venv\Scripts\python.exe" "D:\Projects\…\native_host\host.py"
```
Das funktioniert NUR auf der Entwickler-Maschine mit existierender `.venv`. Beim End-User gibt es weder die `.venv` noch `host.py` als Quelle. Das committete `kicad-host.bat` (`native_host/kicad-host.bat:11`, nutzt den `py`-Launcher) ist nur ein manuelles Smoke-Test-Fallback und setzt ebenfalls eine System-Python-Installation voraus.

🟢 ENTSCHIEDEN: **Im Produktions-Pfad gibt es keinen `.bat`-Shim und kein System-Python.** Der Manifest-`path` zeigt **direkt** auf das PyInstaller-Binary (`kicad-parts-importer-host.exe`), das seinen eigenen Python einbettet. Der ganze `write_runtime_bat`/`host_executable_path`-Mechanismus (`install.py:48-77`) entfällt für Frozen-Builds und bleibt nur im Dev-Modus aktiv.

🟢 ENTSCHIEDEN: `install.py` erkennt den Modus über `getattr(sys, "frozen", False)`:
- **Frozen (End-User):** `host_path = Path(sys.executable)` (das laufende Binary selbst). Kein `.bat`.
- **Dev (Repo):** wie heute — `.bat`-Shim mit `sys.executable` + `host.py`. (Beibehalten für `python native_host/install.py` aus der `.venv`.)

So verschwindet die „.venv-Python-Lücke" für End-User komplett, ohne den Dev-Flow zu brechen.

---

### 18.4 Per-User-Install, kein Admin (entschieden)

🟢 ENTSCHIEDEN: **Strikt per-User, kein Admin/sudo.** Begründung: Native-Messaging-Manifeste werden pro Browser-User-Profil aufgelöst; HKCU/`~`-Pfade brauchen keine erhöhten Rechte; das matcht den Single-User-localhost-Scope des Projekts und umgeht Corporate-UAC-Hürden. (Das deckt sich mit dem heutigen `install.py:103` → `winreg.HKEY_CURRENT_USER`.)

**Drop-Ort des Binarys** (per-User, beschreibbar ohne Admin):
| OS | Binary-Ablage | Begründung |
|---|---|---|
| Windows | `%LOCALAPPDATA%\KiCadPartsImporter\kicad-parts-importer-host.exe` | Standard per-User-App-Ort, kein Programme-Ordner-UAC |
| macOS | `~/Library/Application Support/KiCadPartsImporter/kicad-parts-importer-host` | per-User, von Gatekeeper akzeptiert |
| Linux | `~/.local/share/KiCadPartsImporter/kicad-parts-importer-host` | XDG-Standard |

🟢 ENTSCHIEDEN: Beim Self-Register **kopiert** sich das heruntergeladene Binary an diesen kanonischen Ort (statt den Download-Pfad — z.B. `~/Downloads` — ins Manifest zu schreiben). Vorteil: der User kann die heruntergeladene Datei löschen, der Host bleibt funktionsfähig; und Updates überschreiben einen stabilen Pfad.

---

### 18.5 Self-Register-Flow (Doppelklick-Onboarding)

Single-File-Binary, Zwei-Modi-Erkennung:

```python
# pseudo, in native_host/host.py main() oder einem __main__-Dispatcher:
import sys
def is_chrome_invoked() -> bool:
    # Chrome startet mit Native-Messaging-Args + verbundener stdin-Pipe.
    # Heuristik: ein arg, das mit "chrome-extension://" beginnt ODER eine
    # nicht-tty stdin-Pipe. Robusteste Variante: Chrome übergibt als argv[1]
    # den Manifest-Origin (chrome-extension://<id>/) bzw. unter Win den
    # Manifest-Pfad + --parent-window. Prüfe auf diese Marker.
    return any(a.startswith("chrome-extension://") for a in sys.argv[1:]) \
        or "--parent-window" in " ".join(sys.argv)

if is_chrome_invoked():
    run_native_messaging_loop()   # host.py main()
else:
    run_self_register_gui_or_cli()  # install + freundliche Erfolgsmeldung
```
🟢 ENTSCHIEDEN: Erkennung über die **von Chrome übergebenen argv-Marker** (`chrome-extension://…` als Origin-Arg, unter Windows zusätzlich `--parent-window=<HWND>`). Das ist deterministischer als eine stdin-tty-Prüfung (die in manchen Shell-Kontexten trügt).

**Self-Register-Modus (User-Doppelklick) tut:**
1. Kopiert sich nach `%LOCALAPPDATA%\KiCadPartsImporter\…` (§18.4), falls nicht schon dort.
2. Schreibt das Native-Host-Manifest JSON (mit eingebrannter Web-Store-ID, §18.1) an den OS-Ort (§18.7).
3. Registriert es (Windows: HKCU-Registry-Wert; macOS/Linux: Manifest IST die Datei am Lookup-Ort, kein extra Registry-Schritt).
4. Zeigt eine **Erfolgsmeldung** und beendet sich. Idempotent: Re-Run = No-Op bei gleichem Inhalt (heute schon so, `install.py:74,84,98`).

🟢 ENTSCHIEDEN: Erfolgsmeldung als **minimale native Dialogbox** (Windows: `ctypes.windll.user32.MessageBoxW`; macOS: `osascript -e 'display dialog'`; Linux: stdout-Text + Exit, da Desktop-Dialog-Tooling variiert). Kein GUI-Framework-Dependency (kein tkinter/Qt) — hält das Binary klein und PyInstaller simpel. Text: „KiCad Parts Importer Host installiert. Lade jetzt eine LCSC-Produktseite neu."

---

### 18.6 Onboarding: „Host nicht installiert" → Download-Helper-Banner

**Heutiger Stand (Code-grounded):** Der tri-state Pre-Warm-Button existiert (`chrome_extension/src/content/nativeHostStatusButton.js`). Im `offline`-State (`nativeHostStatusButton.js:44-50`) ist der Download-Button disabled mit Tooltip „Native host is offline — run the installer." Der SW-Pfad (`background.js:1624-1662` `pingNativeHostOnce`, `1685-1703` `prewarmNativeHostInternal`) liefert bei fehlendem Host den Chrome-Fehler *„Specified native messaging host not found."* (vgl. Test `nativeHostStatusButton.test.js:67`).

**Lücke:** Der `offline`-State sagt „run the installer", **verlinkt aber nichts.** Ein Erst-User weiß nicht, WO der Installer ist.

🟢 ENTSCHIEDEN: **Onboarding-Banner mit Download-Link** ergänzen. Wenn der SW unterscheiden kann zwischen „Host nicht installiert" (Fehlertext enthält *„not found"* / *„Specified native messaging host not found"* / *„not registered"*) und „Host installiert aber gerade nicht erreichbar" (Timeout/Disconnect), wird ein **erste-Schritte-Banner** auf der LCSC-Seite gerendert statt nur des disabled Buttons.

Banner-Wireframe (auf LCSC-Produktseite, oberhalb der Anchor-Card injiziert):
```
┌────────────────────────────────────────────────────────────────────────┐
│  ⚙  KiCad Parts Importer — einmalige Einrichtung nötig                    │
│                                                                          │
│  Der lokale Host wurde nicht gefunden. Lade ihn einmalig herunter und    │
│  starte ihn per Doppelklick:                                             │
│                                                                          │
│     [  ⬇  Host herunterladen (Windows)  ]   [ andere Systeme ▾ ]          │
│                                                                          │
│  Nach dem Start: diese Seite neu laden. Du musst nichts manuell          │
│  starten — Chrome ruft den Host künftig automatisch auf.                 │
│                                                  [ Anleitung ]  [ ✕ ]      │
└────────────────────────────────────────────────────────────────────────┘
```
🟢 ENTSCHIEDEN: Der Download-Link zeigt auf die **GitHub-Releases-Asset-URL** des passenden OS-Binarys (OS-Erkennung über `navigator.userAgentData.platform` / `navigator.platform`). Begründung: Web-Store erlaubt kein direktes Binary-Hosting; GitHub Releases ist die bestehende Distribution (CI-Release-Job, `build-backend.yml:153-169`). Die „andere Systeme ▾"-Klappliste listet alle drei Assets.

🟢 ENTSCHIEDEN: **Unterscheidung not-installed vs. offline** im SW: `pingNativeHostOnce` (`background.js:1643-1655`) bekommt eine Fehler-Klassifizierung. Bei `lastError.message` ~ /not found|not registered|forbidden/ → `state:"not-installed"` (Banner). Sonst (timeout, disconnect) → `state:"offline"` (Button disabled, Tooltip „Host gerade nicht erreichbar — Host-Programm gestartet?"). Das erweitert das heutige 3-State-Modell (`nativeHostStatusButton.js:27`) um einen 4. State `not-installed`. **Forbidden** (Manifest existiert, aber Extension-ID nicht in `allowed_origins`) ist ein eigener Diagnosefall → eigener Hinweis „Host-Manifest passt nicht zu dieser Extension — Host neu installieren."

---

### 18.7 Cross-OS Native-Host-Manifest-Lokationen

**Heutiger Stand:** `install.py` registriert NUR Windows-Chrome (`install.py:28-29,90-105`, `REGISTRY_KEY_PATH = Software\Google\Chrome\NativeMessagingHosts\…`). macOS/Linux fehlen komplett (`install.py:118` gated auf `win32`).

🟢 ENTSCHIEDEN: Cross-OS-Manifest-Schreiben implementieren. Pro-OS- und pro-Browser-Tabelle:

| OS | Browser | Manifest-Ort |
|---|---|---|
| Windows | Chrome | HKCU `Software\Google\Chrome\NativeMessagingHosts\com.kicad_parts_importer.host` (REG_SZ = Pfad zur JSON) |
| Windows | Edge | HKCU `Software\Microsoft\Edge\NativeMessagingHosts\com.kicad_parts_importer.host` |
| Windows | Brave | nutzt Chrome-Key (Brave liest den Google-Chrome-HKCU-Key) — **kein separater Eintrag nötig** |
| macOS | Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kicad_parts_importer.host.json` |
| macOS | Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/…json` |
| macOS | Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/…json` |
| Linux | Chrome | `~/.config/google-chrome/NativeMessagingHosts/com.kicad_parts_importer.host.json` |
| Linux | Edge | `~/.config/microsoft-edge/NativeMessagingHosts/…json` |
| Linux | Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/…json` |

Auf macOS/Linux IST das Manifest die Datei am Lookup-Ort (keine Registry). Auf Windows liegt die JSON irgendwo (kanonischer Binary-Ordner, §18.4) und der Registry-Wert zeigt darauf — wie heute (`install.py:94,104`).

🟢 ENTSCHIEDEN: Der Self-Register schreibt das Manifest **für alle installierten unterstützten Browser**, die er erkennt (Verzeichnis/Registry-Hive existiert). Begründung: ein Doppelklick deckt Chrome+Edge+Brave ab, ohne dass der User wählen muss. Manifest-`name`-Konstante bleibt `com.kicad_parts_importer.host` (heute `install.py:28`).

> Welche Browser tatsächlich unterstützt/getestet werden, ist eine Scope/Budget-Frage → 🔴 BRAUCHT DICH (userOnlyQuestions `browsers`). Die Manifest-Schreib-Logik ist billig (gleiche JSON, andere Pfade); der Test-/Support-Aufwand ist die eigentliche Kosten.

---

### 18.8 Code-Signing & OS-Trust (Budget-Entscheidung)

**Heutiger Stand (README `Troubleshooting: Windows blocks the backend`, README.md:115-140):** Binaries sind **nicht** signiert. Windows zeigt SmartScreen „Windows protected your PC", Smart App Control kann unsignierte Apps blocken, Corporate WDAC/AppLocker blockt hart. macOS Gatekeeper quarantänet (`xattr -dr com.apple.quarantine`, README.md:110).

**Recherche-Fakten (2026):**
- Windows OV-Zertifikat ~$200–300/Jahr, EV ~$300–500/Jahr. **Seit März 2024 gibt EV KEINEN sofortigen SmartScreen-Bypass mehr** — sowohl OV als auch EV bauen SmartScreen-Reputation erst über Download-Volumen/Zeit auf. Ab Feb 2026 max. Zertifikatslaufzeit ~459 Tage (kein Mehrjahres-Kauf mehr).
- macOS: Apple Developer Program **$99/Jahr**; **Notarization selbst ist kostenlos** (notarytool), braucht aber ein „Developer ID Application"-Zertifikat (im $99-Programm enthalten). Ohne Notarization: Gatekeeper-Quarantäne-Friktion bleibt.

**Konsequenz für das Native-Messaging-Binary speziell:** Das Host-Binary wird von Chrome als **Subprozess** gestartet, nicht vom User direkt ausgeführt. SmartScreen/Gatekeeper greifen primär beim **ersten manuellen Doppelklick** (= unser Self-Register-Schritt, §18.5). D.h. genau **einmal** sieht der User die OS-Warnung; danach läuft der Host warnungsfrei als Chrome-Kind. Das senkt die Dringlichkeit von Signing — die Friktion ist auf einen einzigen Onboarding-Moment begrenzt.

🟢 ENTSCHIEDEN (Default, falls kein Budget): **Unsigniert ausliefern** + die bestehende README-„Unblock/More-info→Run-anyway"-Anleitung (README.md:130-138) ins Onboarding-Banner spiegeln. Das ist für Open-Source-AGPL-Tools üblich und ausreichend, weil die Warnung nur einmal beim Self-Register erscheint.

Die Geld-Frage selbst eskaliere ich:
🔴 BRAUCHT DICH: Code-Signing-Budget. Optionen — siehe userOnlyQuestions `signing-budget`.

---

### 18.9 Update-Pfad

🟢 ENTSCHIEDEN: **Host-Update = Binary überschreiben.** Der User lädt eine neue Host-Version von GitHub Releases, Doppelklick → Self-Register kopiert über den kanonischen Pfad (§18.4), Manifest bleibt gleich (gleicher `name`, gleiche `allowed_origins`). Kein laufender Prozess muss gestoppt werden, weil Chrome den Host pro Call frisch startet/killt (ADR-0001) — beim nächsten `connectNative` läuft die neue Version. Versions-Sichtbarkeit über `HOST_VERSION` (`host.py:53`), die der Pre-Warm-Ping zurückgibt und der Button-Tooltip zeigt (`nativeHostStatusButton.js:92-93`).

🟢 ENTSCHIEDEN: **Kein Auto-Update** des Hosts in V1. Begründung: Auto-Update unsignierter Binaries ist ein Sicherheits-Antipattern; und die Extension (auto-updated via Web Store) kann bei Host-Version-Mismatch ein „Host-Update verfügbar"-Banner zeigen (Versions-Vergleich Extension-bekannte-Min-Version vs. Ping-`version`). Signiertes Auto-Update ist eine spätere Iteration (abhängig von der Signing-Entscheidung §18.8).

---

### 18.10 Acceptance Criteria

- [ ] **CI baut den richtigen Entry-Point:** `build-backend.yml` friert `native_host/host.py` (nicht `run_server.py`). Das resultierende `kicad-parts-importer-host(.exe)` antwortet von Chrome aus auf `{"verb":"ping"}` mit `{"ok":true}`.
- [ ] **Frische Windows-Maschine (kein Python, keine .venv):** Binary von Releases laden → Doppelklick → Erfolgsdialog → LCSC-Seite neu laden → Anchor-Card-Button `online`, Klick konvertiert. Kein System-Python nötig.
- [ ] **Per-User, kein Admin:** gesamter Flow ohne UAC-Elevation.
- [ ] **Re-Run idempotent:** zweiter Doppelklick = No-Op (kein Crash, kein Dupe-Registry-Eintrag).
- [ ] **not-installed vs. offline:** ohne Host → Onboarding-Banner mit OS-korrektem Download-Link; Host installiert aber Binary umbenannt/gelöscht → `offline`-Tooltip (nicht Banner).
- [ ] **Cross-OS (sofern im Scope):** macOS Doppelklick schreibt `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/…json`; Linux `~/.config/google-chrome/NativeMessagingHosts/…json`.
- [ ] **Multi-Browser (sofern im Scope):** ein Self-Register registriert Chrome + Edge (+ Brave via Chrome-Key) — alle drei können `connectNative`.
- [ ] **Extension-ID-Pinning:** Web-Store-Build kann ohne `--extension-id`-Arg installieren (eingebrannte ID); unpacked-Dev funktioniert weiter via Dev-Override.

---

### 18.11 Konkrete Datei-Änderungsliste (für den Coding-Agent)

| Datei | Änderung |
|---|---|
| `.github/workflows/build-backend.yml:84,89,95` | Entry-Point `run_server.py` → `native_host/host.py`; `--name` → `kicad-parts-importer-host`; `easyeda2kicad` collecten (`--collect-submodules` oder `pip install -e .`) |
| `native_host/host.py:45-47` | sys.path-Hack mit `if not getattr(sys,"frozen",False):` gaten |
| `native_host/host.py` (`main`/`__main__`) | Zwei-Modi-Dispatcher: Chrome-Invoked → Loop; sonst → Self-Register |
| `native_host/install.py:32-40` | `build_manifest` nimmt `extension_ids: list`; `WEBSTORE_EXTENSION_ID`-Konstante |
| `native_host/install.py:48-77` | `.bat`-Shim nur im Dev-Modus; Frozen → `host_path = sys.executable` |
| `native_host/install.py:28-29,90-119` | Cross-OS + Multi-Browser-Registrierung (Tabelle §18.7); kanonischer Binary-Copy-Ort (§18.4) |
| `chrome_extension/background.js:1643-1655` | Fehler-Klassifizierung not-installed / forbidden / offline |
| `chrome_extension/src/content/nativeHostStatusButton.js:27,44-50` | 4. State `not-installed`; Banner-Trigger statt nur disabled Button |
| `chrome_extension/manifest.json:12` | V2-`http://localhost:8087/*`-host_permission entfernen |
| neu: `chrome_extension/src/content/onboardingBanner.js` | Download-Helper-Banner (Wireframe §18.6) |
| `docs/KONZEPT.md:1273-1338` | §18 ersetzen (gRPC/Variante-2/Token-Reste raus, ADR-0001 ist final) |
| `README.md:106-148` | „Install the backend"-Sektion auf Native-Messaging-Doppelklick-Flow umschreiben |

---

## 8. 🟢 Entscheidungs-Index (Agent — zum Drüberschauen)

### Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform

- 🟢 **AD-1** — Category Rules werden NICHT als separates chrome.storage.local.rules-Array gebaut (wie KONZEPT §12.2 skizziert), sondern das existierende categorySettings[categoryPath] wird zum vollwertigen ComponentRule erweitert (Superset von {hidePinNumbers,hidePinNames,valueParam}).  
  _Warum:_ Es existiert bereits vollständige CRUD-UI (popup.js Categories-Tab), Persistenz, Dedup (dedupeCategorySettings), Python-Mirror und ein korrekter Deepest-Prefix-Matcher (background.js:50 resolveCategorySettings) — alle keyed auf den normalisierten Category Path. Ein zweites Modell erzwingt Migration, doppelten Matcher und Drift-Risiko. Das KONZEPT-Rule-Shape wird als Teilmenge eingebettet.
- 🟢 **AD-2** — Der Deepest-Prefix-Matcher resolveCategorySettings (background.js:50) bleibt unverändert als Kern; matchComponentRule baut darauf auf und ergänzt nur Pin-Count-, Package-Form-Guards und Layer-Suggestion-Ranking.  
  _Warum:_ Der Matcher ist bereits korrekt (longest key mit Slash-Boundary) und getestet. Wiederverwendung statt Neuschrieb minimiert Risiko und hält JS-Verhalten konsistent mit dem Python-Mirror.
- 🟢 **AD-3** — Package-Form-Detection ist ein eigenes Modul packageForm.mjs + Python-Mirror package_form.py mit gepaartem Drift-Test (wie categoryPath). Imperial (0603) ist die kanonische Form; Metric (1608) wird als Alias mitgeführt.  
  _Warum:_ KiCad-Standard-Libraries und LCSC-DOM nutzen überwiegend Imperial. Eine Kanon-Form vermeidet Doppel-Rules; Metric-Alias erlaubt trotzdem Match gegen Metric-only-Footprint-Namen. Taxonomie als versionierte JSON-Datei, damit neue Packages ohne Code-Release ergänzbar sind.
- 🟢 **AD-4** — Auto-Template-Match (Namens-/Pin-Count-Heuristik ohne explizite Rule) liefert NUR Panel-Vorschläge, löst niemals den Skip-Panel-Flow aus. Skip-Panel nur bei explizit vom User gesetzter Rule mit autoApply=auto.  
  _Warum:_ Frei benannte User-Templates machen Namens-Heuristik fehleranfällig. Stilles Auto-Apply falscher Footprints in die Library ist gefährlich; Vorschläge mit Confidence-Badge sind sicher und trotzdem komfortabel.
- 🟢 **AD-5** — LabelMapping ist per-Rule-Überlagerung über die globale LCSC_PARAMS_MAP (background.js:8); Rule gewinnt punktuell. Default (kein LabelMapping) = heutiges Verhalten (valueParam->Value, mapParamKey-Rest als Properties via template_merger._build_value_map).  
  _Warum:_ Globale Tabelle deckt 90% ab (Power/Tolerance/Voltage/MPN); per-Rule-Overrides lösen Sonderfälle deklarativ ohne Code-Edit. Bestehender, funktionierender Metadaten-Merge bleibt unangetastet als Fallback.
- 🟢 **AD-6** — Phase-1-Response wird additiv erweitert um package/packageForm, manufacturer, mpn, easyedaHas{symbol,footprint,model} und existsInActiveLib — alle aus dem CAD-Fetch, den Phase 1 ohnehin macht (phase1.py:127), plus dem DOM-Package-Hint.  
  _Warum:_ Der Matcher braucht diese Signale (Package-Form-Guard, Perfect-Workflow, Overwrite-Vorschau, 3D-Reuse) ohne zweiten Netzwerk-Roundtrip. Additiv = keine Breaking Changes am bestehenden Phase-1-Vertrag.
- 🟢 **AD-7** — Perfect-Workflow: wenn easyedaHas[layer]==false, ist Template fuer diesen Layer Pflicht (EasyEDA-Fallback unmoeglich). Fehlt ein Match, zeigt das Panel ein rot umrandetes Pflicht-Dropdown; Confirm bleibt disabled bis Auswahl != none. Beide Layer aus Template + FP mit (model) => Template-Assembly-Pipeline ohne EasyEDA-Call.  
  _Warum:_ Erfuellt User-Vision 5 (LCSC kennt Teil, EasyEDA hat nichts -> manuell zusammenklicken; perfekt = automatisch). Nutzt die bestehende Template-Assembly-Pipeline (KONZEPT §9.2) und 3D-Carry-Over (§11) ohne neue Mechanik.
- 🟢 **AD-8** — 3D bleibt nicht user-waehlbar (kein Dropdown) und folgt deterministisch dem Footprint (ADR-0005, KONZEPT §11.3). 3D-Auto-Assoziation = (model ...)-Ref des gewaehlten Template-Footprints; zusaetzlich Reuse-Hinweis wenn Active Library bereits Footprint+3D mit gleichem Package-Form-Namen hat.  
  _Warum:_ Multi-Layer-3D-Override-UI wuerde die KISS-Heuristik brechen; die 6 3D-Pfade sind klar definiert. Reuse vorhandener sauberer Footprints vermeidet Duplikate und nutzt existierende Library-Counts (LibraryValidateResponse).
- 🟢 **AD-9** — Stock-Library wird als normale Template-Library ausgeliefert (StdLib.kicad_sym + .pretty/ + .3dshapes/), vom Installer geschrieben und beim ersten Start automatisch als isTemplateLibrary registriert. Footprints referenzieren primaer ${KICAD9_3DMODEL_DIR} statt eigene STEP-Files.  
  _Warum:_ Override Panel, ListTemplates, Always-Re-Resolve und 3D-Carry-Over funktionieren dann unveraendert mit der Stock-Lib; kein neuer Storage-Mechanismus. System-3D-Variable spart Auslieferungsgroesse und nutzt hochwertige KiCad-Standardmodelle (KONZEPT §11.1 Fall 3).
- 🟢 **AD-10** — Mitgelieferte Stock-Rules werden initial mit autoApply=suggest geseedet, nie mit auto. Ein Categories-Tab-Button bietet das Seeding optional an (kein Zwang).  
  _Warum:_ User soll erste Imports sehen und bestaetigen; erst nach Vertrauen schaltet er einzelne Kategorien auf auto (One-Click). Matcht das KONZEPT-Zielbild progressiver Automatisierung ohne stille Ueberraschungen am Tag 1.

### Template-System + Metadaten-als-Labels

- 🟢 **td-1** — Symbol-Template-Merge (template_merger.py), Pin-Reconciliation und Symbol-Pin-Remap (symbol_pin_remap.py) werden eingefroren 1:1 aus V2 übernommen — keine Re-Architektur.  
  _Warum:_ Der Code ist KiCad-konform (Pin-number==Pad-name-Regel), behandelt Edge-Cases (disjunkte Pin-Labels bei gleicher Anzahl, Multi-Unit-Symbole, Hidden-Props) und ist die einzige getestete Implementierung. S1-Hybrid-Strategie behält bewährte Engine.
- 🟢 **td-2** — Footprint-Pads bleiben IMMER EasyEDA-benannt; nur Symbol-(number …) wird per PAD-Map umgeschrieben. footprint_pad_remap.apply_template_pin_map_to_footprint bleibt test-only und wird NICHT in den Import-Pfad verdrahtet.  
  _Warum:_ KiCad verbindet Schematic↔PCB ausschließlich über pin-number==pad-name; das Umschreiben nur einer Seite (Symbol) hält die Footprint-Datei stabil/wiederverwendbar und vermeidet Offset-Korruption. Modul-Docstring footprint_pad_remap.py:1-14 dokumentiert das bereits als bewusste Entscheidung.
- 🟢 **td-3** — Always-Re-Resolve gilt als verbindliche Policy und ist bereits korrekt: Template-File wird in _export_symbol_from_template (conversion.py:306) und im Listing bei jedem Aufruf frisch von Disk via extract_symbol_from_lib gelesen. In V3 nur per Mock-FS-Test absichern, kein Code-Change.  
  _Warum:_ Kein Caching-Layer vorhanden (phase2.py:33-36 bestätigt); deckt sich mit KONZEPT §4/§8.4/§10.5. User editiert Templates in KiCad und erwartet sofortige Wirkung beim nächsten Import.
- 🟢 **td-4** — Reference-Prefix kommt aus dem Template (z.B. R/C/L/D), NICHT aus EasyEDAs prefix (oft U). value_param_key wird nur gesetzt, wenn Template ein gleichnamiges Feld hat, und ist aus symbol_params ausgeschlossen (kein Value-Duplikat).  
  _Warum:_ Bereits so implementiert (template_merger.py:230-237, 252-258) und produktentscheidend korrekt: Schematic-Annotation soll der Template-Library folgen, und der Value soll nicht doppelt als Property erscheinen.
- 🟢 **td-5** — Bug in chrome_extension/background.js:39 (\ statt // Kommentar in normalizeSymbolValue) wird in V3 gefixt.  
  _Warum:_ Backslash am Zeilenanfang ist in JS kein gültiger Kommentar; der Ohm-Strip-Pfad (50kΩ→50k) ist load-bearing für das Resistor-Value-Beispiel. Klarer Fehler, agent-fixbar.
- 🟢 **td-6** — Footprint-Template-Override + Pin-Map-Sidecar werden als V3-Neubau spezifiziert: neues Modul native_host/pin_map.py (atomic temp+rename), phase2.py-Gate öffnen, Template-Assembly-Pipeline (KONZEPT §9.2) ohne EasyEDA-Call. Sidecar-mapping wird in das bestehende template_pin_map-Format (Symbol-Pin→Pad) übersetzt.  
  _Warum:_ phase2.py:139-144 lehnt Footprint-Templates aktuell explizit ab und nennt die exakten Blocker (#9 Pin-Map, #6 3D). Das Sidecar-Format und der Resolver sind in KONZEPT §13 bereits durchspezifiziert; templates.py listet Footprints schon — nur Assembly/Write fehlt.

### 3D-Layer

- 🟢 **F-DEC-1** — 3D bleibt implizite Schicht ohne eigenes UI; kein 3D-Dropdown im Override Panel — Steuerung ausschließlich über die Footprint-Wahl.  
  _Warum:_ ADR-0005 §a-c und KONZEPT §11.3 verlangen das; ein 3D-Override würde die KISS-Heuristik durchbrechen und Geometrie-Misalignment ermöglichen.
- 🟢 **F-DEC-2** — Genau eine effektive (model ...)-Form pro Resultat-Footprint; bei Multi-Ref-Templates wird jede Ref einzeln nach F.2-Klassifikation behandelt, Anzahl/Reihenfolge bleiben erhalten; Anhängen (Fall 4/5) nur bei null vorhandenen Refs.  
  _Warum:_ Bewahrt hand-kuratierte Template-Footprints unverändert und macht den deterministischen Pfad eindeutig.
- 🟢 **F-DEC-3** — Association-Reuse (Fall 4) wird VOR dem EasyEDA-Fallback (Fall 5) ausgewertet.  
  _Warum:_ Offline-Reuse eines bereits in der Active-Lib vorhandenen 3D ist schneller und erfüllt den User-Wunsch 'library has matching footprint/3D' ohne unnötigen EasyEDA-Roundtrip.
- 🟢 **F-DEC-4** — Neues Modul easyeda2kicad/kicad/template_3d_carryover.py im gefrorenen Engine-Paket; phase2.py orchestriert nur.  
  _Warum:_ Hält die gesamte Template-Mechanik (merger, pad_remap, carryover) beieinander; Transport-Layer bleibt dünn (S1-Hybrid-Strategie).
- 🟢 **F-DEC-5** — Surgical Regex-Replace des Pfad-Tokens in (model ...) statt Full-S-Expression-Roundtrip-Parser.  
  _Warum:_ KONZEPT §11.2.2 schlug S-Expr-Parser vor; ein Roundtrip-Parser riskiert Whitespace/Kommentar/Format-Drift in hand-kuratierten Footprints. Nur das erste Pfad-Token wird ersetzt, Rest byte-erhaltend.
- 🟢 **F-DEC-6** — ${KIPRJMOD} und alle ${[A-Z][A-Z0-9_]*}-Variablen zählen als Variable-Form → verbatim, kein Copy.  
  _Warum:_ Ein Template-FP mit ${KIPRJMOD}/... ist bewusst projekt-relativ; KONZEPT §11.2.2 listete KIPRJMOD nicht explizit, hier geschlossen.
- 🟢 **F-DEC-7** — Carry-Over-klassifizierte Ref mit fehlendem Source-File auf Disk → Ref verbatim + Warn-Message, KEIN Abbruch.  
  _Warum:_ Ein fehlendes 3D darf den Symbol/Footprint-Import nicht killen; gleiche Toleranz wie der Remove-Case (Fall 7).
- 🟢 **F-DEC-8** — Dedup-Key = Basename + SHA-256-Content-Hash; gleicher Inhalt+Name = idempotenter Skip, gleicher Name+anderer Inhalt = Collision; Cross-Name-Dedup wird NICHT gemacht.  
  _Warum:_ KiCad-Refs sind namensbasiert; Cross-Name-Dedup würde Refs brechen. Entspricht KONZEPT §11.2.2 Hash-Logik.
- 🟢 **F-DEC-9** — Rewrite-Ziel ist immer ${KIPRJMOD}/<ActiveLibName>.3dshapes/<basename> (projekt-relativ).  
  _Warum:_ Konsistent mit EasyEDA-Pipeline-Default und ADR-0005; setzt die V3-Annahme Single Active Library im aktiven KiCad-Projekt voraus.
- 🟢 **F-DEC-10** — Footprint↔3D-Association über Footprint-Basename als Schlüssel (KiCad-native (model ...)-Verknüpfung bzw. Namensgleichheit), kein semantisches Geometrie-Matching.  
  _Warum:_ Deterministisch und robust; Geometrie-Matching wäre fragil und ohne Mehrwert für den deterministischen Pfad.
- 🟢 **F-DEC-11** — Association-Reuse greift nur im Template-FP-ohne-eigene-Ref-Pfad (Fall 4); bei eigener Template-Ref hat Carry-Over Vorrang, bei EasyEDA-FP gehört EasyEDA-3D dazu.  
  _Warum:_ Explizite Template-Intention bzw. EasyEDA-FP/3D-Kohärenz schlägt opportunistischen Reuse (vermeidet ADR-0005-Misalignment-Caveat).
- 🟢 **F-DEC-12** — Bestehendes 'Footprint existiert + overwrite=False'-Verhalten (conversion.py:596-600) gilt als Association-Reuse: existierender FP samt 3D-Ref bleibt, 3D wird nicht neu geschrieben.  
  _Warum:_ Bereits korrektes idempotentes Verhalten; F.3 ergänzt nur den neu-schreibenden Fall.
- 🟢 **F-DEC-13** — Kein resolvebarer Footprint (kein Template, EasyEDA ohne FP) → kein 3D, Symbol-only-Import, kein Fehler; die 'what now?'-Multi-Dialog-Entscheidung ist UI-Sache des Override-Panel-Areas.  
  _Warum:_ 3D folgt dem Footprint; ohne Footprint kein Anker. Trennt 3D-Layer-Verantwortung sauber vom UI.
- 🟢 **F-DEC-14** — Remove-Case (Fall 7) ist First-Class-Erfolgspfad: FP ohne (model ...) geschrieben, Import erfolgreich.  
  _Warum:_ KiCad öffnet model-lose Footprints normal; kein Grund für Degraded-Mode oder Fehler. Test F-AC-8.
- 🟢 **F-DEC-15** — Carry-Over schreibt seinen Ref-String direkt in den Template-FP-Text; der bestehende KI_MODEL_3D-Emit (export_kicad_footprint.py:964-987) bleibt nur für die EasyEDA-Pipeline (Fall 6); zusätzlich defensives file_3d-Default gegen den UnboundLocal-Gap (Zeilen 967-978).  
  _Warum:_ Trennt EasyEDA- von Template-Pfad sauber; schließt einen latenten UnboundLocalError als kleinen Backport-würdigen Fix.

### Transport & RPC-Vertrag (Native Messaging)

- 🟢 **D1** — Persistenten, warmen Native-Messaging-Port wiederverwenden statt spawn-per-RPC (ein Singleton hostPort im SW + pending Map<id,handler>, lazy reconnect bei onDisconnect, Keep-Alive-ping auf demselben Port).  
  _Warum:_ Heute öffnet JEDER RPC (ping/fetchMetadata/convert/listTemplates) einen frischen connectNative-Port (background.js:843,1626,1748,1832), was pro Aufruf einen neuen PyInstaller-Python-Prozess spawnt (~0.3-1.5s Kaltstart). Ein warmer Port hält den Prozess über die Sitzung und nimmt den Kaltstart aus dem kritischen Phase-1/2-Pfad — der explizit benannte Hauptspeed-Hebel.
- 🟢 **D2** — Strukturiertes Fehlerobjekt error:{code,message} statt error:"freitext-string".  
  _Warum:_ Host liefert heute reinen String (host.py:154,159,208), SW liest msg.error als String. Content-Script-Entscheidungsdialoge ('kein Footprint → was nun?', 'kein Symbol → was nun?') brauchen einen maschinenlesbaren code zum deterministischen Verzweigen statt Strings zu parsen. Abwärtskompatibler SW-Shim normalisiert alten String zu {code:'unknown',message}.
- 🟢 **D3** — id wird zum Pflicht-Korrelationsschlüssel (monotoner seq-Zähler statt Date.now()).  
  _Warum:_ Auf einem warmen Multiplex-Port (D1) müssen Antworten und Progress-Frames per msg.id ihrem Aufrufer zugeordnet werden. Date.now() kann bei zwei Frames in derselben Millisekunde kollidieren; ++seq ist eindeutig.
- 🟢 **D4** — Streaming-Progress über chrome.tabs.sendMessage-Broadcast (type:v3ConvertProgress, gefiltert nach lcscId) beibehalten; KEIN dedizierter runtime.connect-Port für Content↔SW.  
  _Warum:_ Single-Flight (ADR-0004) garantiert ≤1 laufenden convert; ein Multiplex-Port brächte keinen Vorteil. Broadcast ist bereits implementiert/getestet (phase2Convert.js). Content-Scripts empfangen kein runtime.sendMessage vom SW, daher tabs.sendMessage. Langlebiger connect-Port aus MV3-Content-Script hält SW künstlich am Leben.
- 🟢 **D5** — Legacy-WS-Verbs fs_roots/fs_list/fs_check, lcsc_footprint_preview, templates_* werden nach Native Messaging portiert und dabei von snake_case auf camelCase umbenannt (fsRoots/fsList/fsCheck/renderFootprintSvg/listTemplates).  
  _Warum:_ ADR-0003 Clean Break entfernt den WS-Server vollständig; alle noch WS-gebundenen Hop-A-Handler müssen auf Native-Verbs umziehen. Einheitliche camelCase-Wire-Sprache (V3-Verbs sind bereits camelCase: fetchMetadata, listTemplates). Implementierungen aus server.py:719-826 bleiben funktional unverändert, nur ohne FastAPI/HTTPException.
- 🟢 **D6** — read-only Verbs (listTemplates, fsList, renderFootprintSvg, pinMapRead) laufen AUSSERHALB des Busy-Locks; nur fetchMetadata + convert teilen sich den Single-Flight-Lock.  
  _Warum:_ Das Override-Panel füllt Dropdowns/Previews parallel; diese nebenwirkungsfreien Disk-/Render-Reads dürfen eine laufende Operation nicht blockieren bzw. nicht selbst busy werden. Entspricht host.py heute (listTemplates ist nicht im Guard, host.py:203).
- 🟢 **D7** — Pin↔Pad-Sidecar als JSON neben der .kicad_sym (<lib>.pinmap.json), Map {symbolName:{pinNumber:padName}}, atomar via temp+rename geschrieben.  
  _Warum:_ Menschenlesbar, versionierbar, keine Mutation der KiCad-Datei, einfaches atomares Schreiben. Schlüssel/Werte als Strings (Pin-Nummern können Buchstaben enthalten, vgl. template_pin_map models.py:62).
- 🟢 **D8** — Datasheet-Download bleibt primär im Service Worker (fetchDatasheetBlob, background.js:2323); ein optionaler Host-Verb fetchDatasheet ist nur Fallback.  
  _Warum:_ Nur der SW kann LCSC-Cookies (credentials:include) senden, HTML-Shells nach der echten .pdf-URL durchsuchen und Progress streamen; der Host kann das nicht und unterliegt dem 1-MB-NM-Frame-Limit (vs. 24 MB im SW). Host-Verb nur wenn host_permissions fehlen.
- 🟢 **D9** — Alle result-Payloads sind Objekte; fsRoots gibt {roots:[…]} statt nacktem Array zurück; ping bleibt als einzige Ausnahme flach ({id,ok,version}).  
  _Warum:_ Konsistenter SW-Code und leichtere additive Erweiterung. ping bleibt flach, weil eingespielt und vom SW so gelesen (background.js:1645).
- 🟢 **D10** — busy ist ein erwarteter Nicht-Fehler-Zustand: UI zeigt einen Hinweis ('Import läuft bereits in anderem Tab'), keinen roten Fehler-Toast.  
  _Warum:_ ADR-0004: keine Queue, Zweittab bekommt busy. Das ist Designabsicht, kein Crash — soll informativ, nicht alarmierend dargestellt werden.

### UI/UX — On-Page-Flow (LCSC-Seite)

- 🟢 **d1** — Alle user-sichtbaren Strings liegen unter stabilen i18n-Keys (k2c.*) in einem COPY-DECK, DE als Default, EN optional nachziehbar. Code referenziert Keys, nicht Literale.  
  _Warum:_ KONZEPT.md ist deutsch; die User-Vision verlangt deutschsprachige, intuitive Texte (Value=50R-Beispiel). Keys entkoppeln Copy von Logik und machen die spätere EN-Lokalisierung kostenlos.
- 🟢 **d2** — Eine einzige Status-Oberfläche pro Karte (geteilter data-k2c-phase1-status-Span für Phase 1 + Phase 2), nicht zwei konkurrierende Knoten.  
  _Warum:_ Bereits so implementiert (phase1Fetch.js:52 / phase2Convert.js:27). Ein Status-Surface verhindert widersprüchliche gleichzeitige Meldungen und hält die Anchor-Cell schmal.
- 🟢 **d3** — Eskalations-Hierarchie Inline-Status → inline Panel-<tr> → Sub-Pane im Panel → Vollbild-Modal NUR für Missing-Layer-Flows.  
  _Warum:_ Modals stehlen Fokus und sind das, was das Override Panel laut KONZEPT §8.1 gerade ablösen soll. Nur die 'was nun?'-Entscheidungen rechtfertigen ein Modal.
- 🟢 **d4** — Confidence ist ein 3-stufiges Enum (high/medium/low), kein Float-Prozentwert in der UI.  
  _Warum:_ Float-Prozente suggerieren Scheingenauigkeit und sind nicht handlungsleitend. Drei Stufen mappen sauber auf grün/amber/grau-Badges. Schwellen bleiben intern in der Suggestion-Engine.
- 🟢 **d5** — Auto-Suggest belegt die Dropdowns vor; der 'One-Click-Accept' IST der Importieren-Button — kein separater Accept-Button.  
  _Warum:_ Ein zweiter Accept-Button wäre ein doppelter Confirm. Vorbelegung + ein Confirm = ein Klick, exakt die User-Vision 'one-click import'.
- 🟢 **d6** — Auto-Apply (Skip-Panel) zeigt IMMER inline, welches Symbol→Footprint es schreibt, bevor/während es schreibt.  
  _Warum:_ Stilles automatisches Schreiben in die Bibliothek verletzt das Vertrauensprinzip. Der Customize-Button bleibt die jederzeitige Eskape-Luke zum vollen Panel (KONZEPT §12.5).
- 🟢 **d7** — Modus-Badge (EasyEDA-Pipeline / Template-Assembly) ist read-only Informations-Cue, kein Steuerelement.  
  _Warum:_ Der Modus wird aus den beiden Dropdowns abgeleitet (KONZEPT §9). Ein steuerbares Badge wäre ein zweiter Weg, dasselbe einzustellen — Verwirrungsquelle.
- 🟢 **d8** — Dropdowns werden mit applyDialogStyleSelect (dialog.js:40) gestylt statt rohem Browser-Default.  
  _Warum:_ Visuelle Konsistenz mit den bestehenden Modal-Dialogen; der rohe <select> in overridePanel.js heute wirkt wie ein Fremdkörper auf der LCSC-Seite.
- 🟢 **d9** — Datasheet-Sub-Pane ist collapsed by default und lädt die PDF-Bytes lazy erst beim Klick auf 'Vorschau einblenden'.  
  _Warum:_ PDFs sind 5–20 MB (KONZEPT §5.2.3). Beim Panel-Öffnen automatisch zu laden würde das Panel aufblähen und das schnelle Metadaten-Erlebnis (~1s) zerstören.
- 🟢 **d10** — Datasheet-Bytes kommen über eine separate fetchDatasheet-RPC (KONZEPT §15.2 Variante A), nicht per Content-Script-Fetch.  
  _Warum:_ LCSCs Datasheet-CDN setzt keine permissiven ACAO-Header → CORS blockiert Content-Script-Fetch. Variante A trennt zudem schnelle Metadaten vom langsamen PDF-Download.
- 🟢 **d11** — Missing-Layer-Flows: bei beidseitig fehlendem Symbol+Footprint+vorhandenen Specs wird der kombinierte 'manuell zusammenstellen'-Modal (§U4.3) bevorzugt statt einer Dialog-Kaskade.  
  _Warum:_ Eine einzige Entscheidung statt Symbol-Dialog→Footprint-Dialog-Kaskade — genau die Kaskade, die das Panel laut KONZEPT §8.1 eliminieren soll.
- 🟢 **d12** — 3D ist KEIN eigener Picker in den Missing-Layer-Modals — nur read-only Status '3D: aus Footprint übernommen' / 'kein 3D verfügbar'.  
  _Warum:_ 3D folgt dem Footprint (ADR-0005 / KONZEPT §11.3 'nicht user-overridbar'). Ein 3D-Picker würde diese feste Beziehung aufweichen.
- 🟢 **d13** — 'Reset Pin Map'-Button gehört ins Panel (KONZEPT §13.5 markierte das als offen — entschieden: JA).  
  _Warum:_ Ohne ihn müsste der User die Sidecar-JSON von Hand löschen, was das Intuitivitäts-Prinzip (User-Vision Punkt 7) bricht. Kosten: ein Button. Klarer Gewinn.
- 🟢 **d14** — Pin↔Pad-UI ist ein inline Sub-Pane im Panel, kein eigenes Modal.  
  _Warum:_ Es braucht Sichtkontakt zu den Dropdowns darüber (welches Symbol/welcher Footprint gewählt ist); ein Modal über dem Panel wäre eine UI-über-UI-Stapelung.
- 🟢 **d15** — Alle 7 Backend-Fehlercodes (busy, easyeda_unavailable, template_not_found, overwrite_refused, pin_pad_mismatch, lib_write_failed, internal) werden auf handlungsorientierte DE-Texte mit Recovery-Hint/Button gemappt; der rohe Code geht nur in console.debug.  
  _Warum:_ User dürfen nie einen rohen Code sehen. Jeder Fehler bekommt eine klare nächste Handlung (Retry / Panel öffnen / Pin↔Pad öffnen / Overwrite-Toggle).
- 🟢 **d16** — Host-offline und host-not-installed bekommen unterschiedliche Texte/Handlungen, heuristisch unterschieden über chrome.runtime.lastError ('not found'/'Specified' → not-installed).  
  _Warum:_ 'Service neu starten' vs. 'Installer ausführen' sind verschiedene Handlungen; ein gemeinsamer Text würde den User in die falsche Richtung schicken.
- 🟢 **d17** — Customize-Button hat exakt dieselben Vorbedingungen/Disabled-States wie Download (online + Active-Lib + nicht busy).  
  _Warum:_ Vermeidet einen verwirrenden 'halb-aktiven' Zustand, in dem Customize klickbar wäre, Download aber nicht.
- 🟢 **d18** — V2-Value-Param-Dialoge (lcscValueParamDialogs.js) bleiben als orthogonale Schicht vor dem Panel/Auto-Apply erhalten, werden nicht neu gebaut.  
  _Warum:_ Sie betreffen die Value-Property-Quelle, nicht den Symbol/Footprint-Layer; sind fertig implementiert (default/configure/cancel) und müssen nur in den V3-Flow eingehängt werden.
- 🟢 **d19** — Metadata-as-Labels erscheint im Panel als read-only Einzeiler-Vorschau (Value/Tolerance/Package/MPN/…), kein Inline-Editor in Slice 1.  
  _Warum:_ Die Property-Mapping-Konfiguration lebt in Settings/Category-Rule, nicht pro Import. Read-only Vorschau macht die User-Vision (Value=50R, Tolerance=±1% als Labels) transparent ohne Scope-Explosion.
- 🟢 **d20** — Anchor-<tr> erbt LCSC-Tabellen-CSS via Inline-Styles (kein Shadow-DOM); nur das Float-Fallback-Panel nutzt Shadow-DOM-Isolation.  
  _Warum:_ Die <tr> muss sich in die Header-Card einfügen (KONZEPT §6.3), das Float-Panel muss sich gegen LCSCs globale Resets schützen (KONZEPT §6.4) — verschiedene Anforderungen.
- 🟢 **d21** — Eine zentrale State-Machine pro Anchor-Card (Modul cardState.js) als Single-Source der States/Transitions/Copy-Keys; data-k2c-phase1-status trägt den State-Namen als CSS-Hook.  
  _Warum:_ Heute ist der State implizit über mehrere Module verstreut (phase1Fetch/phase2Convert setzen Status ad hoc). Eine explizite Maschine macht erlaubte Übergänge testbar und verhindert illegale Zustände (z.B. Confirm während converting).

### UI/UX — Popup, Settings & Datei-Picker

- 🟢 **D-UI-1** — Popup fixe Breite 420 px, Höhe min(640px, viewport), Scroll pro Tab-Panel.  
  _Warum:_ V2 nutzt Bootstrap-container ohne feste Breite und wird auf schmalen Setups gequetscht; 420 px ist die bequeme Lesebreite für File-Explorer-Modal und mehrspaltige Regelzeilen, bleibt unter Chrome-Action-Max (~800 px).
- 🟢 **D-UI-2** — Header zeigt eine Status-Zeile mit Native-Host-Status (tri-state checking/online/offline); V2 WebSocket-Backend-Zeile entfernt.  
  _Warum:_ V3 nutzt Native Messaging (Ground Truth), keine WS-Verbindung mehr. Status kommt aus nativeHostStatus (background.js:1669) via v3NativeHostStatusUpdate-Broadcast.
- 🟢 **D-RULES-1** — Erweitertes Rule-Datenmodell als additives Superset des KONZEPT §12.2 Rule (id, match.pinCount, match.packageForm, symbol/footprint/model3dSource, action, pinDisplay, valueParam, labelMap[]).  
  _Warum:_ Vision Punkt 3/4/6 verlangt Matching nach Pin-Count+Package und Metadata-Label-Mapping, die V2-categorySettings (nur valueParam/hidePins) nicht kennt. Additiv hält Abwärtskompatibilität und Migration trivial.
- 🟢 **D-RULES-2** — action als 2-Wege-Segment 'Ask / Auto-apply' statt KONZEPT-autoConfirm-Checkbox; auto-apply ≡ autoConfirm:true.  
  _Warum:_ Benennt die zwei realen Outcomes (Panel zeigen vs. direkt importieren) klarer als eine Checkbox; mappt 1:1 auf den Skip-Panel-Flow (KONZEPT §12.4).
- 🟢 **D-RULES-3** — Inline-Accordion-Zeilen statt separatem Edit-Modal.  
  _Warum:_ V2-cat-item-Muster (popup.js:1073) ist erprobt, skaliert auf viele Regeln, zeigt collapsed Summary-Chips und expanded den vollen Editor ohne Modal-Zwang. Intuitiver als das in KONZEPT §4.3.1 angedeutete Edit-Modal.
- 🟢 **D-RULES-4** — Symbol-/Footprint-Source-Dropdowns aus Template-Libraries via Native-Host listTemplates, optgroup pro Lib, EasyEDA als Default; fehlender gespeicherter Name → Warn-Icon, nicht-blockierend.  
  _Warum:_ templates.py:44 liefert symbols[]/footprints[]; isTemplateLibrary-Filter existiert (background.js:823). Graceful Degradation statt Hard-Reset entspricht KONZEPT §4.3.1-Validierung.
- 🟢 **D-RULES-5** — 3D-Layer ist nur ein Toggle 'Follow footprint' (default an), kein freies Dropdown; EasyEDA-3D nur als Fallback wenn aus.  
  _Warum:_ ADR-0005 + MEMORY project_v3_3d_layer: 3D folgt dem Footprint per Carry-Over, EasyEDA-3D nur Fallback. Hält die Regel einfach.
- 🟢 **D-RULES-6** — Metadata-Label-Mapping als editierbare Tabelle {lcscParam→symbolProp, visible}; 'Suggest from this page' nutzt letzten Page-Snapshot + Fuzzy-Match gegen STANDARD_SYMBOL_PROPERTY_KEYS; unbekannte Keys als hidden custom property.  
  _Warum:_ Vision Punkt 6; template_merger.py:235-261 mappt bereits Datasheet/Manufacturer/Tolerance/Package/Power/Voltage Rating und legt unbekannte als hidden property an (_make_hidden_property). UI macht diese existierende Pipeline konfigurierbar.
- 🟢 **D-RULES-7** — Migration V2 categorySettings → rules[] beim ersten V3-Load; Resistors-Seed-Rule als Vorlage behalten.  
  _Warum:_ background.js:118-121 enthält den V2-Default; verlustfreie Migration (key→categoryPath, Pin-Flags→pinDisplay, Rest auf easyeda/ask-Defaults) verhindert Datenverlust und liefert dem User ein lebendes Beispiel.
- 🟢 **D-RULES-8** — Bei doppeltem categoryPath kein Overwrite-Prompt, sondern Live-Merge-Hinweis + Sprung zur existierenden Zeile; Dedup wie V2.  
  _Warum:_ V2 dedupliziert bereits (popup.js:1318-1347); ein Prompt würde den flüssigen Inline-Save-Flow stören.
- 🟢 **D-LIB-1** — Asset-Badges als Icon+Count (z.B. ⚙ Symbol (128)), Farbe grün=Einträge/grau=leer beibehalten.  
  _Warum:_ popup.js:877-884 liefert Count+Farbe schon; Icon+Count ist kompakter und passt in die 420px-Breite.
- 🟢 **D-LIB-2** — Warnung (⚠ Tooltip), wenn dieselbe Lib gleichzeitig Active und Template ist.  
  _Warum:_ KONZEPT §4.3.2 'Active Library ≠ Template Library'; verhindert dass eine Lib sich beim Import selbst überschreibt, ohne das V2-Verhalten (beides erlaubt) hart zu brechen.
- 🟢 **D-LIB-3** — 'Add'-Modal mit Create (Name+Base-Folder+Häkchen) und Import (.kicad_sym); beide Pfad-Buttons rufen den File-Explorer-Picker (folder- bzw. import-mode).  
  _Warum:_ Modal existiert (popup.html:253), Picker-Modi existieren (popup.js:1721); konsistente Pfadwahl über einen Komfort-Picker.
- 🟢 **D-SET-1** — Zwei V2-Overwrite-Switches zu einer 3-Wege-Policy Ask|Overwrite|Skip zusammenführen; 3D-Overwrite als Unter-Detail bei Policy=Overwrite.  
  _Warum:_ KONZEPT §4.3.3 nennt 'Default overwrite policy'; vereinheitlicht mit Override-Panel-Logik (§12.4 Schritt 4) und senkt kognitive Last gegenüber zwei separaten Switches (popup.html:176-184).
- 🟢 **D-SET-2** — 'Always show Override Panel' als prominentester neuer Settings-Toggle (default OFF) ganz oben in Import behaviour.  
  _Warum:_ KONZEPT §12.4-5 Master-Bremse: ON deaktiviert global den Skip-Panel-Flow, überschreibt jede auto-apply-Regel. Wichtigster Sicherheits-Schalter der Auto-Suggestion-Vision.
- 🟢 **D-SET-3** — Kein 'system'-Theme in V1; nur Light/Dark wie V2.  
  _Warum:_ V2 hat nur Light/Dark (popup.html:151-156); 'system' (KONZEPT-Erwähnung) addiert prefers-color-scheme-Logik ohne klaren Nutzen für ein Tool-Popup.
- 🟢 **D-SET-4** — 'Re-check'-Button triggert prewarmNativeHost und aktualisiert Status-Zeile + Header-Dot; ersetzt V2 'Test'.  
  _Warum:_ background.js:1685 prewarmNativeHostInternal liefert frischen Ping (host.py:139); ersetzt den WS-Test (popup.html:129), der in V3 entfällt.
- 🟢 **D-PICK-1** — fs_roots/fs_list/fs_check als Native-Messaging-Verben in native_host/host.py nachziehen (Logik aus server.py:719-826 nach native_host/fs.py extrahieren), Datencontract 1:1.  
  _Warum:_ Diese Verben existieren heute NUR im Legacy-WS-Server; Picker ruft sie über WS (popup.js:1762/1769). Da V3 WS droppt (Ground Truth), funktioniert der Picker sonst nicht. Blockierende Voraussetzung.
- 🟢 **D-PICK-2** — Quick-Access-Leiste (This PC/Home/Documents/Downloads) aus fs_roots-Labels.  
  _Warum:_ Vision Punkt 7 'wie ein Datei-Explorer'; server.py:743-755 liefert genau diese Roots. V2 nutzt sie nur als Startpfad, nicht als sichtbaren Schnellzugriff.
- 🟢 **D-PICK-3** — Back/Forward/Up-Navigation mit In-Session-History-Stack; Tastatur Alt+←/Alt+→/Backspace.  
  _Warum:_ Vision verlangt explizit back/forward; V2 hat nur Breadcrumbs. data.parent (popup.js:1772) liefert Up.
- 🟢 **D-PICK-4** — Client-seitiger Inhalts-Filter (substring, case-insensitiv) ohne Server-Roundtrip.  
  _Warum:_ Für große Verzeichnisse essenziell; V2-Picker hat keinen Filter. entries liegen bereits client-seitig vor.
- 🟢 **D-PICK-5** — Live-Pfad-Validierung via fs_check; Footer zeigt writable/not-writable/will-create; 'Select' disabled bei writable=false für Schreibziele.  
  _Warum:_ server.py:808-826 liefert exists/is_dir/writable; verhindert die häufigste Frustration (Lib in nicht-schreibbarem Pfad anlegen).
- 🟢 **D-PICK-6** — Vollständige Tastatur+A11y: listbox-Rolle, ↑/↓/Enter/Esc, Tab durch Breadcrumb-Buttons, aria-current=page, Separatoren via CSS (nicht im A11y-Tree), Fokus-Trap+Rückfokus.  
  _Warum:_ WCAG 1.3.1 / W3C-APG-Breadcrumb-Pattern; V2 hat Pfeiltasten (popup.js:1890) aber unvollständige A11y. CSS-Separatoren vermeiden Screenreader-Lärm (APG-Empfehlung).
- 🟢 **D-PICK-7** — Zwei Picker-Modi bleiben: folder (Verzeichnis) und import (.kicad_sym-Datei, Extension-Filter); Doppelklick Ordner=öffnen, Datei=wählen+bestätigen.  
  _Warum:_ V2-Modi (popup.js:1721-1722, 1879-1888) decken Library-Create (folder) und Library-Import (file) ab; Apply-Guard erzwingt File im Import-Mode (popup.js:1977).
- 🟢 **D-EMPTY-1** — Inhaltliche Empty-States pro Tab (Library, Rules) mit erklärendem Text + Primär-CTA statt nur 'No libraries yet'.  
  _Warum:_ V2 zeigt nur dürren Text (popup.js:683); geführte Empty-States senken die Einstiegshürde (Vision: 'nutzen, nicht studieren').
- 🟢 **D-ONB-1** — Nicht-modales 2-Schritt-Onboarding-Banner oben im Popup (Host installieren / Library anlegen), dismissable, re-evaluiert bei jedem Öffnen.  
  _Warum:_ Führt First-Run-User ohne Vollbild-Wizard; Schritt-Checks aus nativeHostStatus (background.js:1669) und getActiveLibrary (popup.js:1985).
- 🟢 **D-ONB-2** — Popup ist der einzige Onboarding-Ort; Import-Klick ohne Host hält roten Dot+Tooltip → Popup-Banner. Kein separates Onboarding-Tab.  
  _Warum:_ KONZEPT §20.1 (Zeile 1308) verlinkt schon auf Onboarding-Doku; ein zentraler Ort reduziert Pflegeaufwand.
- 🟢 **D-COPY-1** — Popup-UI primär Deutsch, technische Begriffe englisch; i18n-Keys vorbereitet, V1 nur DE-Strings.  
  _Warum:_ User-Kontext (FH Zwickau, mike.espig@fh-zwickau.de) und KONZEPT.md sind deutsch; i18n-Keys halten spätere EN-Lokalisierung offen ohne V1-Aufwand.

### Installation & Distribution

- 🟢 **single-artifact** — Host-Binary und Installer sind EIN Artefakt: ein PyInstaller-onefile mit Zwei-Modi-Erkennung (Chrome-invoked = Native-Messaging-Loop; per Doppelklick gestartet = Self-Register). Nur eine Datei zum Download.  
  _Warum:_ Minimiert Download-/Distributions-Komplexität; host.py hat bereits main()+__main__; ein zusätzliches Installer-Binary wäre redundanter Pflegeaufwand.
- 🟢 **webstore-id-baked** — Web-Store-Extension-ID wird als Konstante in install.py eingebrannt (Default), --extension-id bleibt nur Dev-Override; Manifest listet mehrere allowed_origins (Web-Store-ID + optionale Dev-ID).  
  _Warum:_ Native Messaging verlangt die ID in allowed_origins, bevor der User die Extension lädt; sie kann nicht zur Laufzeit erfragt werden. Web-Store-ID ist nach erstem Upload stabil. Mehrere Origins lassen denselben Host für Web-Store- UND unpacked-Dev-Last funktionieren.
- 🟢 **ci-entry-point-fix** — CI (build-backend.yml:84/89/95) friert native_host/host.py statt run_server.py ein; Artefakt umbenannt zu kicad-parts-importer-host; easyeda2kicad via --collect-submodules/-e . mitgepackt; host.py sys.path-Hack auf nicht-frozen gaten.  
  _Warum:_ run_server.py ist der gedroppte V2-WebSocket-Server (ADR-0001) und spricht NICHT das stdin/stdout-NM-Protokoll → connectNative würde sofort disconnecten. Release-blockierender Bug. host.py:244 ist bereits NM-loop-tauglich.
- 🟢 **no-bat-for-enduser** — Produktions-Manifest-path zeigt direkt auf das self-contained PyInstaller-Exe (eingebetteter Python); kein .bat-Shim, kein System-Python. Der .bat-Mechanismus (install.py:48-77) bleibt nur im Dev-Modus aktiv (frozen-Erkennung).  
  _Warum:_ Behebt die .venv-Python-Launcher-Lücke: der heutige host-launcher.bat brennt sys.executable (.venv\Scripts\python.exe) ein, das beim End-User nicht existiert; kicad-host.bat braucht System-Python. Das Frozen-Binary trägt seinen eigenen Interpreter.
- 🟢 **per-user-no-admin** — Strikt per-User-Install ohne Admin/sudo: HKCU-Registry (Windows) bzw. ~/-Pfade (macOS/Linux); Binary nach %LOCALAPPDATA% / ~/Library/Application Support / ~/.local/share; Self-Register kopiert sich dorthin statt den Download-Pfad zu registrieren.  
  _Warum:_ NM-Manifeste werden pro User-Profil aufgelöst und brauchen keine Elevation; matcht Single-User-localhost-Scope; umgeht Corporate-UAC. Kanonischer Kopier-Ort macht das Binary löschbar/überschreibbar (Updates).
- 🟢 **doubleclick-mode-detection** — Modus-Erkennung über Chrome-übergebene argv-Marker (chrome-extension://<id>/ Origin-Arg, Windows zusätzlich --parent-window=<HWND>), nicht über stdin-tty-Heuristik.  
  _Warum:_ Deterministischer als tty-Prüfung, die in manchen Shell-Kontexten trügt. Chrome reicht den Origin/Manifest beim NM-Start mit.
- 🟢 **native-dialog-no-gui-dep** — Self-Register-Erfolgsmeldung als minimale native Dialogbox (MessageBoxW / osascript / stdout auf Linux), kein tkinter/Qt-Dependency.  
  _Warum:_ Hält das PyInstaller-Binary klein und den Build simpel; vermeidet GUI-Framework-Bloat für eine einzige Erfolgsmeldung.
- 🟢 **onboarding-banner-download** — 4. Button-State not-installed löst ein Onboarding-Banner auf der LCSC-Seite aus mit OS-erkanntem Download-Link auf das GitHub-Releases-Asset; offline (Timeout/Disconnect) bleibt nur disabled Button + Tooltip; forbidden (ID-Mismatch) eigener Hinweis.  
  _Warum:_ Der heutige offline-State (nativeHostStatusButton.js:44-50) sagt run the installer, verlinkt aber nichts. Web Store darf keine Binaries hosten → GitHub Releases (bestehender CI-Release-Job) ist die Quelle. SW kann not-found vs timeout am lastError.message unterscheiden.
- 🟢 **cross-os-multi-browser-register** — Self-Register schreibt Manifest für alle erkannten unterstützten Browser (Chrome/Edge/Brave) und alle drei OS gemäß Pfad-Tabelle; Brave nutzt unter Windows den Chrome-HKCU-Key; name-Konstante bleibt com.kicad_parts_importer.host.  
  _Warum:_ install.py registriert heute nur Windows-Chrome (install.py:28-29,118). Ein Doppelklick soll alle Browser des Users abdecken. Manifest-Schreiben ist billig; nur Test/Support ist die echte Kostenfrage (eskaliert).
- 🟢 **localhost-permission-removed** — V2-Reliquie host_permissions http://localhost:8087/* aus manifest.json:12 entfernen.  
  _Warum:_ V3 hat keinen localhost-Server (ADR-0001); die Permission ist tot und vergrößert unnötig die Web-Store-Review-Angriffsfläche.
- 🟢 **unsigned-default** — Default (ohne Budget): unsigniert ausliefern; README-Unblock/Run-anyway-Anleitung ins Onboarding-Banner spiegeln. Die Geld-Frage selbst wird eskaliert.  
  _Warum:_ Das Host-Binary läuft als Chrome-Subprozess; SmartScreen/Gatekeeper greifen nur beim EINEN manuellen Self-Register-Doppelklick, danach warnungsfrei. Seit März 2024 gibt selbst EV keinen sofortigen SmartScreen-Bypass mehr → Signing-ROI ist niedrig. AGPL-Open-Source-üblich.
- 🟢 **host-update-overwrite-no-autoupdate** — Host-Update = Binary über kanonischen Pfad überschreiben (Doppelklick); kein Auto-Update in V1; Extension kann bei Versions-Mismatch (Ping-version vs. min-erwartet) ein Update-Banner zeigen.  
  _Warum:_ Chrome startet/killt den Host pro Call (ADR-0001) → kein laufender Prozess zu stoppen, neue Version greift beim nächsten connectNative. Auto-Update unsignierter Binaries ist ein Sicherheits-Antipattern; verschoben bis Signing geklärt ist.

### Repo-Cleanup

- 🟢 **CL-BRANCH** — Cleanup-Branch vom aktuellen Tree (master @ a8af557) abzweigen, NICHT auf v2.0.0-Tag reset.  
  _Warum:_ S1 will native_host/ (host/phase1/phase2/templates) + die neuen V3-Content-Scripts (anchorCard, overridePanel, phase1Fetch, phase2Convert, nativeHostStatusButton) behalten — die existieren auf v2.0.0 noch nicht. Ein v2.0.0-Reset würde genau diese Arbeit wegwerfen.
- 🟢 **CL-ARCHIVE-MECH** — Zweistufig: Git-Tag archive/v3-drift (existiert @ a8af557) = unveränderlicher Code-Snapshot; superseded Docs zusätzlich physisch per git mv nach docs/archive/. Toter Code (api/server.py, run_server.py) wird gelöscht (nicht verschoben).  
  _Warum:_ Tag konserviert alten Code verlustfrei → ein toter Code-Ordner im Tree ist Ballast. Docs haben Trail-Wert und gehören sichtbar archiviert, damit Leser nicht über veraltete Pläne stolpern.
- 🟢 **CL-RM-WS** — Legacy-WebSocket-Pfad löschen: run_server.py, easyeda2kicad/api/server.py, tests/test_api_server.py.  
  _Warum:_ Mit S1 (Native Messaging via native_host/) ist der gesamte FastAPI/uvicorn-WS-Server tot. server.py (1285 Z.) komplett von native_host/ ersetzt; test_api_server.py testet ausschließlich create_app() des gelöschten Servers; run_server.py ist der uvicorn-Entry der 0.0.0.0 bindet.
- 🟢 **CL-EXT** — extensionWsClient.js + categoryPath.js (DUP von shared/categoryPath.mjs) als zu-löschen MARKIEREN, aber erst nach der Extension-Native-Messaging-Migration entfernen — NICHT im Cleanup-Commit.  
  _Warum:_ background.js ist hybrid: importScripts('extensionWsClient.js') @ background.js:5 ist noch aktiv, obwohl connectNative @ background.js:844 schon existiert. Sofortiges Löschen bricht background.js+popup.js. Vollständige WS→Native-Umstellung ist Migrations-Arbeit, nicht Cleanup.
- 🟢 **CL-MODELS** — easyeda2kicad/api/models.py BEHALTEN trotz WS-lastiger Payloads.  
  _Warum:_ native_host/phase2.py importiert TaskCreatePayload daraus (S1-Engine-Fassade). Ungenutzte WS-only-Modelle separat ausdünnen, nicht im Cleanup.
- 🟢 **CL-GENERATED** — native_host/_generated/ nur lokal löschen (Hygiene), kein Repo-Change; keine neue .gitignore-Zeile.  
  _Warum:_ Bereits via native_host/.gitignore ignoriert. Enthält maschinenspezifisches host-launcher.bat (zeigt auf .venv-Python) + hartkodierte Extension-ID; install.py regeneriert es.
- 🟢 **CL-AGPL-AUTHOR** — easyeda2kicad/__init__.py __author__ ergänzen ('uPesy (original), theautomatist (V3 fork)') + __original_source__-Variable, statt uPesy zu ersetzen.  
  _Warum:_ AGPL verlangt Erhalt der Original-Attribution; Fork-Kennzeichnung erfüllt Modified-by-Notice ohne Provenienz zu löschen.
- 🟢 **CL-AGPL-GEN** — Generator-Strings an den lebenden Stellen (helpers.py:218/258/323, conversion.py:274, __main__.py:178) auf eigenen Fork-Identifier umstellen mit Original im Quell-Kommentar; export_kicad_3d_model.py:16-Kommentar Original behalten + Fork-Zeile ergänzen.  
  _Warum:_ Kennzeichnet das modifizierte Werk (AGPL Modified-Notice) und behält Provenienz-Kette. server.py:350-Vorkommen entfällt (Datei gelöscht).
- 🟢 **CL-BIND** — 127.0.0.1-Bind-Anforderung gilt als erledigt durch Löschung von run_server.py.  
  _Warum:_ Einziger 0.0.0.0-Bind war run_server.py:12. native_host nutzt stdin/stdout ohne Port → nach Löschung existiert kein Netzwerk-Bind.
- 🟢 **CL-CI** — build-backend.yml PyInstaller-Entry von run_server.py auf native_host/host.py umstellen; fastapi+uvicorn aus requirements.txt entfernen; manifest.json localhost:8087-Permission/WS-description/version anpassen.  
  _Warum:_ Nach §3-Löschung sind run_server.py + fastapi/uvicorn nur noch von gelöschtem Code referenziert; localhost:8087 ist der obsolete WS-Port. Sonst bricht der Build / lügt grün.
- 🟢 **CL-KONZEPT-DRIFT** — KONZEPT.md §5-Überschrift 'Lokaler Service (gRPC-Backend)' auf 'Native Host (Chrome Native Messaging)' korrigieren.  
  _Warum:_ Direkter Widerspruch zur DECIDED-Transport-Entscheidung (Native Messaging, kein gRPC). Reiner Doc-Konsistenz-Fix.
- 🟢 **CL-IMG** — img/store_images/* (jpg+drawio+icon) behalten; Top-Level img/*.png (V2-UI-Screenshots) als entfernbar markieren, final aber erst im README-Rewrite entscheiden.  
  _Warum:_ Nur store_images werden vom README referenziert; die *.png-Screenshots nicht. Vorerst KEEP vermeidet README-Lücken bevor das V3-README steht.


---

## 9. 🔴 Offene Fragen — BRAUCHT DICH (abhängigkeitsgeordnet)

Diese kann kein Agent für dich entscheiden — echte Wert-/Kosten-/Präferenz-Fragen. Unabhängige zuerst, abhängige danach.

### Unabhängig

- 🔴 **[Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform] UQ-1** — Welche Komponentenklassen und konkreten Footprints soll die mitgelieferte Stock-Library (StdLib) in v1 enthalten? Vorschlag: Resistor/Capacitor/Capacitor_Polarized/Inductor/Diode/LED als Symbole + R/C 0402-1206, SOT-23-3/-5, SOD-123 als Footprints. Reicht das, oder gibt es Pflicht-Packages (z.B. spezifische QFN/connector-Familien), die dein Workflow zwingend braucht?  
  _Warum du:_ Bestimmt Scope und Pflegeaufwand der Stock-Library. Falsche/fehlende Standard-Footprints untergraben die Auto-Selection sofort. Reine Produkt-/Scope-Entscheidung, nicht agent-resolvbar.
- 🔴 **[Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform] UQ-3** — Wie aggressiv soll der Default sein, sobald die Stock-Library installiert ist: bleiben die Stock-Rules dauerhaft auf 'suggest' (User schaltet bewusst auf 'auto'), oder willst du nach z.B. 3 erfolgreichen bestätigten Imports derselben Kategorie eine automatische Beförderung auf 'auto' anbieten/aktivieren?  
  _Warum du:_ Bestimmt, wie schnell der One-Click-Traum greift vs. wie viel Kontrolle der User behält. Reine Produkt-Präferenz (Komfort vs. Vorsicht), die deine Risikobereitschaft widerspiegelt.
- 🔴 **[Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform] UQ-4** — Soll die Package-Taxonomie (packageTaxonomy.json) zusätzlich Verbindungs-/THT-Familien und herstellerspezifische Packages abdecken, oder bewusst auf die gängigen SMD-Chip- und SOT/SOIC/QFN-Familien beschränkt bleiben (alles andere fällt auf den Trim-Fallback zurück, kein Package-Form-Match)?  
  _Warum du:_ Definiert die Reichweite der Package-Form-getriebenen Footprint-Vorschläge. Breitere Taxonomie = mehr Pflege + mehr Fehlklassifikations-Risiko. Scope-Cut-Entscheidung.
- 🔴 **[Template-System + Metadaten-als-Labels] tq-1** — Reset-Pin-Map-Button im Override Panel (KONZEPT §13.5 / §21.5): Soll es einen sichtbaren Button geben, der die Sidecar-JSON löscht und das Pin↔Pad-Mapping neu triggert, oder genügt manuelles Löschen der Datei?  
  _Warum du:_ Reines UX/Komfort-Tradeoff (extra UI-Fläche vs. User-Freundlichkeit). KONZEPT empfiehlt den Button, aber das ist eine Produktpräferenz, keine technische Notwendigkeit — beeinflusst Override-Panel-Scope.
- 🔴 **[3D-Layer] F-Q1** — Verhalten bei 3D-Hash-Collision (gleicher Basename in <ActiveLib>.3dshapes/, aber anderer Inhalt als das Template-File): (A) Convert hart abbrechen mit user-actionable Error 'lib_write_failed: 3D file hash collision' (KONZEPT §11.2.2 Vorschlag), oder (B) automatisch unter Suffix-Namen kopieren (<basename>__<hash8>.step) und Ref entsprechend umschreiben?  
  _Warum du:_ Das ist ein Daten-Integritäts-/UX-Tradeoff (sichtbarer Fehler + User räumt auf vs. stille Auto-Dedup mit potenziell wachsendem .3dshapes/-Verzeichnis), keine rein technische Entscheidung. Option B ändert auch die Referenzierungs-Semantik. Default-Annahme falls keine Antwort: Option A (hart abbrechen), weil es dem dokumentierten KONZEPT entspricht und Überraschungen vermeidet.
- 🔴 **[Transport & RPC-Vertrag (Native Messaging)] Q1** — Soll der Native Host für den Warm-Port multi-threaded werden (Reader-Thread + Worker, sodass schnelle read-only Verbs wie listTemplates/renderFootprintSvg während eines laufenden 10s-convert bedient werden), oder bleibt er strikt seriell (Panel-Reads warten hinter convert)? Agent-Empfehlung: multi-threaded, weil die UX-Vision auf flüssiger Override-Panel-Interaktion beruht.  
  _Warum du:_ Echte Aufwands-/Komplexitätsentscheidung: Der heutige Host ist single-threaded (host.py:226 read→handle→write). Mit Warm-Port + parallelen Reads während convert braucht es Threading, sonst friert das Override-Panel während jeder Conversion ein. Das ist Code-Umfang vs. UX-Qualität — eine Produktentscheidung.
- 🔴 **[Transport & RPC-Vertrag (Native Messaging)] Q2** — Soll der optionale Host-seitige fetchDatasheet-Verb überhaupt gebaut werden? Das 1-MB-Native-Messaging-Frame-Limit zwingt zu Chunking/Tempfile für große PDFs. Agent-Empfehlung: weglassen — der Service-Worker-Pfad (mit Cookies, HTML-Shell-Recovery, 24-MB-Limit, Progress) genügt.  
  _Warum du:_ Reiner Scope-Schnitt: ob der Aufwand für einen Datasheet-Fallback über Native Messaging (inkl. Frame-Chunking) gerechtfertigt ist, hängt von deiner Priorität für Offline-/no-host_permissions-Setups ab — eine Kosten/Nutzen-Abwägung.
- 🔴 **[UI/UX — On-Page-Flow (LCSC-Seite)] q1** — Soll die UI von Anfang an zweisprachig (DE + EN) ausgeliefert werden, oder reicht DE-only für V3-Release und EN kommt später? Das COPY-DECK ist auf Keys ausgelegt, aber die EN-Spalte zu füllen + Sprachumschalter zu bauen ist zusätzlicher Aufwand.  
  _Warum du:_ Bestimmt, ob ein Locale-Switcher + vollständige EN-Übersetzung in V3-Scope ist. LCSC-Nutzer sind international, aber dein KONZEPT.md ist durchgängig deutsch.
- 🔴 **[UI/UX — On-Page-Flow (LCSC-Seite)] q2** — Bei Auto-Apply (Skip-Panel-Flow): soll das Tool wirklich OHNE jede Bestätigung in die Bibliothek schreiben, sobald eine autoConfirm-Regel + High-Confidence vorliegt — oder möchtest du mindestens einen kurzen, abbrechbaren Countdown ('importiere in 3s … [Abbrechen]') als Sicherheitsnetz?  
  _Warum du:_ Echtes Auto-Apply ist maximal bequem (deine Vision Punkt 3 'auto-apply vs ask'), aber schreibt unwiderruflich Dateien. Ein Countdown ist ein Kompromiss zwischen Bequemlichkeit und Kontrolle — das ist eine Präferenzentscheidung, keine technische.
- 🔴 **[UI/UX — On-Page-Flow (LCSC-Seite)] q4** — Sollen Symbol-, Footprint- und Library-PATH-Picker im Override-Panel/in den Missing-Layer-Modals als echter hierarchischer Datei-Explorer (Baum-Navigation, Breadcrumbs, Suche, Zurück/Vor — wie in deiner Vision Punkt 7) gebaut werden, oder reicht für V3 das aktuelle flache optgroup-Dropdown (Lib → Namen) und der Explorer kommt als Folge-Iteration?  
  _Warum du:_ Der volle Datei-Explorer ist erheblicher UI-Aufwand (Tree-Component, Breadcrumb-Nav, Suche) und überschneidet sich mit dem Popup-Tab Library. Ob das in V3-Scope gehört, ist eine Aufwand/Nutzen-Entscheidung, die nur du als Scope-Owner treffen kannst.
- 🔴 **[UI/UX — Popup, Settings & Datei-Picker] Q-RULES-1** — Wie viel Mächtigkeit soll der Regel-Editor in V1 haben? Variante A (schlank): nur categoryPath + Symbol/Footprint-Source + Ask/Auto-apply. Variante B (voll, wie spezifiziert): zusätzlich Pin-Count-/Package-Form-Match + editierbares Metadata-Label-Mapping. B ist deutlich mehr Build-Aufwand.  
  _Warum du:_ Das ist eine Scope-Cut-Linie (Aufwand vs. Vision-Vollständigkeit). Die Vision (Punkt 3+6) verlangt B, aber B verdoppelt den Bau-Aufwand der Rules-UI und die Test-Matrix. Reine Wertentscheidung, die ich nicht für dich treffen darf.
- 🔴 **[UI/UX — Popup, Settings & Datei-Picker] Q-PICK-1** — Akzeptierst du, dass der File-Explorer-Picker Zugriff auf das gesamte Dateisystem des Nutzers über die Native-Host-FS-RPCs gibt (Laufwerke, Home, beliebige Ordner)? Oder soll der Zugriff auf erlaubte Root-Verzeichnisse (z.B. nur Documents + explizit hinzugefügte Lib-Ordner) eingeschränkt werden?  
  _Warum du:_ Das ist eine Sicherheits-/Privacy-Policy-Entscheidung mit Vertrauens- und ggf. Store-Review-Implikationen. fs_list erlaubt heute beliebiges Verzeichnis-Listing (server.py:760). Single-user-localhost mindert das Risiko, aber die Reichweite des FS-Zugriffs ist deine Abwägung.
- 🔴 **[Installation & Distribution] signing-budget** — Code-Signing-Budget? Optionen: (A) Nichts — unsigniert, einmaliger SmartScreen/Gatekeeper-Hinweis beim Self-Register-Doppelklick (Default, $0). (B) Nur macOS notarisieren: Apple Developer Program $99/Jahr, Notarization selbst kostenlos — entfernt die Gatekeeper-Quarantäne für Mac-User. (C) Windows OV-Zertifikat ~$200-300/Jahr (baut SmartScreen-Reputation langsam auf — seit März 2024 KEIN sofortiger Bypass, auch nicht mit EV). (D) Windows EV ~$300-500/Jahr (für unser Subprozess-Szenario kaum Mehrwert vs OV). (E) Voll: macOS-Notarization + Windows-OV.  
  _Warum du:_ Das Host-Binary läuft als Chrome-Subprozess und triggert die OS-Warnung nur EINMAL beim manuellen Self-Register-Doppelklick, danach warnungsfrei. Damit ist der Signing-ROI gering, aber für eine polierte Erst-User-Erfahrung evtl. gewünscht. Reine Geld-/Geschäftsentscheidung, die ich nicht treffen kann. Ab Feb 2026 max. Zertifikatslaufzeit ~459 Tage (kein Mehrjahres-Kauf).
- 🔴 **[Installation & Distribution] browsers** — Welche Browser werden offiziell unterstützt und getestet? (A) Nur Chrome. (B) Chrome + Edge. (C) Chrome + Edge + Brave. (Firefox separat, da anderes NM-Manifest-Format/-Ort — bewusst ausgeklammert?)  
  _Warum du:_ Das Manifest-Schreiben für mehrere Chromium-Browser ist billig (gleiche JSON, andere Pfade — Tabelle in §18.7), aber jeder zusätzliche offiziell-supported Browser bedeutet Test- und Support-Aufwand. Reine Scope-Entscheidung. Brave liest unter Windows ohnehin den Chrome-HKCU-Key (quasi gratis); Edge braucht einen eigenen Registry-Key/Pfad.
- 🔴 **[Installation & Distribution] webstore-id** — Finale Chrome-Web-Store-Extension-ID für das V3-Listing? Wird das V3-Listing neu angelegt (Clean Break, ADR-0003 — V2 wird bei V3-Release depubliziert) oder das bestehende V2-Listing (ID ojkpgmndjlkghmaccanfophkcngdkpmi) weiterverwendet?  
  _Warum du:_ Diese ID muss in den Installer eingebrannt werden (allowed_origins), bevor End-User die Extension laden. Sie ist nach erstem Upload stabil und nicht von mir bestimmbar. Bei neuem V3-Listing ist die ID erst nach dem ersten Web-Store-Upload bekannt — dann muss der erste signierte Installer-Build darauf warten.
- 🔴 **[Repo-Cleanup] UQ-BRANDING** — Wie lautet der finale Repo-/Tool-Name und die kanonische GitHub-URL für den AGPL-Generator-String + Source-Link (z.B. https://github.com/theautomatist/KiCad-Parts-Importer)?  
  _Warum du:_ Der Generator-String wird in jede geschriebene KiCad-Datei eingebettet und der AGPL-Source-Link in README/Popup muss auf das echte öffentliche Repo zeigen. Branding ist eine Geschäfts-/Eigentümerentscheidung, die ich nicht erfinden darf.
- 🔴 **[Repo-Cleanup] UQ-PYINSTALLER** — Native-Host-PyInstaller-Bundling ist laut native_host/README als Issue #13 noch offen. Soll der build-backend.yml-Job bis dahin auf workflow_dispatch-only/deaktiviert gesetzt werden, oder erwartest du einen sofort funktionierenden native_host/host.py-Build im selben Cleanup-PR?  
  _Warum du:_ Bestimmt, ob der Release-Build im Cleanup-PR grün sein muss oder bewusst geparkt wird — eine Scope-/Zeitplan-Entscheidung.

### Abhängig (erst nach der jeweiligen Vorentscheidung)

- 🔴 **[Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform] UQ-2** — Sollen die kanonischen Standard-Symbole/Footprints von Grund auf neu in KiCad gezeichnet werden, oder dürfen wir die KiCad-Standard-Symbol-/Footprint-Libraries als Basis kopieren/forken (Lizenz: CC-BY-SA 4.0 + Ausnahme)? Letzteres spart enorm Zeit, koppelt aber Lizenz/Attribution.  
  _hängt ab von:_ `UQ-1` · _Warum du:_ Lizenz- und Aufwands-/Qualitätsabwägung mit rechtlicher Komponente (CC-BY-SA Attribution-Pflicht vs. AGPL-Projekt). Das ist eine Business-/Compliance-Entscheidung, die nur du treffen kannst.
- 🔴 **[Template-System + Metadaten-als-Labels] tq-2** — Footprint-SVG-Render für die Pin↔Pad-Sub-UI (KONZEPT §13.3 / §21.4): separater RPC RenderFootprintSvg oder als Teil von ListTemplates ausliefern?  
  _hängt ab von:_ `tq-1` · _Warum du:_ Architektur-/Performance-Tradeoff mit Scope-Auswirkung: ListTemplates soll schnell und cachebar bleiben; SVG-Render nur bei Bedarf. Hängt davon ab, ob die Sub-UI überhaupt im V3-MVP-Scope ist (siehe Footprint-Template-Override).
- 🔴 **[UI/UX — On-Page-Flow (LCSC-Seite)] q3** — Wie aggressiv soll das Tool bei NIEDRIGER Confidence vorgehen: Vorschlag trotzdem vorbelegen (User muss ggf. wegklicken) ODER Dropdown auf 'Keep EasyEDA' lassen und den Low-Confidence-Vorschlag nur als unaufdringlichen Hinweis zeigen?  
  _hängt ab von:_ `q2` · _Warum du:_ Beeinflusst, wie oft der User einen falschen Vorschlag korrigieren muss vs. einen hilfreichen verpasst. Das ist eine UX-Geschmacksfrage (proaktiv vs. zurückhaltend), die von deiner Toleranz für 'falsche aber bequeme' Defaults abhängt.
- 🔴 **[UI/UX — Popup, Settings & Datei-Picker] Q-UI-1** — Soll die Popup-UI tatsächlich primär Deutsch sein, oder bevorzugst du Englisch als Standard (mit DE als Option)? Das betrifft alle Labels/Copy-Strings.  
  _hängt ab von:_ `D-COPY-1` · _Warum du:_ Sprachwahl ist eine Produkt-/Zielgruppen-Entscheidung, nicht agent-auflösbar. Mein Default ist DE (passend zu KONZEPT.md + deinem FH-Kontext), aber wenn die Extension international veröffentlicht werden soll, ändert das die ganze Copy-Deck-Strategie.
- 🔴 **[Repo-Cleanup] UQ-EXT-MIGRATION-ORDER** — Soll der Cleanup-Commit bewusst nur den toten WS-Backend-Pfad (server.py/run_server.py/test_api_server.py) löschen, ABER die WS-abhängigen Extension-Dateien (extensionWsClient.js, categoryPath.js) stehen lassen, bis die Extension-Native-Messaging-Migration als separater Issue durch ist? Oder beides in einem großen Schritt?  
  _hängt ab von:_ `UQ-BRANDING` · _Warum du:_ background.js ist hybrid (importScripts WS @ Zeile5 + connectNative @ Zeile844). Sofort-Löschen bricht popup/background bis die Migration fertig ist — das ist Umbau-, kein Aufräum-Risiko, und betrifft den Auslieferungszeitplan (Scope-Cut-Linie).


---

## 10. Offene Risiken (aggregiert)


**Auto-Vorschlag-Intelligenz — Kategorie / Pin-Zahl / Bauform:**
- Phase 1 muss CAD-Daten fetchen, um easyedaHas{symbol,footprint,model}, pinCount und manufacturer/mpn zu liefern — das ist genau der Fetch, den phase1.py:127 bereits macht, aber Phase 2 fetcht ERNEUT (conversion.py:421). Doppelter EasyEDA-Roundtrip pro Import. Mitigation: Phase-1-CAD-Daten an Phase 2 durchreichen/cachen (eigener kleiner Slice), sonst verdoppelt Auto-Selection die Latenz.
- Package-Form-Detection aus dem freien LCSC-Package-String ist heuristisch; reale Strings variieren stark ('SOP-8_3.9x4.9x1.27P', '0603(1608 Metric)', lokalisierte Labels). Fehlklassifikation führt zu falschem Footprint-Vorschlag. Mitigation: confidence-gating (<0.6 = kein Auto-Match) + breiter Fixture-Corpus + Taxonomie als pflegbare JSON.
- Auto-Template-Match-Scoring (Name-Token-Overlap) ist sprach-/benennungsabhängig; User-Templates mit kryptischen Namen ('R_std_v2') matchen nicht. Folge: viele 'No rule — keeping EasyEDA'-Fälle trotz vorhandener passender Templates. Mitigation: Setup-Wizard, der Stock-Rules seedet, statt sich auf Namens-Heuristik zu verlassen.
- Footprint-Template-Override ist in phase2.py:139 noch HART ABGELEHNT (braucht Pin-Map-Sidecar #9 + 3D-follows-Footprint #6). Bis #6/#9 landen, kann die Auto-Selection footprintSource=template zwar VORSCHLAGEN und im Panel anzeigen, aber Phase 2 würde es zurückweisen. Reihenfolge-Abhängigkeit: Auto-Selection-Footprint-Pfad ist erst nach #6/#9 voll funktionsfähig (Symbol-Template-Pfad funktioniert schon heute).
- existsInActiveLib + Footprint/3D-Reuse-Check braucht eine Basename-Liste der Active-Lib-Footprints und .3dshapes-Inhalte; LibraryValidateResponse liefert heute nur counts (models.py:140), keine Namen. Kleiner RPC-Zusatz nötig, sonst kann der 'Active library already has R_0603 + 3D — reuse?'-Pfad (AD-8) nicht implementiert werden.
- mergeCategoryConfig (categoryPath.mjs:73) und dedupeCategorySettings müssen um alle neuen ComponentRule-Felder erweitert werden, sonst gehen Symbol-/Footprint-Source/autoApply/LabelMapping bei Dedup verloren. Der Python-Mirror (helpers.py) kennt diese Felder nicht — Drift-Test deckt nur normalize ab, nicht die Rule-Felder; Rule-Persistenz-Parität braucht eigene Tests.

**Template-System + Metadaten-als-Labels:**
- template_merger._replace_property_value (Zeile 75-83) arbeitet per Regex auf S-Expressions; Property-Werte mit eingebetteten Quotes werden zu ' escaped (OK), aber Backslashes/Klammern in Werten könnten Edge-Cases erzeugen — Golden-File-Corpus (S1-Strategie) muss solche Werte abdecken.
- value_param_key-Pfad (Template hat zweites Feld gleich dem Value-Param) ist subtil und scheinbar ohne dedizierten Unit-Test; Regression bei Refactor möglich.
- Footprint-Template-Assembly braucht Koordination mit dem 3D-Bereich (ADR-0005 Carry-Over) und dem Pin↔Pad-UI-Bereich; isolierte Backend-Implementierung allein liefert noch kein nutzbares Feature.
- LCSC-DOM-Scrape (lcscPageSnapshot.js) ist strukturell robust, aber bei zukünftigen LCSC-Layout-Änderungen weiterhin fragil — Param-Mapping-Coverage (LCSC_PARAMS_MAP) muss bei neuen Kategorien/Labels manuell gepflegt werden.
- Sidecar-Format aus KONZEPT §13.4 nutzt {pin,pad}-Liste, während das Backend template_pin_map als dict[str,str] erwartet — Übersetzungsschicht muss eindeutige Targets garantieren (apply_pin_number_map skippt sonst), sonst stille Mapping-Verluste.

**3D-Layer:**
- ${KIPRJMOD}-basierte Refs setzen voraus, dass die Active Library physisch im aktiven KiCad-Projektverzeichnis liegt (V3-Grundannahme Single Active Library). Liegt die Active-Lib außerhalb des Projekts, lösen die 3D-Pfade in pcbnew nicht auf — sollte in der Settings-/Library-Area validiert/dokumentiert werden.
- Template-Assembly (Perfect-Assembly, Fall 1, kein EasyEDA-Call) hängt davon ab, dass Phase-1-Metadaten alle Symbol-Properties liefern (Value, MPN, Manufacturer, Datasheet). Lückenhafte LCSC-Page-Scrapes (Override-Panel/Phase-1-Area) würden hier zu unvollständigen Symbolen führen — Kreuzabhängigkeit zur Metadata-as-Labels-Area.
- STEP-Dateien sind groß (oft mehrere MB); Carry-Over kopiert sie als ganze Binaries (KONZEPT §15 erlaubt das explizit). Bei vielen Imports mit je eigenem STEP kann <ActiveLib>.3dshapes/ stark wachsen — kein Cleanup-Mechanismus spezifiziert.
- KiCad-9 kennt neben (model ...) auch Varianten; falls hand-kuratierte Template-FPs ungewöhnliche Model-Block-Syntax verwenden (z.B. (model_3d ...) o.Ä.), muss das Regex-Pattern (F.2.2) ggf. erweitert werden — gegen reale Template-Korpus-Fixtures verifizieren.
- Die EasyEDA-3D-Offset-/Rotations-Mathematik (export_kicad_footprint.py:538-596) gilt nur für EasyEDA-FPs (Fall 6); Carry-Over übernimmt offset/scale/rotate des Template-FP unverändert. Mischfälle (EasyEDA-3D als Fallback an einen Template-FP angehängt, Fall 5) erben die EasyEDA-Offsets, die gegen die Template-FP-Geometrie verschoben sein können — pcbnew-Smoke-Test (F-AC-13) muss Fall 5 visuell prüfen.

**Transport & RPC-Vertrag (Native Messaging):**
- 1-MB-Native-Messaging-Frame-Limit (Chrome-Hard-Cap) gilt für renderFootprintSvg (960x960 SVG) und einen etwaigen fetchDatasheet: große Footprint-SVGs oder base64-PDFs können das Limit sprengen → Render-Größe/Detail muss getestet und ggf. gedrosselt werden; Datasheet-Fallback bräuchte Chunking.
- Warm-Port + paralleler read-only-Verkehr während convert erfordert Host-Threading (siehe Q1). Bleibt der Host seriell, ist das Override-Panel während jeder Conversion blockiert — funktional korrekt, aber UX-Regression gegenüber der Vision.
- Umstellung error:string → error:{code,message} ist ein Vertragsbruch: Host UND alle SW-Bridges (background.js:1648/1772/1869) plus Content-Script-Konsumenten (phase2Convert.js formatPhase2Terminal liest envelope.error als String) müssen synchron migriert werden, sonst zeigt die UI [object Object]. Abwärtskompatibler Shim ist spezifiziert, muss aber konsequent eingebaut werden.
- Der Clean-Break (ADR-0003) hängt davon ab, dass JEDER noch WS-gebundene Hop-A-Handler (fs:*, templates*, lcscFootprintPreview, submitJob/quickDownload, checkComponentExists, validateLibrary, libraries_scaffold/validate/component, health/ping/list_tasks) auf Native-Verbs portiert wird. Dieser Vertrag definiert nur die Transport-Zielverben; die Portierung der library/component/health-Verben (nicht in meinem Area-Scope) muss separat spezifiziert werden, sonst bleibt der WS-Server faktisch nötig.
- Persistenter Port + Chrome-Service-Worker-Idle-Timeout (30s in MV3): Der Keep-Alive-Alarm (25s) hält den SW und damit den Port; fällt der Alarm aus (z.B. Browser drosselt Alarme), stirbt der SW, der Port disconnectet, der Python-Prozess wird gekillt → nächster Call hat wieder Kaltstart. Reconnect-Logik (host_disconnected → lazy reopen) fängt das funktional ab, aber der Speed-Vorteil ist dann punktuell weg.

**UI/UX — On-Page-Flow (LCSC-Seite):**
- Die Suggestion-Engine (Matching von Kategorie+Pin-Count+Paket auf Templates) ist NICHT Teil dieses UI-Bereichs, aber die gesamte Auto-Suggest-Präsentation (§U3) hängt von ihrem Eingabevertrag §U3.1 ab. Liefert die Engine kein confidence/reason-Feld, fällt die Badge-Präsentation in sich zusammen — der Vertrag muss mit dem Engine-Owner abgestimmt werden.
- KONZEPT.md referenziert an mehreren Stellen noch 'gRPC', während GROUND TRUTH Native Messaging vorschreibt. Dieser Spec liest alle RPC-Namen als Native-Host-RPCs; KONZEPT §5 sollte parallel aktualisiert werden, sonst entstehen widersprüchliche Quelldokumente.
- Das Footprint-SVG für die Pin↔Pad-Sub-UI (§U5) braucht einen Backend-RPC (renderFootprintSvg ODER Teil von listTemplates) — KONZEPT §13.3 lässt offen, welcher. Ohne diesen RPC kann die Sub-UI das klickbare Footprint nicht rendern.
- Die Disabled-Button-Matrix (§U1) setzt voraus, dass der Host-Status (online/offline/checking) und der Active-Library-Status zuverlässig und schnell (<500ms, KONZEPT §16) im Content-Script verfügbar sind. Verzögerte/flatternde Status-Ticks könnten Buttons unbeabsichtigt disablen und als 'kaputt' wahrgenommen werden.
- fetchDatasheet als separate RPC (§U6, d10) existiert im Backend noch nicht (KONZEPT §15.2 markiert Variante A nur als Empfehlung). Die Datasheet-Sektion bleibt bis dahin ein Platzhalter.
- Float-Fallback mit Shadow-DOM (§U1, d20) muss alle Dialog-/Panel-Sub-UIs (Modals via mountCsModal hängen an document.body, nicht im Shadow) korrekt einbinden — Modals aus dem Shadow-DOM-Kontext heraus zu mounten kann Z-Index-/Event-Probleme erzeugen, die getestet werden müssen.

**UI/UX — Popup, Settings & Datei-Picker:**
- R1 (blockierend für Picker): fs_roots/fs_list/fs_check existieren NUR im Legacy-WS-Server (server.py:719/760/808) und werden vom Picker über WS gerufen (popup.js:1762/1769, background.js:1589-1599). V3 droppt WS (Ground Truth). Ohne Portierung dieser drei Verben in den Native Host (D-PICK-1) ist der gesamte File-Explorer-Picker in V3 nicht funktionsfähig. Muss vor dem UI-Bau eingeplant werden.
- R2: Das erweiterte Rule-Datenmodell (D-RULES-1) muss vom Content-Script-categoryRuleMatcher (KONZEPT §4.4/§12) UND vom Override-Panel UND von Phase 2 (labelMap → template_merger) konsumiert werden. Schema-Drift zwischen Popup-Persistenz und Konsumenten ist ein reales Risiko; ein gemeinsames Rule-Schema-Modul (analog shared/categoryPath.mjs) sollte erzwungen werden.
- R3: Metadata-Label-'Suggest from this page' (D-RULES-6) braucht den letzten lcscPageSnapshot im Popup-Kontext. Das Popup hat ihn nicht automatisch — es müsste den Snapshot über background.js vom zuletzt aktiven LCSC-Tab anfordern. Wenn kein LCSC-Tab offen ist, fällt der Suggest-Button auf manuelle Eingabe zurück (Empty-State nötig).
- R4: 420px-Popup-Breite (D-UI-1) plus mehrspaltiger Label-Mapping-Tabelle (LCSC-Param | Symbol-Prop | show | ✕) wird eng. Lange LCSC-Parameternamen/Pfade brauchen Truncation+Tooltip; die Label-Tabelle ggf. als gestapelte Cards statt echter Tabelle bei <440px.
- R5: fs_check-Schreibrecht-Prüfung (D-PICK-5) ist auf Windows mit os.access(W_OK) (server.py:815) nur eingeschränkt verlässlich (ACLs/Network-Drives). 'writable=true' garantiert nicht erfolgreichen Write; der echte Fehler muss beim Library-Create trotzdem sauber abgefangen werden.
- R6: Theme-Konsistenz — der Override-Panel (Content-Script, separate ADR/Issue #5) und das Popup teilen sich keine CSS-Variablen. Light/Dark im Popup (D-SET-3) wirkt laut V2-Tooltip (popup.html:140) NICHT auf In-Page-Panels. Die Vision 'alles intuitiv/einheitlich' könnte hier visuell brechen; bewusste Entscheidung nötig, ob das akzeptabel ist.

**Installation & Distribution:**
- CI-Entry-Point-Bug ist release-blockierend: solange build-backend.yml run_server.py statt host.py friert, ist JEDES gebaute Host-Binary funktionsunfähig (kein NM-Protokoll). Höchste Prio.
- Web-Store-Extension-ID-Henne-Ei: bei einem NEUEN V3-Listing ist die ID erst nach erstem Upload bekannt; der erste auslieferbare Host-Installer (mit eingebrannter ID) kann erst danach gebaut werden. Reihenfolge im Release-Prozess festlegen.
- PyInstaller-Frozen-Import: host.py:45-47 fügt _REPO_ROOT zu sys.path — im Frozen-Modus zeigt das ins Leere. Wenn easyeda2kicad nicht korrekt mit-gecollected wird, startet der Host beim End-User, antwortet aber auf convert mit ModuleNotFoundError. Muss im CI-Build verifiziert werden (Ping reicht nicht, ein convert-Smoke ist nötig).
- Modus-Erkennung (Chrome-invoked vs Doppelklick) ist heuristisch über argv-Marker; falls Chrome auf einer OS-Variante andere Args übergibt, könnte der Host fälschlich in den Self-Register-Modus fallen (oder umgekehrt). Auf allen Ziel-OS verifizieren.
- Smart App Control / WDAC / AppLocker (Corporate-Windows) blockt unsignierte Binaries HART — auch Unblock+SmartScreen-Override hilft dann nicht (README.md:138). Für gemanagte PCs ohne Signing kein Self-Service-Weg; nur IT-Allowlist oder signiertes Binary.
- Manifest-allowed_origins-Mismatch (forbidden): wenn die eingebrannte ID nicht zur tatsächlich geladenen Extension passt (z.B. User lädt unpacked Dev-Build, Installer hat nur Web-Store-ID), schlägt connectNative mit forbidden fehl — braucht den eigenen Diagnose-Hinweis (§18.6), sonst verwirrender offline-Zustand.
- macOS/Linux NM-Manifest-Schreiben ist noch komplett unimplementiert (install.py:118 gated auf win32); Issue #13 muss die Pfad-Tabelle §18.7 umsetzen, sonst ist V3 de facto Windows-only.

**Repo-Cleanup:**
- background.js ist HYBRID (importScripts('extensionWsClient.js') @ background.js:5 noch aktiv + connectNative @ background.js:844). Löschen der WS-Extension-Dateien VOR der vollständigen Native-Messaging-Migration bricht popup+background. Cleanup-Commit darf diese 2 Dateien NICHT mit-löschen (siehe agentDecision CL-EXT).
- build-backend.yml baut pyinstaller run_server.py (3x: Zeilen 84/89/95) — nach Löschung von run_server.py bricht der Release-Build, bis Entry auf native_host umgestellt ist UND native_host PyInstaller-fähig ist (laut README Issue #13 noch offen).
- tests/test_extension_manifest.py validiert Manifest-Felder; das Anpassen von manifest.json (localhost:8087 raus, version, description) kann diesen Test rot färben, wenn nicht mit-angepasst.
- Category-Path-Normalisierung ist mehrfach implementiert (shared/categoryPath.mjs, src/content/categoryNormalize.js, helpers.py-Mirror, + DUP categoryPath.js) — Löschen von categoryPath.js löst nur einen Teil; volle Konsolidierung (CONTEXT.md:100 'Pending consolidation, Candidate 8') bleibt offene Architektur-Schuld.
- KONZEPT.md §5-TOC sagt 'gRPC-Backend' — Drift gegen DECIDED Native Messaging. Wenn nicht korrigiert, leitet das Master-Doc Implementierer in die falsche Transport-Richtung.
- requirements.txt listet fastapi+uvicorn nur für den gelöschten WS-Pfad; werden sie nicht entfernt, bleibt unnötige Dependency-/Angriffsfläche im PyInstaller-Bundle.
