# Entscheidungs-Log (aufgelöste 🔴-Fragen)

Laufendes Protokoll der vom Nutzer beantworteten Konzept-Fragen. Ergänzt den 🔴-Block in `KONZEPT.md`.

## Runde 1 — 2026-06-04

- **Repo/Branding (`UQ-BRANDING`)** → **Bestehendes Repo behalten.** Kanonische URL = `https://github.com/theautomatist/KiCad-Parts-Importer`. Dieser String wird in den AGPL-Generator-Eintrag jeder geschriebenen KiCad-Datei und in den Source-Link (README/Popup) eingebrannt. Entriegelt die AGPL-Hygiene im Cleanup.

- **Footprint-MVP (`Footprint-Template-Override`, `tq-1`/`tq-2`)** → **Symbol zuerst, Footprint + Pin↔Pad als Folge-Iteration.** V3-MVP liefert: Symbol-Override + Metadaten-Labels + Auto-Vorschlag + 3D-Carry-Over. Footprint-Template-Swap, Pin-Map-Sidecar und die klickbare Pin↔Pad-Sub-UI kommen als sauberer Folge-Slice. → Issue-Schnitt entsprechend priorisieren.

- **Regel-Editor-Tiefe (`Q-RULES-1`)** → **Voll.** Pro Kategorie: Symbol- + Footprint-Source, Pin-Count- + Bauform-Match, **editierbares Metadaten-Label-Mapping**, Ask/Auto. Das Daten-Modell wird von Anfang an für die volle Variante ausgelegt (UI darf inkrementell wachsen, aber die Regel-Struktur ist vollständig).

- **Auto-Apply-Modell (`q2`/`q3`/`UQ-3`)** → **Zwei-Phasen, Zwei-Klick. KEIN stiller Auto-Write, KEIN Countdown.**
  - **Setup-Phase** (erste Begegnung mit einer Kategorie/Bauteilklasse): statt sofortigem Import ein Einrichtungs-Schritt → Symbol/Footprint/3D + Metadaten-Label-Zuordnung festlegen, mit **„Übernehmen"** speichern (erzeugt/aktualisiert die Regel).
  - **Routine-Phase** (Regel existiert): **„Download"** → Dialog zeigt das vollständig aufgelöste Ergebnis (Symbol, Footprint, 3D, ggf. Datenblatt) → **„Bestätigen"** → sofortiger Import, falls nicht bereits in der Lib (Idempotenz: „bereits vorhanden").
  - **Konsequenz fürs Konzept:** Der „Skip-Panel-Flow" wird neu definiert — das Panel wird **nie vollständig übersprungen**, sondern in der Routine-Phase zum schnellen *Bestätigungs-Preview* (alles vorbefüllt, ein Blick + „Bestätigen"). Die §Auto-Selection/§UI-On-Page-Abschnitte sind beim Issue-Schnitt entsprechend zu interpretieren.

### Noch offen (für die Schluss-Review geparkt)
StdLib-Umfang + KiCad-Lib-Fork-Lizenz (`UQ-1`/`UQ-2`), Stock-Rule-Aggressivität (`UQ-3`-Beförderung), Package-Taxonomie-Reichweite (`UQ-4`), DE-only vs DE+EN (`q1`/`Q-UI-1`), Low-Confidence-Verhalten (`q3`), File-Explorer-Picker-Tiefe in V3 (`q4`), FS-Zugriffs-Scope (`Q-PICK-1`), Host-Threading (`Q1`), `fetchDatasheet`-Verb (`Q2`), 3D-Hash-Collision-Policy (`F-Q1`), Signing-Budget, Browser-Support, Web-Store-ID, Extension-Migrations-Reihenfolge (`UQ-EXT-MIGRATION-ORDER`), PyInstaller/CI (`UQ-PYINSTALLER`).
