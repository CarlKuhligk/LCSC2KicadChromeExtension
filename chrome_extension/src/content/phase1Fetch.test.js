import { describe, it, expect, beforeEach } from "vitest";
import {
  wirePhase1Download,
  formatPhase1Summary,
  PHASE1_STATUS_ATTR,
} from "./phase1Fetch.js";
import { buildAnchorCardRow } from "./anchorCard.js";
import { extractPageData } from "./lcscPageSnapshot.js";

/**
 * Reuses the same C22548 anchor-row scaffold the V3 Anchor Card injects
 * (`anchorCard.js#buildAnchorCardRow`) — the Phase 1 wiring targets the
 * Download/Customize buttons inside that row, so building it here keeps the
 * test surface aligned with what runs on the LCSC page.
 */
function mountAnchorRow() {
  const row = buildAnchorCardRow(document, { colSpan: 1 });
  // The buttons need a host or jsdom will trip on missing layout when we
  // dispatch synthetic clicks; wrap in a <table><tbody> for realism.
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  tbody.appendChild(row);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return row;
}

function clickDownload(row) {
  row.querySelector('[data-k2c-action="download"]').click();
}

const SNAPSHOT_C22548 = {
  category: "Passives/Resistors",
  datasheetUrl: "https://datasheet.example/C22548.pdf",
};

describe("formatPhase1Summary", () => {
  it("renders category, pin count, and datasheet marker when all present", () => {
    expect(
      formatPhase1Summary({
        categoryPath: "Passives/Resistors",
        pinCount: 2,
        datasheetUrl: "https://x/y.pdf",
      }),
    ).toBe("Passives/Resistors · 2 pins · datasheet ✓");
  });

  it("uses singular 'pin' for one pin", () => {
    expect(formatPhase1Summary({ pinCount: 1 })).toBe("1 pin");
  });

  it("falls back to '(no metadata)' when every field is missing", () => {
    expect(formatPhase1Summary({})).toBe("(no metadata)");
    expect(formatPhase1Summary(null)).toBe("(no metadata)");
  });

  it("omits the category segment when only pin count is present", () => {
    expect(formatPhase1Summary({ pinCount: 3 })).toBe("3 pins");
  });
});

