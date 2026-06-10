import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractPageData,
  looksLikePricingTable,
  detectLcscLanguage,
  PAGE_SCRAPE_LABELS,
} from "./lcscPageSnapshot.js";

function _docWithLang(lang) {
  return { documentElement: { getAttribute: (k) => (k === "lang" ? lang : null) } };
}

/**
 * Fixture reconstructed from the real DevTools dump on
 * lcsc.com/product-detail/C22548.html (German-locale, post-Tailwind migration).
 * Each <table> mirrors what the user's snippet returned: the header card, the
 * three-column main parameters table, the spec-table summary, a price table
 * (to verify we skip it), and a regulatory table (mostly empty values).
 */
const LCSC_C22548_FIXTURE = `
<!-- Table 0: header card -->
<table class="w-full text-sm text-[#1C1F23] table-fixed">
  <tbody>
    <tr><td>Hersteller</td><td><span>YAGEO</span><span>Asian Brands</span></td></tr>
    <tr><td>Herst.-Teilenr.</td><td>RC0603FR-071KL</td></tr>
    <tr><td>LCSC-Nr.</td><td>C22548</td></tr>
    <tr><td>Verp.</td><td>0603</td></tr>
    <tr><td>Kundennummer</td><td></td></tr>
    <tr><td>Hauptmerkm.</td><td>RES 1kΩ ±1% 100mW 0603</td></tr>
    <tr><td>Datenblatt</td><td><a href="https://lcsc.com/datasheet/yageo-rc0603.pdf">YAGEO RC0603FR-071KL</a></td></tr>
  </tbody>
</table>

<!-- Table 1: main specs (Typ / Beschreibung / Alle) -->
<table class="w-full border-collapse text-[14px]">
  <thead><tr><th>Typ</th><th>Beschreibung</th><th>Alle</th></tr></thead>
  <tbody>
    <tr><td>Kategorie</td><td>Passives/Resistors/Chip Resistor - Surface Mount</td><td></td></tr>
    <tr><td>Hersteller</td><td>YAGEO</td><td></td></tr>
    <tr><td>Verp.</td><td>0603</td><td></td></tr>
    <tr><td>Power(Watts)</td><td>100mW</td><td></td></tr>
    <tr><td>Resistance</td><td>1kΩ</td><td></td></tr>
    <tr><td>Operating Temperature</td><td>-55℃~+155℃</td><td></td></tr>
    <tr><td>Voltage Rating</td><td>75V</td><td></td></tr>
    <tr><td>Type</td><td>Thick Film Resistor</td><td></td></tr>
    <tr><td>Temperature Coefficient</td><td>±100ppm/℃</td><td></td></tr>
    <tr><td>Tolerance</td><td>±1%</td><td></td></tr>
  </tbody>
</table>

<!-- Table 2: sales info (skipped — not relevant for KiCad import, but valid spec-style) -->
<table class="spec-table">
  <thead><tr><th>Typ</th><th>Details</th></tr></thead>
  <tbody>
    <tr><td>Minimum</td><td>100</td></tr>
    <tr><td>Vielfaches</td><td>100</td></tr>
    <tr><td>Standardgehäuse</td><td>5000</td></tr>
    <tr><td>Verkaufseinheit</td><td>Piece</td></tr>
    <tr><td>EDA-Modelle</td><td>EasyEDA-Modell</td></tr>
  </tbody>
</table>

<!-- Table 4: PRICING — must be skipped -->
<table class="w-full text-[14px] priceTable">
  <thead><tr><th>Stk.</th><th>E-Preis</th><th>Gesamtbetrag</th></tr></thead>
  <tbody>
    <tr><td>100+</td><td>$ 0.005</td><td>$ 0.5</td></tr>
    <tr><td>85,000+</td><td>$ 0.0018</td><td>$ 153</td></tr>
  </tbody>
</table>

<!-- Table 5: regulatory (RoHS, customs codes) — many empty values -->
<table class="w-full border-collapse text-[14px]">
  <thead><tr><th>Typ</th><th>Details</th></tr></thead>
  <tbody>
    <tr><td>RoHS</td><td></td></tr>
    <tr><td>ECCN</td><td>EAR99</td></tr>
    <tr><td>CNHTS</td><td>8533211000</td></tr>
  </tbody>
</table>
`;

