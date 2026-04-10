import itertools
import re
import textwrap
from dataclasses import dataclass, field, fields
from enum import Enum, auto
from typing import List, Optional, Union


class KiPinType(Enum):
    _input = auto()
    output = auto()
    bidirectional = auto()
    tri_state = auto()
    passive = auto()
    free = auto()
    unspecified = auto()
    power_in = auto()
    power_out = auto()
    open_collector = auto()
    open_emitter = auto()
    no_connect = auto()


class KiPinStyle(Enum):
    line = auto()
    inverted = auto()
    clock = auto()
    inverted_clock = auto()
    input_low = auto()
    clock_low = auto()
    output_low = auto()
    edge_clock_high = auto()
    non_logic = auto()


class KiBoxFill(Enum):
    none = auto()
    outline = auto()
    background = auto()


# Config V5
# Dimensions are in mil
class KiExportConfigV5(Enum):
    PIN_LENGTH = 100
    PIN_SPACING = 100
    PIN_NUM_SIZE = 50
    PIN_NAME_SIZE = 50
    PIN_NAME_OFFSET = 40
    DEFAULT_BOX_LINE_WIDTH = 0
    FIELD_FONT_SIZE = 60
    FIELD_OFFSET_START = 200
    FIELD_OFFSET_INCREMENT = 100


ki_pin_type_v5_format = {
    KiPinType._input: "I",
    KiPinType.output: "O",
    KiPinType.bidirectional: "B",
    KiPinType.tri_state: "T",
    KiPinType.passive: "P",
    KiPinType.free: "U",
    KiPinType.unspecified: "U",
    KiPinType.power_in: "W",
    KiPinType.power_out: "W",
    KiPinType.open_collector: "C",
    KiPinType.open_emitter: "E",
    KiPinType.no_connect: "N",
}

ki_pin_style_v5_format = {
    KiPinStyle.line: "",
    KiPinStyle.inverted: "I",
    KiPinStyle.clock: "C",
    KiPinStyle.inverted_clock: "F",
    KiPinStyle.input_low: "L",
    KiPinStyle.clock_low: "CL",
    KiPinStyle.output_low: "V",
    KiPinStyle.edge_clock_high: "C",
    KiPinStyle.non_logic: "X",
}

ki_pin_orientation_v5_format = {"0": "L", "90": "D", "180": "R", "270": "U"}

ki_box_fill_v5_format = {
    KiBoxFill.none: "N",
    KiBoxFill.outline: "F",
    KiBoxFill.background: "f",
}


def sanitize_fields(name: str) -> str:
    return name.replace(" ", "").replace("/", "_").replace(":", "{colon}")


def apply_text_style(text: str) -> str:
    if text.endswith("#"):
        text = f"~{{{text[:-1]}}}"
    return text


def apply_pin_name_style(pin_name: str) -> str:
    return "/".join(apply_text_style(txt) for txt in pin_name.split("/"))


# Config V6
# Dimensions are in mm
class KiExportConfigV6(Enum):
    PIN_LENGTH = 2.54
    PIN_SPACING = 2.54
    PIN_NUM_SIZE = 1.27
    PIN_NAME_SIZE = 1.27
    DEFAULT_BOX_LINE_WIDTH = 0
    PROPERTY_FONT_SIZE = 1.27
    FIELD_OFFSET_START = 5.08
    FIELD_OFFSET_INCREMENT = 2.54


# KiCad fields already emitted from KiSymbolInfo; LCSC param rows must not duplicate them
# (e.g. LCSC "Datasheet" is link text / filename, not the PDF URL).
STANDARD_SYMBOL_PROPERTY_KEYS = frozenset(
    {
        "Reference",
        "Value",
        "Footprint",
        "Datasheet",
        "Description",
        "Manufacturer",
        "LCSC Part",
        "JLC Part",
    }
)


