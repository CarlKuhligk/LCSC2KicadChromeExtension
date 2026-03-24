from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from collections import deque
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional, Set, Tuple

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
from easyeda2kicad.helpers import (
    count_pins_in_symbol_string,
    extract_symbol_from_lib,
    lcsc_primary_and_sub_symbols,
    list_symbols_in_lib,
)
from easyeda2kicad.kicad.symbol_pin_remap import list_pins_from_symbol_block
from easyeda2kicad.kicad.symbol_preview_svg import symbol_block_to_svg
from easyeda2kicad.kicad.template_merger import KNOWN_TEMPLATE_NAMES
from easyeda2kicad.service import (
    ConversionError,
    ConversionRequest,
    ConversionResult,
    ConversionStage,
    run_conversion,
)
from easyeda2kicad.service.lcsc_preview import (
    easyeda_pins_from_cad,
    footprint_preview_bundle,
    suggested_pad_to_symbol_map,
)
from easyeda2kicad.api.models import (
    ComponentCheckRequest,
    ComponentCheckResponse,
    ConversionResultModel,
    GalleryTemplateRef,
    LcscFootprintPreviewPayload,
    LibraryScaffoldRequest,
    LibraryScaffoldResponse,
    LibraryValidateRequest,
    LibraryValidateResponse,
    PathRequest,
    TaskCreatePayload,
    TaskDetail,
    TaskSummary,
    TemplatePinCheckPayload,
    TemplatePinCheckResponse,
    TemplatePinMapContextPayload,
    TemplatePreviewPayload,
    TemplatesGalleryPinSummaryPayload,
)

log = logging.getLogger(__name__)

# KiCad 3D package folder: count geometry KiCad can reference (not only legacy WRL).
_MODEL_FILE_SUFFIXES = frozenset({".wrl", ".step", ".stp", ".igs", ".iges"})

_WS_JOB_TRACE = os.environ.get("EASYEDA2KICAD_WS_JOB_TRACE", "").strip().lower() in (
    "1",
    "true",
    "yes",
)


def _job_trace(msg: str) -> None:
    if _WS_JOB_TRACE:
        log.info("[ws-job] %s", msg)


class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class TaskRecord:
    id: str
    request: ConversionRequest
    status: str = TaskStatus.QUEUED
    progress: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    result: Optional[ConversionResult] = None
    log: List[dict[str, Any]] = field(default_factory=list)


async def _fetch_cad_data_for_lcsc(lcsc_id: str) -> dict:
    """EasyEDA CAD JSON for a component; raises HTTPException on failure."""
    api = EasyedaApi()
    cad_data: Dict[str, Any] = {}
    last_exc: Exception | None = None
    for attempt in range(1, 4):
        try:
            cad_data = api.get_cad_data_of_component(lcsc_id=lcsc_id)
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            if attempt < 3:
                await asyncio.sleep(1)
            else:
                break
    if last_exc is not None:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch EasyEDA data for {lcsc_id}: {last_exc}",
        ) from last_exc
    if not cad_data:
        raise HTTPException(
            status_code=404,
            detail=f"No CAD data for component {lcsc_id}.",
        )
    return cad_data


async def run_templates_pin_check(payload: TemplatePinCheckPayload) -> TemplatePinCheckResponse:
    """Shared by REST and WebSocket extension API."""
    lcsc_id = payload.lcsc_id.strip().upper()
    if not lcsc_id.startswith("C"):
        raise HTTPException(status_code=400, detail="LCSC ID must start with 'C'.")
    cad_data = await _fetch_cad_data_for_lcsc(lcsc_id)
    primary_symbol, _ = lcsc_primary_and_sub_symbols(cad_data)
    easyeda_pin_count = len(primary_symbol.pins)

    template_str = extract_symbol_from_lib(payload.template_lib_path, payload.template_name)
    if not template_str:
        raise HTTPException(
            status_code=404,
            detail=f"Template '{payload.template_name}' not found in {payload.template_lib_path}.",
        )
    template_pin_count = count_pins_in_symbol_string(template_str)
    match = easyeda_pin_count == template_pin_count
    return TemplatePinCheckResponse(
        easyeda_pin_count=easyeda_pin_count,
        template_pin_count=template_pin_count,
        match=match,
    )


async def run_templates_gallery_pin_summary(
    payload: TemplatesGalleryPinSummaryPayload,
) -> dict[str, Any]:
    """
    One EasyEDA fetch, then pin counts for many template symbols (gallery left pane).
    """
    lcsc_id = payload.lcsc_id.strip().upper()
    if not lcsc_id.startswith("C"):
        raise HTTPException(status_code=400, detail="LCSC ID must start with 'C'.")
    cad_data = await _fetch_cad_data_for_lcsc(lcsc_id)
    primary_symbol, _ = lcsc_primary_and_sub_symbols(cad_data)
    easyeda_pin_count = len(primary_symbol.pins)

    entries: List[dict[str, Any]] = []
    for t in payload.templates:
        name = (t.template_name or "").strip()
        lib = (t.template_lib_path or "").strip()
        if not name or not lib:
            continue
        template_str = extract_symbol_from_lib(lib, name)
        if not template_str:
            entries.append(
                {
                    "template_name": name,
                    "template_lib_path": lib,
                    "template_pin_count": -1,
                    "match": False,
                }
            )
            continue
        c = count_pins_in_symbol_string(template_str)
        entries.append(
            {
                "template_name": name,
                "template_lib_path": lib,
                "template_pin_count": c,
                "match": c == easyeda_pin_count,
            }
        )

    return {
        "easyeda_pin_count": easyeda_pin_count,
        "entries": entries,
    }


