# Entscheidungs-Log (aufgelöste 🔴-Fragen)

Laufendes Protokoll der vom Nutzer beantworteten Konzept-Fragen. Ergänzt den 🔴-Block in `KONZEPT.md`.

## Runde 3 — 2026-06-09 (Testlauf-Feedback, verfeinert ADR-0006)

Aus dem ersten echten End-to-End-Import abgeleitete Verfeinerungen. Diese **überschreiben** frühere Aussagen zum Metadaten-Mapping (Runde 1 `Q-RULES-1`, Ein-Klick-Schwelle unten):

- **Metadaten: kein manuelles Label-Mapping mehr.** Alle LCSC-Spec-Tabellen-Parameter werden beim Import **automatisch** als Symbol-Properties upsertet (existierendes Feld → Wert ersetzen, fehlendes → hinzufügen; Stock/Preis/Menge filtert der Scraper aus). Begründung des Nutzers: „alle Daten stehen ja in der Tabelle". Der editierbare Metadaten-Mapper entfällt; der Import-Editor zeigt stattdessen eine **read-only Property-Vorschau**. Die `ComponentRule` trägt kein `labelMapping` mehr (leer).
- **Confidence-Schwelle angepasst:** „Metadaten-Labels gemappt" entfällt als 🟢-Faktor (`labelsMapped` ist immer erfüllt, da auto). 🟢 = **Symbol-Template gematcht + Kategorie erkannt + hohe Confidence**. Behebt zugleich einen Bug, der die Lernschleife sonst dauerhaft auf 🟡 gehalten hätte.
- **Dialoge als Modal-Overlays:** ⚪ Register-Prompt **und** Import-Editor sind Modal-Overlays (abgedunkelter Hintergrund), nicht inline. 🟢/🟡 bleiben inline (Seitenfluss, kein Dialog).
- **Lernschleife-Fix:** registrierte Regel wird in `state.categorySettings` gespiegelt (nicht nur in den Native-Host-Store), damit der nächste Match sie findet.
- **Library-Management auf Native Host migriert:** Create (neuer `scaffoldLibrary`-Verb) + Import (`validateLibrary`) — die V2-WebSocket-Pfade (`libraries_scaffold`/`_validate`) waren tot. Picker-Buttons hängen jetzt am Native-Host-Status statt am toten WS-`connected`.

## Runde 1 — 2026-06-04

- **Repo/Branding (`UQ-BRANDING`)** → **Bestehendes Repo behalten.** Kanonische URL = `https://github.com/theautomatist/KiCad-Parts-Importer`. Dieser String wird in den AGPL-Generator-Eintrag jeder geschriebenen KiCad-Datei und in den Source-Link (README/Popup) eingebrannt. Entriegelt die AGPL-Hygiene im Cleanup.

- **Footprint-MVP (`Footprint-Template-Override`, `tq-1`/`tq-2`)** → **Symbol zuerst, Footprint + Pin↔Pad als Folge-Iteration.** V3-MVP liefert: Symbol-Override + Metadaten-Labels + Auto-Vorschlag + 3D-Carry-Over. Footprint-Template-Swap, Pin-Map-Sidecar und die klickbare Pin↔Pad-Sub-UI kommen als sauberer Folge-Slice. → Issue-Schnitt entsprechend priorisieren.

- **Regel-Editor-Tiefe (`Q-RULES-1`)** → **Voll.** Pro Kategorie: Symbol- + Footprint-Source, Pin-Count- + Bauform-Match, **editierbares Metadaten-Label-Mapping**, Ask/Auto. Das Daten-Modell wird von Anfang an für die volle Variante ausgelegt (UI darf inkrementell wachsen, aber die Regel-Struktur ist vollständig).

- **Auto-Apply-Modell (`q2`/`q3`/`UQ-3`)** → **Zwei-Phasen, Zwei-Klick. KEIN stiller Auto-Write, KEIN Countdown.**
  - **Setup-Phase** (erste Begegnung mit einer Kategorie/Bauteilklasse): statt sofortigem Import ein Einrichtungs-Schritt → Symbol/Footprint/3D + Metadaten-Label-Zuordnung festlegen, mit **„Übernehmen"** speichern (erzeugt/aktualisiert die Regel).
  - **Routine-Phase** (Regel existiert): **„Download"** → Dialog zeigt das vollständig aufgelöste Ergebnis (Symbol, Footprint, 3D, ggf. Datenblatt) → **„Bestätigen"** → sofortiger Import, falls nicht bereits in der Lib (Idempotenz: „bereits vorhanden").
  - **Konsequenz fürs Konzept:** Der „Skip-Panel-Flow" wird neu definiert — das Panel wird **nie vollständig übersprungen**, sondern in der Routine-Phase zum schnellen *Bestätigungs-Preview* (alles vorbefüllt, ein Blick + „Bestätigen"). Die §Auto-Selection/§UI-On-Page-Abschnitte sind beim Issue-Schnitt entsprechend zu interpretieren.