# ---------------- INFO HEADER ----------------
@dataclass
class KiSymbolInfo:
    name: str
    prefix: str
    package: str
    manufacturer: str
    datasheet: str
    lcsc_id: str
    jlc_id: str
    y_low: Union[int, float] = 0
    y_high: Union[int, float] = 0
    hide_pin_numbers: bool = False
    hide_pin_names: bool = False
    value_override: Optional[str] = None
    #: LCSC param name used for the Value field (extension omits this key from ``symbol_params``).
    value_param_key: Optional[str] = None
    symbol_params: Optional[dict] = None
    symbol_description: Optional[str] = None

    def export_v6(self) -> List[str]:
        _prop_visible = textwrap.indent(
            textwrap.dedent(
                """
                (property "{key}" "{value}"
                  (at 0 {pos_y:.2f} 0)
                  (effects
                    (font
                      (size {font_size} {font_size})
                    )
                  )
                )"""
            ),
            "  ",
        )
        _prop_hidden = textwrap.indent(
            textwrap.dedent(
                """
                (property "{key}" "{value}"
                  (at 0 {pos_y:.2f} 0)
                  (effects
                    (font
                      (size {font_size} {font_size})
                    )
                    (hide yes)
                  )
                )"""
            ),
            "  ",
        )

        def _prop(key, value, pos_y, hide="hide"):
            safe_value = str(value).replace('"', "'")
            template = _prop_visible if hide == "" else _prop_hidden
            return template.format(
                key=key,
                value=safe_value,
                pos_y=pos_y,
                font_size=KiExportConfigV6.PROPERTY_FONT_SIZE.value,
            )

        field_offset_y = KiExportConfigV6.FIELD_OFFSET_START.value
        header: List[str] = [
            _prop("Reference", self.prefix, self.y_high + field_offset_y, hide=""),
        ]

        header.append(
            _prop(
                "Value",
                self.value_override if self.value_override else self.name,
                self.y_low - field_offset_y,
                hide="",
            )
        )

        field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
        header.append(_prop("Footprint", self.package or "", self.y_low - field_offset_y))

        field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
        header.append(_prop("Datasheet", self.datasheet or "", self.y_low - field_offset_y))

        description_value = self.symbol_description or (
            self.name if self.value_override and self.value_override != self.name else ""
        )
        field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
        header.append(_prop("Description", description_value, self.y_low - field_offset_y))

        if self.manufacturer:
            field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
            header.append(_prop("Manufacturer", self.manufacturer, self.y_low - field_offset_y))

        if self.lcsc_id:
            field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
            header.append(_prop("LCSC Part", self.lcsc_id, self.y_low - field_offset_y))

        if self.jlc_id:
            field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
            header.append(_prop("JLC Part", self.jlc_id, self.y_low - field_offset_y))

        if self.symbol_params:
            for param_key, param_value in self.symbol_params.items():
                if param_key in STANDARD_SYMBOL_PROPERTY_KEYS:
                    continue
                if param_value:
                    field_offset_y += KiExportConfigV6.FIELD_OFFSET_INCREMENT.value
                    header.append(_prop(param_key, param_value, self.y_low - field_offset_y))

        return header


# ---------------- PIN ----------------
@dataclass
class KiSymbolPin:
    name: str
    number: str
    style: KiPinStyle
    length: float
    type: KiPinType
    orientation: float
    pos_x: Union[int, float]
    pos_y: Union[int, float]
    hide_number: bool = False
    hide_name: bool = False

    def export_v6(self) -> str:
        name_effects = "(effects (font (size {s} {s})){hide})".format(
            s=KiExportConfigV6.PIN_NAME_SIZE.value,
            hide=" hide" if self.hide_name else "",
        )
        num_effects = "(effects (font (size {s} {s})){hide})".format(
            s=KiExportConfigV6.PIN_NUM_SIZE.value,
            hide=" hide" if self.hide_number else "",
        )
        return """
            (pin {pin_type} {pin_style}
              (at {x:.2f} {y:.2f} {orientation})
              (length {pin_length})
              (name "{pin_name}" {name_effects})
              (number "{pin_num}" {num_effects})
            )""".format(
            pin_type=self.type.name[1:]
            if self.type.name.startswith("_")
            else self.type.name,
            pin_style=self.style.name,
            x=self.pos_x,
            y=self.pos_y,
            orientation=(180 + self.orientation) % 360,  # TODO: 360 - ?
            pin_length=self.length,
            pin_name=apply_pin_name_style(self.name),
            name_effects=name_effects,
            pin_num=self.number,
            num_effects=num_effects,
        )