def run_template_preview(payload: TemplatePreviewPayload) -> dict[str, Any]:
    """SVG preview of a template symbol (for extension hover / dialog)."""
    # Intrinsic SVG pixel size (not the extension panel): larger = sharper when scaled in the UI.
    w, h = (1600, 1200) if payload.label_pins else (300, 225)
    template_str = extract_symbol_from_lib(
        payload.template_lib_path.strip(), payload.template_name.strip()
    )
    if not template_str:
        return {"ok": False, "error": "symbol_not_found"}
    pins: List[dict[str, str]] = list_pins_from_symbol_block(template_str)
    svg, meta = symbol_block_to_svg(
        template_str,
        label_pins=payload.label_pins,
        draw_pin_names=payload.draw_pin_names,
        width_px=w,
        height_px=h,
        preview_theme=payload.preview_theme,
    )
    if svg is None:
        return {"ok": False, **meta}
    out: dict[str, Any] = {"ok": True, "svg": svg, "pins": pins}
    if isinstance(meta, dict):
        for k, v in meta.items():
            if k not in out:
                out[k] = v
    return out


async def run_templates_pin_map_context(payload: TemplatePinMapContextPayload) -> dict[str, Any]:
    """Pins, pads, SVG previews for the template pin-assignment dialog."""
    lcsc_id = payload.lcsc_id.strip().upper()
    if not lcsc_id.startswith("C"):
        raise HTTPException(status_code=400, detail="LCSC ID must start with 'C'.")
    cad_data = await _fetch_cad_data_for_lcsc(lcsc_id)

    easyeda_pins = easyeda_pins_from_cad(cad_data)

    template_str = extract_symbol_from_lib(
        payload.template_lib_path.strip(), payload.template_name.strip()
    )
    if not template_str:
        raise HTTPException(
            status_code=404,
            detail=f"Template '{payload.template_name}' not found in {payload.template_lib_path}.",
        )

    template_pins = list_pins_from_symbol_block(template_str)

    sym_preview = run_template_preview(
        TemplatePreviewPayload(
            template_name=payload.template_name,
            template_lib_path=payload.template_lib_path,
            label_pins=True,
            draw_pin_names=False,
        )
    )
    symbol_svg = sym_preview.get("svg") if sym_preview.get("ok") else None

    fp_bundle = footprint_preview_bundle(
        cad_data, width_px=220, height_px=220, lcsc_id=lcsc_id
    )
    suggested_map = suggested_pad_to_symbol_map(easyeda_pins, fp_bundle.pads)

    return {
        "symbol_svg": symbol_svg,
        "footprint_svg": fp_bundle.footprint_svg,
        "easyeda_pins": easyeda_pins,
        "template_pins": template_pins,
        "pads": fp_bundle.pads,
        "suggested_map": suggested_map,
        "footprint_name": fp_bundle.footprint_name,
    }


async def run_lcsc_footprint_preview(payload: LcscFootprintPreviewPayload) -> dict[str, Any]:
    """EasyEDA footprint → SVG + pad list + LCSC schematic pin numbers for template gallery PAD map."""
    lcsc_id = payload.lcsc_id.strip().upper()
    if not lcsc_id.startswith("C"):
        raise HTTPException(status_code=400, detail="LCSC ID must start with 'C'.")
    cad_data = await _fetch_cad_data_for_lcsc(lcsc_id)

    easyeda_pins: List[dict[str, str]] = []
    try:
        easyeda_pins = easyeda_pins_from_cad(cad_data)
    except Exception as exc:
        log.warning("LCSC schematic pins for footprint preview failed for %s: %s", lcsc_id, exc)

    fp_bundle = footprint_preview_bundle(
        cad_data, width_px=960, height_px=960, lcsc_id=lcsc_id
    )
    return {
        "ok": fp_bundle.ok,
        "footprint_svg": fp_bundle.footprint_svg,
        "footprint_name": fp_bundle.footprint_name,
        "pads": fp_bundle.pads,
        "easyeda_pins": easyeda_pins,
    }


@dataclass
class ExtensionClient:
    """Chrome extension multiplexed WS: subscribed task_ids receive task_update pushes."""

    ws: WebSocket
    task_ids: Set[str] = field(default_factory=set)


def _normalize_library_prefix(base_path: str, library_name: str) -> Path:
    try:
        base = Path(base_path).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base path: {base_path}") from exc
    cleaned_name = (library_name or "").strip()
    if not cleaned_name:
        raise HTTPException(status_code=400, detail="Library name must not be empty.")
    if any(sep in cleaned_name for sep in ("/", "\\")):
        raise HTTPException(status_code=400, detail="Library name must not contain path separators.")
    return base / cleaned_name


