# Plan: Template-Auswahl per Download-Dropdown + Pin-Inkompatibilitäts-Dialog

## Ziel

- **Entfernen:** Kategorie-basierte Template-Vorauswahl in den Settings (pro Kategorie ein festes Template).
- **Neu:** Beim Klick auf „Download (Template)“ öffnet sich ein Dropdown mit Suche; Nutzer wählt ein Template aus allen als Template markierten Bibliotheken.
- **Neu:** Wenn das gewählte Template mehr oder weniger Pins hat als das EasyEDA-Original: Hinweis im Progress-Bereich + zwei Buttons: „Continue (with pin incompatibility, manual fix required)“ bzw. „Download EasyEDA model“.

---

## 1. Backend

### 1.1 Template-Symbolliste aus mehreren Bibliotheken

- **Aktuell:** `GET /templates/symbols?lib_path=...` liefert Symbole **einer** Bibliothek; Extension nutzt nur **eine** als Template markierte Lib (`getTemplateLibraryPath()`).
- **Neu:** Extension kann mehrere Libs als „Template“ markieren. Backend braucht eine API, die aus **mehreren** Pfaden alle Symbolnamen aggregiert (ohne Duplikate), optional mit Lib-Herkunft für die Anzeige.

**Vorschlag:**

- Neuer Endpoint: `POST /templates/symbols/batch`  
  - Body: `{ "lib_paths": ["path1.kicad_sym", "path2.kicad_sym"] }`  
  - Response: `{ "symbols": ["Sym1", "Sym2", ...], "by_lib": { "path1.kicad_sym": ["Sym1"], "path2.kicad_sym": ["Sym2", "Sym3"] } }`  
  - Oder: `GET /templates/symbols?lib_path=path1&lib_path=path2` (mehrfacher Query-Parameter).
- Bestehenden `GET /templates/symbols?lib_path=...` beibehalten für eine einzelne Lib (z. B. für Abwärtskompatibilität oder einfache Fälle). Extension ruft dann für **alle** Template-Libs `templates/symbols` auf und aggregiert selbst, **oder** nutzt den neuen Batch-Endpoint.

**Entscheidung:** Einfachste Variante: Extension ruft für jede Template-Lib einmal `GET /templates/symbols?lib_path=...` auf und merged die Listen (Duplikate nach Namen entfernen). Kein neuer Backend-Endpoint nötig. Optional: später Batch-Endpoint für weniger Roundtrips.

### 1.2 Pin-Check vor der Konvertierung

- **Neu:** Endpoint, der **ohne** vollständige Konvertierung prüft: Wie viele Pins hat das EasyEDA-Symbol? Wie viele Pins hat das gewählte Template?
- **Zweck:** Extension ruft diesen nach Auswahl eines Templates auf; bei Abweichung zeigt sie den Pin-Inkompatibilitäts-Dialog.

**Vorschlag:**

- Neuer Endpoint: `POST /templates/pin-check` (oder `GET` mit vielen Query-Parametern; POST ist lesbarer).  
  - Body: `{ "lcsc_id": "C12345", "template_name": "MyResistor", "template_lib_path": "C:/path/to/Templates.kicad_sym" }`  
  - Backend:
    1. EasyEDA-Daten für `lcsc_id` laden (wie bei Konvertierung).
    2. EasyEDA-Symbol parsen, **Anzahl Pins** des primären Symbols ermitteln (`len(primary_symbol.pins)` o. ä.).
    3. Template aus `template_lib_path` lesen (`extract_symbol_from_lib`), Symbol-String parsen und **Anzahl** `(pin ...)`-Blöcke zählen (nur Top-Level im Symbol, keine Sub-Units verwechseln).
    4. Response: `{ "easyeda_pin_count": 2, "template_pin_count": 2, "match": true }` bzw. `match: false` bei Abweichung.

- **Hilfsfunktion Backend:** In `helpers.py` oder `template_merger.py`: `count_pins_in_symbol_string(symbol_str: str) -> int` (z. B. Regex für `(pin ` in dem extrahierten Symbol-Block).

### 1.3 Konvertierung mit „Template erzwingen“ (kein Fallback auf EasyEDA)

- **Aktuell:** Wenn Template gewählt ist, aber z. B. nicht gefunden wird, fällt die Konvertierung auf das EasyEDA-Symbol zurück.
- **Neu:** Wenn der Nutzer im Pin-Inkompatibilitäts-Dialog „Continue (with pin incompatibility…)“ wählt, soll **ausschließlich** das Template verwendet werden (kein Fallback). Dazu ein Flag im Request, z. B. `force_template: true`. Backend verhält sich dann so:
  - Bei `force_template: true`: Nur Template-Export; wenn Template fehlt oder Merge fehlschlägt → Fehler zurückgeben statt auf EasyEDA zu wechseln.
  - Bestehendes Verhalten bleibt bei `force_template: false` bzw. wenn nicht gesetzt.

- **TaskCreatePayload / ConversionRequest:** Neues optionales Feld `force_template: bool = False`. In `conversion.py` im Symbol-Export: Wenn `use_template` und `force_template`, nach fehlgeschlagenem Template **nicht** in den LCSC-Export fallen, sondern Fehler melden.

