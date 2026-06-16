"""
Unicode normalization + property hygiene for KiCad symbol text.

KiCad's default fonts often lack single-codepoint compatibility characters (e.g. U+2103 ℃).
Fuzzy property matching maps LCSC parameter names to template field names that differ only
by encoding (℃ vs °C, Unicode dashes, etc.).
``strip_property_whitespace`` / ``find_property_whitespace`` trim and report leading/trailing
whitespace in property keys/values (KiCad warns on those).
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


# Matches one ``(property "KEY" "VALUE"`` declaration head, capturing key and value
# separately. ``[^"]*`` mirrors the assumption used throughout the merge code
# (``_replace_property_value`` / ``_list_property_names``): values never contain a
# literal ``"`` because every write path escapes it to ``'``.
_PROPERTY_KEY_VALUE_RE = re.compile(r'(\(property\s+")([^"]*)("\s+")([^"]*)(")')


def strip_property_whitespace(text: str) -> str:
    """Trim leading/trailing whitespace from the key and value of every
    ``(property "key" "value" …)`` declaration in a KiCad symbol/library string.

    KiCad's library checker flags fields with leading or trailing spaces
    ("Some symbols contain leading/trailing spaces"). Scraped LCSC values and,
    above all, hand-edited or cloned template symbols can carry such padding.
    This collapses only the edges — internal spacing is preserved (``"100 nF"``
    stays ``"100 nF"``). It operates on a single symbol block or a whole
    ``.kicad_sym`` file alike (plain regex over the property heads), so the same
    routine guards the import write path and the library-cleanup verb.
    """
    if not text:
        return text

    def _repl(m: "re.Match[str]") -> str:
        return (
            m.group(1)
            + m.group(2).strip()
            + m.group(3)
            + m.group(4).strip()
            + m.group(5)
        )

    return _PROPERTY_KEY_VALUE_RE.sub(_repl, text)


def find_property_whitespace(text: str) -> list[dict[str, str]]:
    """Read-only companion to :func:`strip_property_whitespace`.

    Report every ``(property "key" "value" …)`` whose key or value carries
    leading/trailing whitespace. Drives the ``validateLibrary`` report and the
    ``cleanLibrary`` preview. Each entry is ``{"field", "kind"}`` where ``field``
    is the trimmed key and ``kind`` is ``"key"`` / ``"value"`` / ``"both"``.
    """
    if not text:
        return []
    issues: list[dict[str, str]] = []
    for m in _PROPERTY_KEY_VALUE_RE.finditer(text):
        key, value = m.group(2), m.group(4)
        key_dirty = key != key.strip()
        val_dirty = value != value.strip()
        if not (key_dirty or val_dirty):
            continue
        kind = "both" if key_dirty and val_dirty else ("key" if key_dirty else "value")
        issues.append({"field": key.strip(), "kind": kind})
    return issues


def normalize_property_key_for_match(s: str) -> str:
    """
    Canonical form for matching LCSC / template property *names* when they differ
    only by Unicode encoding, spacing, or letter case.
    """
    t = normalize_for_kicad_text(s)
    t = re.sub(r"\s+", " ", t.strip())
    return t.casefold()


def normalized_match_keys_for_lcsc_param(prop_name: str) -> frozenset[str]:
    """
    Normalized property-key form to match a ``symbol_params`` key against template
    ``(property "…")`` names. Matching folds only Unicode encoding, spacing, and
    case — there are deliberately no synonym/alias exceptions: template labels are
    authored to match the LCSC page wording verbatim (owner convention).
    """
    return frozenset({normalize_property_key_for_match(prop_name)})


def lcsc_param_matches_any_template_field(
    prop_name: str,
    initial_template_norms: set[str],
) -> bool:
    """Whether this LCSC param key corresponds to some template field name (including aliases)."""
    return bool(initial_template_norms & set(normalized_match_keys_for_lcsc_param(prop_name)))
