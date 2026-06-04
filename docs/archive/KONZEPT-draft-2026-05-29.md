# Konzeptpapier — KiCad Parts Importer

**Status:** Konzept · Stand 2026-05-29
**Zweck:** Vollständige Spezifikation aller Features und technischen Details, sodass dieses Tool eins-zu-eins nachgebaut werden kann.
**Leitprinzip:** *Keep it stupid simple* — jede Komponente und jedes Feature wird in der einfachsten Variante umgesetzt, die ihren Zweck erfüllt. Mehrwege-Logik, Job-Queues, Multi-Subscriber-Busse, Konfigurations-Hebel werden bewusst weggelassen.

> **Konventionen in diesem Dokument**
>
> - **Domain-Begriffe** (`Anchor Card`, `Override Panel`, `Phase 1 Fetch`, …) sind kursiv oder fett und werden in §2 definiert. Sie sind load-bearing — Code und Commit-Messages benutzen exakt diese Namen.
> - Abschnitte mit **🟡 OFFEN** beschreiben Punkte, an denen mehrere Wege denkbar sind. Jede offene Stelle nennt die Optionen, das Trade-off und eine vorläufige Empfehlung.
> - Inputs/Outputs jedes Features sind explizit aufgeführt, damit das Feature isoliert nachgebaut werden kann.

---

## Inhaltsverzeichnis