---

## 2. Chrome Extension

### 2.1 Settings: Template-Spalte / -Zeile pro Kategorie entfernen

- **Popup (Settings-Tab):** In der Kategorie-Tabelle die Spalte „Template“ und das Template-Dropdown (inkl. Status-Punkt) entfernen.
- **popup.js:**  
  - Beim Aufbau der Kategorie-Zeilen (`buildCategoryItem`) den Block „Template select + status dot“ entfernen.  
  - `readCategoryTableState` / `saveCategoryTableState`: Feld `templateName` aus den Kategorie-Einstellungen entfernen (oder ignoriert lassen).  
  - `updateCatSummary`: Logik für `has-template` (Rahmenfarbe) entfernen.
- **popup.css:** Styles für `.template-name-select`, `.template-status-dot`, `.cat-item.has-template` können entfallen oder drin bleiben (ohne Nutzung).
- **background.js:**  
  - `getCategorySettings` / gespeicherte `categorySettings` weiterhin für `hidePinNumbers`, `hidePinNames`, `valueParam` nutzen; **kein** `templateName` mehr pro Kategorie.  
  - Defaults in `DEFAULT_CATEGORY_SETTINGS`: `templateName` aus den Presets (Resistors, Capacitors, Inductors) entfernen.

### 2.2 Template-Liste aus allen Template-Bibliotheken

- **Aktuell:** Es gibt genau eine „Template-Bibliothek“ (`getTemplateLibraryPath()`); `state.templateSymbols` kommt von dieser einen Lib.
- **Neu:** **Alle** Bibliotheken mit `isTemplateLibrary === true` berücksichtigen. Für jede solche Lib die Symbol-Liste holen und zu einer gemeinsamen Liste zusammenführen (z. B. Set von Namen, sortiert; Duplikate nur einmal anzeigen). Optional: pro Symbol speichern, aus welcher Lib es stammt (für `template_lib_path` beim Aufruf).

- **background.js:**  
  - Statt `getTemplateLibraryPath()` (eine Lib): `getTemplateLibraryPaths()` → Array aller `library.symbolPath || library.path` wo `library.isTemplateLibrary`.  
  - `refreshTemplateStatus`: Für **jede** Template-Lib `GET /templates/symbols?lib_path=...` aufrufen; Ergebnisse zusammenführen. Speichern als `state.templateSymbols` (Liste eindeutiger Namen) und optional `state.templateSymbolsByLib: { [libPath]: string[] }`, damit die Extension beim Download die richtige `template_lib_path` mitschicken kann.  
  - Beim Senden des Konvertierungs-Jobs: `template_lib_path` muss die Lib sein, in der das **gewählte** Template liegt. Dafür entweder in der UI pro Symbol die Lib mitführen oder Backend ermittelt die Lib (z. B. erste Lib, in der das Symbol vorkommt). Einfachste Variante: Pro Template-Eintrag im Dropdown `{ name, libPath }` speichern; bei Auswahl wird `templateName` und `template_lib_path` gesetzt.

### 2.3 Download-Button: „Download (Template)“ mit Dropdown + Suche

- **Aktuell:** Pro Kategorie werden feste Buttons gebaut (z. B. „Template“, „LCSC“, ggf. „Polarized“/„Non-Polar.“). Template-Button nutzt das in den Settings hinterlegte Kategorie-Template.
- **Neu:**  
  - Immer mindestens zwei Optionen: **„Download (Template)“** und **„Download (LCSC)“** (oder „Download / LCSC“). Keine kategorieabhängige Vorauswahl eines Templates.  
  - Klick auf **„Download (Template)“** öffnet ein **Dropdown** (unter dem Button oder als Modal):  
    - **Oben:** Suchfeld (Filter nach Symbolname).  
    - **Darunter:** Liste aller verfügbaren Template-Symbole (aus allen Template-Libs). Einträge z. B. „Symbolname (Lib-Name)“ oder nur Symbolname; bei Klick wird dieses Template gewählt und der eigentliche Download gestartet.

- **contentScript.js:**  
  - `buildDlOptions`: Unabhängig von Kategorie immer mindestens `[{ subLabel: "LCSC", ... }, { subLabel: "Template", useTemplate: true, templateName: null }]`. Beim zweiten Eintrag wird kein festes `templateName` gesetzt; stattdessen wird beim Klick „Template“ ein Dropdown geöffnet.  
  - Neues UI-Element: Dropdown-Container (z. B. unter der Button-Gruppe), mit Input (Suche) und scrollbarer Liste. Liste wird aus `state.templateSymbols` (oder der erweiterten Liste mit Lib-Info) gefüllt; Filterung beim Tippen. Bei Klick auf einen Eintrag: `templateName` und `template_lib_path` setzen und **Pin-Check** aufrufen (siehe 2.4).  
  - Wenn **keine** Template-Libs existieren oder die Liste leer ist: „Download (Template)“ ausblenden oder disabled anzeigen mit Tooltip „Mark a library as template in Settings“.

