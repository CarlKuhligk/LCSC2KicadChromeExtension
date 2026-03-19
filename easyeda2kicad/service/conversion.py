from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Callable, Dict, List, Optional

from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
from easyeda2kicad.easyeda.easyeda_importer import (
    Easyeda3dModelImporter,
    EasyedaFootprintImporter,
    EasyedaSymbolImporter,
)
from easyeda2kicad.easyeda.parameters_easyeda import EeSymbol
from easyeda2kicad.helpers import (
    add_component_in_symbol_lib_file,
    add_sub_components_in_symbol_lib_file,
    extract_symbol_from_lib,
    symbol_is_empty,
    id_already_in_symbol_lib,
    update_component_in_symbol_lib_file,
)
from easyeda2kicad.kicad.export_kicad_3d_model import Exporter3dModelKicad
from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad
from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion, sanitize_fields
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
    kicad_version: KicadVersion = KicadVersion.v6
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

    def __post_init__(self) -> None:
        if not self.lcsc_id or not self.lcsc_id.startswith("C"):
            raise ConversionError("LCSC ID must start with 'C'.")
        if not (
            self.generate_symbol or self.generate_footprint or self.generate_model
        ):
            raise ConversionError("At least one export target must be selected.")
        self.output_prefix = str(Path(self.output_prefix))


@dataclass
class ConversionResult:
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = field(default_factory=dict)
    messages: List[str] = field(default_factory=list)



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

    symbol_extension = "kicad_sym" if request.kicad_version == KicadVersion.v6 else "lib"
    symbol_path = output_path.with_suffix(f".{symbol_extension}")
    if request.generate_symbol and not symbol_path.exists():
        try:
            with open(symbol_path, "w", encoding="utf-8") as symbol_file:
                if request.kicad_version == KicadVersion.v6:
                    symbol_file.write(
                        "(kicad_symbol_lib\n"
                        "  (version 20211014)\n"
                        "  (generator https://github.com/uPesy/easyeda2kicad.py)\n"
                        ")"
                    )
                else:
                    symbol_file.write(
                        "EESchema-LIBRARY Version 2.4\n#encoding utf-8\n"
                    )
        except OSError as exc:
            raise ConversionError(
                f"Unable to initialize symbol library file '{symbol_path}'."
            ) from exc

    return output_path, str(footprint_dir), symbol_extension


def _footprint_exists(lib_path: str, package_name: str) -> bool:
    return Path(lib_path, f"{package_name}.kicad_mod").is_file()


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
        kicad_version=request.kicad_version,
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
        return merger.merge(
            template_sym_str=template_str,
            template_name=request.template_name,
            ki_info=ki_info,
            source_pins=exporter.output.pins,
        )
    except Exception as exc:
        logging.error("TemplateMerger.merge() failed: %s", exc)
        return ""