## Runde 2 — 2026-06-05

### Apply-Modell → Confidence-Zustandsautomat (**revidiert Runde-1 `q2`/Auto-Apply**)

Das Runde-1-Modell „Download → *dann* Bestätigen" (zwei sequenzielle Klicks) wird ersetzt durch einen **Confidence-getriebenen Zustandsautomaten** mit drei Zuständen. „Zwei-Klick" bedeutet ab jetzt **zwei Buttons nebeneinander**, nicht zwei aufeinanderfolgende Bestätigungen. Der 3-Sekunden-Countdown ist endgültig gestrichen.

| Zustand | Bedingung | Verhalten |
|---|---|---|
| 🟢 **Vollständig definiert** | Regel existiert, Metadaten + Template-Daten passen, hohe Confidence | **Ein Klick = sofort importieren** (kein Bestätigen, kein Countdown, Ergebnis sofort sichtbar). Zweiter Button **„Modifizieren"** → öffnet den Import-Editor für Sonderfälle. |
| 🟡 **Niedrige Confidence** | bekannt, aber Match unsicher | **In Settings einstellbar:** „Keep EasyEDA + Hinweis" *oder* Import-Editor öffnen. |
| ⚪ **Neu / unbekannt** | keine Regel | **Aktiver Prompt:** „Neues Bauteil — nur EasyEDA herunterladen *oder* registrieren?" |

