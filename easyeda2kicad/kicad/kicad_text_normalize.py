"""
Unicode normalization for KiCad symbol text.

KiCad's default fonts often lack single-codepoint compatibility characters (e.g. U+2103 ℃).
Fuzzy property matching maps LCSC parameter names to template field names that differ only
by encoding (℃ vs °C, Unicode dashes, etc.).
"""
from __future__ import annotations

import re
import unicodedata

# Hyphen / minus variants seen in datasheets and copy-paste
_DASH_LIKE = (
    "\u2010",
    "\u2011",
    "\u2012",
    "\u2013",
    "\u2014",
    "\u2212",
    "\ufe58",
    "\uff0d",
)


def normalize_for_kicad_text(s: str) -> str:
    """
    Replace characters that often render as tofu in KiCad with common alternatives.

    Applied to merged property values and, when needed, property names.
    """
    if not s:
        return s
    t = unicodedata.normalize("NFKC", s)
    for c in _DASH_LIKE:
        t = t.replace(c, "-")
    t = t.replace("\u2103", "\u00b0C")  # ℃
    t = t.replace("\u2109", "\u00b0F")  # ℉
    t = t.replace("\ufeff", "")
    t = t.replace("\u200b", "")
    t = t.replace("\u200c", "")
    t = t.replace("\u200d", "")
    return t


def normalize_property_key_for_match(s: str) -> str:
    """
    Canonical form for matching LCSC / template property *names* when they differ
    only by Unicode encoding, spacing, or letter case.
    """
    t = normalize_for_kicad_text(s)
    t = re.sub(r"\s+", " ", t.strip())
    return t.casefold()


# Reverse of ``chrome_extension/background.js`` ``LCSC_PARAMS_MAP``: the extension sends
# mapped (canonical) keys in ``symbol_params``, but KiCad templates often use the original
# LCSC page wording (e.g. "Temperature Coefficient" vs "Temp. Coefficient").
LCSC_CANONICAL_TO_PAGE_LABEL_ALIASES: dict[str, tuple[str, ...]] = {
    "Temp. Coefficient": ("Temperature Coefficient",),
    "Operating Temp.": ("Operating Temperature",),
    "Storage Temp.": ("Storage Temperature",),
    "Power": (
        "Power(Watts)",
        "Rated Power",
        "Power Dissipation",
        "Rated Power (Watts)",
    ),
    "Tolerance": ("Tolerance (±)", "Resistance Tolerance", "Capacitance Tolerance"),
    "Voltage Rating": (
        "Voltage Rating - DC",
        "Voltage - Rated",
        "Voltage Rating DC",
        "Rated Voltage",
        "Voltage Rating (Max)",
    ),
    "DCR": ("DC Resistance (DCR) (Max)", "DC Resistance"),
    "Sat. Current": ("Saturation Current (Isat)", "Saturation Current"),
    "Self Res. Freq.": ("Self Resonant Frequency",),
    "MPN": ("Manufacturer Part Number",),
    "Mounting": ("Mounting Type",),
}


def normalized_match_keys_for_lcsc_param(prop_name: str) -> frozenset[str]:
    """
    Normalized property-key forms to try when matching a ``symbol_params`` key to template
    ``(property "…")`` names (canonical key plus LCSC page-label aliases).
    """
    name = prop_name.strip()
    keys: set[str] = {normalize_property_key_for_match(name)}
    for alt in LCSC_CANONICAL_TO_PAGE_LABEL_ALIASES.get(name, ()):
        keys.add(normalize_property_key_for_match(alt))
    return frozenset(keys)


def lcsc_param_matches_any_template_field(
    prop_name: str,
    initial_template_norms: set[str],
) -> bool:
    """Whether this LCSC param key corresponds to some template field name (including aliases)."""
    return bool(initial_template_norms & set(normalized_match_keys_for_lcsc_param(prop_name)))
