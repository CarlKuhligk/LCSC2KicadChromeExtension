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
