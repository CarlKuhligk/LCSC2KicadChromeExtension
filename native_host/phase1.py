"""
V3 **Phase 1 Fetch** metadata resolver (Issue #3).

Returns the small dict the **Override Panel** needs to render with sensible
defaults: Category Path, pin count, datasheet URL. Designed to complete in
~1 s so the panel appears before the user reads it.

The resolver is wired into ``native_host.host`` as the ``fetchMetadata`` RPC
handler. It is also imported directly by ``tests/test_native_host_phase1.py``
to exercise the JSON-shape contract without going through the
Native-Messaging frame loop.

Inputs:

- ``lcsc_id`` — required, validated against ``^C\\d+$``.
- ``page_hints`` — optional dict the LCSC content script supplies from its
  **LCSC Page Snapshot**. Carries the DOM-scraped ``categoryPath`` and
  ``datasheetUrl``; the resolver normalizes the category path via the Python
  mirror so the response field is drift-free with the JS side.

The EasyEDA component API is the source of truth for pin count (and a
fallback for the datasheet URL when the page snapshot did not surface one).
"""

from __future__ import annotations

import re
from typing import Any, Callable

from easyeda2kicad.helpers import normalize_category_path

_LCSC_ID_RE = re.compile(r"^C\d+$")


def _validate_lcsc_id(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ValueError("lcscId must be a string")
    candidate = raw.strip().upper()
    if not candidate:
        raise ValueError("lcscId is required")
    if not _LCSC_ID_RE.match(candidate):
        raise ValueError(f"invalid lcscId: {raw!r}")
    return candidate


def _count_pins_in_data_str(data_str: dict[str, Any]) -> int:
    """Pin count = number of ``P~…`` lines in ``dataStr.shape``.

    EasyEDA's shape encoding uses single-letter prefixes (``P~`` pin,
    ``R~`` rectangle, ``T~`` text, …), not the multi-letter ``PIN~`` the
    original implementation assumed. Faster than running the full
    ``EasyedaSymbolImporter`` (Phase 2's job) — we only need a number,
    not the parsed pin objects.
    """
    shape = data_str.get("shape") if isinstance(data_str, dict) else None
    if not isinstance(shape, list):
        return 0
    count = 0
    for line in shape:
        if isinstance(line, str) and line.startswith("P~"):
            count += 1
    return count


def _datasheet_from_cad(cad: dict[str, Any]) -> str | None:
    """Mirror of ``easyeda_importer._resolve_datasheet_url`` for Phase 1.

    Returns ``None`` when EasyEDA exposes neither an explicit URL nor an
    LCSC product number to derive one from. We do NOT synthesize the LCSC
    product URL here — Phase 1 returns ``null`` and the panel falls back to
    the DOM scrape's ``datasheetUrl`` instead.
    """
    if not isinstance(cad, dict):
        return None
    lcsc = cad.get("lcsc") or {}
    if isinstance(lcsc, dict):
        url = lcsc.get("url")
        if isinstance(url, str) and url.strip():
            return url.strip()
    return None


def _pin_count_from_cad(cad: dict[str, Any]) -> int | None:
    if not isinstance(cad, dict):
        return None
    data_str = cad.get("dataStr")
    if not isinstance(data_str, dict):
        return None
    return _count_pins_in_data_str(data_str)


def fetch_metadata(
    lcsc_id: Any,
    page_hints: dict[str, Any] | None = None,
    *,
    cad_fetcher: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Resolve Phase 1 metadata for ``lcsc_id``.

    Args:
        lcsc_id: LCSC part identifier (``^C\\d+$``). Whitespace is trimmed
            and lower-case is upper-cased.
        page_hints: Optional dict from the LCSC content script's
            **LCSC Page Snapshot** — ``{"categoryPath", "datasheetUrl"}``.
        cad_fetcher: Optional override for the EasyEDA component-data fetch.
            Defaults to ``EasyedaApi().get_cad_data_of_component``. Tests
            inject a stub that returns a fixed dict so they don't hit the
            real API.

    Returns:
        ``{"lcscId", "categoryPath", "pinCount", "datasheetUrl"}``. Any
        field other than ``lcscId`` may be ``None``/``0`` when the source
        did not surface it; the panel handles missing fields gracefully.

    Raises:
        ValueError: when ``lcsc_id`` is missing or malformed.
    """
    normalized_id = _validate_lcsc_id(lcsc_id)

    if cad_fetcher is None:
        from easyeda2kicad.easyeda.easyeda_api import EasyedaApi

        cad_fetcher = EasyedaApi().get_cad_data_of_component

    cad: dict[str, Any]
    try:
        cad = cad_fetcher(normalized_id) or {}
    except Exception:
        cad = {}

    pin_count = _pin_count_from_cad(cad) or 0
    easyeda_datasheet = _datasheet_from_cad(cad)

    hint_category: Any = None
    hint_datasheet: Any = None
    if isinstance(page_hints, dict):
        hint_category = page_hints.get("categoryPath")
        hint_datasheet = page_hints.get("datasheetUrl")

    category_path = normalize_category_path(hint_category) or None
    datasheet_url = (
        hint_datasheet
        if isinstance(hint_datasheet, str) and hint_datasheet.strip()
        else easyeda_datasheet
    )
    if isinstance(datasheet_url, str):
        datasheet_url = datasheet_url.strip() or None

    return {
        "lcscId": normalized_id,
        "categoryPath": category_path,
        "pinCount": pin_count,
        "datasheetUrl": datasheet_url,
    }