describe("looksLikePricingTable", () => {
  beforeEach(() => {
    document.body.innerHTML = LCSC_C22548_FIXTURE;
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("flags the table whose class contains 'priceTable'", () => {
    const tables = [...document.querySelectorAll("table")];
    const priceTable = tables.find((t) => t.className.includes("priceTable"));
    expect(priceTable).toBeTruthy();
    expect(looksLikePricingTable(priceTable)).toBe(true);
  });

  it("does not flag spec tables", () => {
    const specTable = document.querySelector("table.spec-table");
    expect(looksLikePricingTable(specTable)).toBe(false);
  });

  it("does not flag the header card", () => {
    const headerCard = document.querySelector("table.table-fixed");
    expect(looksLikePricingTable(headerCard)).toBe(false);
  });
});

describe("extractPageData — real LCSC C22548 fixture", () => {
  beforeEach(() => {
    document.body.innerHTML = LCSC_C22548_FIXTURE;
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts the canonical category path from the main params table", () => {
    const snapshot = extractPageData();
    expect(snapshot.category).toBe(
      "Passives/Resistors/Chip Resistor - Surface Mount",
    );
  });

  it("extracts the package size via 'Verp.' (German label)", () => {
    const snapshot = extractPageData();
    expect(snapshot.package).toBe("0603");
  });

  it("extracts the description from 'Hauptmerkm.' (German label)", () => {
    const snapshot = extractPageData();
    expect(snapshot.description).toBe("RES 1kΩ ±1% 100mW 0603");
  });

  it("returns a populated params map with every spec key", () => {
    const snapshot = extractPageData();
    expect(snapshot.params["Resistance"]).toBe("1kΩ");
    expect(snapshot.params["Power(Watts)"]).toBe("100mW");
    expect(snapshot.params["Tolerance"]).toBe("±1%");
    expect(snapshot.params["Voltage Rating"]).toBe("75V");
    expect(snapshot.params["Herst.-Teilenr."]).toBe("RC0603FR-071KL");
  });

  it("prefers cleaner Table-1 'Hersteller' over Table-0's concatenated cell (last-write-wins)", () => {
    const snapshot = extractPageData();
    // Header card shows "YAGEOAsian Brands"; spec table shows "YAGEO" — we want the latter.
    expect(snapshot.params["Hersteller"]).toBe("YAGEO");
  });

  it("captures the datasheet PDF URL from the Datenblatt row", () => {
    const snapshot = extractPageData();
    expect(snapshot.datasheetUrl).toBe(
      "https://lcsc.com/datasheet/yageo-rc0603.pdf",
    );
  });

  it("does NOT include keys from the pricing table", () => {
    const snapshot = extractPageData();
    expect(snapshot.params["Stk."]).toBeUndefined();
    expect(snapshot.params["E-Preis"]).toBeUndefined();
    expect(snapshot.params["100+"]).toBeUndefined();
    expect(snapshot.params["85,000+"]).toBeUndefined();
  });

  it("ignores the empty Kundennummer row but keeps it as a known key", () => {
    const snapshot = extractPageData();
    expect(snapshot.params["Kundennummer"]).toBe("");
  });

  it("valueParamOptions ranks 'Herst.-Teilenr.' first (DE-localized MPN-like key)", () => {
    const snapshot = extractPageData();
    expect(snapshot.valueParamOptions[0]).toBe("Herst.-Teilenr.");
  });

  it("valueParamOptions includes every params key, no duplicates", () => {
    const snapshot = extractPageData();
    const set = new Set(snapshot.valueParamOptions);
    expect(set.size).toBe(snapshot.valueParamOptions.length);
    Object.keys(snapshot.params).forEach((k) => {
      expect(snapshot.valueParamOptions).toContain(k);
    });
  });
});

describe("extractPageData — degradation cases", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the empty shape when the page has no tables", () => {
    const snapshot = extractPageData();
    expect(snapshot).toEqual({
      category: null,
      package: null,
      params: {},
      description: null,
      datasheetUrl: null,
      valueParamOptions: [],
    });
  });

  it("does not throw on a table with only header rows", () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Typ</th><th>Details</th></tr></thead>
        <tbody></tbody>
      </table>
    `;
    const snapshot = extractPageData();
    expect(snapshot.params).toEqual({});
  });

  it("skips rows where the key looks like a numeric quantity (>= digit string)", () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr><td>100</td><td>$ 1.0</td></tr>
          <tr><td>85,000+</td><td>$ 0.5</td></tr>
          <tr><td>Resistance</td><td>1kΩ</td></tr>
        </tbody>
      </table>
    `;
    const snapshot = extractPageData();
    expect(snapshot.params).toEqual({ Resistance: "1kΩ" });
  });

  it("respects English LCSC labels (Category, Package, Datasheet)", () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr><td>Category</td><td>Passives/Resistors/SMD</td></tr>
          <tr><td>Package</td><td>0805</td></tr>
          <tr><td>Datasheet</td><td><a href="https://example.com/d.pdf">link</a></td></tr>
        </tbody>
      </table>
    `;
    const snapshot = extractPageData();
    expect(snapshot.category).toBe("Passives/Resistors/SMD");
    expect(snapshot.package).toBe("0805");
    expect(snapshot.datasheetUrl).toBe("https://example.com/d.pdf");
  });
});

describe("PAGE_SCRAPE_LABELS", () => {
  it("covers at least DE and EN for every load-bearing label", () => {
    expect(PAGE_SCRAPE_LABELS.category).toContain("Category");
    expect(PAGE_SCRAPE_LABELS.category).toContain("Kategorie");
    expect(PAGE_SCRAPE_LABELS.packageSize).toContain("Package");
    expect(PAGE_SCRAPE_LABELS.packageSize).toContain("Verp.");
    expect(PAGE_SCRAPE_LABELS.datasheet).toContain("Datasheet");
    expect(PAGE_SCRAPE_LABELS.datasheet).toContain("Datenblatt");
  });
});

describe("detectLcscLanguage", () => {
  it("treats <html lang='en'> (and en-US) as English", () => {
    expect(detectLcscLanguage(_docWithLang("en"))).toEqual({
      lang: "en",
      isEnglish: true,
      known: true,
    });
    expect(detectLcscLanguage(_docWithLang("en-US")).isEnglish).toBe(true);
  });

  it("flags a non-English lang (de) as not English", () => {
    expect(detectLcscLanguage(_docWithLang("de"))).toEqual({
      lang: "de",
      isEnglish: false,
      known: true,
    });
  });

  it("stays silent (known:false) when lang is absent and no hint is given", () => {
    const r = detectLcscLanguage(_docWithLang(""));
    expect(r.known).toBe(false);
    expect(r.isEnglish).toBe(true); // no false alarm
  });

  it("falls back to a localized category label when lang is absent", () => {
    const r = detectLcscLanguage(_docWithLang(""), { categoryLabel: "Kategorie" });
    expect(r).toEqual({ lang: "kategorie", isEnglish: false, known: true });
  });

  it("an English category label is not a non-English signal", () => {
    const r = detectLcscLanguage(_docWithLang(""), { categoryLabel: "Category" });
    expect(r.known).toBe(false);
  });
});
