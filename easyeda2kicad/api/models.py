from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class TaskCreatePayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component identifier (e.g. C8733)")
    output_path: str = Field(
        ..., description="Library prefix path (e.g. /path/to/MyLib)"
    )
    overwrite: bool = False
    overwrite_model: bool = Field(
        False, description="Overwrite existing 3D models even if files exist already."
    )
    symbol: bool = False
    footprint: bool = False
    model: bool = Field(False, description="Export 3D model")
    project_relative: bool = Field(
        False, description="Store 3D model path relative to project"
    )
    project_relative_path: Optional[str] = Field(
        None, description="Project-relative 3D model path suffix (prefixed by ${KIPRJMOD})"
    )
    model_path: Optional[str] = Field(
        None, description="Explicit 3D model base path to use as-is."
    )
    hide_pin_numbers: bool = Field(False, description="Hide pin numbers in exported symbol.")
    hide_pin_names: bool = Field(False, description="Hide pin names in exported symbol.")
    symbol_value_override: Optional[str] = Field(
        None, description="Override symbol Value property (e.g. resistance value from component page)."
    )
    symbol_params: Optional[Dict[str, str]] = Field(
        None, description="Additional component parameters from LCSC page to include as symbol properties."
    )
    symbol_description: Optional[str] = Field(
        None, description="Component description text scraped from LCSC product page."
    )
    symbol_datasheet_url: Optional[str] = Field(
        None, description="Actual datasheet PDF URL scraped from LCSC product page, overrides EasyEDA value."
    )
    use_template: bool = Field(False, description="Use a template symbol instead of EasyEDA graphics.")
    template_name: Optional[str] = Field(
        None, description="Name of the template symbol (e.g. 'Template_Resistor')."
    )
    template_lib_path: Optional[str] = Field(
        None, description="Full path to the .kicad_sym file that contains the template symbols."
    )
    force_template: bool = Field(
        False,
        description="If true, use only the template (no fallback to EasyEDA symbol on template failure).",
    )
    template_pin_map: Optional[Dict[str, str]] = Field(
        None,
        description=(
            "Template PAD map: merged symbol pin number (key) → footprint pad name (value). "
            "Only symbol (number …) is rewritten; pin (name …) and all footprint (pad …) names "
            "are never modified by the importer."
        ),
    )

    @field_validator("lcsc_id")
    @classmethod
    def validate_lcsc(cls, value: str) -> str:
        if not value or not value.startswith("C"):
            raise ValueError("LCSC ID must start with 'C'")
        return value

    @model_validator(mode="after")
    def ensure_target_selected(cls, payload: TaskCreatePayload) -> TaskCreatePayload:
        if not any([payload.symbol, payload.footprint, payload.model]):
            raise ValueError("Select at least one output: symbol, footprint or model.")
        return payload


class ConversionResultModel(BaseModel):
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = Field(default_factory=dict)
    messages: List[str] = Field(default_factory=list)


class TaskSummary(BaseModel):
    id: str
    status: str
    progress: int
    message: Optional[str]
    queue_position: Optional[int]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    result: Optional[ConversionResultModel]


class TaskDetail(TaskSummary):
    log: List[dict[str, Any]]


class PathRequest(BaseModel):
    path: str


class LibraryScaffoldRequest(BaseModel):
    base_path: str = Field(..., description="Base directory for the library")
    library_name: str = Field(..., description="Library name without extension")
    symbol: bool = True
    footprint: bool = True
    model: bool = True
    project_relative: bool = False

    @model_validator(mode="after")
    def ensure_outputs(cls, payload: LibraryScaffoldRequest) -> LibraryScaffoldRequest:
        if not any((payload.symbol, payload.footprint, payload.model)):
            raise ValueError("Select at least one scaffold target.")
        return payload


class LibraryScaffoldResponse(BaseModel):
    resolved_library_prefix: str
    symbol_path: Optional[str]
    footprint_dir: Optional[str]
    model_dir: Optional[str]
    created: Dict[str, bool]


class LibraryValidateRequest(BaseModel):
    path: str


class LibraryValidateResponse(BaseModel):
    resolved_path: str
    exists: bool
    is_dir: bool
    writable: bool
    assets: Dict[str, bool]
    counts: Dict[str, int] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)
    model_path: Optional[str] = None


class ComponentCheckRequest(BaseModel):
    path: str
    lcsc_id: str

    @field_validator("lcsc_id")
    @classmethod
    def validate_lcsc(cls, value: str) -> str:
        if not value or not value.startswith("C"):
            raise ValueError("LCSC ID must start with 'C'")
        return value


class ComponentCheckResponse(BaseModel):
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = Field(default_factory=dict)
    messages: List[str] = Field(default_factory=list)


class TemplatePinCheckPayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component ID (e.g. C12345).")
    template_name: str = Field(..., description="Symbol name in the template library.")
    template_lib_path: str = Field(..., description="Full path to the .kicad_sym template file.")


class TemplatePinCheckResponse(BaseModel):
    easyeda_pin_count: int
    template_pin_count: int
    match: bool


class GalleryTemplateRef(BaseModel):
    template_name: str
    template_lib_path: str


class TemplatesGalleryPinSummaryPayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component ID (e.g. C12345).")
    templates: List[GalleryTemplateRef]

    @field_validator("templates")
    @classmethod
    def _cap_template_list(cls, v: List[GalleryTemplateRef]) -> List[GalleryTemplateRef]:
        if len(v) > 500:
            raise ValueError("Too many templates (max 500 per request).")
        return v


class TemplatePreviewPayload(BaseModel):
    template_name: str = Field(..., description="Symbol name in the template library.")
    template_lib_path: str = Field(..., description="Full path to the .kicad_sym template file.")
    label_pins: bool = Field(
        False,
        description="Use larger fonts/margins for pin number+name labels (always drawn; compact when false).",
    )
    draw_pin_names: bool = Field(
        True,
        description="When false, SVG shows pin numbers only; names are listed in API ``pins`` for side UI.",
    )
    preview_theme: str = Field(
        "light",
        description="light: dark ink on transparent SVG; dark: light ink on transparent SVG (dark page / Dark Reader).",
    )

    @field_validator("preview_theme")
    @classmethod
    def _norm_preview_theme(cls, v: str) -> str:
        t = (v or "light").strip().lower()
        return t if t in ("light", "dark") else "light"


class TemplatePinMapContextPayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component ID (e.g. C12345).")
    template_name: str = Field(..., description="Symbol name in the template library.")
    template_lib_path: str = Field(..., description="Full path to the .kicad_sym template file.")


class LcscFootprintPreviewPayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component ID (e.g. C12345).")