# ---------------- RECTANGLE ----------------
@dataclass
class KiSymbolRectangle:
    pos_x0: Union[int, float] = 0
    pos_y0: Union[int, float] = 0
    pos_x1: Union[int, float] = 0
    pos_y1: Union[int, float] = 0

    def export_v6(self) -> str:
        return """
            (rectangle
              (start {x0:.2f} {y0:.2f})
              (end {x1:.2f} {y1:.2f})
              (stroke (width {line_width}) (type default) (color 0 0 0 0))
              (fill (type {fill}))
            )""".format(
            x0=self.pos_x0,
            y0=self.pos_y0,
            x1=self.pos_x1,
            y1=self.pos_y1,
            line_width=KiExportConfigV6.DEFAULT_BOX_LINE_WIDTH.value,
            fill=KiBoxFill.background.name,
        )


# ---------------- POLYGON ----------------
@dataclass
class KiSymbolPolygon:
    points: List[List[float]] = field(default_factory=List[List[float]])
    points_number: int = 0
    is_closed: bool = False

    def export_v6(self) -> str:
        return """
            (polyline
              (pts
                {polyline_path}
              )
              (stroke (width {line_width}) (type default) (color 0 0 0 0))
              (fill (type {fill}))
            )""".format(
            polyline_path=" ".join(
                [f"(xy {pts[0]:.2f} {pts[1]:.2f})" for pts in self.points]
            ),
            line_width=KiExportConfigV6.DEFAULT_BOX_LINE_WIDTH.value,
            fill=KiBoxFill.background.name if self.is_closed else KiBoxFill.none.name,
        )


# ---------------- CIRCLE ----------------
@dataclass
class KiSymbolCircle:
    pos_x: Union[int, float] = 0
    pos_y: Union[int, float] = 0
    radius: Union[int, float] = 0
    background_filling: bool = False

    def export_v5(self) -> str:
        return (
            "C {pos_x:.0f} {pos_y:.0f} {radius:.0f} {unit_num} 1 {line_width} {fill}\n"
            .format(
                pos_x=self.pos_x,
                pos_y=self.pos_y,
                radius=int(self.radius),
                unit_num=1,
                line_width=KiExportConfigV5.DEFAULT_BOX_LINE_WIDTH.value,
                fill=ki_box_fill_v5_format[KiBoxFill.background]
                if self.background_filling
                else ki_box_fill_v5_format[KiBoxFill.none],
            )
        )

    def export_v6(self) -> str:
        return """
            (circle
              (center {pos_x:.2f} {pos_y:.2f})
              (radius {radius:.2f})
              (stroke (width {line_width}) (type default) (color 0 0 0 0))
              (fill (type {fill}))
            )""".format(
            pos_x=self.pos_x,
            pos_y=self.pos_y,
            radius=self.radius,
            line_width=KiExportConfigV6.DEFAULT_BOX_LINE_WIDTH.value,
            fill=KiBoxFill.background.name
            if self.background_filling
            else KiBoxFill.none.name,
        )


# ---------------- ARC ----------------
@dataclass
class KiSymbolArc:
    center_x: float = 0
    center_y: float = 0
    radius: float = 0
    angle_start: float = 0.0
    angle_end: float = 0.0
    start_x: float = 0
    start_y: float = 0
    middle_x: float = 0
    middle_y: float = 0
    end_x: float = 0
    end_y: float = 0

    def export_v6(self) -> str:
        return """
            (arc
              (start {start_x:.2f} {start_y:.2f})
              (mid {middle_x:.2f} {middle_y:.2f})
              (end {end_x:.2f} {end_y:.2f})
              (stroke (width {line_width}) (type default) (color 0 0 0 0))
              (fill (type {fill}))
            )""".format(
            start_x=self.start_x,
            start_y=self.start_y,
            middle_x=self.middle_x,
            middle_y=self.middle_y,
            end_x=self.end_x,
            end_y=self.end_y,
            line_width=KiExportConfigV6.DEFAULT_BOX_LINE_WIDTH.value,
            fill=KiBoxFill.background.name
            if self.angle_start == self.angle_end
            else KiBoxFill.none.name,
        )