describe("wirePhase1Download", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false when no Download button exists on the row", () => {
    const row = document.createElement("tr");
    document.body.appendChild(row);
    const ok = wirePhase1Download(row, "C22548", { rpc: () => {} });
    expect(ok).toBe(false);
  });

  it("returns false when deps.rpc is missing", () => {
    const row = mountAnchorRow();
    expect(wirePhase1Download(row, "C22548", {})).toBe(false);
  });

  it("calls SW rpc with the page-snapshot category and datasheet URL on click", async () => {
    const row = mountAnchorRow();
    const seen = { calls: [] };
    const ok = wirePhase1Download(row, "C22548", {
      rpc: (lcscId, hints) => {
        seen.calls.push({ lcscId, hints });
        return Promise.resolve({
          ok: true,
          result: {
            lcscId,
            categoryPath: "Passives/Resistors",
            pinCount: 2,
            datasheetUrl: hints?.datasheetUrl || null,
          },
        });
      },
      snapshot: () => SNAPSHOT_C22548,
    });
    expect(ok).toBe(true);
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].lcscId).toBe("C22548");
    expect(seen.calls[0].hints).toEqual({
      categoryPath: "Passives/Resistors",
      datasheetUrl: "https://datasheet.example/C22548.pdf",
      // Issue #31 — package hint feeds the Native Host's package_form
      // detector + the JS-side Auto-Template-Match footprint scorer.
      package: null,
    });
  });

  it("renders the formatted result inline in the row's actions cell on success", async () => {
    const row = mountAnchorRow();
    wirePhase1Download(row, "C22548", {
      rpc: () =>
        Promise.resolve({
          ok: true,
          result: {
            lcscId: "C22548",
            categoryPath: "Passives/Resistors",
            pinCount: 2,
            datasheetUrl: "https://x/y.pdf",
          },
        }),
      snapshot: () => SNAPSHOT_C22548,
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    const status = row.querySelector(`[${PHASE1_STATUS_ATTR}]`);
    expect(status).toBeTruthy();
    expect(status.getAttribute(PHASE1_STATUS_ATTR)).toBe("ok");
    expect(status.textContent).toContain("Passives/Resistors");
    expect(status.textContent).toContain("2 pins");
    expect(status.textContent).toContain("datasheet ✓");
  });

  it("shows the SW error message inline when the RPC returns ok=false", async () => {
    const row = mountAnchorRow();
    wirePhase1Download(row, "C22548", {
      rpc: () => Promise.resolve({ ok: false, error: "busy" }),
      snapshot: () => SNAPSHOT_C22548,
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    const status = row.querySelector(`[${PHASE1_STATUS_ATTR}]`);
    expect(status.getAttribute(PHASE1_STATUS_ATTR)).toBe("error");
    expect(status.textContent).toContain("busy");
  });

  it("surfaces a thrown RPC error in the inline status without crashing the page", async () => {
    const row = mountAnchorRow();
    wirePhase1Download(row, "C22548", {
      rpc: () => Promise.reject(new Error("Extension was reloaded")),
      snapshot: () => SNAPSHOT_C22548,
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    const status = row.querySelector(`[${PHASE1_STATUS_ATTR}]`);
    expect(status.getAttribute(PHASE1_STATUS_ATTR)).toBe("error");
    expect(status.textContent).toContain("Extension was reloaded");
  });

  it("shows the loading state immediately on click", () => {
    const row = mountAnchorRow();
    let resolveRpc;
    wirePhase1Download(row, "C22548", {
      rpc: () => new Promise((r) => { resolveRpc = r; }),
      snapshot: () => SNAPSHOT_C22548,
    });
    clickDownload(row);
    const status = row.querySelector(`[${PHASE1_STATUS_ATTR}]`);
    expect(status.getAttribute(PHASE1_STATUS_ATTR)).toBe("loading");
    expect(status.textContent).toContain("Phase 1");
    // Resolve so jsdom doesn't keep dangling promises.
    resolveRpc({ ok: true, result: { categoryPath: null, pinCount: 0, datasheetUrl: null } });
  });

  it("forwards page-snapshot data from extractPageData on the live C22548 fixture", async () => {
    // Reuses the same DOM scaffold as lcscPageSnapshot.test.js so the
    // Phase 1 RPC payload reflects the actual content script's snapshot
    // rather than a hand-rolled subset (acceptance criterion: 'Vitest
    // reuses lcscPageSnapshot.js C22548-Fixture für den JS-Pfad').
    document.body.innerHTML = `
      <table class="w-full text-sm text-[#1C1F23] table-fixed">
        <tbody>
          <tr><td>Hersteller</td><td>YAGEO</td></tr>
          <tr><td>Herst.-Teilenr.</td><td>RC0603FR-071KL</td></tr>
          <tr><td>LCSC-Nr.</td><td>C22548</td></tr>
          <tr><td>Verp.</td><td>0603</td></tr>
          <tr><td>Datenblatt</td><td><a href="https://datasheet.example/C22548.pdf">YAGEO RC0603FR-071KL</a></td></tr>
        </tbody>
      </table>
      <table>
        <thead><tr><th>Typ</th><th>Beschreibung</th></tr></thead>
        <tbody>
          <tr><td>Kategorie</td><td>Passives/Resistors/Chip Resistor - Surface Mount</td></tr>
        </tbody>
      </table>
    `;
    const row = buildAnchorCardRow(document, { colSpan: 1 });
    const table = document.querySelector("table");
    table.querySelector("tbody").appendChild(row);
    const seen = { hints: null };
    wirePhase1Download(row, "C22548", {
      rpc: (_id, hints) => {
        seen.hints = hints;
        return Promise.resolve({
          ok: true,
          result: { categoryPath: hints?.categoryPath || null, pinCount: 2, datasheetUrl: hints?.datasheetUrl || null },
        });
      },
      snapshot: extractPageData,
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.hints).toEqual({
      categoryPath: "Passives/Resistors/Chip Resistor - Surface Mount",
      datasheetUrl: "https://datasheet.example/C22548.pdf",
      package: "0603",
    });
  });

  it("invokes onPhase1Ok with the Phase 1 result after rendering the OK status", async () => {
    const row = mountAnchorRow();
    const seen = { calls: [] };
    wirePhase1Download(row, "C22548", {
      rpc: () =>
        Promise.resolve({
          ok: true,
          result: { categoryPath: "Passives/Resistors", pinCount: 2, datasheetUrl: null },
        }),
      snapshot: () => SNAPSHOT_C22548,
      onPhase1Ok: (result, rowArg) => {
        seen.calls.push({ result, sameRow: rowArg === row });
      },
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].sameRow).toBe(true);
    expect(seen.calls[0].result.categoryPath).toBe("Passives/Resistors");
  });

  it("does not invoke onPhase1Ok when Phase 1 reports an error", async () => {
    const row = mountAnchorRow();
    let called = 0;
    wirePhase1Download(row, "C22548", {
      rpc: () => Promise.resolve({ ok: false, error: "boom" }),
      snapshot: () => SNAPSHOT_C22548,
      onPhase1Ok: () => { called += 1; },
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(0);
  });

  it("does not let a rejecting onPhase1Ok crash the click handler", async () => {
    const row = mountAnchorRow();
    wirePhase1Download(row, "C22548", {
      rpc: () =>
        Promise.resolve({
          ok: true,
          result: { categoryPath: "X", pinCount: 1, datasheetUrl: null },
        }),
      snapshot: () => SNAPSHOT_C22548,
      onPhase1Ok: () => Promise.reject(new Error("phase 2 down")),
    });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    // Phase 1's OK status remains visible even when Phase 2's chain throws —
    // we don't overwrite the row with an error from the downstream hook.
    const status = row.querySelector(`[${PHASE1_STATUS_ATTR}]`);
    expect(status.getAttribute(PHASE1_STATUS_ATTR)).toBe("ok");
  });

  it("is idempotent — a second wire call does not register a duplicate listener", async () => {
    const row = mountAnchorRow();
    let callCount = 0;
    const rpc = () => {
      callCount += 1;
      return Promise.resolve({
        ok: true,
        result: { categoryPath: "X", pinCount: 1, datasheetUrl: null },
      });
    };
    wirePhase1Download(row, "C22548", { rpc, snapshot: () => SNAPSHOT_C22548 });
    wirePhase1Download(row, "C22548", { rpc, snapshot: () => SNAPSHOT_C22548 });
    clickDownload(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(callCount).toBe(1);
  });
});
