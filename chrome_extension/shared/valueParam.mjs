"use strict";

/**
 * Value-Param detection (V3). The "Value-Param" is the one scraped LCSC table
 * parameter whose value fills the KiCad symbol's **Value** field — Resistance
 * for a resistor (10kΩ), Capacitance for a capacitor, etc. All other params
 * stay plain Properties (the auto-upsert). This module is the single source for
 * guessing it, shared by the Import-Editor dropdown (preselect) and the
 * content-script auto-🟢 path (so a fast Category-Match import still gets a
 * Value). One symbol → one Value-Param.
 */

/**
 * Common Value-Param names in priority order. Case-insensitive; the first one
 * present in the scraped params wins.
 */
export const PREFERRED_VALUE_PARAMS = [
  "Resistance",
  "Capacitance",
  "Inductance",
  "Voltage Rating",
  "Voltage",
];

/**
 * Pick the likely Value-Param name from a scraped ``pageParams`` map. Returns
 * the param NAME verbatim (as it appears in pageParams) or ``null`` when none of
 * the preferred names is present.
 *
 * @param {Record<string, string> | null | undefined} pageParams
 * @returns {string | null}
 */
export function detectValueParam(pageParams) {
  if (!pageParams || typeof pageParams !== "object") return null;
  const lowerToKey = new Map();
  for (const k of Object.keys(pageParams)) {
    if (typeof k !== "string" || !k.trim()) continue;
    const v = pageParams[k];
    if (typeof v !== "string" || !v.trim()) continue;
    lowerToKey.set(k.trim().toLowerCase(), k);
  }
  if (!lowerToKey.size) return null;
  for (const pref of PREFERRED_VALUE_PARAMS) {
    const hit = lowerToKey.get(pref.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