def _ensure_directory_writable(path: Path) -> None:
    if not path.exists():
        try:
            path.mkdir(parents=True, exist_ok=True)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=f"Missing permissions for '{path}'.") from exc
    if not os.access(str(path), os.W_OK):
        raise HTTPException(status_code=403, detail=f"Directory not writable: {path}")


def _scaffold_library(payload: LibraryScaffoldRequest) -> Tuple[Path, Dict[str, bool], Dict[str, Optional[str]]]:
    prefix = _normalize_library_prefix(payload.base_path, payload.library_name)
    _ensure_directory_writable(prefix.parent)

    created: Dict[str, bool] = {"symbol": False, "footprint": False, "model": False}
    paths: Dict[str, Optional[str]] = {"symbol": None, "footprint": None, "model": None}

    if not prefix.exists():
        try:
            prefix.mkdir(exist_ok=True)
        except OSError as exc:
            raise HTTPException(status_code=403, detail=f"Unable to create library folder: {prefix}") from exc

    symbol_path = prefix.with_suffix(".kicad_sym")
    if payload.symbol:
        if not symbol_path.exists():
            try:
                symbol_path.write_text(
                    "(kicad_symbol_lib\n"
                    "  (version 20211014)\n"
                    "  (generator https://github.com/uPesy/easyeda2kicad.py)\n"
                    ")",
                    encoding="utf-8",
                )
            except OSError as exc:
                raise HTTPException(status_code=403, detail=f"Unable to create symbol file: {symbol_path}") from exc
            created["symbol"] = True
        paths["symbol"] = str(symbol_path)
    elif symbol_path.exists():
        paths["symbol"] = str(symbol_path)

    footprint_dir = prefix.with_suffix(".pretty")
    if payload.footprint:
        if not footprint_dir.exists():
            try:
                footprint_dir.mkdir(exist_ok=True)
            except OSError as exc:
                raise HTTPException(status_code=403, detail=f"Unable to create footprint folder: {footprint_dir}") from exc
            created["footprint"] = True
        paths["footprint"] = str(footprint_dir)
    elif footprint_dir.exists():
        paths["footprint"] = str(footprint_dir)

    if payload.model or payload.footprint:
        model_dir = prefix.with_suffix(".3dshapes")
        created_model = False
        if not model_dir.exists():
            try:
                model_dir.mkdir(exist_ok=True)
            except OSError as exc:
                raise HTTPException(status_code=403, detail=f"Unable to create 3D folder: {model_dir}") from exc
            created_model = True
        if model_dir.exists():
            paths["model"] = str(model_dir)
        if payload.model:
            created["model"] = created_model
        elif created_model:
            created["model"] = True

    return prefix, created, paths


def _inspect_library(path: str) -> LibraryValidateResponse:
    try:
        target = Path(path).expanduser()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    resolved = target.resolve(strict=False)
    is_dir = resolved.is_dir()
    is_file = resolved.is_file()

    assets = {"symbol": False, "footprint": False, "model": False}
    counts = {"symbol": 0, "footprint": 0, "model": 0}
    warnings: List[str] = []

    lower_suffix = resolved.suffix.lower()
    if is_file and lower_suffix in {".kicad_sym", ".lib"}:
        symbol_candidates = [resolved]
        library_root = resolved.with_suffix("")
    else:
        symbol_candidates = [resolved.with_suffix(".kicad_sym"), resolved.with_suffix(".lib")]
        library_root = resolved

    symbol_exists = next((candidate for candidate in symbol_candidates if candidate.is_file()), None)
    if symbol_exists:
        assets["symbol"] = True
        counts["symbol"] = _count_symbols_in_file(symbol_exists)

    footprint_dir = library_root.with_suffix(".pretty")
    footprint_exists = footprint_dir.is_dir()
    if footprint_exists:
        assets["footprint"] = True
        counts["footprint"] = sum(1 for item in footprint_dir.iterdir() if item.is_file() and item.suffix == ".kicad_mod")
    model_path = _extract_model_path(footprint_dir) if footprint_exists else None

    model_dir = library_root.with_suffix(".3dshapes")
    model_exists = model_dir.is_dir()
    if model_exists:
        assets["model"] = True
        counts["model"] = sum(
            1
            for item in model_dir.iterdir()
            if item.is_file() and item.suffix.lower() in _MODEL_FILE_SUFFIXES
        )

    exists = resolved.exists() or bool(symbol_exists) or footprint_exists or model_exists

    writable = False
    if symbol_exists:
        writable = os.access(str(symbol_exists.parent), os.W_OK)
        if not writable:
            warnings.append("Library file is not writable.")
    elif exists and is_dir:
        writable = os.access(str(resolved), os.W_OK)
        if not writable:
            warnings.append("Directory is not writable.")
    else:
        parent = resolved.parent
        if parent.exists():
            writable = os.access(str(parent), os.W_OK)
            if not writable:
                warnings.append("Parent directory is not writable.")
        else:
            warnings.append("Parent directory does not exist.")

    return LibraryValidateResponse(
        resolved_path=str(symbol_exists or resolved),
        exists=exists,
        is_dir=is_dir,
        writable=writable,
        assets=assets,
        counts=counts,
        warnings=warnings,
        model_path=model_path,
    )