def run_conversion(
    request: ConversionRequest, progress_cb: Optional[ProgressCallback] = None
) -> ConversionResult:
    """
    Execute easyeda2kicad exports based on the incoming request.

    Raises ConversionError on failure.
    """

    def notify(stage: ConversionStage, steps_done: int, total_steps: int, message: str):
        if not progress_cb:
            return
        percent = int((steps_done / total_steps) * 100) if total_steps else 0
        percent = max(0, min(100, percent))
        progress_cb(stage, percent, message)

    steps_total = 1  # Fetching counts as one step
    if request.generate_symbol:
        steps_total += 1
    if request.generate_footprint:
        steps_total += 1
    if request.generate_model:
        steps_total += 1

    completed_steps = 0
    notify(
        ConversionStage.FETCHING,
        completed_steps,
        steps_total,
        "Fetching component data from EasyEDA.",
    )

    output_path, footprint_dir, symbol_ext = _ensure_output_scaffold(request)
    symbol_file = output_path.with_suffix(f".{symbol_ext}")
    model_dir = output_path.with_suffix(".3dshapes")
    library_name = output_path.name

    api = EasyedaApi()
    cad_data = {}
    last_exc: Exception | None = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            cad_data = api.get_cad_data_of_component(lcsc_id=request.lcsc_id)
            last_exc = None
            break
        except Exception as exc:  # pragma: no cover - network errors bubble up
            last_exc = exc
            if attempt < max_attempts:
                notify(
                    ConversionStage.FETCHING,
                    completed_steps,
                    steps_total,
                    f"Fetching component data from EasyEDA failed ({attempt}/{max_attempts}). Retrying…",
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

    completed_steps += 1
    notify(
        ConversionStage.FETCHING,
        completed_steps,
        steps_total,
        "Component data downloaded.",
    )

    result = ConversionResult()

    easyeda_footprint = None

    # Shared API for 3D model downloads with retry; on_retry updates status.
    retry_ctx = {"stage": ConversionStage.EXPORT_MODEL, "steps": 0, "total": steps_total}

    def _on_3d_retry(attempt: int, max_attempts: int) -> None:
        notify(
            retry_ctx["stage"],
            retry_ctx["steps"],
            retry_ctx["total"],
            f"Fetching 3D model failed ({attempt}/{max_attempts}). Retrying…",
        )

    api_3d = EasyedaApi(on_retry=_on_3d_retry)

    if request.generate_symbol:
        notify(
            ConversionStage.EXPORT_SYMBOL,
            completed_steps,
            steps_total,
            "Generating symbol.",
        )
        importer = EasyedaSymbolImporter(easyeda_cp_cad_data=cad_data)
        primary_symbol: EeSymbol = importer.get_symbol()

        subparts_data = cad_data.get("subparts") or []
        sub_symbols: List[EeSymbol] = []
        if subparts_data:
            iterable = subparts_data
            if symbol_is_empty(primary_symbol):
                primary_importer = EasyedaSymbolImporter(
                    easyeda_cp_cad_data=iterable[0]
                )
                primary_symbol = primary_importer.get_symbol()
                iterable = iterable[1:]
            for subpart_data in iterable:
                sub_importer = EasyedaSymbolImporter(easyeda_cp_cad_data=subpart_data)
                sub_symbols.append(sub_importer.get_symbol())

        sanitized_name = sanitize_fields(primary_symbol.info.name)
        existing = id_already_in_symbol_lib(
            lib_path=str(symbol_file),
            component_name=sanitized_name,
            kicad_version=request.kicad_version,
        )
        exported_symbol = ""
        exported_sub_symbols: List[str] = []
        if existing and not request.overwrite:
            result.messages.append(
                f"Symbol '{primary_symbol.info.name}' already exists – not overwritten."
            )
        else:
            # Try template path first
            if request.use_template and request.template_name:
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

            # Fall back to LCSC export if template was not used or failed (and not force_template)
            if not exported_symbol:
                exporter = ExporterSymbolKicad(
                    symbol=primary_symbol,
                    kicad_version=request.kicad_version,
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
                        kicad_version=request.kicad_version,
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

            # Write symbol to library (applies to both template and LCSC paths)
            if exported_symbol:
                if existing:
                    update_component_in_symbol_lib_file(
                        lib_path=str(symbol_file),
                        component_name=sanitized_name,
                        component_content=exported_symbol,
                        kicad_version=request.kicad_version,
                    )
                else:
                    add_component_in_symbol_lib_file(
                        lib_path=str(symbol_file),
                        component_content=exported_symbol,
                        kicad_version=request.kicad_version,
                    )
                if exported_sub_symbols and request.kicad_version == KicadVersion.v6:
                    add_sub_components_in_symbol_lib_file(
                        lib_path=str(symbol_file),
                        component_name=sanitized_name,
                        sub_components_content=exported_sub_symbols,
                        kicad_version=request.kicad_version,
                    )
                elif exported_sub_symbols:
                    logging.warning(
                        "Multi-unit symbols are only supported for KiCad v6 libraries; skipping"
                        " additional units."
                    )

        completed_steps += 1
        notify(
            ConversionStage.EXPORT_SYMBOL,
            completed_steps,
            steps_total,
            "Symbol export completed.",
        )
        result.symbol_path = str(symbol_file)

    if request.generate_footprint:
        notify(
            ConversionStage.EXPORT_FOOTPRINT,
            completed_steps,
            steps_total,
            "Generating footprint.",
        )
        retry_ctx["stage"], retry_ctx["steps"] = ConversionStage.EXPORT_FOOTPRINT, completed_steps
        importer = EasyedaFootprintImporter(easyeda_cp_cad_data=cad_data, api=api_3d)
        easyeda_footprint = importer.get_footprint()

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
        else:
            ki_footprint = ExporterFootprintKicad(footprint=easyeda_footprint)
            ki_footprint.export(
                footprint_full_path=os.path.join(footprint_dir, footprint_filename),
                model_3d_path=model_path,
                model_3d_path_is_explicit=model_path_is_explicit,
            )

        completed_steps += 1
        notify(
            ConversionStage.EXPORT_FOOTPRINT,
            completed_steps,
            steps_total,
            "Footprint export completed.",
        )
        result.footprint_path = os.path.join(footprint_dir, footprint_filename)

    if request.generate_model:
        notify(
            ConversionStage.EXPORT_MODEL,
            completed_steps,
            steps_total,
            "Generating 3D model.",
        )
        retry_ctx["stage"], retry_ctx["steps"] = ConversionStage.EXPORT_MODEL, completed_steps
        model_data = None
        if easyeda_footprint and easyeda_footprint.model_3d:
            model_data = easyeda_footprint.model_3d
        if model_data is None:
            model_data = Easyeda3dModelImporter(
                easyeda_cp_cad_data=cad_data, download_raw_3d_model=True, api=api_3d
            ).output

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

        if not result.model_paths:
            result.messages.append("No 3D model available.")

        completed_steps += 1
        notify(
            ConversionStage.EXPORT_MODEL,
            completed_steps,
            steps_total,
            "3D model export completed.",
        )

    notify(
        ConversionStage.FINALISING,
        completed_steps,
        steps_total,
        "Finalising conversion.",
    )

    notify(ConversionStage.COMPLETED, steps_total, steps_total, "Conversion finished.")

    return result
