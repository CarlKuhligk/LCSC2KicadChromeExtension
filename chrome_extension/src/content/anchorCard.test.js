import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findAnchorRow,
  buildAnchorCardRow,
  injectAnchorCard,
  markAnchorCardImported,
  LCSC_ID_LABELS,
  ANCHOR_ROW_ATTR,
} from "./anchorCard.js";

/**
 * Reconstructed from the real DevTools dump on lcsc.com/product-detail/C22548
 * (German-locale, Tailwind layout). The header card is the first table; we
 * keep the surrounding spec / pricing tables so the anchor walk has to pick
 * the *right* row, not just any row that looks plausible.
 */
const LCSC_C22548_DE_FIXTURE = `
<table class="w-full text-sm text-[#1C1F23] table-fixed">
  <tbody>
    <tr><td>Hersteller</td><td>YAGEO</td></tr>
    <tr><td>Herst.-Teilenr.</td><td>RC0603FR-071KL</td></tr>
    <tr><td>LCSC-Nr.</td><td>C22548</td></tr>
    <tr><td>Verp.</td><td>0603</td></tr>
    <tr><td>Datenblatt</td><td><a href="https://example.com/d.pdf">YAGEO RC0603FR-071KL</a></td></tr>
  </tbody>
</table>
<table class="w-full border-collapse text-[14px]">
  <thead><tr><th>Typ</th><th>Beschreibung</th></tr></thead>
  <tbody>
    <tr><td>Kategorie</td><td>Passives/Resistors/Chip Resistor - Surface Mount</td></tr>
    <tr><td>Resistance</td><td>1kΩ</td></tr>
  </tbody>
</table>
<table class="w-full text-[14px] priceTable">
  <thead><tr><th>Stk.</th><th>E-Preis</th></tr></thead>
  <tbody><tr><td>100+</td><td>$ 0.005</td></tr></tbody>
</table>
`;

/** EN-locale variant — same product, English UI strings. Validates the multilingual matcher. */
const LCSC_C22548_EN_FIXTURE = `
<table class="w-full text-sm text-[#1C1F23] table-fixed">
  <tbody>
    <tr><td>Manufacturer</td><td>YAGEO</td></tr>
    <tr><td>Mfr. Part #</td><td>RC0603FR-071KL</td></tr>
    <tr><td>LCSC Part #</td><td>C22548</td></tr>
    <tr><td>Package</td><td>0603</td></tr>
    <tr><td>Datasheet</td><td><a href="https://example.com/d.pdf">YAGEO RC0603FR-071KL</a></td></tr>
  </tbody>
</table>
`;

/** ZH-locale variant. Extra coverage for the third officially-listed label. */
const LCSC_C22548_ZH_FIXTURE = `
<table>
  <tbody>
    <tr><td>制造商</td><td>YAGEO</td></tr>
    <tr><td>LCSC编号</td><td>C22548</td></tr>
  </tbody>
</table>
`;

/**
 * A degraded layout: a localized label we don't ship in `LCSC_ID_LABELS`, but
 * the cell contains a bare LCSC ID — the cell-pattern fallback must catch it.
 */
const LCSC_CELL_FALLBACK_FIXTURE = `
<table>
  <tbody>
    <tr><td>Some unknown label</td><td>C99999</td></tr>
  </tbody>
</table>
`;

/**
 * No anchor at all — neither a known label nor an LCSC-shaped cell. Float
 * fallback should fire in the caller; this test checks `findAnchorRow` /
 * `injectAnchorCard` cleanly return null without throwing.
 */
const NO_ANCHOR_FIXTURE = `
<div>
  <p>Marketing copy with no product table.</p>
  <table>
    <tbody>
      <tr><td>Color</td><td>Red</td></tr>
      <tr><td>Weight</td><td>10g</td></tr>
    </tbody>
  </table>
</div>
`;

