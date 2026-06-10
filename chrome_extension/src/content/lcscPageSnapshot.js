"use strict";

import { normalizeCategoryPath } from "../../shared/categoryPath.mjs";

/**
 * LCSC Page Snapshot (see CONTEXT.md): the frozen view of DOM data we need per
 * import — LCSC ID, breadcrumb Category Path, attribute-table params, datasheet
 * URL. Re-extracted on every gate (we do not subscribe to LCSC DOM mutations).
 *
 * Modern LCSC (post-2026 Tailwind migration) presents parameters across multiple
 * tables with utility-class names rather than the legacy `tableInfoWrap`. The
 * scraper is therefore *structural*, not class-based: walk every `<table>`, take
 * 2- or 3-column rows whose first cell is a short label, and aggregate into a
 * single params map with last-write-wins so cleaner spec-table values overwrite
 * the header card's concatenations.
 */

/**
 * Multilingual labels for keys that orchestrate the import. The parameter
 * *values* (e.g. "Power(Watts)", "Resistance") stay English-ish across LCSC
 * locales, but the surrounding table chrome is localized, so we map a few
 * load-bearing labels by language.
 */
export const PAGE_SCRAPE_LABELS = {
  category: ["Category", "Kategorie", "分类", "Catégorie"],
  packageSize: ["Package", "Verp.", "Verpackung", "Paquet", "封装"],
  description: ["Hauptmerkm.", "Hauptmerkmale", "Description", "Beschreibung", "描述"],
  datasheet: ["Datasheet", "Datenblatt", "Fiche technique", "数据手册"],
};

/**
 * Non-English category labels seen in the scrape — a fallback signal when the
 * page sets no ``<html lang>``. If the snapshot's category label is one of
 * these, the session is clearly localized.
 */
const _NON_ENGLISH_CATEGORY_LABELS = new Set(["kategorie", "分类", "catégorie"]);

/**
 * Detect whether the LCSC page renders in English. The scraped parameter
 * *values* inherit the page's display language, so a non-English session
 * produces mixed/localized symbol Properties AND breaks the category match
 * ("Widerstände" never matches a template tagged "Resistors"). Callers warn
 * the user — and the docs say so in bold — when this returns ``isEnglish:false``.
 *
 * Primary signal: ``<html lang>``. Fallback (when lang is absent): the language
 * of the scraped category label. ``known:false`` means we could not tell, so
 * callers should stay silent rather than cry wolf.
 *
 * @param {Document} [doc=document]
 * @param {{ categoryLabel?: string | null }} [hints]
 * @returns {{ lang: string, isEnglish: boolean, known: boolean }}
 */
export function detectLcscLanguage(doc = document, hints = {}) {
  const raw = (doc?.documentElement?.getAttribute?.("lang") || "")
    .trim()
    .toLowerCase();
  if (raw) {
    const isEnglish = raw === "en" || raw.startsWith("en-") || raw.startsWith("en_");
    return { lang: raw, isEnglish, known: true };
  }
  const label = (hints?.categoryLabel || "").trim().toLowerCase();
  if (label && _NON_ENGLISH_CATEGORY_LABELS.has(label)) {
    return { lang: label, isEnglish: false, known: true };
  }
  return { lang: "", isEnglish: true, known: false };
}

function firstNonEmptyValueFor(params, candidates) {
  for (const key of candidates) {
    const v = params[key];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/**
 * Heuristic: skip pricing tables. They have monetary cell content and
 * quantity-like first-column headers (Stk./Qty/E-Preis) — not specs.
 */
export function looksLikePricingTable(tbl) {
  const cls = (tbl.className?.toString?.() || "").toLowerCase();
  if (cls.includes("pricetable")) return true;
  const firstRow = tbl.querySelector("tr");
  if (!firstRow) return false;
  const text = (firstRow.textContent || "").toLowerCase();
  return /(stk\.|qty|quantity|e-preis|gesamtbetrag|unit price|price)/.test(text)
    && /(\$|€|cny|usd|eur)/i.test((tbl.textContent || ""));
}

/**
 * @typedef {{
 *   category: string | null,
 *   package: string | null,
 *   params: Record<string, string>,
 *   description: string | null,
 *   datasheetUrl: string | null,
 *   valueParamOptions: string[],
 * }} LcscPageSnapshot
 *
 * @param {Document} [doc=document]
 * @returns {LcscPageSnapshot}
 */
export function extractPageData(doc = document) {
  try {
    const params = {};
    const labelsInOrder = [];
    const seenLabel = new Set();

    doc.querySelectorAll("table").forEach((tbl) => {
      if (looksLikePricingTable(tbl)) return;
      tbl.querySelectorAll("tr").forEach((tr) => {
        if (tr.querySelector("th")) return; // header row
        const cells = [...tr.children];
        if (cells.length < 2) return;
        const keyEl = cells[0];
        const valEl = cells[1];
        if (keyEl.querySelector("table") || valEl.querySelector("table")) return;
        const key = (keyEl.textContent || "").replace(/\s+/g, " ").trim();
        if (!key || key.length > 80) return;
        // Quantity-range rows in pricing-like tables ("85,000+", "100").
        if (/^[\d,.]+\+?$/.test(key)) return;
        const link = valEl.querySelector("a[href]");
        let value;
        if (link && link.textContent.trim()) {
          value = link.textContent.replace(/\s+/g, " ").trim();
        } else {
          value = (valEl.textContent || "").replace(/\s+/g, " ").trim();
        }
        params[key] = value;
        if (!seenLabel.has(key)) {
          seenLabel.add(key);
          labelsInOrder.push(key);
        }
      });
    });

    const categoryRaw = firstNonEmptyValueFor(params, PAGE_SCRAPE_LABELS.category);
    const category = categoryRaw ? normalizeCategoryPath(categoryRaw) || null : null;
    const pkg = firstNonEmptyValueFor(params, PAGE_SCRAPE_LABELS.packageSize);
    const description = firstNonEmptyValueFor(params, PAGE_SCRAPE_LABELS.description);

    let datasheetUrl = null;
    for (const tr of doc.querySelectorAll("table tr")) {
      const cells = [...tr.children];
      if (cells.length < 2) continue;
      const key = (cells[0].textContent || "").trim();
      if (PAGE_SCRAPE_LABELS.datasheet.includes(key)) {
        const a = cells[1].querySelector("a[href]");
        if (a) {
          datasheetUrl = a.href || null;
          break;
        }
      }
    }
    if (!datasheetUrl) {
      const pdf = doc.querySelector('a[href*=".pdf"]');
      datasheetUrl = pdf ? pdf.href : null;
    }

    const preferredFirst = [
      "Mfr. Part #",
      "Manufacturer Part Number",
      "Herst.-Teilenr.",
      "Hersteller-Teilenr.",
      "Manufacturer",
      "Hersteller",
      "Category",
      "Kategorie",
      "Package",
      "Verp.",
    ];
    const valueParamOptions = [];
    const used = new Set();
    const add = (k) => {
      const key = (k || "").trim();
      if (!key || used.has(key)) return;
      used.add(key);
      valueParamOptions.push(key);
    };
    preferredFirst.forEach((k) => {
      if (params[k] != null) add(k);
    });
    labelsInOrder.forEach(add);

    return {
      category,
      package: pkg,
      params,
      description,
      datasheetUrl,
      valueParamOptions,
    };
  } catch (_err) {
    return {
      category: null,
      package: null,
      params: {},
      description: null,
      datasheetUrl: null,
      valueParamOptions: [],
    };
  }
}
