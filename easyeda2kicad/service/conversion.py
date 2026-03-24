from __future__ import annotations

"""LCSC → KiCad: one EasyEDA fetch, then direct symbol/footprint/3D export or template merge + PAD map."""

import logging
import math
import os
import threading
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
from easyeda2kicad.easyeda.easyeda_importer import (
    Easyeda3dModelImporter,
    EasyedaFootprintImporter,
    EasyedaSymbolImporter,
)
from easyeda2kicad.helpers import (
    add_component_in_symbol_lib_file,
    add_sub_components_in_symbol_lib_file,
    extract_symbol_from_lib,
    id_already_in_symbol_lib,
    lcsc_primary_and_sub_symbols,
    update_component_in_symbol_lib_file,
)
from easyeda2kicad.kicad.export_kicad_3d_model import Exporter3dModelKicad
from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad
from easyeda2kicad.kicad.parameters_kicad_symbol import sanitize_fields
from easyeda2kicad.kicad.symbol_pin_remap import apply_pin_number_map
from easyeda2kicad.kicad.template_merger import TemplateMerger, get_template_lib_path


class ConversionStage(Enum):
    QUEUED = auto()
    FETCHING = auto()
    EXPORT_SYMBOL = auto()
    EXPORT_FOOTPRINT = auto()
    EXPORT_MODEL = auto()
    FINALISING = auto()
    COMPLETED = auto()
    FAILED = auto()


ProgressCallback = Callable[[ConversionStage, int, Optional[str]], None]


class ConversionError(RuntimeError):
    """Raised when a conversion cannot be completed."""


@dataclass
class ConversionRequest:
    lcsc_id: str
    output_prefix: str
    overwrite: bool = False
    overwrite_model: bool = False
    generate_symbol: bool = False
    generate_footprint: bool = False
    generate_model: bool = False
    project_relative: bool = False
    project_relative_path: Optional[str] = None
    model_path: Optional[str] = None
    hide_pin_numbers: bool = False
    hide_pin_names: bool = False
    symbol_value_override: Optional[str] = None
    symbol_params: Optional[dict] = None
    symbol_description: Optional[str] = None
    symbol_datasheet_url: Optional[str] = None
    use_template: bool = False
    template_name: Optional[str] = None
    template_lib_path: Optional[str] = None
    force_template: bool = False
    # Keys/values: remap symbol (number …) only; footprint pads are never renamed (see
    # _export_symbol_from_template + symbol_pin_remap.apply_pin_number_map).
    template_pin_map: Optional[Mapping[str, str]] = None

    def __post_init__(self) -> None:
        if not self.lcsc_id or not self.lcsc_id.startswith("C"):
            raise ConversionError("LCSC ID must start with 'C'.")
        if not (
            self.generate_symbol or self.generate_footprint or self.generate_model
        ):
            raise ConversionError("At least one export target must be selected.")
        self.output_prefix = str(Path(self.output_prefix))

    @classmethod
    def from_task_create_payload(cls, payload: Any) -> ConversionRequest:
        """
        Build from the extension WebSocket ``enqueue_task`` model (``TaskCreatePayload``).

        Imported lazily to avoid a circular import with ``easyeda2kicad.api.server``.
        """
        from easyeda2kicad.api.models import TaskCreatePayload

        if not isinstance(payload, TaskCreatePayload):
            payload = TaskCreatePayload.model_validate(payload)
        return cls(
            lcsc_id=payload.lcsc_id,
            output_prefix=payload.output_path,
            overwrite=payload.overwrite,
            overwrite_model=payload.overwrite_model,
            generate_symbol=payload.symbol,
            generate_footprint=payload.footprint,
            generate_model=payload.model,
            project_relative=payload.project_relative,
            project_relative_path=payload.project_relative_path,
            model_path=payload.model_path,
            hide_pin_numbers=payload.hide_pin_numbers,
            hide_pin_names=payload.hide_pin_names,
            symbol_value_override=payload.symbol_value_override,
            symbol_params=payload.symbol_params,
            symbol_description=payload.symbol_description,
            symbol_datasheet_url=payload.symbol_datasheet_url,
            use_template=payload.use_template,
            template_name=payload.template_name,
            template_lib_path=payload.template_lib_path,
            force_template=payload.force_template,
            template_pin_map=payload.template_pin_map,
        )