# ---------------- BEZIER CURVE ----------------
@dataclass
class KiSymbolBezier:
    points: List[List[float]] = field(default_factory=List[List[float]])
    points_number: int = 0
    is_closed: bool = False

    def export_v6(self) -> str:
        return """
            (gr_curve
              (pts
                {polyline_path}
              )
              (stroke (width {line_width}) (type default) (color 0 0 0 0))
              (fill (type {fill}))
            )""".format(
            polyline_path="".join([f" (xy {pts[0]} {pts[1]})" for pts in self.points]),
            line_width=KiExportConfigV6.DEFAULT_BOX_LINE_WIDTH.value,
            fill=KiBoxFill.background.name if self.is_closed else KiBoxFill.none.name,
        )


# ---------------- SYMBOL ----------------
@dataclass
class KiSymbol:
    info: KiSymbolInfo
    pins: List[KiSymbolPin] = field(default_factory=lambda: [])
    rectangles: List[KiSymbolRectangle] = field(default_factory=lambda: [])
    circles: List[KiSymbolCircle] = field(default_factory=lambda: [])
    arcs: List[KiSymbolArc] = field(default_factory=lambda: [])
    polygons: List[KiSymbolPolygon] = field(default_factory=lambda: [])
    beziers: List[KiSymbolBezier] = field(default_factory=lambda: [])

    def _collect_export_parts(self) -> dict:
        self.info.y_low = min(pin.pos_y for pin in self.pins) if self.pins else 0
        self.info.y_high = max(pin.pos_y for pin in self.pins) if self.pins else 0

        sym_export_data = {}
        for _field in fields(self):
            shapes = getattr(self, _field.name)
            if isinstance(shapes, list):
                sym_export_data.setdefault(_field.name, [])
                for sub_symbol in shapes:
                    sym_export_data[_field.name].append(sub_symbol.export_v6())
            else:
                sym_export_data[_field.name] = shapes.export_v6()
        return sym_export_data

    def export_v6(self):
        sym_export_data = self._collect_export_parts()
        sym_info = sym_export_data.pop("info")
        sym_pins = sym_export_data.pop("pins")
        sym_graphic_items = itertools.chain.from_iterable(sym_export_data.values())

        pin_number_hide = (
            "\n    (pin_numbers\n      (hide yes)\n    )" if self.info.hide_pin_numbers else ""
        )
        pin_name_hide = (
            "\n    (pin_names\n      (hide yes)\n    )" if self.info.hide_pin_names else ""
        )

        template = textwrap.dedent(
            """
        (symbol "{library_id}"{pin_number_hide}{pin_name_hide}
          (exclude_from_sim no)
          (in_bom yes)
          (on_board yes)
          {symbol_properties}
          (symbol "{library_id}_0_1"
            {graphic_items}
            {pins}
          )
          (embedded_fonts no)
        )"""
        )

        return textwrap.indent(template, "  ").format(
            library_id=sanitize_fields(self.info.name),
            pin_number_hide=pin_number_hide,
            pin_name_hide=pin_name_hide,
            symbol_properties=textwrap.indent(
                textwrap.dedent("".join(sym_info)), "  " * 2
            ),
            graphic_items=textwrap.indent(
                textwrap.dedent("".join(sym_graphic_items)), "  " * 3
            ),
            pins=textwrap.indent(textwrap.dedent("".join(sym_pins)), "  " * 3),
        )

    def export(self) -> str:
        component_data = self.export_v6()
        return re.sub(r"\n\s*\n", "\n", component_data, re.MULTILINE)