def _extract_model_path(footprint_dir: Path) -> Optional[str]:
    if not footprint_dir.exists():
        return None
    candidates = list(footprint_dir.glob("*.kicad_mod"))
    for candidate in candidates[:20]:
        try:
            content = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        match = re.search(r'\(model\s+"([^"]+)"', content)
        if not match:
            match = re.search(r"\(model\s+([^\s\)]+)", content)
        if not match:
            continue
        model_path = match.group(1).strip()
        if not model_path:
            return None
        last_slash = max(model_path.rfind("/"), model_path.rfind("\\"))
        if last_slash == -1:
            return None
        return model_path[:last_slash]
    return None


def _extract_model_paths(footprint_path: Path, model_dir: Path) -> Dict[str, str]:
    try:
        content = footprint_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}

    model_paths: Dict[str, str] = {}
    for match in re.finditer(r'\(model\s+(?:"([^"]+)"|([^\s\)]+))', content):
        raw_path = (match.group(1) or match.group(2) or "").strip()
        if not raw_path:
            continue
        resolved = _resolve_model_candidate(raw_path, model_dir)
        if resolved:
            model_paths[resolved.name] = str(resolved)
    return model_paths


def _resolve_model_candidate(raw_path: str, model_dir: Path) -> Optional[Path]:
    cleaned = raw_path.strip().replace("\\", "/")
    if cleaned.startswith("${KIPRJMOD}"):
        cleaned = cleaned[len("${KIPRJMOD}") :]
    cleaned = cleaned.lstrip("/")

    candidate = Path(cleaned)
    if candidate.is_absolute():
        if candidate.is_file():
            return candidate
        return None

    for base in (model_dir, model_dir.parent):
        resolved = (base / cleaned).resolve(strict=False)
        if resolved.is_file():
            return resolved

    basename = Path(raw_path).name
    if basename:
        fallback = model_dir / basename
        if fallback.is_file():
            return fallback

    return None


def _iter_symbol_blocks_v6(content: str) -> List[str]:
    blocks: List[str] = []
    depth = 0
    in_block = False
    block_lines: List[str] = []
    for line in content.splitlines():
        if not in_block:
            if line.lstrip().startswith("(symbol "):
                in_block = True
                depth = line.count("(") - line.count(")")
                block_lines = [line]
                if depth <= 0:
                    blocks.append("\n".join(block_lines))
                    in_block = False
            continue
        block_lines.append(line)
        depth += line.count("(") - line.count(")")
        if depth <= 0:
            blocks.append("\n".join(block_lines))
            in_block = False
    return blocks


def _iter_symbol_blocks_v5(content: str) -> List[str]:
    blocks: List[str] = []
    block_lines: List[str] = []
    in_block = False
    for line in content.splitlines():
        if not in_block:
            if line.startswith("DEF "):
                in_block = True
                block_lines = [line]
            continue
        block_lines.append(line)
        if line.strip() == "ENDDEF":
            blocks.append("\n".join(block_lines))
            in_block = False
    return blocks


def _find_component_block(content: str, lcsc_id: str, suffix: str) -> Optional[Tuple[str, Optional[str]]]:
    lcsc = lcsc_id.strip()
    if not lcsc:
        return None

    blocks = _iter_symbol_blocks_v6(content) if suffix == ".kicad_sym" else _iter_symbol_blocks_v5(content)
    if not blocks:
        return None

    if suffix == ".kicad_sym":
        lcsc_pattern = re.compile(
            rf'\(property\s+"LCSC Part"\s+"{re.escape(lcsc)}"',
            re.IGNORECASE | re.DOTALL,
        )
        footprint_pattern = re.compile(
            r'\(property\s+"Footprint"\s+"([^"]+)"',
            re.IGNORECASE | re.DOTALL,
        )
    else:
        lcsc_pattern = re.compile(
            rf'^\s*F6\s+"{re.escape(lcsc)}".*LCSC Part',
            re.IGNORECASE | re.MULTILINE,
        )
        footprint_pattern = re.compile(r'^\s*F2\s+"([^"]*)"', re.MULTILINE)

    for block in blocks:
        if not lcsc_pattern.search(block):
            continue
        footprint_match = footprint_pattern.search(block)
        footprint_ref = footprint_match.group(1).strip() if footprint_match else None
        return block, footprint_ref
    return None


def _check_component_in_library(path: str, lcsc_id: str) -> ComponentCheckResponse:
    try:
        target = Path(path).expanduser()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    resolved = target.resolve(strict=False)
    lower_suffix = resolved.suffix.lower()
    if lower_suffix in {".kicad_sym", ".lib"}:
        symbol_candidates = [resolved]
        library_root = resolved.with_suffix("")
    else:
        symbol_candidates = [resolved.with_suffix(".kicad_sym"), resolved.with_suffix(".lib")]
        library_root = resolved

    symbol_path = next((candidate for candidate in symbol_candidates if candidate.is_file()), None)
    if not symbol_path:
        return ComponentCheckResponse(messages=["Symbol library not found."])

    try:
        content = symbol_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ComponentCheckResponse(messages=["Unable to read symbol library."])

    match = _find_component_block(content, lcsc_id, symbol_path.suffix.lower())
    if not match:
        return ComponentCheckResponse(messages=["Component not found in library."])

    _block, footprint_ref = match
    footprint_path: Optional[Path] = None
    if footprint_ref:
        footprint_name = footprint_ref.split(":")[-1].strip()
        if footprint_name:
            footprint_path = library_root.with_suffix(".pretty") / f"{footprint_name}.kicad_mod"

    model_paths: Dict[str, str] = {}
    if footprint_path and footprint_path.is_file():
        model_dir = library_root.with_suffix(".3dshapes")
        model_paths = _extract_model_paths(footprint_path, model_dir)

    return ComponentCheckResponse(
        symbol_path=str(symbol_path),
        footprint_path=str(footprint_path) if footprint_path and footprint_path.is_file() else None,
        model_paths=model_paths,
        messages=[],
    )