@dataclass
class ConversionResult:
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = field(default_factory=dict)
    messages: List[str] = field(default_factory=list)


_SEGMENT_STAGE = {
    "fetch": ConversionStage.FETCHING,
    "symbol": ConversionStage.EXPORT_SYMBOL,
    "footprint": ConversionStage.EXPORT_FOOTPRINT,
    "model": ConversionStage.EXPORT_MODEL,
}


def _segment_weights(request: ConversionRequest) -> List[tuple[str, float]]:
    """Equal share per enabled segment (e.g. 4 steps → 25% each on the overall bar)."""
    parts: List[tuple[str, float]] = [("fetch", 1.0)]
    if request.generate_symbol:
        parts.append(("symbol", 1.0))
    if request.generate_footprint:
        parts.append(("footprint", 1.0))
    if request.generate_model:
        parts.append(("model", 1.0))
    n = len(parts)
    w = 1.0 / n
    return [(name, w) for name, _ in parts]


def _cad_fetch_with_pulsing_progress(
    prog: "_ConversionProgress",
    api: EasyedaApi,
    lcsc_id: str,
) -> dict:
    """
    While the blocking EasyEDA HTTP call runs, emit rising progress within the fetch
    segment (maps sub-progress ~0–100% of that step onto the global bar).
    """
    stop = threading.Event()
    last_f = [0.20]

    def pulse_loop() -> None:
        t0 = time.monotonic()
        while not stop.is_set():
            elapsed = time.monotonic() - t0
            f = min(0.97, 0.22 + 0.75 * (1.0 - math.exp(-elapsed / 1.4)))
            if f > last_f[0] + 0.01:
                last_f[0] = f
                prog.emit(
                    "fetch",
                    f,
                    "Downloading CAD data (in progress)…",
                )
            if stop.wait(0.35):
                break

    th = threading.Thread(
        target=pulse_loop,
        daemon=True,
        name="easyeda2kicad-fetch-progress",
    )
    th.start()
    try:
        return api.get_cad_data_of_component(lcsc_id=lcsc_id)
    finally:
        stop.set()
        th.join(timeout=1.5)


class _ConversionProgress:
    """Sub-step progress mapped to overall 0–99% (100 reserved for COMPLETED)."""

    __slots__ = ("_cb", "_start", "_span", "_step_no", "_n_steps")

    def __init__(self, request: ConversionRequest, progress_cb: Optional[ProgressCallback]):
        self._cb = progress_cb
        segs = _segment_weights(request)
        self._span = {n: w for n, w in segs}
        acc = 0.0
        self._start = {}
        for name, w in segs:
            self._start[name] = acc
            acc += w
        order = [n for n, _ in segs]
        self._n_steps = len(order)
        self._step_no = {name: i + 1 for i, name in enumerate(order)}

    def emit(self, segment: str, frac: float, message: str) -> None:
        if not self._cb:
            return
        frac = max(0.0, min(1.0, frac))
        base = self._start.get(segment, 0.0)
        span = self._span.get(segment, 0.0)
        pct = int(round(100 * (base + span * frac)))
        pct = max(0, min(99, pct))
        step = self._step_no.get(segment, 0)
        labeled = (
            f"[{step}/{self._n_steps}] {message}"
            if step and self._n_steps
            else message
        )
        self._cb(_SEGMENT_STAGE[segment], pct, labeled)

    def emit_finalizing(self, message: str) -> None:
        if not self._cb:
            return
        self._cb(ConversionStage.FINALISING, 99, message)