describe("findAnchorRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("matches the LCSC-Nr. row on the DE C22548 fixture (header card wins over spec table)", () => {
    document.body.innerHTML = LCSC_C22548_DE_FIXTURE;
    const row = findAnchorRow();
    expect(row).toBeTruthy();
    expect(row.children[0].textContent.trim()).toBe("LCSC-Nr.");
    expect(row.children[1].textContent.trim()).toBe("C22548");
    expect(row.closest("table").classList.contains("table-fixed")).toBe(true);
  });

  it("matches the LCSC Part # row on the EN C22548 fixture", () => {
    document.body.innerHTML = LCSC_C22548_EN_FIXTURE;
    const row = findAnchorRow();
    expect(row).toBeTruthy();
    expect(row.children[0].textContent.trim()).toBe("LCSC Part #");
    expect(row.children[1].textContent.trim()).toBe("C22548");
  });

  it("matches the LCSC编号 row on the ZH fixture", () => {
    document.body.innerHTML = LCSC_C22548_ZH_FIXTURE;
    const row = findAnchorRow();
    expect(row).toBeTruthy();
    expect(row.children[0].textContent.trim()).toBe("LCSC编号");
  });

  it("falls back to a row whose cell text is just /^C\\d+$/ when no label matches", () => {
    document.body.innerHTML = LCSC_CELL_FALLBACK_FIXTURE;
    const row = findAnchorRow();
    expect(row).toBeTruthy();
    expect(row.children[1].textContent.trim()).toBe("C99999");
  });

  it("returns null when the page has no LCSC anchor of any kind", () => {
    document.body.innerHTML = NO_ANCHOR_FIXTURE;
    expect(findAnchorRow()).toBeNull();
  });

  it("returns null on an empty document without throwing", () => {
    document.body.innerHTML = "";
    expect(findAnchorRow()).toBeNull();
  });

  it("ignores header rows (<th>)", () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>LCSC-Nr.</th><th>C22548</th></tr></thead>
        <tbody><tr><td>Color</td><td>Red</td></tr></tbody>
      </table>
    `;
    expect(findAnchorRow()).toBeNull();
  });
});

describe("buildAnchorCardRow", () => {
  it("builds a <tr> with the KiCad label and a single Download button", () => {
    const tr = buildAnchorCardRow(document);
    expect(tr.tagName).toBe("TR");
    expect(tr.getAttribute(ANCHOR_ROW_ATTR)).toBe("true");
    expect(tr.querySelector('[data-k2c-anchor-label="true"]').textContent).toBe("KiCad");
    const buttons = tr.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("data-k2c-action")).toBe("download");
    expect(buttons[0].textContent).toBe("Download");
    // Customize (Issue #12 scaffold) was removed — the editor is reachable via
    // Download → Override Panel → registrieren/Modifizieren.
    expect(tr.querySelector('[data-k2c-action="customize"]')).toBeNull();
  });

  it("applies colSpan on the actions cell when the anchor row is wider than 2 columns", () => {
    const tr = buildAnchorCardRow(document, { colSpan: 3 });
    const actions = tr.querySelector('[data-k2c-anchor-actions="true"]');
    expect(actions.colSpan).toBe(3);
  });

  it("omits colSpan when only one actions column is needed", () => {
    const tr = buildAnchorCardRow(document, { colSpan: 1 });
    const actions = tr.querySelector('[data-k2c-anchor-actions="true"]');
    // jsdom reports the default colSpan of 1 — we only set it explicitly when > 1.
    expect(actions.hasAttribute("colspan")).toBe(false);
  });
});

describe("markAnchorCardImported", () => {
  it("relabels Download → Re-Import with a persist override (no separate badge)", () => {
    const tr = buildAnchorCardRow(document);
    expect(markAnchorCardImported(tr)).toBe(true);

    const dl = tr.querySelector('button[data-k2c-action="download"]');
    expect(dl.textContent).toBe("Re-Import");
    // The dataset hook makes the label survive the Native-Host status re-paint.
    expect(dl.dataset.k2cLabelOverride).toBe("Re-Import");
    // The button label alone conveys "already in library" — no chip/badge.
    expect(tr.querySelector("[data-k2c-exists-chip]")).toBeNull();
  });

  it("is idempotent — a second call keeps a single Re-Import button", () => {
    const tr = buildAnchorCardRow(document);
    markAnchorCardImported(tr);
    markAnchorCardImported(tr);
    const buttons = tr.querySelectorAll('button[data-k2c-action="download"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("Re-Import");
  });

  it("returns false for a row without a download button", () => {
    const tr = document.createElement("tr");
    expect(markAnchorCardImported(tr)).toBe(false);
    expect(markAnchorCardImported(null)).toBe(false);
  });
});

describe("injectAnchorCard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("inserts the V3 <tr> as the LAST row of the anchor table's tbody on the DE fixture", () => {
    document.body.innerHTML = LCSC_C22548_DE_FIXTURE;
    const inserted = injectAnchorCard();
    expect(inserted).toBeTruthy();
    const tbody = document.querySelector("table.table-fixed tbody");
    expect(tbody.lastElementChild).toBe(inserted);
    // And it must sit AFTER all of the original data rows, not interleaved.
    const lcscRow = [...tbody.children].find(
      (tr) => tr.children[0]?.textContent.trim() === "LCSC-Nr.",
    );
    expect(lcscRow.nextElementSibling.children[0]?.textContent.trim()).toBe("Verp.");
    expect(inserted.querySelector('[data-k2c-action="download"]')).toBeTruthy();
    expect(inserted.querySelector('[data-k2c-action="customize"]')).toBeNull();
  });

  it("inserts as the LAST row of the anchor table on the EN fixture", () => {
    document.body.innerHTML = LCSC_C22548_EN_FIXTURE;
    const inserted = injectAnchorCard();
    expect(inserted).toBeTruthy();
    const tbody = document.querySelector("table tbody");
    expect(tbody.lastElementChild).toBe(inserted);
  });

  it("returns null when no anchor exists, so the caller can render the float fallback", () => {
    document.body.innerHTML = NO_ANCHOR_FIXTURE;
    expect(injectAnchorCard()).toBeNull();
    // And it must NOT have written anything to the DOM.
    expect(document.querySelector(`[${ANCHOR_ROW_ATTR}]`)).toBeNull();
  });

  it("is idempotent — a second call returns the existing row without duplicating", () => {
    document.body.innerHTML = LCSC_C22548_DE_FIXTURE;
    const first = injectAnchorCard();
    const second = injectAnchorCard();
    expect(second).toBe(first);
    expect(
      document.querySelectorAll(`[${ANCHOR_ROW_ATTR}="true"]`),
    ).toHaveLength(1);
  });
});

describe("LCSC_ID_LABELS", () => {
  it("covers DE, EN, and ZH at minimum", () => {
    expect(LCSC_ID_LABELS).toContain("LCSC-Nr.");
    expect(LCSC_ID_LABELS).toContain("LCSC Part #");
    expect(LCSC_ID_LABELS).toContain("LCSC编号");
  });
});