def _index_symbols_by_lcsc(content: str, suffix: str) -> Dict[str, Optional[str]]:
    mapping: Dict[str, Optional[str]] = {}
    if suffix == ".kicad_sym":
        for block in _iter_symbol_blocks_v6(content):
            lcsc_match = re.search(
                r'\(property\s+"LCSC Part"\s+"([^"]+)"',
                block,
                re.IGNORECASE | re.DOTALL,
            )
            if not lcsc_match:
                continue
            lcsc_id = lcsc_match.group(1).strip().upper()
            footprint_match = re.search(
                r'\(property\s+"Footprint"\s+"([^"]+)"',
                block,
                re.IGNORECASE | re.DOTALL,
            )
            footprint_ref = footprint_match.group(1).strip() if footprint_match else None
            mapping[lcsc_id] = footprint_ref
        return mapping

    for block in _iter_symbol_blocks_v5(content):
        lcsc_match = re.search(
            r'^\s*F6\s+"([^"]+)".*LCSC Part',
            block,
            re.IGNORECASE | re.MULTILINE,
        )
        if not lcsc_match:
            continue
        lcsc_id = lcsc_match.group(1).strip().upper()
        footprint_match = re.search(r'^\s*F2\s+"([^"]*)"', block, re.MULTILINE)
        footprint_ref = footprint_match.group(1).strip() if footprint_match else None
        mapping[lcsc_id] = footprint_ref
    return mapping


def _count_symbols_legacy_lib(path: Path) -> int:
    """Count DEF entries in a KiCad v5 legacy .lib file."""
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    return len(re.findall(r"^\s*DEF\s+", content, flags=re.MULTILINE))


def _count_symbols_in_file(path: Path) -> int:
    """
    Count library symbols (components), not nested KiCad 6+ graphic (symbol "Name_N_M") blocks.
    """
    lower = path.suffix.lower()
    if lower == ".kicad_sym":
        return len(list_symbols_in_lib(str(path)))
    if lower == ".lib":
        return _count_symbols_legacy_lib(path)
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0
    matches = re.findall(r"\(\s*symbol\b", content)
    return len(matches) or 1


def _fs_roots() -> List[dict[str, str]]:
    roots: List[dict[str, str]] = []
    seen: set[str] = set()

    if os.name == "nt":
        from string import ascii_uppercase

        for letter in ascii_uppercase:
            drive_path = Path(f"{letter}:/").resolve()
            if drive_path.exists():
                path_str = str(drive_path)
                if path_str not in seen:
                    roots.append(
                        {
                            "path": path_str,
                            "label": f"{letter}:\\",
                        }
                    )
                    seen.add(path_str)
    else:
        root_path = Path("/").resolve()
        roots.append({"path": str(root_path), "label": "/"})
        seen.add(str(root_path))

    home_path = Path.home().resolve()
    if str(home_path) not in seen:
        roots.append({"path": str(home_path), "label": str(home_path)})
        seen.add(str(home_path))

    # Add common user directories if they exist
    for relative in ("Documents", "Downloads", "Desktop"):
        candidate = home_path / relative
        if candidate.exists():
            path_str = str(candidate.resolve())
            if path_str not in seen:
                roots.append({"path": path_str, "label": path_str})
                seen.add(path_str)

    return roots


def _fs_list_directory(path: str) -> dict[str, Any]:
    try:
        target = Path(path).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")

    entries: List[dict[str, Any]] = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                entries.append(
                    {
                        "name": entry.name,
                        "path": str(Path(entry.path).resolve(strict=False)),
                        "is_dir": entry.is_dir(follow_symlinks=False),
                        "is_symlink": entry.is_symlink(),
                    }
                )
    except PermissionError as exc:
        raise HTTPException(
            status_code=403, detail=f"Access denied for directory: {path}"
        ) from exc

    entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))

    parent = str(target.parent) if target.parent != target else None

    breadcrumbs: List[dict[str, str]] = []
    current = target
    seen: Set[str] = set()
    while True:
        label = current.name or current.drive or "/"
        breadcrumbs.append({"label": label, "path": str(current)})
        current_str = str(current)
        if current_str in seen or current == current.parent:
            break
        seen.add(current_str)
        current = current.parent
    breadcrumbs.reverse()

    return {"path": str(target), "parent": parent, "entries": entries, "breadcrumbs": breadcrumbs}


def _fs_check(path: str) -> dict[str, Any]:
    target = Path(path).expanduser()
    resolved = target.resolve(strict=False)
    exists = target.exists()
    is_dir = target.is_dir()

    if exists and is_dir:
        writable = os.access(str(target), os.W_OK)
    else:
        parent = target.parent if target.suffix else target.parent
        writable = parent.exists() and os.access(str(parent), os.W_OK)

    return {
        "requested": path,
        "resolved": str(resolved),
        "exists": exists,
        "is_dir": is_dir,
        "writable": writable,
    }