def _ensure_output_scaffold(
    request: ConversionRequest,
) -> tuple[Path, str, str]:
    """
    Ensure output directories and base library file exist.

    Returns a tuple (output_prefix_path, footprint_dir, symbol_extension).
    """
    output_path = Path(request.output_prefix)
    base_dir = output_path.parent if output_path.parent != Path("") else Path(".")
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        raise ConversionError(
            f"Missing permissions to create base folder '{base_dir}'."
        ) from exc

    footprint_dir = output_path.with_suffix(".pretty")
    model_dir = output_path.with_suffix(".3dshapes")
    try:
        if request.generate_footprint:
            footprint_dir.mkdir(exist_ok=True)
        if request.generate_model or request.generate_footprint:
            model_dir.mkdir(exist_ok=True)
    except PermissionError as exc:
        raise ConversionError(
            f"Missing permissions to create library folders under '{base_dir}'."
        ) from exc

    symbol_extension = "kicad_sym"
    symbol_path = output_path.with_suffix(f".{symbol_extension}")
    if request.generate_symbol and not symbol_path.exists():
        try:
            with open(symbol_path, "w", encoding="utf-8") as symbol_file:
                symbol_file.write(
                    "(kicad_symbol_lib\n"
                    "  (version 20211014)\n"
                    "  (generator https://github.com/uPesy/easyeda2kicad.py)\n"
                    ")"
                )
        except OSError as exc:
            raise ConversionError(
                f"Unable to initialize symbol library file '{symbol_path}'."
            ) from exc

    return output_path, str(footprint_dir), symbol_extension


def _footprint_exists(lib_path: str, package_name: str) -> bool:
    return Path(lib_path, f"{package_name}.kicad_mod").is_file()


def _coerce_template_pin_map(
    pin_map: Optional[Mapping[str, Any]],
) -> Optional[dict[str, str]]:
    """Normalize JSON/extension maps to str→str (drops nulls and blanks)."""
    if not pin_map:
        return None
    out: dict[str, str] = {}
    for k, v in dict(pin_map).items():
        if v is None:
            continue
        sk = str(k).strip()
        sv = str(v).strip()
        if sk and sv:
            out[sk] = sv
    return out or None


def _export_symbol_from_template(
    request: "ConversionRequest",
    primary_symbol: object,
    library_name: str,
) -> str:
    """
    Build a symbol string by merging LCSC metadata into a template symbol.
    Returns an empty string if the template cannot be found.
    """
    from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad

    # Resolve template library: prefer explicitly provided path, fall back to
    # auto-detecting Templates.kicad_sym next to the output symbol library.
    if request.template_lib_path:
        template_lib = Path(request.template_lib_path)
        if not template_lib.is_file():
            logging.warning("Template library not found at %s", request.template_lib_path)
            return ""
    else:
        symbol_lib_path = str(Path(request.output_prefix).with_suffix(".kicad_sym"))
        template_lib = get_template_lib_path(symbol_lib_path)
        if template_lib is None:
            logging.warning("Templates.kicad_sym not found next to %s", symbol_lib_path)
            return ""

    template_str = extract_symbol_from_lib(str(template_lib), request.template_name)
    if not template_str:
        logging.warning(
            "Template symbol '%s' not found in %s", request.template_name, template_lib
        )
        return ""

    # Build a KiSymbolInfo via the normal exporter path so that
    # all fields (value, footprint, datasheet, params, …) are populated
    # identically to a regular LCSC export.
    exporter = ExporterSymbolKicad(
        symbol=primary_symbol,
        hide_pin_numbers=request.hide_pin_numbers,
        hide_pin_names=request.hide_pin_names,
        value_override=request.symbol_value_override,
        symbol_params=request.symbol_params,
        symbol_description=request.symbol_description,
        symbol_datasheet_url=request.symbol_datasheet_url,
    )
    # Populate ki_info by running the footprint ref path tuner
    exporter.export(footprint_lib_name=library_name)
    ki_info = exporter.output.info

    merger = TemplateMerger()
    try:
        merged = merger.merge(
            template_sym_str=template_str,
            template_name=request.template_name,
            ki_info=ki_info,
            source_pins=exporter.output.pins,
        )
    except Exception as exc:
        logging.error("TemplateMerger.merge() failed: %s", exc)
        return ""
    coerced = _coerce_template_pin_map(request.template_pin_map)
    if merged and coerced:
        # PAD map: footprint stays EasyEDA; schematic↔PCB link is KiCad’s pin-number = pad-name
        # rule. See ``symbol_pin_remap.apply_pin_number_map`` docstring.
        before = merged
        merged = apply_pin_number_map(merged, coerced)
        if merged != before:
            logging.info(
                "Template import: applied PAD map (%d entries) to symbol pin numbers.",
                len(coerced),
            )
        elif any(str(k).strip() != str(v).strip() for k, v in coerced.items()):
            logging.warning(
                "Template import: PAD map had %d non-identity entries but symbol pin numbers "
                "were unchanged (duplicate targets, or keys not matching merged pins). Map=%s",
                len(coerced),
                coerced,
            )
    return merged


