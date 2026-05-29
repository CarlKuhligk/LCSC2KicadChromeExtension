"""
V3 Template-Listing resolver (Issue #5 follow-up).

Lists symbol names and footprint names of a Template Library so the
**Override Panel** can populate its Symbol / Footprint Source dropdowns.
In V2 this came from the WebSocket backend's ``templates_symbols`` RPC;
V3 talks Native Messaging directly, so the SW asks the Native Host to do
the on-disk listing.

A Template Library is a ``.kicad_sym`` file plus (optionally) a sibling
``.pretty/`` directory of ``.kicad_mod`` footprints, by KiCad convention:

    MyTemplates.kicad_sym         ← symbol layer
    MyTemplates.pretty/X.kicad_mod ← footprint layer (one file per FP)

Either layer may be missing; the resolver returns the layers it found.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from easyeda2kicad.helpers import list_symbols_in_lib


def _list_footprints_in_pretty(pretty_dir: Path) -> list[str]:
    """Return footprint names (no ``.kicad_mod`` suffix) sorted alphabetically.

    Quiet on missing directories — that just means no Footprint layer.
    """
    if not pretty_dir.is_dir():
        return []
    return sorted(
        p.stem for p in pretty_dir.iterdir() if p.suffix == ".kicad_mod" and p.is_file()
    )


def _resolve_pretty_dir(symbol_lib_path: Path) -> Path:
    """Pair ``Foo.kicad_sym`` with the sibling ``Foo.pretty/`` directory."""
    return symbol_lib_path.with_suffix(".pretty")


def list_templates(lib_path: Any) -> dict[str, Any]:
    """List symbols + footprints belonging to a Template Library.

    Args:
        lib_path: Filesystem path to the ``.kicad_sym`` file. Required.

    Returns:
        ``{"libPath": str, "symbols": [...], "footprints": [...]}``. Both
        lists may be empty when the file is missing or the layer doesn't
        exist.

    Raises:
        ValueError: when ``lib_path`` is missing or empty.
    """
    raw = lib_path if isinstance(lib_path, str) else ""
    candidate = raw.strip()
    if not candidate:
        raise ValueError("libPath is required")
    sym = Path(candidate)
    symbols = list_symbols_in_lib(str(sym)) if sym.is_file() else []
    footprints = _list_footprints_in_pretty(_resolve_pretty_dir(sym))
    return {
        "libPath": candidate,
        "symbols": list(symbols),
        "footprints": list(footprints),
    }