- **„Registrieren"** = der Lern-Akt: Im Import-Editor ordnest du zu — Kategorie ↔ Bauteiltyp ↔ Symbol ↔ Footprint(s) ↔ 3D-Modelle und ihre Verknüpfung. Speichert eine **Regel** *und* erhöht die **Confidence** für künftige gleichartige Bauteile.
- **Ein-Klick-Schwelle (MVP, Symbol-first):** 🟢 greift, sobald **Symbol-Template gematcht + Kategorie erkannt + Metadaten-Labels gemappt** sind. Footprint/3D laufen im MVP über den EasyEDA-Default mit; Footprint/3D als Confidence-Treiber kommen mit dem Footprint-Folge-Slice.
- **Import-Editor = EINE wiederverwendbare Komponente** für alle drei Aufruf-Kontexte (Registrieren / Modifizieren / Low-Confidence). Ein Datenmodell, eine Test-Matrix. Zeigt Symbol/Footprint/3D + Verknüpfung, alles editierbar.
- **Idempotenz:** „Import" erkennt „bereits in Lib" → kein Doppel-Write (Zustand „bereits vorhanden").
- **EasyEDA-Roh-Pfad** bleibt überall als Escape (exakter V2-Workflow, kein Regressionsrisiko).

### Stock-Library — Umfang & Form (`UQ-1`, StdLib-Form)
- **Gekoppelt:** StdLib liefert kuratierte **Symbol + Footprint + 3D-Modell** zusammen (keine generische Entkopplung).
- **Quelle:** Der Owner sortiert aus seiner **realen, bereits umfangreich heruntergeladenen Sammlung** aus, was sich lohnt → das wird die StdLib. Bewusst **klein** gehalten, damit man sofort loslegen kann. (Diese Sammlung ist später auch der **Golden-File-Korpus** für die S1-Tests.)
- **Inhaltlicher Startumfang** orientiert sich am Konzept-Vorschlag (Resistor/Capacitor/Capacitor_Polarized/Inductor/Diode/LED + gängige Bauformen), final bestimmt durch die Kuratierung.
- **User-Souveränität:** Jeder User kann eine **eigene Template-Library** registrieren/nutzen, die StdLib in der Registrierung **austauschen**, oder StdLib-Einträge (pro Pfad/Bauteilkategorie) **löschen** und bei Null anfangen.

### Package-Taxonomie (`UQ-4`)
- **Beschränkt auf gängige SMD-Chip- + SOT/SOIC/QFN-Familien.** Alles andere fällt sauber auf den Trim-Fallback zurück (kein Package-Form-Match). Hält die Heuristik beherrschbar und pflegbar. Dient v.a. Matching/Confidence (LCSC-Package-String → passender Template-/Footprint-Eintrag).

### Stock-Rule-Aggressivität (`UQ-3`) & Low-Confidence (`q3`)
- **Keine automatische Beförderung auf 'auto'** — Stock-Rules bleiben auf 'suggest', User schaltet bewusst (konsistent mit dem Confidence-Modell oben).
- **Low-Confidence-Verhalten ist Setting-bar** (siehe 🟡 oben): „Keep EasyEDA + Hinweis" vs. Import-Editor.
- **Neue Bauteile** lösen aktiv den „registrieren?"-Prompt aus (siehe ⚪ oben).

### Lizenz (`UQ-2`, neu geframt)
- **Projekt bleibt AGPL-3.0** (verpflichtend, solange easyeda2kicad-Engine drin; erfüllt Owner-Wunsch „Open Source, Ursprung erhalten, niemand kann es proprietär zumachen").
- **„Nicht kommerziell" ist NICHT umsetzbar** und auch nicht nötig: AGPL/CC-BY-SA erlauben kommerzielle Nutzung, AGPL verhindert aber proprietäres Zumachen (faktischer „Abgreif-Schutz"). NC würde Engine-Neuschreiben + Symbole-Neuzeichnen erfordern und wäre nicht mehr Open Source.
- **StdLib-Herkunft:** Symbole = modifizierte **KiCad-Standard-Symbole** (CC-BY-SA 4.0, vom Owner um Labels erweitert) → Auslieferung mit `LICENSES/`-Ordner: CC-BY-SA-4.0-Attribution (KiCad + Autoren) + „modified by … on …"-Hinweis. Footprints + 3D = **EasyEDA** (faktische Daten) → nur eigener Generator-String (UQ-BRANDING).

### Sprache (`q1` / `Q-UI-1`)
- **DE-only für V3-Release, i18n-ready.** Copy-Deck-Key-Struktur bleibt vollständig i18n-fähig; EN (Spalte füllen + Sprachumschalter) kommt als saubere Folge-Iteration.

### Native Host & Backend (`Q1`, `Q2`, `F-Q1`)
- **Host-Threading (`Q1`): Multi-threaded.** Reader-Thread + Worker — schnelle read-only Verbs (listTemplates, renderFootprintSvg) werden auch während eines laufenden Convert bedient, damit der Import-Editor flüssig bleibt.
- **`fetchDatasheet` (`Q2`): Weglassen.** Der Service-Worker-Pfad genügt (Cookies, HTML-Shell-Recovery, 24-MB-Limit, Progress) und umgeht das 1-MB-Frame-Limit komplett.
- **3D-Handling (`F-Q1`, vom Owner präzisiert) — Reuse-First:**
  - **Reuse:** 3D-Datei existiert in `<ActiveLib>.3dshapes/` mit gleichem Name **und** Inhalt (Hash-Match) → direkt einbinden, **kein** Duplikat, kein Write.
  - **Kopieren:** Datei fehlt → aus Template-Verzeichnis bzw. EasyEDA (je nach Herkunft) in die aktive Lib kopieren.
  - **Echte Collision** (gleicher Name, anderer Inhalt): **Auto-Suffix-Kopie** `<basename>__<hash8>.step` + 3D-Ref umschreiben — Ein-Klick läuft durch, fremdes 3D wird weder überschrieben noch falsch wiederverwendet. (Setzt einen Active-Lib-Basename+Hash-Reuse-Check voraus; LibraryValidateResponse muss dafür Namen/Hashes liefern, nicht nur Counts.)

### Datei-Picker & FS-Sicherheit (`q4`, `Q-PICK-1`)
- **Picker-Tiefe (`q4`): Flaches Dropdown für MVP.** optgroup-Dropdown (Lib → Namen) für Symbol/Footprint-Auswahl + einfacher Ordner-Picker für den Library-Pfad. Voller hierarchischer Datei-Explorer (Baum, Breadcrumbs, Suche) kommt als Folge-Iteration.
- **FS-Zugriff (`Q-PICK-1`): Erlaubte Roots + hinzufügbar.** Start mit sinnvollen Roots (Documents, KiCad-Standardpfade); User fügt eigene Lib-Ordner explizit hinzu, danach voller Zugriff auf genau diese. Sicher + flexibel + store-freundlich. (Die fs_roots/fs_list/fs_check-Verben müssen dafür mit Root-Whitelist in den Native Host portiert werden.)

### Distribution (`signing-budget`, `browsers`, `webstore-id`)
- **Code-Signing: Unsigniert ($0).** Einmaliger SmartScreen/Gatekeeper-Hinweis beim Self-Register-Doppelklick. Hinweis: Corporate-Windows (Smart App Control/WDAC/AppLocker) blockt unsigniert hart → dort nur IT-Allowlist. Re-evaluierbar, sobald Mac-Basis/Reputation es lohnt.
- **Browser: Nur Chrome** offiziell getestet/supported. Edge/Brave funktionieren evtl. (Brave liest unter Windows den Chrome-HKCU-Key), werden aber nicht getestet. Firefox bewusst außen vor. Kleinste Test-Matrix.
- **Web-Store: Neues V3-Listing** (eigene Extension-ID, V2 wird depubliziert — Clean Break, ADR-0003). Konsequenz für den Release-Prozess: ID erst nach erstem Upload bekannt → erster auslieferbarer Installer (eingebrannte allowed_origins) wartet darauf; lokaler Dev-Build nutzt eine via `key` fixierte ID.

### Build- & Cleanup-Zeitplan (`UQ-EXT-MIGRATION-ORDER`, `UQ-PYINSTALLER`)
- **Extension-Migration (`UQ-EXT-MIGRATION-ORDER`): Getrennt, eigener Issue.** WS-Extension-Dateien (extensionWsClient.js, categoryPath.js) bleiben, bis die Native-Messaging-Migration als eigener, getesteter Issue durch ist. Vermeidet popup/background-Bruch durch den hybriden background.js.
- **PyInstaller/CI (`UQ-PYINSTALLER`): Geparkt bis Release-Nähe.** build-backend.yml bleibt deaktiviert/workflow_dispatch-only. #13 wird angegangen, wenn der MVP steht und ein auslieferbares Binary gebraucht wird (inkl. Frozen-Import-Verifikation via convert-Smoke). Blockiert die Feature-Arbeit nicht.

### ✅ Alle 🔴-Fragen geklärt
Sämtliche 22 geparkten user-only-Fragen aus `KONZEPT.md §9` sind nun in Runde 1 + Runde 2 entschieden. Keine offenen Konzept-Fragen mehr.

### Folge-Arbeiten, die sich aus Runde 2 ergeben
1. ✅ **KONZEPT.md synchronisiert** (2026-06-05) — Apply-Modell auf den Confidence-Zustandsautomaten umgestellt (66 Edits über §0–§10/§U, 3 sequenzielle Editor-Agenten + 3 adversarielle Reviewer). Entfernt: `autoApply`/`autoConfirm`/`action`-Felder, §3.5+§U3.4 Skip-Panel, „Always show panel"-Master-Toggle, Countdown, `forcePanel`. Neu: `computeConfidenceState` (§3.5), `state: green/yellow/white` in MatchResult, 🟡-Low-Confidence-Setting, Button „Modifizieren", `k2c.header.{green,yellow,white}`-Keys. gRPC-Drift war im finalen KONZEPT bereits abwesend (Transport durchgängig Native Messaging). `'suggesting'`-State + `overridePanel.js`-Begriff bewusst erhalten.
2. ✅ **ADR-0006** geschrieben — `docs/adr/0006-confidence-driven-apply-model.md` (kanonische Referenz; benennt explizit, was es ersetzt).
3. ✅ **Issue-Schnitt erledigt** (2026-06-06) — Symbol-first-MVP in 9 Tracer-Bullet-Slices geschnitten (Ist-Stand per 6-Agenten-Workflow kartiert) und als GitHub-Issues angelegt. CONTEXT.md-Glossar zuvor auf ADR-0006 synchronisiert (Customize→Modify, Skip-Panel→Confidence State, neu: Import-Editor/Register).
   - **#24** FS-Verben + Library-Picker · **#25** Confidence-Pipeline + ⚪-Register-Prompt · **#26** Multi-Threading + Warm-Port · **#27** Package-Form + Taxonomie · **#28** Registrieren→Symbol-Template-Rule (←#25) · **#29** 🟢 Ein-Klick (←#28) · **#30** Rule-Schema-Migration (←#28) · **#31** 🟡 Low-Confidence + Setting (←#29,#27) · **#32** StdLib-Seed (←#28,#29, HITL)
   - **Folge-Slices (nicht MVP):** Footprint-Template-Swap, Pin↔Pad-Sidecar+Sub-UI, 3D-Carry-Over (Reuse-First), voller Datei-Explorer, EN-Lokalisierung.
4. **Cleanup-Rest entriegelt:** AGPL-Generator-String-Hygiene (Branding + Lizenz nun entschieden) — eigener kleiner Slice.