def run_conversion(
    request: ConversionRequest, progress_cb: Optional[ProgressCallback] = None
) -> ConversionResult:
    """
    Execute easyeda2kicad exports based on the incoming request.

    **Direct (EasyEDA-only):** ``use_template`` is false — symbol, footprint, and optional 3D
    are generated from EasyEDA data (standard exporters).

    **Template import:** ``use_template`` and ``template_name`` — symbol body comes from your
    ``.kicad_sym`` template merged with LCSC pins/fields. The optional PAD map updates symbol
    pin numbers so each pin matches the footprint pad it connects to (EasyEDA pad names are
    left unchanged on the footprint).

    Raises ConversionError on failure.
    """
    prog = _ConversionProgress(request, progress_cb)

    prog.emit("fetch", 0.0, "Requesting component data from EasyEDA…")

    output_path, footprint_dir, symbol_ext = _ensure_output_scaffold(request)
    symbol_file = output_path.with_suffix(f".{symbol_ext}")
    model_dir = output_path.with_suffix(".3dshapes")
    library_name = output_path.name

    prog.emit("fetch", 0.08, "Library folders ready.")

    api = EasyedaApi()
    cad_data = {}
    last_exc: Exception | None = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            prog.emit("fetch", 0.12, "Connecting to EasyEDA…")
            cad_data = _cad_fetch_with_pulsing_progress(prog, api, request.lcsc_id)
            last_exc = None
            break
        except Exception as exc:  # pragma: no cover - network errors bubble up
            last_exc = exc
            if attempt < max_attempts:
                prog.emit(
                    "fetch",
                    min(0.88, 0.18 + 0.22 * attempt),
                    f"CAD request failed ({attempt}/{max_attempts}). Retrying…",
                )
                time.sleep(1)
            else:
                break

    if last_exc is not None:
        raise ConversionError(
            f"Failed to fetch data for {request.lcsc_id}: {last_exc}"
        ) from last_exc

    if not cad_data:
        raise ConversionError(
            f"No CAD data received for component {request.lcsc_id}."
        )

    prog.emit("fetch", 1.0, "CAD data received.")

    result = ConversionResult()

    easyeda_footprint = None

    _retry_seg = {"seg": "model"}
    if request.generate_footprint:
        _retry_seg["seg"] = "footprint"

    def _on_3d_retry(attempt: int, max_attempts: int) -> None:
        prog.emit(
            _retry_seg["seg"],
            0.42,
            f"Download failed ({attempt}/{max_attempts}). Retrying…",
        )

    api_3d = EasyedaApi(on_retry=_on_3d_retry)

    if request.generate_symbol:
        prog.emit("symbol", 0.0, "Parsing EasyEDA symbol…")
        primary_symbol, sub_symbols = lcsc_primary_and_sub_symbols(cad_data)

        prog.emit("symbol", 0.18, "Resolving pins, graphics, and sub-units…")

        sanitized_name = sanitize_fields(primary_symbol.info.name)
        existing = id_already_in_symbol_lib(
            lib_path=str(symbol_file),
            component_name=sanitized_name,
        )
        exported_symbol = ""
        exported_sub_symbols: List[str] = []
        if existing and not request.overwrite:
            result.messages.append(
                f"Symbol '{primary_symbol.info.name}' already exists – not overwritten."
            )
            prog.emit("symbol", 0.55, "Symbol already in library — skipping write.")
        else:
            # Try template path first
            if request.use_template and request.template_name:
                prog.emit(
                    "symbol",
                    0.32,
                    f"Merging template symbol '{request.template_name}'…",
                )
                exported_symbol = _export_symbol_from_template(
                    request=request,
                    primary_symbol=primary_symbol,
                    library_name=library_name,
                )
                if not exported_symbol:
                    if request.force_template:
                        raise ConversionError(
                            f"Template '{request.template_name}' not found or merge failed; "
                            "force_template is set, cannot fall back to LCSC symbol."
                        )
                    result.messages.append(
                        f"Template '{request.template_name}' not found; falling back to LCSC symbol."
                    )

            if not exported_symbol:
                prog.emit("symbol", 0.48, "Rendering EasyEDA shapes for KiCad symbol…")
                exporter = ExporterSymbolKicad(
                    symbol=primary_symbol,
                    hide_pin_numbers=request.hide_pin_numbers,
                    hide_pin_names=request.hide_pin_names,
                    value_override=request.symbol_value_override,
                    symbol_params=request.symbol_params,
                    symbol_description=request.symbol_description,
                    symbol_datasheet_url=request.symbol_datasheet_url,
                )
                exported_symbol = exporter.export(footprint_lib_name=library_name)

                for sub_symbol in sub_symbols:
                    sub_exporter = ExporterSymbolKicad(
                        symbol=sub_symbol,
                        hide_pin_numbers=request.hide_pin_numbers,
                        hide_pin_names=request.hide_pin_names,
                        value_override=request.symbol_value_override,
                        symbol_params=request.symbol_params,
                        symbol_description=request.symbol_description,
                        symbol_datasheet_url=request.symbol_datasheet_url,
                    )
                    sub_export = sub_exporter.export(footprint_lib_name=library_name)
                    if sub_export and sub_export != exported_symbol:
                        exported_sub_symbols.append(sub_export)

            if exported_symbol:
                prog.emit("symbol", 0.78, "Writing symbol into .kicad_sym…")
                if existing:
                    update_component_in_symbol_lib_file(
                        lib_path=str(symbol_file),
                        component_name=sanitized_name,
                        component_content=exported_symbol,
                    )
                else:
                    add_component_in_symbol_lib_file(
                        lib_path=str(symbol_file),
                        component_content=exported_symbol,
                    )
                if exported_sub_symbols:
                    add_sub_components_in_symbol_lib_file(
                        lib_path=str(symbol_file),
                        component_name=sanitized_name,
                        sub_components_content=exported_sub_symbols,
                    )

        prog.emit("symbol", 1.0, "Symbol export completed.")
        result.symbol_path = str(symbol_file)

    if request.generate_footprint:
        _retry_seg["seg"] = "footprint"
        prog.emit("footprint", 0.0, "Parsing EasyEDA footprint…")
        importer = EasyedaFootprintImporter(easyeda_cp_cad_data=cad_data, api=api_3d)
        easyeda_footprint = importer.get_footprint()
        # Never rename pads for template_pin_map — pad numbers stay as EasyEDA defines them.

        prog.emit("footprint", 0.38, "Building KiCad footprint geometry…")

        footprint_exists = _footprint_exists(
            footprint_dir, easyeda_footprint.info.name
        )
        footprint_filename = f"{easyeda_footprint.info.name}.kicad_mod"
        model_path_override = (request.model_path or "").strip()
        model_path_is_explicit = False
        if model_path_override:
            model_path = model_path_override
            model_path_is_explicit = True
        else:
            model_path = str(model_dir).replace("\\", "/").replace("./", "/")
            if request.project_relative:
                relative_path = (request.project_relative_path or "").strip().replace("\\", "/")
                if relative_path.startswith("${KIPRJMOD}"):
                    relative_path = relative_path[len("${KIPRJMOD}"):]
                if relative_path:
                    if not relative_path.startswith("/"):
                        relative_path = f"/{relative_path}"
                    if relative_path.endswith(".3dshapes"):
                        model_path = "${KIPRJMOD}" + relative_path
                    else:
                        model_path = (
                            "${KIPRJMOD}"
                            + relative_path.rstrip("/")
                            + f"/{output_path.name}.3dshapes"
                        )
                else:
                    model_path = "${KIPRJMOD}/" + f"{output_path.name}.3dshapes"

        if footprint_exists and not request.overwrite:
            result.messages.append(
                f"Footprint '{easyeda_footprint.info.name}' already exists – not overwritten."
            )
            prog.emit("footprint", 0.72, "Footprint already in library — skipping write.")
        else:
            prog.emit("footprint", 0.62, "Writing .kicad_mod file…")
            ki_footprint = ExporterFootprintKicad(footprint=easyeda_footprint)
            ki_footprint.export(
                footprint_full_path=os.path.join(footprint_dir, footprint_filename),
                model_3d_path=model_path,
                model_3d_path_is_explicit=model_path_is_explicit,
            )

        prog.emit("footprint", 1.0, "Footprint export completed.")
        result.footprint_path = os.path.join(footprint_dir, footprint_filename)

    if request.generate_model:
        _retry_seg["seg"] = "model"
        prog.emit("model", 0.0, "Preparing 3D model…")
        model_data = None
        if easyeda_footprint and easyeda_footprint.model_3d:
            model_data = easyeda_footprint.model_3d
            prog.emit("model", 0.2, "Using 3D data from footprint…")
        if model_data is None:
            prog.emit("model", 0.32, "Downloading 3D package from EasyEDA…")
            model_data = Easyeda3dModelImporter(
                easyeda_cp_cad_data=cad_data, download_raw_3d_model=True, api=api_3d
            ).output

        prog.emit("model", 0.48, "Converting mesh to KiCad 3D package…")
        exporter = Exporter3dModelKicad(model_3d=model_data)

        base_name = (
            os.path.splitext(exporter.input.name or "")[0]
            if exporter.input
            else ""
        )
        if not base_name:
            base_name = "easyeda_model"
        safe_base_name = base_name.replace("\\", "_").replace("/", "_")
        wrl_path = Path(model_dir) / f"{safe_base_name}.wrl"
        step_path = Path(model_dir) / f"{safe_base_name}.step"

        overwrite_model = getattr(request, "overwrite_model", False) or request.overwrite
        existing_wrl = wrl_path.exists()
        existing_step = step_path.exists()

        if overwrite_model or (not existing_wrl or not existing_step):
            prog.emit("model", 0.68, "Writing .wrl and .step files…")
            exporter.export(lib_path=str(output_path))
            if exporter.output:
                result.model_paths["wrl"] = str(wrl_path)
            if exporter.output_step:
                result.model_paths["step"] = str(step_path)
        else:
            if existing_wrl:
                result.model_paths["wrl"] = str(wrl_path)
            if existing_step:
                result.model_paths["step"] = str(step_path)
            result.messages.append(
                "3D model already exists – not overwritten."
            )
            prog.emit("model", 0.85, "Reusing existing 3D files…")

        if not result.model_paths:
            result.messages.append("No 3D model available.")

        prog.emit("model", 1.0, "3D model export completed.")

    prog.emit_finalizing("Finalising conversion…")

    if progress_cb:
        progress_cb(ConversionStage.COMPLETED, 100, "Conversion finished.")

    return result