### 2.4 Pin-Check und Pin-Inkompatibilitäts-Dialog

- **Ablauf:**  
  1. Nutzer wählt im Template-Dropdown ein Symbol und klickt es an.  
  2. Extension ruft Backend `POST /templates/pin-check` mit `lcsc_id`, `template_name`, `template_lib_path` auf.  
  3. **Falls** `match === true`: Direkt Konvertierung starten (wie bisher mit `use_template: true`, `template_name`, `template_lib_path`).  
  4. **Falls** `match === false`: **Keine** Konvertierung starten, sondern im **Progress-Bereich** (der gleiche, der für Fortschritt genutzt wird) eine Meldung anzeigen, z. B.:  
     „Template has X pins, EasyEDA symbol has Y pins. Pin count differs – manual fix may be required.“  
     Zwei Buttons:  
     - **„Continue (with pin incompatibility, manual fix required)“** → Konvertierung mit `use_template: true`, `template_name`, `template_lib_path`, **`force_template: true`**.  
     - **„Download EasyEDA model“** → Konvertierung mit `use_template: false` (normale LCSC/EasyEDA-Export).

- **contentScript.js:**  
  - Nach Auswahl im Template-Dropdown: Funktion `onTemplateSelected(lcscId, templateName, templateLibPath)`.  
    - Zuerst `POST /templates/pin-check` (über background, der den API-Call macht).  
    - Bei Pin-Match: `handleDownloadClick(..., { useTemplate: true, templateName, templateLibPath })`.  
    - Bei Pin-Mismatch: Progress-Row sichtbar machen, Fortschrittsbalken auf „neutral“ oder „Warnung“, Text wie oben, zwei Buttons einblenden; bei Klick auf „Continue…“ → `handleDownloadClick` mit `force_template: true` und Template-Parametern; bei „Download EasyEDA model“ → `handleDownloadClick` mit `useTemplate: false`.  
  - `handleDownloadClick` und die Nachricht an den Background um `forceTemplate: true/false` erweitern.  
  - Backend-Payload (background → Server): Neues Feld `force_template` mitschicken.

### 2.5 Background: quickDownload und createTask

- **background.js:**  
  - Beim Erzeugen des Task-Payloads (`submitJob` / body für `POST /tasks`) das neue Feld `force_template: Boolean(payload.forceTemplate)` hinzufügen.  
  - `quickDownload`-Handler: Wenn die Nachricht vom Content-Script `forceTemplate` enthält, durchreichen.  
  - Optional: Neue Nachricht `templatesPinCheck` für den Pin-Check (lcsc_id, template_name, template_lib_path) → Background ruft `POST /templates/pin-check` auf und gibt Ergebnis zurück.

---

## 3. API-Server (FastAPI)

- **Neuer Endpoint** `POST /templates/pin-check`: Siehe 1.2.  
- **ConversionRequest / TaskCreatePayload:** Feld `force_template: bool = False` ergänzen und in der Konvertierungslogik auswerten (1.3).  
- **Optional:** `POST /templates/symbols/batch` wie in 1.1, falls man Roundtrips reduzieren will; sonst nur mehrere GET-Aufrufe von der Extension.

---

## 4. Kurzfassung der Änderungen nach Komponente

| Komponente | Änderung |
|------------|----------|
| **Backend conversion.py** | `force_template` unterstützen; bei `force_template` und Template-Fehler keinen LCSC-Fallback. |
| **Backend helpers.py oder template_merger.py** | `count_pins_in_symbol_string(symbol_str)` implementieren. |
| **Backend api/server.py** | `POST /templates/pin-check`; Request-Model um `force_template` erweitern. |
| **Extension popup.js/css** | Template-Spalte und -Dropdown in Kategorie-Settings entfernen; ggf. CSS aufräumen. |
| **Extension background.js** | Mehrere Template-Libs: `getTemplateLibraryPaths()`, `refreshTemplateStatus` für alle; `templateSymbolsByLib`; Pin-Check-Nachricht + API-Call; `force_template` in Payload. |
| **Extension contentScript.js** | Download-Buttons: immer „Template“ + „LCSC“; bei „Template“ Dropdown mit Suche; bei Template-Auswahl Pin-Check; bei Mismatch Progress-UI mit zwei Buttons; `handleDownloadClick` um `forceTemplate` erweitern. |

---

## 5. Reihenfolge der Implementierung (Vorschlag)

1. **Backend:** `count_pins_in_symbol_string` + `POST /templates/pin-check`; dann `force_template` in Request und conversion.py.
2. **Extension background:** Mehrere Template-Libs laden; `templateSymbolsByLib`; Pin-Check-Message; `force_template` in submitJob.
3. **Extension popup:** Template aus Kategorie-Settings entfernen.
4. **Extension contentScript:** Button „Download (Template)“ mit Dropdown + Suche; Pin-Check nach Auswahl; Pin-Mismatch-UI mit zwei Buttons; Anbindung an bestehenden Download-Flow.

Damit ist der Ablauf vollständig geplant und kann schrittweise umgesetzt werden.