1. [Produktvision](#1-produktvision)
2. [Glossar — Domain-Sprache](#2-glossar--domain-sprache)
3. [System-Architektur](#3-system-architektur)
4. [Komponente: Chrome-Extension](#4-komponente-chrome-extension)
5. [Komponente: Lokaler Service (gRPC-Backend)](#5-komponente-lokaler-service-grpc-backend)
6. [Feature-Block A — DOM-Integration auf LCSC](#6-feature-block-a--dom-integration-auf-lcsc)
7. [Feature-Block B — Phase 1 Fetch (Metadaten)](#7-feature-block-b--phase-1-fetch-metadaten)
8. [Feature-Block C — Override Panel](#8-feature-block-c--override-panel)
9. [Feature-Block D — Phase 2 Conversion](#9-feature-block-d--phase-2-conversion)
10. [Feature-Block E — Template-System](#10-feature-block-e--template-system)
11. [Feature-Block F — 3D-Layer](#11-feature-block-f--3d-layer)
12. [Feature-Block G — Category Rules + Skip-Panel-Flow](#12-feature-block-g--category-rules--skip-panel-flow)
13. [Feature-Block H — Pin↔Pad-Map](#13-feature-block-h--pinpad-map)
14. [Feature-Block I — Overwrite-Handling](#14-feature-block-i--overwrite-handling)
15. [Feature-Block J — Datasheet-Preview](#15-feature-block-j--datasheet-preview)
16. [Feature-Block K — Backend-Status & Pre-Warm](#16-feature-block-k--backend-status--pre-warm)
17. [Konfiguration & Persistenz](#17-konfiguration--persistenz)
18. [Installation & Distribution](#18-installation--distribution)
19. [Sicherheit & Datenschutz](#19-sicherheit--datenschutz)
20. [Test-Strategie](#20-test-strategie)
21. [Offene Fragen (gesammelt)](#21-offene-fragen-gesammelt)

---

## 1. Produktvision

### 1.1 Was das Tool ist

Eine Chrome-Extension plus lokaler Service, die genau eine Aufgabe übernimmt: **Ein Bauteil von einer LCSC-Produktseite mit einem Klick in eine KiCad-Bibliothek importieren**, inklusive Symbol, Footprint, 3D-Modell und Metadaten.

### 1.2 Zielgruppe

Hobby- und Profi-Hardware-Entwicklerïnnen, die KiCad nutzen und LCSC als Distributor verwenden. Power-User-Flow ist der Default: nach ein paar Imports kennt das Tool die Kategorien und Templates des Users und liefert eine echte **One-Click-Experience** für wiederkehrende Bauteil-Klassen.

### 1.3 Leitprinzipien

| Prinzip | Konsequenz |
|---|---|
| **Keep it stupid simple** | Keine Job-Queue, kein Multi-Tab-Coordinator, keine Multi-Sub-Bus-Architektur. Ein Klick → eine Anfrage → eine Antwort. |
| **Keine manuelle Backend-Verwaltung** | Der User startet nichts. Nach Installation kümmert sich das System selbst um den Backend-Lifecycle. |
| **Eine Import-Modus, viele Overrides** | Es gibt nicht „EasyEDA-Modus vs. Template-Modus". Es gibt einen einzigen Flow, in dem der User pro Layer (Symbol/Footprint) optional einen Override wählt. |
| **Always Re-Resolve** | Templates werden bei jedem Import frisch von Disk gelesen. Keine Snapshots, keine versteckte Versionierung. Der User editiert seine `.kicad_sym`/`.kicad_mod` in KiCad und sieht die Änderung beim nächsten Import. |
| **Inline statt Modal** | Alle Entscheidungen, die der User treffen muss, passieren im **Override Panel** direkt unter dem Bauteil-Header auf der LCSC-Seite. Keine Modal-Kaskaden, keine separaten Dialoge. |
| **DOM-Robustheit zuerst** | LCSC ändert sein Markup. Wir verankern uns an einem **strukturellen Anchor** (die LCSC-Nummer in einer Header-Tabelle), nicht an CSS-Klassen. Bei Fehlschlag: Float-Panel als Fallback, nicht Render-Skip. |

### 1.4 Was das Tool nicht ist

- **Kein Multi-User-System.** Single-Machine, Single-Chrome-Profile.
- **Kein Marketplace.** Templates sind Dateien auf der lokalen Disk des Users, nicht in einer Cloud.
- **Kein EasyEDA-Fork.** Wir verlassen uns auf die EasyEDA-API und ersetzen Layer nur, wenn der User explizit eine bessere lokale Version hat.
- **Keine Conversion-Engine ohne Browser.** Der Trigger ist immer ein Klick auf einer LCSC-Seite. Eine CLI-Variante ist ausdrücklich out-of-scope.

---

## 2. Glossar — Domain-Sprache

Diese Begriffe sind verbindlich. Code, Commit-Messages und Architektur-Diskussionen benutzen exakt diese Namen.

| Begriff | Definition |
|---|---|
| **Extension** | Die Chrome-Extension (Manifest V3). Drei Surfaces teilen sich einen gRPC-Channel: **Service Worker** (`background.js`), **Popup** (`popup.html`/`popup.js`) und **LCSC Content Script**. |
| **LCSC-Produktseite** | Dritt-Seite unter `lcsc.com/product-detail/...`, die vom Content-Script augmentiert wird. |
| **Lokaler Service** | Lokal installierter Backend-Prozess, der die Conversion durchführt und gRPC spricht. Replaces V2's `run_server.py`. Lebenszyklus: vom System verwaltet, vom User nicht zu starten. Siehe §5. |
| **gRPC-Channel** | Bidirektionale Kommunikation zwischen Extension und Lokaler Service. Liefert RPCs für Metadaten-Fetch, Conversion und Template-Listing; streamt Progress-Events. Siehe §3.2. |
| **Anchor Card** | Die Header-Tabelle auf jeder LCSC-Produktseite, die u.a. `LCSC-Nr.`, `Hersteller`, `Herst.-Teilenr.` enthält. In diese Tabelle wird ein neues `<tr>` mit den Tool-Controls injiziert. |
| **Float Fallback** | Festes Floating-Panel, das angezeigt wird, wenn der Anchor-Walk null liefert. |
| **Download-Button** | Primärer Trigger, sichtbar im injizierten `<tr>`. Startet den Default-Import-Flow. |
| **Customize-Button** | Sekundärer Trigger neben Download. Zwingt das Override Panel zur Anzeige, auch wenn eine Category Rule sonst skippen würde. |
| **Phase 1 Fetch** | Schnelle Metadaten-RPC (~1 s). Liefert *Category Path*, *Pin Count*, *Datasheet-URL*, *Manufacturer*, *MPN* sowie die Kennzeichen, ob das Bauteil schon in der Active Library existiert. Pulled keine Symbol-/Footprint-/3D-Daten. |
| **Phase 2 Conversion** | Slow-RPC (~5–10 s). Schreibt Symbol + Footprint + (3D) in die Active Library. Streamt `progress`-Events. Zwei Execution-Modes: **EasyEDA Pipeline** und **Template-Assembly**. |
| **Override Panel** | Inline-UI zwischen Phase 1 und Phase 2. Erlaubt Symbol-Source-Wahl, Footprint-Source-Wahl, Pin↔Pad-Konfirmation, Overwrite-Warning, Datasheet-Vorschau. Single source of truth für alle User-Entscheidungen. |
| **Skip-Panel-Flow** | Default-Verhalten für wiederkehrende Imports: wenn eine Category Rule den Flow voll auflöst (Symbol-Source + Footprint-Source + auto-confirm-Flag + Pin-Count passt), wird das Panel übersprungen und Phase 2 läuft direkt. |
| **Active Library** | Die eine in den Settings markierte KiCad-Bibliothek. Alle Imports landen hier. Pfad: `<dir>/<name>.kicad_sym` plus Sibling `<dir>/<name>.pretty/` für Footprints und `<dir>/<name>.3dshapes/` für 3D-Modelle. |
| **Template Library** | Eine vom User markierte KiCad-Bibliothek, deren Symbole + Footprints als Override-Quellen verwendbar sind. Mehrere Template-Libraries möglich. |
| **Template-Layer** | Ein einzelner Override-Layer (Symbol oder Footprint), referenziert per `(libPath, name)`. Symbol und Footprint sind unabhängige Layer — es gibt keine „compound entry". |
| **Pin-Map Sidecar** | JSON-Datei unter `<TemplateLibrary>/pin_maps/<symbol>__<footprint>.json`, die die Pin↔Pad-Zuordnung für ein konkretes (Template-Symbol, Template-Footprint)-Paar speichert. |
| **3D Layer** | Implizite dritte Override-Schicht. **Folgt dem Footprint**: kommt der Footprint aus einem Template, kommt auch das 3D aus dem Template (Carry-Over); ist der Footprint EasyEDA, kommt EasyEDA-3D mit. Nicht user-overridbar. |
| **Template-3D Carry-Over** | Kopier-/Rewrite-Mechanik: 3D-Files, die ein Template-Footprint referenziert, werden in `<ActiveLib>.3dshapes/` kopiert (idempotent, content-hash-dedupliziert) und die Reference im geschriebenen Footprint wird auf `${KIPRJMOD}/<ActiveLib>.3dshapes/...` umgeschrieben. System-Variablen-Pfade (`${KICAD9_3DMODEL_DIR}`, `${KISYS3DMOD}`) werden verbatim gelassen. |
| **Template-Assembly** | Phase-2-Mode, der greift, wenn **beide** Layer Template sind und der Template-Footprint sein eigenes 3D mitbringt. EasyEDA wird in diesem Fall gar nicht aufgerufen; Phase-1-Metadaten liefern die Symbol-Properties. |
| **Category Rule** | Popup-gespeicherter Regelsatz mit Key = normalisierter *Category Path*, gespeicherten Default-Werten für Symbol-Source, Footprint-Source und einem `autoConfirm`-Flag. Matching erfolgt per **deepest-prefix** gegen die Phase-1 Category Path. |
| **Category Path** | Kanonische Normalform der LCSC-Breadcrumb. Slash-getrennt, segments trimmed, Unicode NFC, kein leading/trailing slash. Beispiel: `Passives/Resistors/SMD`. |
| **LCSC Page Snapshot** | Frozen-View der DOM-Daten, die für einen Import gebraucht werden: LCSC-ID, Breadcrumb, Attribut-Tabellen-Werte, Datasheet-URL. Wird pro Trigger neu extrahiert; keine MutationObserver-Abos. |
| **Always Re-Resolve** | Verbindliche Policy: Templates werden bei jedem Import frisch von Disk gelesen. Keine Caches, kein Versions-Pinning. |
| **Pre-Warm** | Mechanismus, der den Lokalen Service schon beim Page-Load der LCSC-Seite anwirft, damit er beim ersten Klick warm ist. |

---

## 3. System-Architektur

### 3.1 Komponenten-Diagramm

```
┌────────────────────────────────────────────────────────────────────┐
│                       Chrome-Extension (MV3)                       │
│                                                                    │
│   ┌──────────────┐   ┌────────────────┐   ┌──────────────────┐     │
│   │   Popup      │   │ Content Script │   │  Service Worker  │     │
│   │ (Settings/   │   │ (LCSC injection│   │  (gRPC client)   │     │
│   │  Library /   │   │  + Override    │   │                  │     │
│   │  Categories) │   │  Panel + …)    │   │                  │     │
│   └──────┬───────┘   └────────┬───────┘   └────────┬─────────┘     │
│          │                    │                    │               │
│          └────── chrome.runtime.sendMessage ───────┤               │
│                                                    │               │
└────────────────────────────────────────────────────┼───────────────┘
                                                     │
                                       gRPC-Web / HTTP/2 (loopback)
                                                     │
┌────────────────────────────────────────────────────┼───────────────┐
│                  Lokaler Service (Single-Binary)   │               │
│                                                    ▼               │
│       ┌──────────────────────────────────────────────────┐         │
│       │  gRPC-Server (loopback, 127.0.0.1:<random|fix>)  │         │
│       └──────┬────────────────────────────────────┬──────┘         │
│              │                                    │                │
│   ┌──────────▼─────────┐               ┌──────────▼────────┐       │
│   │  Phase-1 Fetcher   │               │  Phase-2 Pipeline │       │
│   │  (LCSC + EasyEDA   │               │  (EasyEDA convert │       │
│   │   Metadata)        │               │   + override +    │       │
│   │                    │               │   3D + write)     │       │
│   └────────────────────┘               └─────────┬─────────┘       │
│                                                  │                 │
│                              ┌───────────────────▼───────────────┐ │
│                              │   KiCad File Writer               │ │
│                              │   (.kicad_sym / .pretty/ /        │ │
│                              │    .3dshapes/ / pin_maps/)        │ │
│                              └───────────────────────────────────┘ │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                ┌─────────────────────────────┐
                │  Lokales Filesystem         │
                │  (Active Library +          │
                │   Template Libraries)       │
                └─────────────────────────────┘
```

### 3.2 Kommunikation Extension ↔ Lokaler Service

**Transport:** gRPC-Web über HTTP/2 auf einem Loopback-Port (`127.0.0.1`). Die Extension öffnet den Channel beim LCSC-Page-Load (Pre-Warm) und hält ihn bis zum Tab-Close offen.

**Warum gRPC-Web und nicht reines gRPC:** Chrome-Extensions können kein nacktes HTTP/2 mit Trailer-Frames sprechen (das wäre voll-gRPC). gRPC-Web ist ein standardisierter Sub-Set, der über normales `fetch()` läuft und Server-Streaming unterstützt — genau was Phase 2 für Progress-Events braucht.

**Service-Definition (Proto-Skizze):**

```protobuf
syntax = "proto3";
package kicad_importer.v1;

service Importer {
  // Liveness & Versions-Check.
  rpc Ping(PingRequest) returns (PingResponse);

  // Liste der Template-Inhalte einer Lib (für Override-Panel-Dropdowns).
  rpc ListTemplates(ListTemplatesRequest) returns (ListTemplatesResponse);

  // Phase 1 — Metadaten in ~1 s.
  rpc FetchMetadata(FetchMetadataRequest) returns (FetchMetadataResponse);

  // Phase 2 — Conversion in ~5–10 s, streamt Progress.
  rpc Convert(ConvertRequest) returns (stream ConvertEvent);
}

message PingRequest {}
message PingResponse {
  string version = 1;
}

message ListTemplatesRequest {
  string lib_path = 1;  // Pfad zur .kicad_sym
}
message ListTemplatesResponse {
  string lib_path = 1;
  repeated string symbols = 2;
  repeated string footprints = 3;
}

message FetchMetadataRequest {
  string lcsc_id = 1;       // z.B. "C22548"
  PageHints page_hints = 2; // optional: vom Content-Script gepulled
}
message PageHints {
  string category_path = 1;
  string datasheet_url = 2;
}
message FetchMetadataResponse {
  string lcsc_id = 1;
  string category_path = 2;
  int32  pin_count = 3;
  string datasheet_url = 4;
  string manufacturer = 5;
  string mpn = 6;
  string value = 7;
  bool   symbol_exists_in_active_lib = 8;
  bool   footprint_exists_in_active_lib = 9;
}

message ConvertRequest {
  string lcsc_id = 1;
  string active_lib_path = 2;
  Overrides overrides = 3;
  bool overwrite = 4;
}
message Overrides {
  LayerChoice symbol = 1;
  LayerChoice footprint = 2;
}
message LayerChoice {
  enum Source { EASYEDA = 0; TEMPLATE = 1; }
  Source source = 1;
  string lib_path = 2; // nur wenn TEMPLATE
  string name = 3;     // nur wenn TEMPLATE
}
message ConvertEvent {
  oneof event {
    Progress progress = 1;
    Done done = 2;
    Error error = 3;
  }
}
message Progress { string message = 1; int32 percent = 2; }
message Done    { string written_lib_path = 1; }
message Error   { string code = 1; string message = 2; }
```

**Concurrency:** Der Service ist single-flight. Ein `Convert`, das während eines anderen `Convert` reinkommt, wird mit `Error{code: "busy"}` beantwortet. Begründung: ein User, eine Hand am Mauszeiger. Multi-Tab-Coordination ist deutlich teurer als die seltene „bitte einen Moment warten"-UX.

### 3.3 Lebenszyklus des Lokalen Service

**Anforderung des Users:** Kein manueller Start. Nach Installation soll das Tool ohne Interaktion funktionieren.

**Empfohlene Umsetzung — Variante 1 (On-Demand-Helper):**
- Der Lokale Service wird einmalig per Installer auf Disk gelegt (`<install-dir>/kicad-importer-service.exe`).
- Beim Page-Load der LCSC-Seite startet ein **Launcher-Subprozess** den Service, falls er nicht schon läuft. Der Launcher wird vom Service Worker via Native Messaging getriggert (Native Messaging ist der einzige Browser-Hook, der einen Subprozess starten kann).
- Service hört auf einem zufälligen Loopback-Port, gibt diesen via `stdout` an den Launcher zurück, der ihn dem Service Worker durchreicht.
- Service beendet sich nach 5 Minuten Idle (kein gRPC-Call) selbst — kein dauerhafter Hintergrund-Prozess.

**Variante 2 (System-Service):**
- Installer registriert den Service als Windows-Service / launchd-Agent / systemd-User-Unit mit Auto-Start.
- Service läuft permanent im Hintergrund, hört auf einem festen Loopback-Port.
- Vorteil: kein Native-Messaging-Detour, kein Cold-Start beim ersten Klick.
- Nachteil: dauerhaft RAM-Footprint, OS-spezifische Service-Registrierung, Update-Komplexität (laufenden Service stoppen).

**🟡 OFFEN (Architektur-Kern):** Variante 1 vs. Variante 2.

| | Variante 1 (On-Demand) | Variante 2 (System-Service) |
|---|---|---|
| User-Erlebnis nach Installation | „Funktioniert ohne dass ich was tun muss" ✓ | „Funktioniert ohne dass ich was tun muss" ✓ |
| RAM-Footprint im Idle | 0 (Service nicht gestartet) | ~50 MB dauerhaft |
| Cold-Start beim ersten Klick | ~500 ms (Pre-Warm versteckt das) | 0 |
| Installer-Komplexität | Mittel (Native-Host-Manifest schreiben) | Hoch (OS-spezifische Service-APIs) |
| Update-Pfad | Trivial (Service ist beim Update meist nicht aktiv) | Hoch (Service stoppen, ersetzen, neu starten) |
| Cross-OS-Aufwand | Native-Host-Pfade pro OS (3 Stellen) | Service-APIs pro OS (3 sehr unterschiedliche Mechanismen) |

**Empfehlung:** Variante 1. Sie deckt den User-Wunsch („nichts manuell starten") ab und ist deutlich weniger Installer-Code. Der einmalige Cold-Start beim ersten Klick wird durch **Pre-Warm** (siehe §16) vor dem User versteckt.

**Konsequenz für die gRPC-Spec:** Variante 1 bedeutet, dass das System trotz gRPC-Wire-Protocol weiterhin einen Native-Messaging-Hook braucht, um den Service zu starten — nicht für die Conversion-Daten selbst, sondern nur als „Subprozess-Starter". Wer Native Messaging komplett vermeiden will, müsste Variante 2 wählen. Beides ist mit KISS verträglich, weil die User-sichtbare Komplexität in beiden Fällen null ist.

### 3.4 Sprachwahl für den Lokalen Service

**🟡 OFFEN:** Python (via PyInstaller) vs. Rust vs. Go.

| | Python + PyInstaller | Rust | Go |
|---|---|---|---|
| EasyEDA-Konversionslogik | `easyeda2kicad`-Library existiert | Neu schreiben | Neu schreiben |
| Single-Binary-Distribution | Funktioniert (PyInstaller), aber 30–80 MB Binary | Trivial, ~5 MB | Trivial, ~10 MB |
| Startup-Zeit | 300–800 ms (PyInstaller-Bootstrap) | <50 ms | <50 ms |
| Wartung gRPC-Server | `grpcio`-Library okay | `tonic` exzellent | offiziell unterstützt |
| Time-to-Working-Backend | Niedrig (existierender Code) | Hoch | Hoch |

**Empfehlung:** Python via PyInstaller. Die Conversion-Logik (`easyeda2kicad` + Forks) ist in Python ausgereift; sie in Rust/Go neu zu implementieren wäre ein eigenes Projekt. Die 30–80 MB Binary sind ein einmaliger Download.

### 3.5 Datenflüsse — Standardweg (Click → Library)

```
User klickt Download im Anchor <tr>
        │
        ▼
Content Script → Service Worker (sendMessage: "phase1")
        │
        ▼
Service Worker → Lokaler Service (gRPC: FetchMetadata)
        │
        ▼ (~1 s)
Service Worker ← Lokaler Service (gRPC: FetchMetadataResponse)
        │
        ▼
Content Script erhält Metadaten + matched Category Rules
        │
        ├──► Skip-Panel-Flow möglich? ──► Phase 2 direkt
        │
        ▼
Override Panel rendert inline im LCSC <tr>
        │
        ▼
User wählt Symbol-Source, Footprint-Source, ggf. Pin↔Pad, ggf. Overwrite
        │
        ▼
User klickt Confirm
        │
        ▼
Content Script → Service Worker (sendMessage: "convert" + overrides)
        │
        ▼
Service Worker → Lokaler Service (gRPC: Convert, server-streaming)
        │
        ▼
Während der Stream offen ist: jedes ConvertEvent {progress}
        wird an den Content Script weitergereicht; Button-UI zeigt Status
        │
        ▼ (~5–10 s)
Terminal: ConvertEvent {done} oder {error}
        │
        ▼
Content Script entfernt Override Panel, zeigt Success/Error im <tr>
```

---

## 4. Komponente: Chrome-Extension

### 4.1 Manifest & Permissions

```json
{
  "manifest_version": 3,
  "name": "KiCad Parts Importer",
  "version": "X.Y.Z",
  "description": "Import LCSC parts into KiCad libraries with one click.",
  "permissions": [
    "storage",
    "alarms",
    "nativeMessaging"
  ],
  "host_permissions": [
    "https://www.lcsc.com/*",
    "https://lcsc.com/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "KiCad Importer" },
  "content_scripts": [
    {
      "matches": ["https://www.lcsc.com/product-detail/*", "https://lcsc.com/product-detail/*"],
      "js": ["src/content/index.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["pdf_viewer.html", "src/content/*.js"],
      "matches": ["https://www.lcsc.com/*", "https://lcsc.com/*"]
    }
  ]
}
```

**Begründung der Permissions:**
- `storage` — Persistenz der Settings (Active Library, Template Libraries, Category Rules, Toggles).
- `alarms` — 25-Sek-Heartbeat für Service-Worker-Keep-Alive (siehe §16).
- `nativeMessaging` — nötig für Variante 1 (On-Demand-Service-Start). Bei Variante 2 (System-Service) entfällt diese Permission.
- `host_permissions` — Content-Script-Injection und CORS-freier Datasheet-Pull, falls der Service URLs anfordert.

### 4.2 Service Worker (`background.js`)

**Aufgabe:** Einziger Owner des gRPC-Channels. Marshalled Aufrufe von Popup und Content-Script zum Lokalen Service.

**Zustand im Service Worker:**
```js
const state = {
  serviceOnline: false,         // letzter Ping-Status
  serviceVersion: null,
  channel: null,                // gRPC-Web-Channel-Handle
  servicePort: null,            // dynamisch ermittelt bei Variante 1
  prewarmAlarmId: "k2c-keepalive",
  busyConvert: false,           // mirror des Service-busy
};
```

**Aufrufschnittstelle (Message-Types via `chrome.runtime.sendMessage`):**

| Type | Caller | Antwort-Envelope |
|---|---|---|
| `ping` | Popup, Content-Script | `{ok, data: {online, version}}` |
| `listTemplates` | Content-Script (beim Panel-Render) | `{ok, data: {symbols, footprints}}` |
| `fetchMetadata` | Content-Script (Phase 1) | `{ok, data: {…FetchMetadataResponse}}` |
| `convert` | Content-Script (Phase 2 Confirm) | Streaming via `chrome.runtime.Port` |
| `getSettings` / `setSettings` | Popup | `{ok, data: settings}` |

**Antwort-Envelope (verbindlich für alle SW-Antworten):**
```js
{ok: true, data: {…}}    // Erfolg
{ok: false, error: "…"}  // Fehler
```
Das Envelope ist load-bearing: Caller, die das `data`-Feld zu früh aufrutschen, übersehen das `ok`-Flag.

**Streaming für Phase 2:**
Da `sendMessage` kein Streaming kennt, eröffnet der Content-Script vor `Convert` einen `chrome.runtime.connect({name: "convert"})`-Port. Der Service Worker pumpt jedes `ConvertEvent` als Port-Message durch. Beim terminalen Event schließt der Service Worker den Port.

### 4.3 Popup (`popup.html` / `popup.js`)

Drei Tabs:

#### 4.3.1 Tab Categories

**Zweck:** CRUD über *Category Rules*.

**Input:** User klickt „Add Rule" oder „Edit", trägt ein:
- `categoryPath` (text input, validiert: muss durch `normalizeCategoryPath` durchlaufen)
- `symbolSource` (dropdown: `EasyEDA` | jeder Template-Symbol-Name aus den aktiven Template Libraries)
- `footprintSource` (dropdown: `EasyEDA` | jeder Template-Footprint-Name)
- `autoConfirm` (checkbox)

**Output:** Persistiert in `chrome.storage.local.rules: Array<Rule>`.

**Validierung:**
- Doppelter `categoryPath` → User-Fehler („Rule für diesen Pfad existiert bereits — überschreiben?")
- `symbolSource = Template-X` ohne dass `Template-X` in aktiver Template-Library existiert → Warning-Icon im Edit-View

#### 4.3.2 Tab Library

**Zweck:** Active Library + Template Libraries verwalten.

**Input:**
- Pfad-Picker (file-input, `accept=".kicad_sym"`) für die Active Library.
- Liste von Template-Library-Pfaden mit „Add" / „Remove" / „Reload"-Buttons. Jede Zeile hat ein Aktiv-Toggle (Template-Lib zählt nur bei `active = true` als Override-Quelle).

**Output:** Persistiert in `chrome.storage.local.activeLibrary` und `chrome.storage.local.templateLibraries: Array<{path, active}>`.

**Validierung:**
- Pfad existiert auf Disk (via `Ping`/`ListTemplates` gegen den Service prüfbar — der Service antwortet mit leerer Liste, wenn die Datei fehlt).
- Active Library ≠ Template Library (Konflikt-Warning).

#### 4.3.3 Tab Settings

**Zweck:** Globale Toggles.

**Felder:**
- `Theme` (light / dark / system).
- `Debug logs` (write `console.debug` lines).
- `Default overwrite policy` (`ask` | `overwrite` | `skip`).
- `Always show Override Panel` (Master-Toggle; default OFF; ON deaktiviert global den Skip-Panel-Flow).

**Status-Zeile:** zeigt den letzten `Ping`-Status („Lokaler Service: online · v0.0.1" / „offline — Installer ausgeführt?"). Refresh-Knopf re-triggered Ping.

### 4.4 LCSC Content Script

**Eintrittspunkt:** `src/content/index.js`. ESM-Modul. Run-at `document_idle` damit LCSC's React/Tailwind-Layer bereits gerendert ist.

**Top-Level-Flow:**
1. Beim Init: kicked Pre-Warm — `chrome.runtime.sendMessage({type: "ping"})`.
2. Findet die *Anchor Card* (siehe §6).
3. Injiziert das `<tr>` mit Download-Button + Customize-Button.
4. Bindet Click-Handler.
5. Bei Click:
   - `phase1Fetch(lcscId)` (siehe §7)
   - dann entweder Skip-Panel-Flow (§12) oder `renderOverridePanel` (§8)
6. Bei Panel-Confirm: `phase2Convert(overrides)` (siehe §9)

**Modul-Übersicht (`src/content/`):**

| Modul | Aufgabe |
|---|---|
| `index.js` | Bootstrap, Top-Level-Flow |
| `lcscPageSnapshot.js` | DOM-Walk: extrahiert LCSC-ID, Category Path, Attribut-Tabelle, Datasheet-URL |
| `anchorCard.js` | Findet die Anchor-Card-Tabelle, fallback auf Float Panel |
| `phase1Fetch.js` | Wrappt SW-Aufruf, rendert Inline-Status im `<tr>` |
| `phase2Convert.js` | Wrappt SW-Streaming, rendert Progress im `<tr>` |
| `overridePanel.js` | Baut & mounted Panel, sammelt User-Selektion |
| `pinPadSubPanel.js` | Sub-UI für Pin↔Pad-Mapping (§13) |
| `datasheetSubPanel.js` | PDF-Vorschau via `pdf_viewer.html` (§15) |
| `nativeHostStatusButton.js` | Subscribed Online/Offline-Status, rendert Indikator |
| `categoryRuleMatcher.js` | Liest Rules aus Storage, deepest-prefix-Match |

Jedes Modul wird über `web_accessible_resources` exposed (sonst lädt es nicht — eine wiederkehrende Falle bei MV3-Content-Scripts).

---

## 5. Komponente: Lokaler Service (gRPC-Backend)

### 5.1 Single-Binary-Distribution

Der Service wird als ein einziges ausführbares File ausgeliefert (PyInstaller). Drop-In nach `<install-dir>`. Selbst-Registrierung beim ersten Start (siehe §18).

### 5.2 gRPC-Endpoints — Detail

**Alle Endpoints validieren:** Eingabe wird mit Protobuf-Defaults gelesen; leere/missing Felder werden mit klaren `InvalidArgument`-Fehlern beantwortet.

#### 5.2.1 `Ping`

**Input:** `PingRequest {}`
**Output:** `PingResponse { version: string }`
**Fehler:** keine (außer Transport-Layer-Fehler)
**Verwendung:** Pre-Warm und Status-Zeile im Popup.

#### 5.2.2 `ListTemplates`

**Input:** `ListTemplatesRequest { lib_path }`
**Output:** `ListTemplatesResponse { lib_path, symbols, footprints }`

**Logik:**
- `lib_path` zeigt auf eine `.kicad_sym`-Datei. Symbol-Layer-Quelle.
- Footprint-Quelle ist die Sibling-Directory `<lib>.pretty/`. Aus jedem `.kicad_mod` wird der `basename` extrahiert.
- Beide Listen sind sortiert, dedupliziert, frei von Sub-Symbolen (KiCad's `Name_0_1`-Convention für Multi-Unit-Symbols wird gefiltert).
- Datei oder Verzeichnis nicht vorhanden → leere Liste, kein Fehler. Eine Template-Library darf reines Symbol-only oder reines Footprint-only sein.

**Fehler:**
- `InvalidArgument` bei leerem oder whitespace-only `lib_path`.

#### 5.2.3 `FetchMetadata` — Phase 1

**Input:** `FetchMetadataRequest { lcsc_id, page_hints }`
**Output:** `FetchMetadataResponse { …8 Felder… }`

**Logik:**
1. LCSC-API anfragen (LCSC's interne JSON-API für die Produktseite, gefunden über Page-Inspection).
2. Aus Antwort extrahieren: `Category Path` (LCSC's Breadcrumb-String), `manufacturer`, `mpn`, `value`, `datasheet_url`.
3. EasyEDA-API anfragen für `pin_count` (komplettes Symbol nicht ziehen — Phase 1 ist explizit metadata-only).
4. `Category Path` durch Python-Mirror der JS-`normalizeCategoryPath` jagen — drift-frei zur Extension.
5. `active_lib_path` ist nicht Teil von Phase 1 — der Service kennt die Active Library nicht. Aber: die Extension reicht `active_lib_path` als Teil des `page_hints`-Felds rein, damit der Service die `symbol_exists_in_active_lib`/`footprint_exists_in_active_lib`-Flags berechnen kann.

**Fehler:**
- `InvalidArgument` bei leerem oder formal ungültigem `lcsc_id` (Regex: `^C\d+$`).
- `NotFound` wenn LCSC die ID nicht kennt.
- `Unavailable` wenn LCSC- oder EasyEDA-API nicht erreichbar.
- `Resource_Exhausted` mit code `busy`, wenn parallel ein anderes `Phase1`/`Convert` läuft.

**🟡 OFFEN — Datasheet-PDF-Bytes mitliefern oder separate RPC?**
Variante A: Phase 1 liefert nur die URL, eine eigene `FetchDatasheet`-RPC bringt die Bytes.
Variante B: Phase 1 antwortet inkrementell und schickt die Bytes nach den Metadaten als Stream-Tail.
Variante C: Datasheet-Sub-Pane im Override Panel pulled die URL direkt aus dem Browser (CORS!).
**Empfehlung:** Variante A. Trennt schnelle Metadaten (~1 s) von potenziell langsamen PDF-Downloads (5–20 MB Files).

#### 5.2.4 `Convert` — Phase 2 (Streaming)

**Input:** `ConvertRequest { lcsc_id, active_lib_path, overrides, overwrite }`
**Output:** Stream von `ConvertEvent`. Stream-Ende = terminales `done` oder `error`.

**Branch-Entscheidung:**
- Wenn `overrides.symbol = TEMPLATE` UND `overrides.footprint = TEMPLATE` UND der Template-Footprint eine `(model "...")`-Reference enthält: **Template-Assembly** (siehe §10.4).
- Sonst: **EasyEDA Pipeline** (siehe §9.1).

**Streaming-Protocol:**
- Jedes `Progress {message, percent}`-Event wird ausgesendet, sobald ein Pipeline-Schritt anfängt. Mindestens 3 pro Conversion: „fetching EasyEDA", „writing symbol", „writing footprint" (plus „carry over 3D" wenn relevant).
- Genau ein terminales Event: `Done {written_lib_path}` oder `Error {code, message}`.

**Fehler-Codes:**
| Code | Bedeutung |
|---|---|
| `busy` | Anderer Convert läuft. |
| `easyeda_unavailable` | EasyEDA-API nicht erreichbar. |
| `template_not_found` | Override zeigt auf nicht-existente Template-Library. |
| `overwrite_refused` | Part existiert + `overwrite=false`. |
| `pin_pad_mismatch` | Symbol-Pin-Count ≠ Footprint-Pad-Count und kein Sidecar verfügbar. |
| `lib_write_failed` | Filesystem-Fehler beim Schreiben. |
| `internal` | Catch-all. |

### 5.3 Modulstruktur des Lokalen Service

```
service/
  main.py              # gRPC-Server-Bootstrap, single-flight-Lock, Shutdown-Logik
  rpc_handlers.py      # FetchMetadata, Convert, ListTemplates, Ping
  phase1.py            # LCSC + EasyEDA-Metadaten-Pull
  phase2_easyeda.py    # EasyEDA-Pipeline (Symbol/FP-Gen, Override-Apply)
  phase2_assembly.py   # Template-Assembly-Pipeline
  threed.py            # 3D-Resolution (siehe §11)
  templates.py         # list_templates() — von ListTemplates aufgerufen
  pin_map.py           # Pin-Map-Sidecar Lookup + Write
  kicad_writer.py      # Atomare Writes von .kicad_sym, .kicad_mod, .step
  categoryPath.py      # Mirror von shared/categoryPath.mjs
  exists.py            # symbol_exists / footprint_exists für Phase 1
  install.py           # Self-Register-Logik (siehe §18)
```

### 5.4 Single-Flight-Lock

Eine `threading.Lock` umschließt jedes `Phase1`/`Convert`. Tryacquire → bei Fehlschlag sofort `Error{code: "busy"}` zurück, kein Warten in der Queue (ADR-Streamed-Progress-Prinzip: keine Job-Verwaltung).

### 5.5 Idle-Shutdown (nur Variante 1)

Ein Hintergrund-Thread misst `time_since_last_rpc`. Erreicht der Wert 300 s, sendet der Server sich selbst `SIGINT`. Damit ist der RAM-Footprint im Idle null.

---

## 6. Feature-Block A — DOM-Integration auf LCSC

### 6.1 Überblick

**Aufgabe:** Den User-Trigger (Download- + Customize-Button) so auf der LCSC-Seite einbetten, dass er auch nach LCSC-Layout-Änderungen stabil sichtbar bleibt.

**Input:** Live LCSC-Produktseite.
**Output:** Ein neues `<tr>` in der **Anchor Card**, sichtbar enthaltend Download- und Customize-Button. Bei Fehlschlag: ein **Float Fallback**-Panel rechts unten.

### 6.2 Anchor-Detection

#### 6.2.1 Input
- Das Root-`document` der LCSC-Produktseite.

#### 6.2.2 Algorithmus
1. Walke alle `<table>`-Elemente im Dokument.
2. Für jede Tabelle: durchlaufe alle Zeilen, prüfe ob eine Cell den Text matcht gegen die multilinguale Label-Liste:
   - `LCSC-Nr.` (DE)
   - `LCSC#` (kurz)
   - `LCSC Part #` (EN)
   - `LCSC编号` (ZH)
3. Match-Treffer in der Header-Cell + Cell-Pattern `/^C\d+$/` in der direkt benachbarten Cell → diese Tabelle ist die Anchor Card.
4. Bei mehrfachem Match: die erste Tabelle in DOM-Order wird gewählt.
5. Bei null Match: Fallback-Heuristik — irgendeine Tabelle, in der irgendeine Cell `/^C\d+$/` matcht und mindestens 3 andere Cells „Hersteller"-artige Labels enthalten. Bei auch null → null zurück.

#### 6.2.3 Output
- Referenz auf das `<tbody>` der Anchor Card, oder null.

### 6.3 Injection des `<tr>`

#### 6.3.1 Input
- Das Anchor-`<tbody>`.

#### 6.3.2 Algorithmus
1. Baue ein `<tr data-k2c-controls="true">` mit einer `<td colspan>`-Cell, deren Inhalt zwei Buttons enthält:
   - `<button data-k2c-action="download" />` mit Label „In KiCad importieren" (i18n-bereit).
   - `<button data-k2c-action="customize" />` mit Icon-Look („Customize").
2. Plus eine Status-Span (`data-k2c-status`) für Inline-Feedback zwischen Phase 1, Phase 2 und Terminal-State.
3. Plus ein Mini-Status-Dot (`data-k2c-host-status`) für Online/Offline-Visualisierung (siehe §16).
4. `appendChild` an das Ende des `<tbody>` (nicht middle insert — der User-Test 2026-05-29 zeigte, dass middle-insert „mittendrin rumfliegt").

#### 6.3.3 Output
- Sichtbarer Tool-Trigger in der Anchor Card.

#### 6.3.4 Idempotenz
Falls bereits ein `<tr data-k2c-controls>` existiert: kein zweites einfügen. Verhindert Re-Inject bei React-Re-Renders der LCSC-Seite.

### 6.4 Float Fallback

#### 6.4.1 Input
- Anchor-Walk hat null geliefert.

#### 6.4.2 Algorithmus
- Baue ein `position: fixed; bottom: 24px; right: 24px; z-index: 2147483646`-Panel mit denselben zwei Buttons.
- Style mit Shadow-DOM-Isolation, damit LCSC's globale CSS-Resets das Panel nicht zerstören.

#### 6.4.3 Output
- Floating-Panel rechts unten, gleicher Click-Flow wie der Anchor-Card-Trigger.

### 6.5 MutationObserver — Nein

Wir abonnieren die LCSC-DOM-Mutationen nicht. Begründung: React-Rerender treibt unnötige Re-Walks. Statt dessen einmaliger Walk bei `document_idle`. Wird der Trigger aus Versehen entfernt, ist das ein User-sichtbares Symptom („Button weg") — dann Tab neuladen.

### 6.6 Acceptance Criteria

- [ ] Anchor-Walk erkennt LCSC-Nr.-Tabelle auf einem DE-Dump und einem EN/ZH-Dump.
- [ ] `<tr>` mit beiden Buttons wird unter die letzten Zeilen injiziert.
- [ ] Manipulierte DOM-Fixture ohne Anchor → Float-Fallback rendert.
- [ ] Unit-Tests (Vitest) gegen reale LCSC-Page-Dumps.
- [ ] Smoke-Test auf live `lcsc.com/product-detail/...` DE und EN.

---

## 7. Feature-Block B — Phase 1 Fetch (Metadaten)

### 7.1 Überblick

**Aufgabe:** Schnelle Metadaten beschaffen, damit das Override Panel sinnvolle Defaults rendern kann. Keine schwere Conversion-Arbeit.

**Input:**
- `lcscId` (aus DOM extrahiert, regex `/^C\d+$/`)
- `pageHints` (optional: Category-Path-Hinweis vom DOM, Datasheet-URL falls schon im DOM präsent)
- `activeLibPath` (aus `chrome.storage`)

**Output:** Objekt entsprechend `FetchMetadataResponse` (siehe §5.2.3).

**Time-Budget:** <2 s end-to-end (Click → Daten beim Content-Script). Ziel ~1 s im Happy-Path.

### 7.2 Datenfluss

1. Content-Script extrahiert `lcscId` via `lcscPageSnapshot.js`.
2. Content-Script sendet `{type: "fetchMetadata", lcscId, pageHints, activeLibPath}` an Service Worker.
3. Service Worker ruft `FetchMetadata` über gRPC auf.
4. Lokaler Service:
   - hits LCSC-API (interner JSON-Endpoint, gefunden per Page-Inspection)
   - hits EasyEDA-API für pin_count
   - normalisiert `categoryPath` via Python-Mirror von `shared/categoryPath.mjs`
   - prüft `symbol_exists_in_active_lib` und `footprint_exists_in_active_lib` per Disk-Check
   - liefert Antwort
5. Content-Script rendert Inline-Mini-Status im `<tr>` („Lade Metadaten…" → „1.2 s · Found in Resistors/SMD") und initiiert dann den Override-Panel-Render oder Skip-Panel-Flow.

### 7.3 Category Path Normalization

Das Normalisierungs-Logik existiert in zwei spiegelnden Implementierungen:
- `shared/categoryPath.mjs` (JS-Side, consumed by Content-Script und Popup)
- `service/categoryPath.py` (Python-Side, consumed by Phase 1)

Drift-Prevention: gepaarte Pytest+Vitest-Fixtures mit denselben In/Out-Pairs (mind. 10 Cases inkl. Unicode, Whitespace, Leading/Trailing-Slashes, Empty-Segments).

**Algorithmus:**
1. Trim.
2. NFC-normalize.
3. Replace ` › `, ` > `, ` / ` durch `/`.
4. Split bei `/`, trim jedes Segment, filtere leere Segments.
5. Join mit `/`.
6. Wenn leer → `""`.

### 7.4 Concurrent Phase 1 → busy

Wenn der User in zwei Tabs gleichzeitig klickt: zweiter Call → `Error{code: "busy"}`. Content-Script zeigt „Lokaler Service ist beschäftigt — bitte warten".

### 7.5 Acceptance Criteria

- [ ] Phase 1 antwortet in <2 s auf gültiger LCSC-ID.
- [ ] Category-Path-Normalisierung Python ↔ JS drift-frei (gepaarter Test).
- [ ] Concurrent Phase 1 → `busy`.
- [ ] Manueller Smoke: Klick → Metadaten erscheinen im Status-Span in <2 s.

---

## 8. Feature-Block C — Override Panel

### 8.1 Überblick

**Aufgabe:** Single inline-UI für alle User-Entscheidungen zwischen Phase 1 und Phase 2. Ersetzt eine 5-Dialog-Kaskade (Category, Value-Param, Pin↔Pad, Template-Gallery, Overwrite) durch *ein* Panel.

**Input:** `FetchMetadataResponse` + Settings (Templates, Rules) + die matched Category Rule (falls vorhanden).
**Output:** Beim Confirm: `Overrides`-Objekt (Symbol-Source + Footprint-Source + optional Pin↔Pad + optional Overwrite-Flag).

### 8.2 Panel-Aufbau

Panel ist ein `<div data-k2c-override-panel>` plus Wrapper-`<tr>` (innerhalb der Anchor-Card-Tabelle wird der Panel-Wrapper als zweite Zeile direkt unter dem Tool-`<tr>` gemountet, in der Float-Variante als Kind des Float-Panels).

**Sub-Sektionen, top-to-bottom:**

#### 8.2.1 Header
- Mode-Indikator: zeigt aktuell entschiedenes Phase-2-Mode (`EasyEDA Pipeline` oder `Template Assembly`) als visuelles Cue.

#### 8.2.2 Symbol-Source
- Dropdown.
- Optionen: `Keep EasyEDA` plus eine optgroup pro aktive Template-Library mit allen Symbol-Namen.
- Default: aus Category-Rule, sonst `Keep EasyEDA`.

#### 8.2.3 Footprint-Source
- Dropdown.
- Optionen: `Keep EasyEDA` plus eine optgroup pro aktive Template-Library mit allen Footprint-Namen.
- Wichtig: Die Footprint-Liste pro Lib ist getrennt von der Symbol-Liste — sie kommt aus der Sibling-`.pretty/`-Direktorei (siehe §10).

#### 8.2.4 Pin↔Pad-Map (conditional)
- Erscheint nur wenn die kombinierte Auswahl Pin↔Pad-Resolution braucht (siehe §13).
- Sub-UI mit klickbarem Footprint-Preview-SVG.

#### 8.2.5 Datasheet Preview (conditional)
- Erscheint nur wenn `datasheetUrl` aus Phase 1 vorhanden ist.
- iframe mit `pdf_viewer.html`, eingebettetes PDF.js (siehe §15).

#### 8.2.6 Overwrite-Warning (conditional)
- Erscheint wenn `symbol_exists_in_active_lib` oder `footprint_exists_in_active_lib` true ist.
- Textzeile + Toggle: „Bauteil existiert bereits — überschreiben?"

#### 8.2.7 Actions
- Cancel-Button — entfernt Panel, keine Phase 2.
- Confirm-Button — packt Overrides, ruft Phase 2 auf.

### 8.3 Encoding der Selektion

Dropdown-Werte sind flach codiert als String, weil `<select><option>` keine komplexen Werte trägt:

```
"easyeda"                           → { source: "easyeda" }
"template:<libPath>:<name>"         → { source: "template", libPath, name }
```

Parser anchored beim `.kicad_sym`-Suffix von `libPath`, damit Windows-Drive-Letter (`C:\...`) und Doppelpunkte im Namen survive.

### 8.4 Always Re-Resolve

Das Panel speichert *nur* `(libPath, name)` der Selektion. Phase 2 liest das File frisch von Disk. Begründung: User darf Template-Dateien in KiCad bearbeiten und sieht die Änderung beim nächsten Import sofort. Kein versteckter Cache.

### 8.5 Skip-Panel-Flow Integration

Vor dem Panel-Render läuft die Skip-Panel-Logik (siehe §12). Bei Skip startet Phase 2 direkt, Panel wird nie gemountet.

### 8.6 Acceptance Criteria

- [ ] Panel rendert inline nach Phase 1, beide Dropdowns gefüllt aus aktiven Template Libs.
- [ ] Footprint-Dropdown zeigt Footprint-Namen, nicht Symbol-Namen.
- [ ] Confirm packt Overrides korrekt.
- [ ] Cancel entfernt Panel ohne Phase 2.
- [ ] Always Re-Resolve: Template wird bei jedem Import frisch gelesen (Test mit Mock-FS).

---

## 9. Feature-Block D — Phase 2 Conversion

### 9.1 EasyEDA Pipeline

**Aktiv wenn:** mindestens einer der beiden Layer (Symbol oder Footprint) `easyeda` ist.

**Input:** `ConvertRequest` mit `overrides`.
**Output:** Stream von `ConvertEvent`s.

**Schritte:**
1. `progress("fetching EasyEDA", 10)`.
2. EasyEDA-API für LCSC-ID anfragen → komplettes Symbol/Footprint/3D-Bundle.
3. `progress("generating symbol", 30)`.
4. Wenn `overrides.symbol = easyeda`: EasyEDA→KiCad-Symbol-Conversion. Wenn `template`: Template-`.kicad_sym` laden, Symbol-Section extrahieren, LCSC-Metadaten als Properties anfügen.
5. `progress("generating footprint", 50)`.
6. Wenn `overrides.footprint = easyeda`: EasyEDA→KiCad-Footprint-Conversion. Wenn `template`: Template-Footprint-File laden.
7. 3D-Resolution (siehe §11).
8. `progress("writing to library", 80)`.
9. KiCad-Writer schreibt Symbol in `<activeLibPath>` (Append-Modus, sort key by name).
10. KiCad-Writer schreibt Footprint in `<activeLibDir>/<libName>.pretty/<fp>.kicad_mod` (atomare temp+rename).
11. Wenn 3D-File zu kopieren: in `<activeLibDir>/<libName>.3dshapes/<basename>` (idempotent + content-hash dedupliziert).
12. `done(written_lib_path)`.

### 9.2 Template-Assembly Pipeline

**Aktiv wenn:** beide Layer `template` UND Template-Footprint hat eine `(model "...")`-Ref.

**Input:** dasselbe `ConvertRequest`.
**Output:** dasselbe Stream-Format.

**Schritte (kein EasyEDA-Call!):**
1. `progress("template-assembly", 5)`.
2. Lese Template-Symbol von Disk (Always Re-Resolve).
3. Lese Template-Footprint von Disk.
4. Trigger Template-3D Carry-Over (siehe §11.2).
5. `progress("resolving pin map", 30)` — Pin-Map-Sidecar nachschauen oder generieren.
6. `progress("writing symbol", 60)` — Symbol in Active-Lib `.kicad_sym` schreiben mit Properties aus Phase-1-Metadaten:
   - `Value` ← `value` aus Phase 1
   - `Reference` ← Symbol-Default
   - `Footprint` ← `<activeLibName>:<footprintName>`
   - `Datasheet` ← `datasheet_url`
   - `LCSC` (custom prop) ← `lcsc_id`
   - `Manufacturer`, `MPN` als optionale Custom-Properties
7. `progress("writing footprint", 80)` — Footprint in Active-Lib `.pretty/` schreiben mit Rewritten `(model ...)`-Ref.
8. `done(written_lib_path)`.

### 9.3 Streamed Progress

Jedes `Progress`-Event geht durch den gRPC-Stream zurück zur Extension. Service Worker reicht es als Port-Message an den Content-Script. Der Status-Span im `<tr>` zeigt das jüngste Event.

**Kein Job-State:** Es gibt keinen Job-ID, keine Reconnect-Logik, keine SW-Restart-Recovery. Stirbt der Service Worker mitten in einem Convert (Chrome-Idle-Kill), bricht der gRPC-Stream → Content-Script zeigt Fehler → User klickt nochmal. Der Service Worker bekommt durch das 25-Sek-Alarm-Heartbeat genug Pseudo-Activity, dass das praktisch nie passiert.

### 9.4 Acceptance Criteria

- [ ] EasyEDA-Pipeline schreibt Symbol + Footprint korrekt.
- [ ] Template-Assembly läuft End-to-End ohne EasyEDA-HTTP-Call.
- [ ] Mindestens 3 Progress-Events streamen pro Convert.
- [ ] Concurrent Convert → `busy`.
- [ ] Stirbt der Service Worker: Stream-Bruch wird user-sichtbar.

---

## 10. Feature-Block E — Template-System

### 10.1 Überblick

**Aufgabe:** Dem User eine Lieblings-KiCad-Library als Override-Quelle dienen zu lassen — getrennt für Symbol-Layer und Footprint-Layer.

**Input:** Eine oder mehrere `.kicad_sym`-Dateien mit Sibling-`.pretty/`-Direktoren auf der lokalen Disk.
**Output:** Override-Optionen im Override Panel.

### 10.2 Template-Library als zwei unabhängige Layer

Eine Template-Library besteht physisch aus:

```
<dir>/
  MyTemplates.kicad_sym         ← Symbol-Layer
  MyTemplates.pretty/
    SMD_0603.kicad_mod          ← Footprint-Layer
    SOT-23-3.kicad_mod
    ...
  MyTemplates.3dshapes/         ← optionale 3D-Files
    SOT-23.step
    ...
  pin_maps/                     ← Pin-Map-Sidecars (siehe §13)
    Resistor_SMT__SMD_0603.json
    ...
```

**Symbol-Layer und Footprint-Layer sind unabhängig.** Es gibt **keinen compound entry**. Die Verbindung „Symbol X gehört zu Footprint Y" entsteht zur Conversion-Zeit aus:
- Category-Rule referenziert beide Layer (siehe §12), oder
- User wählt im Override Panel beide Layer manuell, oder
- Pin-Map-Sidecar resolved das konkrete (Sym, FP)-Paar (siehe §13).

### 10.3 Template-Inhalte enumerieren (`ListTemplates`)

Service-RPC `ListTemplates` (siehe §5.2.2) listet:
- `symbols`: alle Top-Level-Symbole aus der `.kicad_sym` (sub-symbols mit Suffix `_0_1`, `_0_2` … gefiltert).
- `footprints`: alle `.kicad_mod`-Basenames in der Sibling-`.pretty/`-Direktorei.

Die Extension cached dies pro Render des Override Panels. Bei jedem Panel-Open wird die Liste frisch geholt (Always Re-Resolve auch für Listing — User darf Template-Dateien zwischen Imports hinzufügen).

### 10.4 Template-Assembly als Phase-2-Mode

Siehe §9.2. Triggert genau dann, wenn beide Layer Template sind und der gewählte Footprint sein eigenes 3D mitbringt — dann wird EasyEDA komplett umgangen. Das ist der zentrale Use-Case für „LCSC kennt das Bauteil, aber EasyEDA hat weder Symbol noch Footprint".

### 10.5 Always Re-Resolve

Verbindliche Policy. Begründung: User darf in KiCad seine Template-Dateien editieren und sieht die Änderung beim nächsten Import. Kein Schnappschuss, keine Pinning, kein „diese Rule ist an Template v3 gebunden".

### 10.6 Acceptance Criteria

- [ ] Mehrere Template Libraries gleichzeitig konfigurierbar im Popup.
- [ ] Toggle „aktiv" deaktiviert eine Library als Quelle, ohne sie aus der Konfiguration zu löschen.
- [ ] ListTemplates handhabt fehlende `.kicad_sym`, fehlende `.pretty/`-Direktorei (jeweils leere Liste, kein Fehler).
- [ ] Sub-Symbols werden gefiltert.
- [ ] Always Re-Resolve verifiziert durch Mock-FS-Test (zweimal lesen → unterschiedliche Inhalte).

---

## 11. Feature-Block F — 3D-Layer

### 11.1 Resolution Order

3D folgt dem Footprint. Sechs Fälle, deterministisch geordnet:

| Fall | Footprint | Template-FP hat `(model ...)`? | Resultat |
|---|---|---|---|
| 1 | EasyEDA | n/a | EasyEDA-3D wird gepulled, in `<ActiveLib>.3dshapes/<basename>` gelegt, Footprint-Ref auf `${KIPRJMOD}/<ActiveLib>.3dshapes/...`. |
| 2 | Template, Ref auf Template-Internes File | ja | Carry-Over: File-Copy mit Hash-Dedup, Ref-Rewrite. |
| 3 | Template, Ref auf System-Variable (`${KICAD9_3DMODEL_DIR}`, `${KISYS3DMOD}`) | ja | Ref verbatim belassen, **kein** Copy. |
| 4 | Template, Ref auf absoluter Pfad außerhalb Template-Lib | ja | Ref verbatim belassen, **kein** Copy. |
| 5 | Template, keine Ref + EasyEDA hat 3D | nein | Fallback: EasyEDA-3D pullen, Ref an Template-Footprint anhängen. |
| 6 | Template, keine Ref + EasyEDA hat kein 3D | nein | `progress("no 3D", …)`, Footprint ohne Model-Ref schreiben. **Kein Fehler.** |

### 11.2 Template-3D Carry-Over

#### 11.2.1 Input
- Pfad zum Template-`.kicad_mod`.
- Pfad zur Active Library.

#### 11.2.2 Algorithmus
1. Parse Template-`.kicad_mod` mit S-Expression-Parser.
2. Für jede `(model "<path>" …)`-Form:
   - Resolve `<path>`: ist sie relativ zur Template-Lib, ist sie eine Variable-Form, oder absoluter Pfad?
   - **Variable-Form** (`${KICAD9_3DMODEL_DIR}`, `${KISYS3DMOD}`, weitere via Pattern `\$\{[A-Z][A-Z0-9_]*\}`) → Ref verbatim belassen, weiter zur nächsten Form.
   - **Absoluter Pfad außerhalb Template-Lib** → Ref verbatim belassen, weiter.
   - **Relativ zur Template-Lib oder absolut innerhalb der Template-Lib**:
     - Compute SHA-256 des Source-Files.
     - Target-Pfad: `<ActiveLibDir>/<ActiveLibName>.3dshapes/<basename>`.
     - Falls Target existiert mit gleichem Hash → skip Copy.
     - Falls Target existiert mit anderem Hash → `Error{code: "lib_write_failed", message: "3D file hash collision …"}`. Aborts den Convert.
     - Sonst: Copy.
     - Rewrite die `(model …)`-Form auf `${KIPRJMOD}/<ActiveLibName>.3dshapes/<basename>`.
3. Schreibe Footprint mit rewritten Refs.

#### 11.2.3 Output
- Footprint-Datei in `<ActiveLib>.pretty/`.
- 0..N Files in `<ActiveLib>.3dshapes/`.

### 11.3 Nicht user-overridbar

Es gibt **kein** 3D-Dropdown im Override Panel. 3D folgt deterministisch dem Footprint. Begründung: Multi-Layer-Override-UI würde die KISS-Heuristik durchbrechen, und die fünf 3D-Pfade sind gut definiert.

### 11.4 Acceptance Criteria

Sechs Tests gegen Fixture-Footprints und Sample-LCSC-Parts:
- [ ] Fall 1: EasyEDA-FP + EasyEDA-3D → `.step` in `<ActiveLib>.3dshapes/`.
- [ ] Fall 2: Template-FP mit interner Ref → Carry-Over.
- [ ] Fall 3: System-Variable-Ref → verbatim.
- [ ] Fall 4: Absoluter externer Pfad → verbatim.
- [ ] Fall 5: Template-FP ohne Ref + EasyEDA-3D → Fallback hängt an.
- [ ] Fall 6: Template-FP ohne Ref + kein EasyEDA-3D → `no 3D`, kein Fehler.
- [ ] Hash-Collision wird user-actionable gemeldet.
- [ ] Manueller KiCad-Smoke: pcbnew öffnet das Footprint, 3D-Modell sichtbar.

---

## 12. Feature-Block G — Category Rules + Skip-Panel-Flow

### 12.1 Überblick

**Aufgabe:** Wiederkehrende Imports per einmaliger Regel automatisieren.

**Input:**
- User-Eingaben im Popup-Tab Categories.
- Bei Import: `categoryPath` aus Phase 1.

**Output:**
- Persistierte Regelsammlung.
- Bei Import: ggf. Bypass des Override Panels (Skip-Panel-Flow).

### 12.2 Datenmodell

```js
type Rule = {
  categoryPath: string;        // z.B. "Passives/Resistors/SMD"
  symbolSource: LayerChoice;
  footprintSource: LayerChoice;
  autoConfirm: boolean;
}
type LayerChoice =
  | { source: "easyeda" }
  | { source: "template", libPath: string, name: string }
```

Persistenz: `chrome.storage.local.rules: Array<Rule>`. Sortierreihenfolge irrelevant (Matching ist preference-frei).

### 12.3 Deepest-Prefix-Match

#### 12.3.1 Input
- `inputPath` (z.B. `"Passives/Resistors/SMD/0603"`)
- `rules: Array<Rule>`

#### 12.3.2 Algorithmus
1. Filter: nur Rules, deren `categoryPath` entweder == `inputPath` ist oder ein **Prefix mit Slash-Boundary** ist (`rule.categoryPath + "/"` ist Prefix von `inputPath`).
2. Sortiere die verbleibenden absteigend nach Länge des `categoryPath`.
3. Erste = Winner. Sonst null.

#### 12.3.3 Beispiele
- `inputPath = "Passives/Resistors/SMD/0603"`.
- Rules:
  - `"Passives"` → matcht (Prefix). Länge 8.
  - `"Passives/Resistors"` → matcht. Länge 18.
  - `"Passives/Resistors/SMD"` → matcht. Länge 22 → **Winner**.
  - `"Passives/Capacitors"` → matcht nicht.

### 12.4 Skip-Panel-Flow

Nach Phase 1 prüft das Content-Script:
1. Winning Rule existiert?
2. Rule.autoConfirm == true?
3. Pin-Map-Sidecar für `(symbolSource, footprintSource)` existiert oder Sym-Pin-Count == FP-Pad-Count?
4. Keine Overwrite-Warning (oder `Default overwrite policy = overwrite`)?
5. Master-Toggle „Always show Override Panel" == OFF?

Alle ja → Phase 2 startet direkt. Panel wird nicht gemountet. Inline-Status-Span zeigt „Auto: Resistor_SMT → SMD_0603 …".

### 12.5 Customize-Button

Override des Skip-Panel-Flows. Click triggert Phase 1 wie Download, setzt aber `forcePanel = true` im Flow.

### 12.6 Acceptance Criteria

- [ ] CRUD im Popup-Tab.
- [ ] Deepest-Prefix-Match deterministisch.
- [ ] Skip-Panel-Flow startet Phase 2 ohne Panel, wenn alle Bedingungen erfüllt.
- [ ] Customize-Button erzwingt Panel auch bei vollem Auto-Resolve.
- [ ] Master-Toggle „Always show Override Panel" deaktiviert Skip global.

---

## 13. Feature-Block H — Pin↔Pad-Map

### 13.1 Überblick

**Aufgabe:** Wenn Symbol-Pin-Count und Footprint-Pad-Count nicht übereinstimmen (z.B. 8-Pin-Logik-Symbol auf 14-Pad-DIP14-Footprint, weil das DIP14 NC-Pins hat), muss eine explizite Zuordnung persistiert werden.

**Input:** `(symbolSource, footprintSource)` aus dem Override Panel.
**Output:** Pin-Map-Sidecar-JSON unter `<TemplateLibrary>/pin_maps/<symbol>__<footprint>.json`.

### 13.2 Resolution-Reihenfolge

1. Wenn Sidecar existiert: direkt benutzen. Keine UI.
2. Wenn Sym-Pin-Count == FP-Pad-Count UND keine Sidecar-Pflicht (z.B. Numerische Match): trivialer 1:1-Mapping, keine UI.
3. Sonst: Pin↔Pad-Sub-UI im Override Panel.

### 13.3 Sub-UI

**Layout:**
- Linke Seite: nummerierte Liste der Symbol-Pins mit Pin-Name.
- Rechte Seite: SVG-Render des Footprints (vom Lokalen Service als Pre-Generated-SVG aus dem `.kicad_mod` über `RenderFootprintSvg`-RPC — **🟡 OFFEN**: separater RPC oder Teil von `ListTemplates`?).
- Pads im SVG sind klickbar mit dem Pad-Label überlagert.
- User klickt Symbol-Pin → klickt Pad → Verbindung sichtbar (Linie).
- Optionaler „No connection" für unbelegte Pads.

### 13.4 Sidecar-Format

```json
{
  "version": 1,
  "symbol": { "libPath": "…/MyTemplates.kicad_sym", "name": "Resistor_SMT" },
  "footprint": { "libPath": "…/MyTemplates.kicad_sym", "name": "SMD_0603" },
  "mapping": [
    {"pin": "1", "pad": "1"},
    {"pin": "2", "pad": "2"}
  ],
  "created": "2026-05-29T12:34:56Z"
}
```

### 13.5 Re-Trigger

Drei Wege das Mapping neu zu setzen:
1. Customize-Button → Panel rendert, Sub-UI rendert wenn nötig.
2. Manuelles Löschen der Sidecar-JSON-Datei.
3. **🟡 OFFEN**: „Reset Pin Map"-Button im Override Panel selbst — wäre user-freundlich, ist aber extra UI.

### 13.6 Acceptance Criteria

- [ ] Sym-Pin ≠ FP-Pad → Sub-UI rendert.
- [ ] Sidecar wird unter korrektem Pfad geschrieben.
- [ ] Re-Import: Sidecar wird benutzt, keine UI.
- [ ] 1:1-trivial-mapping: keine UI.

---

## 14. Feature-Block I — Overwrite-Handling

### 14.1 Überblick

**Aufgabe:** Wenn das Part bereits in der Active Library existiert, klar entscheiden lassen.

**Input:** `symbol_exists_in_active_lib` / `footprint_exists_in_active_lib` aus Phase 1.
**Output:** `overwrite`-Flag im Phase-2-Call.

### 14.2 Logik

1. Phase 1 prüft Existenz per Disk-Check (`<lib>.kicad_sym`-Parsing für Symbol-Namen, `<lib>.pretty/`-Glob für Footprint-Namen).
2. Wenn mindestens eines existiert: Override Panel zeigt Warning-Zeile mit Toggle „Überschreiben?".
3. Toggle-Default kommt aus Settings `Default overwrite policy`:
   - `ask` → Toggle Default OFF, User muss aktiv „Überschreiben" wählen.
   - `overwrite` → Toggle Default ON.
   - `skip` → Toggle nicht renderbar; stattdessen rote Block-Zeile „Bauteil existiert — Skip".
4. Phase 2 honoriert `overwrite`. Bei `false` und Existenz → `Error{code: "overwrite_refused"}`, keine Disk-Schreib-Operation.
5. Bei `true`: Symbol wird im `.kicad_sym` ersetzt (Pflicht: alles drumherum bewahren — andere Symbole bleiben), Footprint-Datei wird überschrieben (atomares temp+rename).

### 14.3 Acceptance Criteria

- [ ] Phase 1 erkennt Existenz für Symbol UND Footprint separat.
- [ ] Warning rendert nur wenn relevant.
- [ ] `overwrite=false` + existing → Phase 2 `error`, kein Datei-Write.
- [ ] `overwrite=true` ersetzt sauber.

---

## 15. Feature-Block J — Datasheet-Preview

### 15.1 Überblick

**Aufgabe:** PDF-Vorschau im Override Panel, damit der User sieht ob die richtige Variante eingestellt ist.

**Input:** `datasheet_url` aus Phase 1.
**Output:** Inline-iframe mit PDF.js.

### 15.2 Pipeline

1. Extension fragt Lokaler Service per separater `FetchDatasheet`-RPC die Bytes.
2. Service downloaded die PDF (LCSC-Datasheet-URLs sind direkt erreichbar, kein Auth).
3. Service streamt die Bytes als Repeated-Bytes-Field zurück.
4. Extension steckt die Bytes in eine `Blob`, baut `URL.createObjectURL`, mountet in `pdf_viewer.html`-iframe.
5. iframe nutzt PDF.js (gleich wie V2; Datasheet-Panel-Code wiederverwendbar).

**Warum nicht direkter Fetch von LCSC im Content-Script:** CORS. LCSC's Datasheet-CDN setzt keine permissive ACAO-Header.

### 15.3 Edge Cases

- Phase 1 liefert keine `datasheet_url` → Sub-Pane wird nicht gemountet. Kein Error.
- PDF.js scheitert (corrupted file) → Sub-Pane zeigt Error-Text, restliches Panel funktioniert.

### 15.4 Acceptance Criteria

- [ ] PDF rendert in iframe innerhalb des Panels.
- [ ] Panel-Layout bleibt usable bei vorhandenem und fehlendem Datasheet.
- [ ] Smoke gegen LCSC-Part mit + ohne Datasheet.

---

## 16. Feature-Block K — Backend-Status & Pre-Warm

### 16.1 Überblick

**Aufgabe:**
- Den Lokalen Service rechtzeitig hochfahren, damit der erste Klick keinen ~500-ms-Cold-Start sieht.
- Online/Offline-Zustand sichtbar machen, damit User weiß ob er den Installer ausführen muss.

**Input:**
- LCSC-Page-Load-Event.
- Periodischer `chrome.alarms`-Tick.

**Output:**
- Hot Service.
- Visualisiertes Online/Offline am Anchor-`<tr>` und im Popup.

### 16.2 Pre-Warm-Mechanik

1. Beim Content-Script-Init: sende `{type: "ping"}` an Service Worker.
2. Service Worker:
   - Wenn Channel nicht offen: triggert Service-Start (Variante 1 via Native Messaging Launcher; Variante 2 reicht ein simples `Ping`).
   - Sendet `Ping`-RPC.
   - Cached `serviceOnline` und `serviceVersion`.
3. Service Worker broadcasted Status an alle Listeners (Popup + Content-Script).

### 16.3 Keep-Alive

`chrome.alarms.create("k2c-keepalive", {periodInMinutes: 25/60})` — 25-Sek-Tick. Der Alarm-Handler sendet einen No-Op `Ping`, der die Service-Worker-Activity-Window verlängert und den Lokalen Service vor Idle-Shutdown bewahrt.

### 16.4 Status-Visualisierung

Im Anchor-`<tr>`: ein Mini-Dot (`data-k2c-host-status`):
- 🟢 grün: online.
- 🟡 gelb: checking (initial).
- 🔴 rot: offline. Tooltip: „Lokaler Service nicht erreichbar — Installer ausgeführt?"

Im Popup-Tab Settings: Zeile mit Text + Refresh-Button.

### 16.5 Acceptance Criteria

- [ ] LCSC-Page-Load triggert messbar einen Ping in <500 ms nach Content-Script-Init.
- [ ] Alarms-Heartbeat hält den SW aktiv (verifizierbar per devtools-SW-Inspector).
- [ ] Dot zeigt korrekt online/offline.
- [ ] Mid-session Service-Stopp → Status flippt auf offline beim nächsten Tick.

---

## 17. Konfiguration & Persistenz

### 17.1 chrome.storage.local Schema

```js
{
  activeLibrary: { path: "C:\\…\\MyLib.kicad_sym" } | null,
  templateLibraries: [
    { path: "…", active: true },
    { path: "…", active: false },
  ],
  rules: [
    {
      categoryPath: "Passives/Resistors/SMD",
      symbolSource: { source: "easyeda" } | { source: "template", libPath, name },
      footprintSource: { ... },
      autoConfirm: true,
    },
    ...
  ],
  settings: {
    theme: "light" | "dark" | "system",
    debugLogs: false,
    defaultOverwritePolicy: "ask" | "overwrite" | "skip",
    alwaysShowOverridePanel: false,
  },
  version: 1,                // Schema-Version (siehe §17.2)
}
```

### 17.2 Schema-Versionierung

`storage.version` ist Pflicht. Beim Extension-Start liest der Service Worker `storage.version`. Bei null/0 → Schema-Init mit Defaults. Bei alter Version → Migration (wenn das mal eintritt; aktuell nur v1).

### 17.3 Lokaler-Service-Konfiguration

Der Lokale Service liest **keine** Konfigurationsdatei. Alles Notwendige kommt pro RPC mit:
- `active_lib_path` ist Teil von `FetchMetadata` und `Convert`.
- `lib_path` (Template) ist Teil von `ListTemplates` und in den `Overrides`.

**Begründung:** Keine doppelte Source-of-Truth. Die Extension ist die einzige Konfigurations-UI; der Service ist stateless across calls.

### 17.4 Atomare Writes

Filesystem-Operationen im Service:
- `.kicad_sym`: read → modify → write to `<file>.tmp` → fsync → rename to `<file>`. Atomar auf POSIX und (seit Win10) auf Windows.
- `.kicad_mod`: dasselbe Pattern.
- 3D-Files (große Binaries): direkter Copy ist okay (sind individuelle Dateien, kein in-place edit).
- Pin-Map-Sidecar JSON: dasselbe temp+rename-Pattern.

---

## 18. Installation & Distribution

### 18.1 Extension via Chrome Web Store

- Standard Chrome-Web-Store-Listing.
- Manifest V3, kein nicht-strict-CSP-Bypass.
- Permissions sind minimal (siehe §4.1).

### 18.2 Lokaler-Service-Installer

#### 18.2.1 Single-Binary

PyInstaller produziert ein `kicad-importer-installer.exe` (Windows) / `.dmg` (macOS) / `.AppImage` (Linux). Single file, kein Python-Vorinstallieren nötig.

#### 18.2.2 Self-Register

Beim ersten Start:
1. Prüft, ob ein **Native-Host-Manifest** (Variante 1) bzw. ein **System-Service-Entry** (Variante 2) bereits an der OS-spezifischen Stelle existiert.
2. Falls nicht: schreibt es.
3. Idempotent: zweiter Start ist No-Op.

**OS-spezifische Pfade (Variante 1, Native-Host-Manifest):**
- Windows: HKCU-Registry-Key unter `Software\Google\Chrome\NativeMessagingHosts\com.kicad_importer.host` → File-Pfad zum Manifest-JSON.
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kicad_importer.host.json`.
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.kicad_importer.host.json`.

Das Manifest-JSON enthält den Pfad zum Service-Binary und die Liste der allowed Extension-IDs.

#### 18.2.3 Update-Pfad

- Variante 1: Service-Binary wird einfach überschrieben. Beim nächsten Pre-Warm startet der neue.
- Variante 2: Service stoppen → Binary überschreiben → Service starten. Pro OS ein Service-Manager-Aufruf.

### 18.3 Erkennung „Installer nicht ausgeführt"

Erst-Klick auf einer LCSC-Seite ohne Installer → Service Worker kann den Channel nicht öffnen. Status-Dot bleibt rot, Tooltip linkt auf die Onboarding-Dokumentation: „Lade den Installer von der Extension-Detail-Seite, führe ihn einmal aus, lade die LCSC-Seite neu."

### 18.4 Acceptance Criteria

- [ ] Frische Maschine (Win/Mac/Linux): Extension installieren, Installer ausführen, LCSC-Seite öffnen → Status grün, Klick funktioniert.
- [ ] Re-Run des Installers: idempotent, kein Crash.
- [ ] Update: Service-Binary austauschen, nächster Klick funktioniert.

---

## 19. Sicherheit & Datenschutz

### 19.1 Bedrohungs-Modell

- **Außenangreifer**: Loopback-gRPC-Port ist nur lokal erreichbar. CORS ist auf Loopback strikt. Eine fremde Website auf demselben Rechner könnte theoretisch versuchen, gegen `127.0.0.1:<port>` zu fetchen — abgewehrt durch:
  1. Random-Port pro Service-Start (Variante 1).
  2. Validierung der `Origin`-Header gegen `chrome-extension://<our-id>`.
  3. Pre-Shared-Token: Service generiert beim Start ein 256-bit-Token, das via Native-Messaging an die Extension geht; alle gRPC-Calls senden es als Metadata.
- **Bösartige Template-Files**: Templates sind reine KiCad-`.kicad_sym`/`.kicad_mod`. Werden geparst, nicht ausgeführt. Kein Code-Execution-Vektor.
- **Bösartige LCSC-Antworten**: LCSC ist Drittsystem; Antworten werden in Phase 1 strikt validiert (Regex auf `lcsc_id`, Pin-Count-Range, URL-Schema-Check).

### 19.2 Daten-Persistenz

- Nichts wird über die lokale Maschine hinaus gesendet, außer den Standard-LCSC- und EasyEDA-API-Calls.
- Keine Telemetry. Kein Phone-Home.
- Logs (wenn `Debug logs` aktiv) landen nur in der Browser-Console und in `<install-dir>/logs/`.

### 19.3 Update-Verifikation

- Extension-Updates kommen über Chrome Web Store, signiert.
- Service-Updates: **🟡 OFFEN** — Mechanismus zur Signatur-Verifikation des neuen Binaries. Erste Iteration: User lädt den Installer von der Extension-Detail-Seite, akzeptiert OS-Trust-Prompt. Spätere Iteration: signiertes Auto-Update.

---

## 20. Test-Strategie

### 20.1 Drei Schichten

| Schicht | Tool | Was getestet wird |
|---|---|---|
| Lokaler Service | pytest | RPC-Handler, Phase-1- und Phase-2-Logik, 3D-Resolution, Template-Listing, Pin-Map-Resolver, Atomic-Writes |
| Extension (Logik) | Vitest + jsdom | Anchor-Detector, Override-Panel-Build, Category-Rule-Matcher, Selektions-Parser, Service-Worker-Marshalling |
| Extension (Integration) | Manueller Smoke | DOM-Injection auf live LCSC-Seite, Pre-Warm-Latency, Pin↔Pad-UI-Klicks, PDF.js |

### 20.2 Drift-Prevention

- **Category-Path-Normalisierung**: gepaarte Tests Python + JS mit identischen Fixtures.
- **gRPC-Schemas**: einziges Proto-File wird zum Service-Build (Python-Stubs) und zum Extension-Build (gRPC-Web-Stubs) eingelesen. Ein Schema, beide Seiten.
- **`web_accessible_resources`-Guard**: Pytest-Test, der prüft, dass jedes Modul unter `src/content/*.js` im Manifest deklariert ist. Verhindert die V2-Klassik „PR ist grün, Extension ist tot".

### 20.3 Smoke-Test-Pflicht

Nach jedem Extension-PR: `chrome://extensions` → Reload → LCSC-Page-Refresh → Klick → Sym + FP in KiCad-Library sichtbar.

Code-Test allein ist nicht ausreichend, weil Vitest+jsdom MV3's `web_accessible_resources`-Contract nicht enforced.

### 20.4 End-to-End-Smoke pro Mode

Mind. 4 Live-Tests:
1. EasyEDA-Pipeline (beide Layer EasyEDA).
2. Hybrid (Symbol Template, FP EasyEDA).
3. Template-Assembly (beide Template + Template-3D).
4. Skip-Panel-Flow (Rule pre-existing).

---

## 21. Offene Fragen (gesammelt)

Konsolidierte Liste aller 🟡-Punkte aus den vorherigen Kapiteln, mit Empfehlung.

### 21.1 Lebenszyklus des Lokalen Service (§3.3)

**Frage:** On-Demand-Helper (Variante 1) vs. System-Service (Variante 2)?
**Empfehlung:** Variante 1 — leichter Installer, null RAM-Idle, Cold-Start durch Pre-Warm versteckt.
**Begründung:** KISS-Prinzip favorisiert das Mindere an installerseitiger OS-Spezifika.

### 21.2 Sprachwahl des Lokalen Service (§3.4)

**Frage:** Python + PyInstaller, Rust oder Go?
**Empfehlung:** Python + PyInstaller.
**Begründung:** `easyeda2kicad`-Library und ihre Forks existieren in Python; Re-Implementierung in Rust/Go wäre ein eigenes Projekt, das den eigentlichen Zweck nicht schneller voranbringt.

### 21.3 Datasheet-Pull-Variante (§5.2.3)

**Frage:** Datasheet-Bytes mit Phase-1-Antwort koppeln, separate RPC, oder Browser-Direct-Fetch?
**Empfehlung:** Separate `FetchDatasheet`-RPC.
**Begründung:** Trennt Phase-1-Latenz von potenziell langsamen PDF-Downloads, vermeidet CORS-Problem des Browser-Direct-Fetch.

### 21.4 Render-Footprint-SVG (§13.3)

**Frage:** Separater RPC oder Teil von `ListTemplates`?
**Empfehlung:** Separater `RenderFootprintSvg(libPath, name)`-RPC, on-demand.
**Begründung:** SVG-Render ist nur für die Pin↔Pad-Sub-UI nötig; ListTemplates bleibt schnell und cachable.

### 21.5 Reset-Pin-Map-Button (§13.5)

**Frage:** Extra Button im Override Panel oder manuelles Sidecar-Löschen?
**Empfehlung:** Extra-Button, sichtbar im Pin↔Pad-Sub-UI wenn Sidecar existiert.
**Begründung:** „Manuelle Sidecar-Löschung" ist nicht user-friendly; Button-Aufwand ist minimal.

### 21.6 Service-Update-Verifikation (§19.3)

**Frage:** Wie wird der Installer/Service-Binary signiert/verifiziert?
**Empfehlung Iteration 1:** Distribution über Extension-Detail-Seite, User akzeptiert OS-Trust-Prompt. Iteration 2: signiertes Auto-Update.
**Begründung:** Erste Version muss versendet werden können; signiertes Auto-Update ist ein eigenes Projekt.

### 21.7 gRPC-Web vs. native gRPC (§3.2)

**Frage:** Die Extension kann kein natives gRPC sprechen (kein Trailer-Frame-Support im fetch-API). Wir nehmen gRPC-Web. Brauchen wir einen Envoy-Proxy davor?
**Empfehlung:** Direkt gRPC-Web im Lokalen Service implementieren (Python-Library `sonora` oder Go's eigenes `grpcweb`-Sub-Set; **🟡 OFFEN für Python** — ggf. selbst-implementiert über ASGI mit dem Standard-`grpcio`-Server-Stack als Backend).
**Begründung:** Externer Envoy-Prozess würde dem KISS-Prinzip widersprechen. Ein Single-Binary muss beide Layer hosten.

### 21.8 Pre-Shared-Token-Schema (§19.1)

**Frage:** Wie kommt das beim Service-Start generierte Token in die Extension?
**Empfehlung:** Über den Native-Messaging-Launcher (Variante 1). Der Launcher empfängt das Token via Service-`stdout`, gibt es an den Service Worker weiter, der es in allen gRPC-Metadata-Headern sendet.
**Begründung:** Nutzt den existierenden Trust-Channel des Native-Messaging-Manifests.

### 21.9 Variante-2-spezifische Detail (§3.3)

Falls Variante 2 (System-Service) gewählt wird, ist Token-Distribution komplexer (Service startet ohne Extension-Wissen). Möglicher Weg: Service schreibt Token in `<user-data>/token.dat` mit User-only-Permissions; Extension liest es per ergänzendem Helper-RPC. Würde eine ergänzte Permission `nativeMessaging` rechtfertigen, womit Variante 2 nicht mehr „simpler" ist als Variante 1 → bestätigt die Empfehlung 21.1.

---

## Anhang A — Mapping zur derzeitigen Codebasis

(Nur als Orientierung beim Nachbau; nicht Teil der Spec.)

| Konzept | Aktuelles File / Modul |
|---|---|
| Domain-Sprache | `CONTEXT.md` |
| Category-Path-Normalisierung (JS) | `shared/categoryPath.mjs` |
| Anchor-Card-Detection | `chrome_extension/src/content/anchorCard.js` |
| Override Panel | `chrome_extension/src/content/overridePanel.js` |
| Phase-1-Wrapping (Extension) | `chrome_extension/src/content/phase1Fetch.js` |
| Phase-2-Wrapping (Extension) | `chrome_extension/src/content/phase2Convert.js` |
| Service Worker Hub | `chrome_extension/background.js` |
| Phase-1 (Backend) | `native_host/phase1.py` |
| Phase-2 (Backend) | `native_host/phase2.py` |
| Templates-Listing (Backend) | `native_host/templates.py` |
| Installer/Self-Register | `native_host/install.py` |

---

## Anhang B — Konventionen für Commit-Messages

Conventional Commits + Co-Authored-By:

```
feat(content): mount Override Panel with Pin-Pad sub-UI

…

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Scopes: `extension`, `content`, `service`, `proto`, `installer`, `docs`, `tests`.

---

*Ende des Konzeptpapiers. Für laufende Architektur-Lessons und Test-Resultate siehe das Repo-`README.md` und die `docs/adr/`-Verzeichnis.*