def create_app(
    conversion_runner: Callable[[ConversionRequest, Optional[Callable]], ConversionResult]
    = run_conversion,
) -> FastAPI:
    app = FastAPI(
        title="easyeda2kicad API",
        description="WebSocket-only API. Connect to /ws/extension (JSON-RPC + task_update pushes).",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    app.state.conversion_runner = conversion_runner
    app.state.queue: asyncio.Queue[TaskRecord] = asyncio.Queue()
    app.state.pending: Deque[str] = deque()
    app.state.tasks: Dict[str, TaskRecord] = {}
    app.state.task_lock = asyncio.Lock()
    app.state.extension_clients: List[ExtensionClient] = []
    app.state.worker_task: Optional[asyncio.Task[Any]] = None

    def queue_position(task_id: str) -> Optional[int]:
        try:
            return app.state.pending.index(task_id) + 1
        except ValueError:
            return None

    def as_summary(record: TaskRecord) -> TaskSummary:
        return TaskSummary(
            id=record.id,
            status=record.status,
            progress=record.progress,
            message=record.message,
            queue_position=queue_position(record.id),
            error=record.error,
            created_at=record.created_at,
            started_at=record.started_at,
            finished_at=record.finished_at,
            result=ConversionResultModel(
                symbol_path=record.result.symbol_path if record.result else None,
                footprint_path=record.result.footprint_path if record.result else None,
                model_paths=record.result.model_paths if record.result else {},
                messages=record.result.messages if record.result else [],
            )
            if record.result
            else None,
        )

    def as_detail(record: TaskRecord) -> TaskDetail:
        summary = as_summary(record)
        return TaskDetail(**summary.model_dump(), log=record.log)

    async def broadcast(task_id: str) -> None:
        async with app.state.task_lock:
            record = app.state.tasks.get(task_id)
        if not record:
            return

        ext_body = as_detail(record).model_dump(mode="json")
        ext_msg = {"type": "task_update", "task_id": task_id, "payload": ext_body}
        stale_clients: List[ExtensionClient] = []
        push_n = 0
        for client in list(app.state.extension_clients):
            if task_id not in client.task_ids:
                continue
            try:
                await client.ws.send_json(ext_msg)
                push_n += 1
            except (WebSocketDisconnect, RuntimeError):
                stale_clients.append(client)
            except Exception:
                stale_clients.append(client)
        if _WS_JOB_TRACE:
            _job_trace(
                f"broadcast task={task_id} status={record.status} progress={record.progress} "
                f"pushes_ok={push_n} extension_clients={len(app.state.extension_clients)}"
            )
        for client in stale_clients:
            with suppress(ValueError):
                app.state.extension_clients.remove(client)

    async def broadcast_queue_changes() -> None:
        async with app.state.task_lock:
            pending_ids = list(app.state.pending)
        for task_id in pending_ids:
            await broadcast(task_id)

    async def update_progress(
        task_id: str, stage: ConversionStage, percent: int, message: Optional[str]
    ) -> None:
        async with app.state.task_lock:
            record = app.state.tasks.get(task_id)
            if not record:
                return
            record.progress = max(0, min(100, percent))
            record.message = message
            record.updated_at = datetime.now(UTC)
            record.log.append(
                {
                    "timestamp": record.updated_at.isoformat(),
                    "stage": stage.name,
                    "message": message,
                    "progress": record.progress,
                }
            )
            if stage == ConversionStage.COMPLETED:
                record.status = TaskStatus.COMPLETED
                record.finished_at = datetime.now(UTC)
            elif stage == ConversionStage.FAILED:
                record.status = TaskStatus.FAILED
                record.finished_at = datetime.now(UTC)
            else:
                record.status = TaskStatus.RUNNING
        await broadcast(task_id)

    async def worker() -> None:
        loop = asyncio.get_running_loop()
        while True:
            task = await app.state.queue.get()
            pending_head = app.state.pending[0] if app.state.pending else None
            async with app.state.task_lock:
                head_ok = bool(
                    app.state.pending and app.state.pending[0] == task.id
                )
                if app.state.pending and app.state.pending[0] == task.id:
                    app.state.pending.popleft()
                task.status = TaskStatus.RUNNING
                task.started_at = datetime.now(UTC)
                task.updated_at = task.started_at
            if _WS_JOB_TRACE:
                _job_trace(
                    f"worker RUNNING task={task.id} pending_head_was={pending_head!r} "
                    f"popped_head_match={head_ok}"
                )
            await broadcast(task.id)
            await broadcast_queue_changes()

            def progress_callback(
                stage: ConversionStage, percent: int, message: Optional[str]
            ) -> None:
                asyncio.run_coroutine_threadsafe(
                    update_progress(task.id, stage, percent, message), loop
                )

            try:
                result = await asyncio.to_thread(
                    app.state.conversion_runner, task.request, progress_callback
                )
            except Exception as exc:  # pragma: no cover - defensive catch
                if _WS_JOB_TRACE:
                    _job_trace(f"worker FAILED task={task.id} err={exc!r}")
                async with app.state.task_lock:
                    task.status = TaskStatus.FAILED
                    task.error = str(exc)
                    task.message = str(exc)
                    task.progress = task.progress or 0
                    task.finished_at = datetime.now(UTC)
                    task.updated_at = task.finished_at
                    task.log.append(
                        {
                            "timestamp": task.updated_at.isoformat(),
                            "stage": ConversionStage.FAILED.name,
                            "message": task.error,
                            "progress": task.progress,
                        }
                    )
                await broadcast(task.id)
            else:
                if _WS_JOB_TRACE:
                    _job_trace(f"worker COMPLETED task={task.id}")
                async with app.state.task_lock:
                    task.status = TaskStatus.COMPLETED
                    task.result = result
                    task.progress = max(task.progress, 100)
                    task.message = "Conversion finished."
                    task.finished_at = datetime.now(UTC)
                    task.updated_at = task.finished_at
                    task.log.append(
                        {
                            "timestamp": task.updated_at.isoformat(),
                            "stage": ConversionStage.COMPLETED.name,
                            "message": task.message,
                            "progress": task.progress,
                        }
                    )
                await broadcast(task.id)

            app.state.queue.task_done()

    async def start_worker() -> None:
        if app.state.worker_task is None or app.state.worker_task.done():
            app.state.worker_task = asyncio.create_task(worker())

    async def stop_worker() -> None:
        worker_task = app.state.worker_task
        if not worker_task:
            return
        await app.state.queue.join()
        worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await worker_task
        app.state.worker_task = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await start_worker()
        try:
            yield
        finally:
            await stop_worker()

    app.router.lifespan_context = lifespan
    app.state.start_worker = start_worker
    app.state.stop_worker = stop_worker

    async def enqueue_conversion_payload(
        payload: TaskCreatePayload,
        *,
        extension_client: Optional[ExtensionClient] = None,
    ) -> TaskSummary:
        try:
            request = ConversionRequest.from_task_create_payload(payload)
        except ConversionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        task_id = str(uuid.uuid4())
        record = TaskRecord(id=task_id, request=request)

        async with app.state.task_lock:
            app.state.tasks[task_id] = record
            app.state.pending.append(task_id)
            await app.state.queue.put(record)

        if extension_client is not None:
            extension_client.task_ids.add(task_id)

        await broadcast_queue_changes()
        await broadcast(task_id)

        if _WS_JOB_TRACE:
            _job_trace(
                f"enqueue task={task_id} lcsc={payload.lcsc_id} status={record.status} "
                f"queue_size≈{app.state.queue.qsize()} pending={len(app.state.pending)} "
                f"subscribers_this_task="
                f"{sum(1 for c in app.state.extension_clients if task_id in c.task_ids)}"
            )

        return as_summary(record)

    def _extension_ws_http_message(exc: HTTPException) -> str:
        detail = exc.detail
        if isinstance(detail, list):
            return " ".join(str(x) for x in detail)
        return str(detail)

    @app.websocket("/ws/extension")
    async def extension_updates(websocket: WebSocket) -> None:
        """Multiplexed JSON-RPC + server push (task_update) for the Chrome extension."""
        await websocket.accept()
        client = ExtensionClient(ws=websocket)
        app.state.extension_clients.append(client)

        async def ws_ping(_p: dict[str, Any], _c: ExtensionClient) -> Any:
            return {"pong": True}

        async def ws_health(_p: dict[str, Any], _c: ExtensionClient) -> Any:
            return {"status": "ok", "protocol": 1}

        async def ws_list_tasks(_p: dict[str, Any], _c: ExtensionClient) -> Any:
            async with app.state.task_lock:
                records = list(app.state.tasks.values())
            return [as_summary(r).model_dump(mode="json") for r in records]

        async def ws_get_task_detail(p: dict[str, Any], _c: ExtensionClient) -> Any:
            tid = str(p.get("task_id") or "")
            if not tid:
                raise HTTPException(status_code=400, detail="task_id required.")
            async with app.state.task_lock:
                rec = app.state.tasks.get(tid)
            if not rec:
                raise HTTPException(status_code=404, detail="Task not found.")
            return as_detail(rec).model_dump(mode="json")

        async def ws_subscribe_task(p: dict[str, Any], c: ExtensionClient) -> Any:
            tid = str(p.get("task_id") or "")
            if not tid:
                raise HTTPException(status_code=400, detail="task_id required.")
            async with app.state.task_lock:
                if tid not in app.state.tasks:
                    raise HTTPException(status_code=404, detail="Task not found.")
            c.task_ids.add(tid)
            await broadcast(tid)
            return {"subscribed": True, "task_id": tid}

        async def ws_enqueue_task(p: dict[str, Any], c: ExtensionClient) -> Any:
            payload = TaskCreatePayload.model_validate(p)
            summary = await enqueue_conversion_payload(
                payload, extension_client=c
            )
            async with app.state.task_lock:
                rec = app.state.tasks.get(summary.id)
            if rec:
                result = as_summary(rec).model_dump(mode="json")
            else:
                result = summary.model_dump(mode="json")
            if _WS_JOB_TRACE:
                _job_trace(
                    f"enqueue_task RPC reply task={result.get('id')} "
                    f"status={result.get('status')} progress={result.get('progress')}"
                )
            return result

        async def ws_libraries_scaffold(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = LibraryScaffoldRequest.model_validate(p)
            prefix, created, paths = _scaffold_library(req)
            return LibraryScaffoldResponse(
                resolved_library_prefix=str(prefix),
                symbol_path=paths.get("symbol"),
                footprint_dir=paths.get("footprint"),
                model_dir=paths.get("model"),
                created=created,
            ).model_dump(mode="json")

        async def ws_libraries_validate(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = LibraryValidateRequest.model_validate(p)
            return _inspect_library(req.path).model_dump(mode="json")

        async def ws_libraries_component(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = ComponentCheckRequest.model_validate(p)
            return _check_component_in_library(req.path, req.lcsc_id).model_dump(
                mode="json"
            )

        async def ws_fs_roots(_p: dict[str, Any], _c: ExtensionClient) -> Any:
            return _fs_roots()

        async def ws_fs_list(p: dict[str, Any], _c: ExtensionClient) -> Any:
            path = str(p.get("path") or "")
            if not path:
                raise HTTPException(status_code=400, detail="path required.")
            return _fs_list_directory(path)

        async def ws_fs_check(p: dict[str, Any], _c: ExtensionClient) -> Any:
            path = str(p.get("path") or "")
            if not path:
                raise HTTPException(status_code=400, detail="path required.")
            return _fs_check(path)

        async def ws_templates_symbols(p: dict[str, Any], _c: ExtensionClient) -> Any:
            lib_path = str(p.get("lib_path") or "")
            if not lib_path:
                raise HTTPException(status_code=400, detail="lib_path required.")
            return {"symbols": list_symbols_in_lib(lib_path)}

        async def ws_templates_check(p: dict[str, Any], _c: ExtensionClient) -> Any:
            lib_path = str(p.get("lib_path") or "")
            if not lib_path:
                raise HTTPException(status_code=400, detail="lib_path required.")
            symbols_set = set(list_symbols_in_lib(lib_path))
            return {name: name in symbols_set for name in KNOWN_TEMPLATE_NAMES}

        async def ws_templates_pin_check(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = TemplatePinCheckPayload.model_validate(p)
            return (await run_templates_pin_check(req)).model_dump(mode="json")

        async def ws_templates_gallery_pin_summary(
            p: dict[str, Any], _c: ExtensionClient
        ) -> Any:
            req = TemplatesGalleryPinSummaryPayload.model_validate(p)
            return await run_templates_gallery_pin_summary(req)

        async def ws_templates_preview_svg(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = TemplatePreviewPayload.model_validate(p)
            return run_template_preview(req)

        async def ws_templates_pin_map_context(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = TemplatePinMapContextPayload.model_validate(p)
            return await run_templates_pin_map_context(req)

        async def ws_lcsc_footprint_preview(p: dict[str, Any], _c: ExtensionClient) -> Any:
            req = LcscFootprintPreviewPayload.model_validate(p)
            return await run_lcsc_footprint_preview(req)

        _extension_ws_rpc: Dict[
            str, Callable[[dict[str, Any], ExtensionClient], Awaitable[Any]]
        ] = {
            "ping": ws_ping,
            "health": ws_health,
            "list_tasks": ws_list_tasks,
            "get_task_detail": ws_get_task_detail,
            "subscribe_task": ws_subscribe_task,
            "enqueue_task": ws_enqueue_task,
            "libraries_scaffold": ws_libraries_scaffold,
            "libraries_validate": ws_libraries_validate,
            "libraries_component": ws_libraries_component,
            "fs_roots": ws_fs_roots,
            "fs_list": ws_fs_list,
            "fs_check": ws_fs_check,
            "templates_symbols": ws_templates_symbols,
            "templates_check": ws_templates_check,
            "templates_pin_check": ws_templates_pin_check,
            "templates_gallery_pin_summary": ws_templates_gallery_pin_summary,
            "templates_preview_svg": ws_templates_preview_svg,
            "templates_pin_map_context": ws_templates_pin_map_context,
            "lcsc_footprint_preview": ws_lcsc_footprint_preview,
        }

        async def handle_call(req_id: Any, method: str, params: Any) -> None:
            if not isinstance(params, dict):
                params = {}
            handler = _extension_ws_rpc.get(method)
            if handler is None:
                raise HTTPException(status_code=400, detail=f"Unknown method: {method}")
            result = await handler(params, client)
            await websocket.send_json({"id": req_id, "result": result})

        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                req_id = msg.get("id")
                method = msg.get("method")
                if not method or not isinstance(method, str):
                    continue
                params = msg.get("params")
                try:
                    await handle_call(req_id, method, params)
                except HTTPException as exc:
                    await websocket.send_json(
                        {
                            "id": req_id,
                            "error": {
                                "message": _extension_ws_http_message(exc),
                                "code": exc.status_code,
                            },
                        }
                    )
                except ValidationError as exc:
                    await websocket.send_json(
                        {
                            "id": req_id,
                            "error": {"message": str(exc), "code": 400},
                        }
                    )
        except WebSocketDisconnect:
            pass
        finally:
            with suppress(ValueError):
                app.state.extension_clients.remove(client)

    return app


