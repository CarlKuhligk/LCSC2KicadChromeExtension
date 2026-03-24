# Global imports
import logging
import os
from math import acos, cos, isnan, pi, sin, sqrt
from typing import List, Optional, Tuple

from easyeda2kicad.easyeda.parameters_easyeda import EeFootprint
from easyeda2kicad.kicad.footprint_pad_remap import normalize_easyeda_pad_number
from easyeda2kicad.kicad.parameters_kicad_footprint import *

# ---------------------------------------


def easyeda_pad_shape_to_kicad(shape: str) -> str:
    """Map EasyEDA / LCSC ``PAD~`` shape token to KiCad pad shape name."""
    raw = (shape or "").strip()
    if not raw:
        return "rect"
    up = raw.upper()
    if up in KI_PAD_SHAPE:
        return KI_PAD_SHAPE[up]
    return "custom"


def easyeda_ki_shape_for_footprint_pad(ee_pad) -> str:
    """
    Map EasyEDA pad → KiCad *pad shape* for footprint export and preview.

    EasyEDA ``ROUND`` on a non-square pad is almost always a **rounded rectangle**; our
    old mapping to ``circle`` drew a **stretched ellipse** (rx≠ry). Elongated ``OVAL``
    pads from LCSC are usually **stadium / pill** shapes, which match KiCad ``roundrect``
    with ``roundrect_rratio`` 1.0 better than a mathematical ellipse.
    """
    shape_up = (ee_pad.shape or "").strip().upper()
    w = max(float(ee_pad.width), 0.01)
    h = max(float(ee_pad.height), 0.01)
    short = min(w, h)
    long_side = max(w, h)

    if shape_up == "ROUND":
        # Square → keep circular pad; rectangle → rounded rect (not ellipse).
        if abs(w - h) > max(0.05, short * 0.08):
            return "roundrect"
        return "circle"

    if shape_up == "OVAL":
        # Nearly square: true elliptical pad; elongated: pill / stadium as roundrect.
        if long_side > 0 and (short / long_side) < 0.72:
            return "roundrect"
        return "oval"

    return easyeda_pad_shape_to_kicad(ee_pad.shape)


def easyeda_pad_has_through_hole(ee_pad) -> bool:
    """Plated through-hole or slotted hole (hole length used for oval drills)."""
    try:
        r = float(ee_pad.hole_radius)
    except (TypeError, ValueError):
        r = 0.0
    try:
        hl = float(ee_pad.hole_length)
    except (TypeError, ValueError):
        hl = 0.0
    return r > 0 or hl > 0


_DEFAULT_EASYEDA_ROUNDRECT_RRATIO = 0.25


def _easyeda_roundrect_rratio_from_points(
    ee_pad, width_mm: float, height_mm: float
) -> float | None:
    """
    KiCad ``roundrect_rratio`` from EasyEDA ``points`` on RECT / ROUNDRECT pads.

    - One value in (0, 1]: treated as KiCad rratio directly.
    - One value in (1, 100]: corner radius as % of the shorter pad side (EasyEDA Pro style).
    - Explicit ROUNDRECT / RRECT with empty ``points``: use module default ratio.
    """
    shape_up = (ee_pad.shape or "").strip().upper()
    explicit = shape_up in ("ROUNDRECT", "RRECT", "ROUND_RECT")
    rect_family = shape_up in ("RECT", "RECTANGLE", "SQUARE")
    non_square = abs(width_mm - height_mm) > max(
        0.05, min(width_mm, height_mm) * 0.08
    )
    round_means_roundrect = shape_up == "ROUND" and non_square
    if not explicit and not rect_family and not round_means_roundrect:
        return None
    tokens = [t for t in (ee_pad.points or "").strip().split() if t]
    short = min(width_mm, height_mm)
    half = short / 2.0 if short > 0 else 0.0
    if not tokens:
        if explicit or round_means_roundrect:
            return _DEFAULT_EASYEDA_ROUNDRECT_RRATIO
        return None
    # Four tokens are interpreted as chamfer ratios elsewhere, not corner radii.
    if len(tokens) == 4:
        return None

    def _one_radius_value(v: float) -> float | None:
        if v <= 0:
            return None
        if v <= 1.0:
            return max(0.0, min(1.0, v))
        if v <= 100 and half > 0:
            r_mm = min(short * (v / 100.0), half * 0.999)
            return max(0.0, min(1.0, r_mm / half))
        return None

    _rr_fallback = explicit or round_means_roundrect

    if len(tokens) == 2:
        try:
            v1, v2 = float(tokens[0]), float(tokens[1])
        except ValueError:
            return _DEFAULT_EASYEDA_ROUNDRECT_RRATIO if _rr_fallback else None
        a, b = _one_radius_value(v1), _one_radius_value(v2)
        if a is None and b is None:
            return _DEFAULT_EASYEDA_ROUNDRECT_RRATIO if _rr_fallback else None
        return max(a or 0.0, b or 0.0)

    if len(tokens) != 1:
        return _DEFAULT_EASYEDA_ROUNDRECT_RRATIO if _rr_fallback else None
    try:
        v = float(tokens[0])
    except ValueError:
        return _DEFAULT_EASYEDA_ROUNDRECT_RRATIO if _rr_fallback else None
    parsed = _one_radius_value(v)
    if parsed is None:
        return _DEFAULT_EASYEDA_ROUNDRECT_RRATIO if _rr_fallback else None
    return parsed


def _apply_easyeda_chamfer_from_points(ee_pad, ki_pad: KiFootprintPad) -> bool:
    """
    EasyEDA sometimes encodes corner chamfers as four ratios in ``points`` (rect family).
    KiCad order: top_left, top_right, bottom_right, bottom_left.
    Returns True if a chamfrect style was applied.
    """
    if ki_pad.shape == "custom":
        return False
    shape_up = (ee_pad.shape or "").strip().upper()
    chamfer_named = shape_up in (
        "CHAMFER",
        "CHAMFERED",
        "CHAMFER_RECT",
        "CHAMFERED_RECT",
    )
    rect_family = shape_up in ("RECT", "RECTANGLE", "SQUARE")
    if not chamfer_named and not rect_family:
        return False
    tokens = [t for t in (ee_pad.points or "").strip().split() if t]
    if len(tokens) != 4:
        return False
    try:
        vals = [float(t) for t in tokens]
    except ValueError:
        return False

    def _norm_ratio(v: float) -> float:
        av = abs(v)
        if av <= 1.0:
            return max(0.0, min(1.0, av))
        return max(0.0, min(1.0, av / 100.0))

    if chamfer_named:
        # Reject values that look like polygon coordinates (mm), not 0..100 ratios.
        if any(abs(v) > 100.0 for v in vals):
            return False
        ctl, ctr, cbr, cbl = (_norm_ratio(v) for v in vals)
    else:
        # Plain RECT: only treat as chamfer when all values are direct 0..1 ratios (avoids
        # confusing mm coordinates such as "10 10 0 0" with 10% chamfers).
        if any(v <= 0 or v > 1.0 for v in vals):
            return False
        ctl, ctr, cbr, cbl = (
            max(0.0, min(1.0, v)) for v in vals
        )
    if ctl + ctr + cbr + cbl < 1e-9:
        return False
    ki_pad.shape = "chamfrect"
    ki_pad.chamfer_tl, ki_pad.chamfer_tr, ki_pad.chamfer_br, ki_pad.chamfer_bl = (
        ctl,
        ctr,
        cbr,
        cbl,
    )
    ki_pad.roundrect_rratio = 0.0
    return True


def _apply_easyeda_roundrect_from_points(ee_pad, ki_pad: KiFootprintPad) -> None:
    if ki_pad.shape == "custom":
        return
    rr = _easyeda_roundrect_rratio_from_points(ee_pad, ki_pad.width, ki_pad.height)
    if rr is None or rr <= 0:
        return
    ki_pad.shape = "roundrect"
    ki_pad.roundrect_rratio = rr
    ki_pad.chamfer_tl = ki_pad.chamfer_tr = ki_pad.chamfer_br = ki_pad.chamfer_bl = 0.0


def to_radians(n: float) -> float:
    return (n / 180.0) * pi


def to_degrees(n: float) -> float:
    return (n / pi) * 180.0


# Elliptical arc implementation based on the SVG specification notes
# https://www.w3.org/TR/SVG11/implnote.html#ArcConversionEndpointToCenter


def compute_arc(
    start_x: float,
    start_y: float,
    radius_x: float,
    radius_y: float,
    angle: float,
    large_arc_flag: bool,
    sweep_flag: bool,
    end_x: float,
    end_y: float,
) -> Tuple[float, float, float]:
    # Compute the half distance between the current and the final point
    dx2 = (start_x - end_x) / 2.0
    dy2 = (start_y - end_y) / 2.0

    # Convert angle from degrees to radians
    angle = to_radians(angle % 360.0)
    cos_angle = cos(angle)
    sin_angle = sin(angle)

    # Step 1 : Compute (x1, y1)
    x1 = cos_angle * dx2 + sin_angle * dy2
    y1 = -sin_angle * dx2 + cos_angle * dy2

    # Ensure radii are large enough
    radius_x = abs(radius_x)
    radius_y = abs(radius_y)
    Pradius_x = radius_x * radius_x
    Pradius_y = radius_y * radius_y
    Px1 = x1 * x1
    Py1 = y1 * y1

    # check that radii are large enough

    radiiCheck = (
        Px1 / Pradius_x + Py1 / Pradius_y if Pradius_x != 0 and Pradius_y != 0 else 0
    )
    if radiiCheck > 1:
        radius_x = sqrt(radiiCheck) * radius_x
        radius_y = sqrt(radiiCheck) * radius_y
        Pradius_x = radius_x * radius_x
        Pradius_y = radius_y * radius_y

    # Step 2 : Compute (cx1, cy1)
    sign = -1 if large_arc_flag == sweep_flag else 1
    sq = 0
    if Pradius_x * Py1 + Pradius_y * Px1 > 0:
        sq = (Pradius_x * Pradius_y - Pradius_x * Py1 - Pradius_y * Px1) / (
            Pradius_x * Py1 + Pradius_y * Px1
        )
    sq = max(sq, 0)
    coef = sign * sqrt(sq)
    cx1 = coef * ((radius_x * y1) / radius_y)
    cy1 = coef * -((radius_y * x1) / radius_x) if radius_x != 0 else 0

    # Step 3 : Compute (cx, cy) from (cx1, cy1)
    sx2 = (start_x + end_x) / 2.0
    sy2 = (start_y + end_y) / 2.0
    cx = sx2 + (cos_angle * cx1 - sin_angle * cy1)
    cy = sy2 + (sin_angle * cx1 + cos_angle * cy1)

    # Step 4 : Compute the angle_extent (dangle)
    ux = (x1 - cx1) / radius_x if radius_x != 0 else 0
    uy = (y1 - cy1) / radius_y if radius_y != 0 else 0
    vx = (-x1 - cx1) / radius_x if radius_x != 0 else 0
    vy = (-y1 - cy1) / radius_y if radius_y != 0 else 0

    # Compute the angle extent
    n = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
    p = ux * vx + uy * vy
    sign = -1 if (ux * vy - uy * vx) < 0 else 1
    if n != 0:
        clamped_ratio = max(-1, min(1, p / n))
        angle_extent = to_degrees(sign * acos(clamped_ratio))
    else:
        angle_extent = 360 + 359
    if not (sweep_flag) and angle_extent > 0:
        angle_extent -= 360
    elif sweep_flag and angle_extent < 0:
        angle_extent += 360

    angleExtent_sign = 1 if angle_extent < 0 else -1
    angle_extent = (abs(angle_extent) % 360) * angleExtent_sign

    return cx, cy, angle_extent


# ---------------------------------------


def fp_to_ki(dim: float) -> float:
    if dim not in ["", None] and isnan(float(dim)) is False:
        return round(float(dim) * 10 * 0.0254, 2)
    return dim


def drill_to_ki(
    hole_radius: float, hole_length: float, pad_height: float, pad_width: float
) -> str:
    if (
        hole_radius > 0
        and hole_length != ""
        and hole_length is not None
        and hole_length != 0
    ):
        max_distance_hole = max(hole_radius * 2, hole_length)
        pos_0 = pad_height - max_distance_hole
        pos_90 = pad_width - max_distance_hole
        max_distance = max(pos_0, pos_90)

        if max_distance == pos_0:
            return f"(drill oval {hole_radius*2} {hole_length})"
        else:
            return f"(drill oval {hole_length} {hole_radius*2})"
    if hole_radius > 0:
        return f"(drill {2 * hole_radius})"
    try:
        hl_only = float(hole_length or 0)
    except (TypeError, ValueError):
        hl_only = 0.0
    # Rare LCSC/EasyEDA rows: slot length set with zero hole_radius — still emit a drill.
    if hl_only > 0:
        return f"(drill {hl_only})"
    return ""


# ---------------------------------------


def angle_to_ki(rotation: float) -> float:
    if isnan(rotation) is False:
        return float(-(360 - rotation) if rotation > 180 else rotation)
    return 0.0


# ---------------------------------------


def rotate(x: float, y: float, degrees: float) -> Tuple[float, float]:
    radians = (degrees / 180) * 2 * pi
    new_x = x * cos(radians) - y * sin(radians)
    new_y = x * sin(radians) + y * cos(radians)
    return new_x, new_y


def mesh_z_rotation_xy_offset_adjustment_mm(
    mesh_center_x: float,
    mesh_center_y: float,
    easyeda_rz_deg: float,
    kicad_rz_deg: float,
) -> Tuple[float, float]:
    """Extra (model) offset XY in mm for non‑zero EasyEDA ``c_rotation`` Z.

    ``c_origin`` is in the same mm space as the 2D footprint (``convert_to_mm``), while OBJ
    vertices are converted with legacy ``/ 2.54`` in ``compute_obj_center`` / WRL export.
    For **Z rotation only**, KiCad then rotates the mesh in a space that effectively differs
    by a **2.54×** factor on XY vs footprint mm, which shows up as a shifted body (e.g. LCSC
    **C841795**: manual fix ``(4.0, -2.3)`` vs raw ``c_origin`` offset ``(-1, 0)``).

    When EasyEDA Z rotation is 0, return ``(0, 0)`` so packages like TQFN stay unchanged.
    """
    ez = float(easyeda_rz_deg) % 360.0
    if ez < 0:
        ez += 360.0
    if ez <= 1e-6 or ez >= 360.0 - 1e-6:
        return (0.0, 0.0)
    # Do not use ``rotate()`` here: it uses ``(deg/180)*2*pi`` radians (double angle) for legacy
    # arc math. We need true CCW rotation in the footprint XY plane by ``kicad_rz_deg``.
    rad = (float(kicad_rz_deg) / 180.0) * pi
    c, s = cos(rad), sin(rad)
    rx = mesh_center_x * c - mesh_center_y * s
    ry = mesh_center_x * s + mesh_center_y * c
    scale = 2.54
    return (scale * rx, scale * ry)


# ---------------------------------------


def is_on_segment(
    x0: float, y0: float, x1: float, y1: float, px: float, py: float
) -> bool:
    epsilon = 1e-9
    return (
        min(x0, x1) <= px <= max(x0, x1)
        and min(y0, y1) <= py <= max(y0, y1)
        and abs((px - x0) * (y1 - y0) - (py - y0) * (x1 - x0)) < epsilon
    )


def is_left(x0: float, y0: float, x1: float, y1: float, px: float, py: float) -> bool:
    return ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) > 0


def is_point_in_polygon(
    point: Tuple[float, float], polygon: List[Tuple[float, float]]
) -> bool:
    x, y = point
    winding_number = 0
    n = len(polygon)

    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]

        if is_on_segment(x0, y0, x1, y1, x, y):
            return True

        if y0 <= y < y1 and is_left(x0, y0, x1, y1, x, y):
            winding_number += 1
        elif y1 <= y < y0 and not is_left(x0, y0, x1, y1, x, y):
            winding_number -= 1

    return winding_number != 0


def get_circumscribed_regular_polygon(
    center: Tuple[float, float], radius: float, n: int
) -> List[Tuple[float, float]]:
    cx, cy = center
    return [
        (cx + radius * cos(2 * pi * i / n), cy + radius * sin(2 * pi * i / n))
        for i in range(n)
    ]


def is_circle_in_polygon(
    center: Tuple[float, float], radius: float, polygon: List[Tuple[float, float]]
) -> bool:
    return all(
        is_point_in_polygon(vertex, polygon)
        for vertex in get_circumscribed_regular_polygon(center, radius, 12)
    )


def get_bounds_of_polygon(
    polygon: List[Tuple[float, float]],
) -> Tuple[float, float, float, float]:
    min_x = min(polygon, key=lambda vertex: vertex[0])[0]
    max_x = max(polygon, key=lambda vertex: vertex[0])[0]
    min_y = min(polygon, key=lambda vertex: vertex[1])[1]
    max_y = max(polygon, key=lambda vertex: vertex[1])[1]
    return min_x, max_x, min_y, max_y


def frange(start: float, stop: float, step: float):
    count = int((stop - start) / step) + 1
    for i in range(count):
        yield start + step * i


def find_circle_center_in_polygon(
    polygon: List[Tuple[float, float]], radius: float
) -> Optional[Tuple[float, float]]:
    min_x, max_x, min_y, max_y = get_bounds_of_polygon(polygon)
    step = 0.05

    for x in frange(min_x, max_x, step):
        for y in frange(min_y, max_y, step):
            center = (x, y)
            if is_circle_in_polygon(center, radius, polygon):
                return center
    return None


def set_appropriate_position_for_custom_shape(
    ki_pad: KiFootprintPad, polygon: List[Tuple[float, float]]
) -> None:
    center = (ki_pad.pos_x, ki_pad.pos_y)
    radius = ki_pad.width / 2

    if is_circle_in_polygon(center, radius, polygon):
        return

    new_center = find_circle_center_in_polygon(polygon, radius)
    if new_center is None:
        logging.warning(
            f"The custom shape of PAD #${ki_pad.number} cannot contain its anchor pad"
        )
        return

    ki_pad.pos_x, ki_pad.pos_y = new_center


# ---------------------------------------


def sanitize_model_filename(name: str) -> str:
    base = os.path.splitext(name or "")[0]
    if not base:
        base = "easyeda_model"
    return base.replace("\\", "_").replace("/", "_")


class ExporterFootprintKicad:
    def __init__(self, footprint: EeFootprint):
        self.input = footprint
        if not isinstance(self.input, EeFootprint):
            logging.error("Unsupported conversion")
        else:
            self.generate_kicad_footprint()

    def generate_kicad_footprint(self) -> None:
        # Convert dimension from easyeda to kicad
        self.input.bbox.convert_to_mm()

        for fields in (
            self.input.pads,
            self.input.tracks,
            self.input.holes,
            self.input.vias,
            self.input.circles,
            self.input.rectangles,
            self.input.texts,
        ):
            for field in fields:
                field.convert_to_mm()

        ki_info = KiFootprintInfo(
            name=self.input.info.name, fp_type=self.input.info.fp_type
        )

        if self.input.model_3d is not None:
            self.input.model_3d.convert_to_mm()
            footprint_origin_x = self.input.bbox.x
            footprint_origin_y = self.input.bbox.y

            # XY: always use EasyEDA ``c_origin`` (``translation``) relative to the footprint
            # bbox corner — same coordinate frame as pads. Older logic aligned the 2D geometry
            # hull center to the OBJ AABB center using *different* X/Y scale factors; the WRL is
            # not stretched, so that skewed placement whenever footprint vs mesh aspect ratios
            # differed.
            api_translation_x = self.input.model_3d.translation.x
            api_translation_y = self.input.model_3d.translation.y
            model_translation_x = round(api_translation_x - footprint_origin_x, 2)
            model_translation_y = -round(api_translation_y - footprint_origin_y, 2)

            rot_ki_x = (360 - self.input.model_3d.rotation.x) % 360
            rot_ki_y = (360 - self.input.model_3d.rotation.y) % 360
            rot_ki_z = (360 - self.input.model_3d.rotation.z) % 360

            c3 = self.input.model_3d.center
            if c3 is not None and len(c3) >= 2:
                adx, ady = mesh_z_rotation_xy_offset_adjustment_mm(
                    c3[0],
                    c3[1],
                    self.input.model_3d.rotation.z,
                    rot_ki_z,
                )
                model_translation_x = round(model_translation_x + adx, 2)
                model_translation_y = round(model_translation_y + ady, 2)

            model_translation_z = 0.0
            if (
                self.input.model_3d.center is not None
                and self.input.model_3d.size is not None
                and len(self.input.model_3d.center) == 3
                and len(self.input.model_3d.size) == 3
                and self.input.model_3d.size[2] != 0
            ):
                model_center_z = self.input.model_3d.center[2]
                model_size_z = self.input.model_3d.size[2]
                model_bottom_z = model_center_z - (model_size_z / 2)
                model_translation_z = -round(model_bottom_z, 2)
            elif self.input.info.fp_type == "smd":
                model_translation_z = -round(self.input.model_3d.translation.z, 2)

            ki_3d_model_info = Ki3dModel(
                name=self.input.model_3d.name,
                translation=Ki3dModelBase(
                    x=model_translation_x,
                    y=model_translation_y,
                    z=model_translation_z,
                ),
                rotation=Ki3dModelBase(
                    x=rot_ki_x,
                    y=rot_ki_y,
                    z=rot_ki_z,
                ),
                raw_wrl=None,
            )
        else:
            ki_3d_model_info = None

        self.output = KiFootprint(info=ki_info, model_3d=ki_3d_model_info)

        # For pads
        for ee_pad in self.input.pads:
            is_th = easyeda_pad_has_through_hole(ee_pad)
            ee_shape_up = (ee_pad.shape or "").strip().upper()
            ki_pad = KiFootprintPad(
                type="thru_hole" if is_th else "smd",
                shape=easyeda_ki_shape_for_footprint_pad(ee_pad),
                pos_x=ee_pad.center_x - self.input.bbox.x,
                pos_y=ee_pad.center_y - self.input.bbox.y,
                width=max(ee_pad.width, 0.01),
                height=max(ee_pad.height, 0.01),
                layers=(
                    KI_PAD_LAYER_THT if is_th else KI_PAD_LAYER
                ).get(ee_pad.layer_id, ""),
                number=ee_pad.number,
                drill="",
                orientation=angle_to_ki(ee_pad.rotation),
                polygon="",
            )

            ki_pad.drill = drill_to_ki(
                ee_pad.hole_radius, ee_pad.hole_length, ki_pad.height, ki_pad.width
            )
            ki_pad.number = normalize_easyeda_pad_number(ki_pad.number)
            if not _apply_easyeda_chamfer_from_points(ee_pad, ki_pad):
                _apply_easyeda_roundrect_from_points(ee_pad, ki_pad)
            if (
                ee_shape_up == "OVAL"
                and ki_pad.shape == "roundrect"
                and float(ki_pad.roundrect_rratio or 0) < 1e-6
            ):
                ki_pad.roundrect_rratio = 1.0
            if ki_pad.shape == "chamfrect":
                _ch = (
                    float(ki_pad.chamfer_tl or 0)
                    + float(ki_pad.chamfer_tr or 0)
                    + float(ki_pad.chamfer_br or 0)
                    + float(ki_pad.chamfer_bl or 0)
                )
                if _ch < 1e-9:
                    ki_pad.shape = "rect"

            # For custom polygon
            is_custom_shape = ki_pad.shape == "custom"
            point_list = [fp_to_ki(point) for point in ee_pad.points.split(" ")]
            if is_custom_shape:
                if len(point_list) <= 0:
                    logging.warning(
                        f"PAD ${ee_pad.id} is a polygon, but has no points defined"
                    )
                else:
                    ki_pad.width = KI_PAD_SIZE_MIN
                    ki_pad.height = KI_PAD_SIZE_MIN
                    ki_pad.orientation = 0

                    absolute_coords = [
                        (
                            point_list[i] - self.input.bbox.x,
                            point_list[i + 1] - self.input.bbox.y,
                        )
                        for i in range(0, len(point_list), 2)
                    ]
                    set_appropriate_position_for_custom_shape(
                        ki_pad=ki_pad, polygon=absolute_coords
                    )

                    relative_coords = [
                        (x - ki_pad.pos_x, y - ki_pad.pos_y)
                        for (x, y) in absolute_coords
                    ]
                    path = "".join(
                        f"(xy {round(x, 2)} {round(y, 2)})" for x, y in relative_coords
                    )
                    ki_pad.polygon = (
                        "\n\t\t(primitives \n\t\t\t(gr_poly \n\t\t\t\t(pts"
                        f" {path}\n\t\t\t\t) \n\t\t\t\t(width 0) \n\t\t\t)\n\t\t)\n\t"
                    )

            self.output.pads.append(ki_pad)

        # For tracks
        for ee_track in self.input.tracks:
            ki_track = KiFootprintTrack(
                layers=(
                    KI_PAD_LAYER[ee_track.layer_id]
                    if ee_track.layer_id in KI_PAD_LAYER
                    else "F.Fab"
                ),
                stroke_width=max(ee_track.stroke_width, 0.01),
            )

            # Generate line
            point_list = [fp_to_ki(point) for point in ee_track.points.split(" ")]
            for i in range(0, len(point_list) - 2, 2):
                ki_track.points_start_x.append(
                    round(point_list[i] - self.input.bbox.x, 2)
                )
                ki_track.points_start_y.append(
                    round(point_list[i + 1] - self.input.bbox.y, 2)
                )
                ki_track.points_end_x.append(
                    round(point_list[i + 2] - self.input.bbox.x, 2)
                )
                ki_track.points_end_y.append(
                    round(point_list[i + 3] - self.input.bbox.y, 2)
                )

            self.output.tracks.append(ki_track)

        # For holes
        for ee_hole in self.input.holes:
            ki_hole = KiFootprintHole(
                pos_x=ee_hole.center_x - self.input.bbox.x,
                pos_y=ee_hole.center_y - self.input.bbox.y,
                size=ee_hole.radius * 2,
            )

            self.output.holes.append(ki_hole)

        # For Vias
        for ee_via in self.input.vias:
            ki_via = KiFootprintVia(
                pos_x=ee_via.center_x - self.input.bbox.x,
                pos_y=ee_via.center_y - self.input.bbox.y,
                size=ee_via.radius * 2,
                diameter=ee_via.diameter,
            )

            self.output.vias.append(ki_via)

        # For circles
        for ee_circle in self.input.circles:
            ki_circle = KiFootprintCircle(
                cx=ee_circle.cx - self.input.bbox.x,
                cy=ee_circle.cy - self.input.bbox.y,
                end_x=0.0,
                end_y=0.0,
                layers=(
                    KI_LAYERS[ee_circle.layer_id]
                    if ee_circle.layer_id in KI_LAYERS
                    else "F.Fab"
                ),
                stroke_width=max(ee_circle.stroke_width, 0.01),
            )
            ki_circle.end_x = ki_circle.cx + ee_circle.radius
            ki_circle.end_y = ki_circle.cy
            self.output.circles.append(ki_circle)

        # For rectangles
        for ee_rectangle in self.input.rectangles:
            ki_rectangle = KiFootprintRectangle(
                layers=(
                    KI_PAD_LAYER[ee_rectangle.layer_id]
                    if ee_rectangle.layer_id in KI_PAD_LAYER
                    else "F.Fab"
                ),
                stroke_width=max(ee_rectangle.stroke_width, 0.01),
            )

            start_x = ee_rectangle.x - self.input.bbox.x
            start_y = ee_rectangle.y - self.input.bbox.y
            width = ee_rectangle.width
            height = ee_rectangle.height

            ki_rectangle.points_start_x = [
                start_x,
                start_x + width,
                start_x + width,
                start_x,
            ]
            ki_rectangle.points_start_y = [
                start_y,
                start_y,
                start_y + height,
                start_y + height,
            ]
            ki_rectangle.points_end_x = [
                start_x + width,
                start_x + width,
                start_x,
                start_x,
            ]
            ki_rectangle.points_end_y = [
                start_y,
                start_y + height,
                start_y + height,
                start_y,
            ]

            self.output.rectangles.append(ki_rectangle)

        # For arcs
        for ee_arc in self.input.arcs:
            arc_path = (
                ee_arc.path.replace(",", " ").replace("M ", "M").replace("A ", "A")
            )

            start_x, start_y = arc_path.split("A")[0][1:].split(" ", 1)
            start_x = fp_to_ki(start_x) - self.input.bbox.x
            start_y = fp_to_ki(start_y) - self.input.bbox.y

            arc_parameters = arc_path.split("A")[1].replace("  ", " ")
            (
                svg_rx,
                svg_ry,
                x_axis_rotation,
                large_arc,
                sweep,
                end_x,
                end_y,
            ) = arc_parameters.split(" ", 6)
            rx, ry = rotate(fp_to_ki(svg_rx), fp_to_ki(svg_ry), 0)

            end_x = fp_to_ki(end_x) - self.input.bbox.x
            end_y = fp_to_ki(end_y) - self.input.bbox.y
            if ry != 0:
                cx, cy, extent = compute_arc(
                    start_x,
                    start_y,
                    rx,
                    ry,
                    float(x_axis_rotation),
                    large_arc == "1",
                    sweep == "1",
                    end_x,
                    end_y,
                )
            else:
                cx = 0.0
                cy = 0.0
                extent = 0.0

            ki_arc = KiFootprintArc(
                start_x=cx,
                start_y=cy,
                end_x=end_x,
                end_y=end_y,
                angle=extent,
                layers=(
                    KI_LAYERS[ee_arc.layer_id]
                    if ee_arc.layer_id in KI_LAYERS
                    else "F.Fab"
                ),
                stroke_width=max(fp_to_ki(ee_arc.stroke_width), 0.01),
            )
            self.output.arcs.append(ki_arc)

        # For texts
        for ee_text in self.input.texts:
            ki_text = KiFootprintText(
                pos_x=ee_text.center_x - self.input.bbox.x,
                pos_y=ee_text.center_y - self.input.bbox.y,
                orientation=angle_to_ki(ee_text.rotation),
                text=ee_text.text,
                layers=(
                    KI_LAYERS[ee_text.layer_id]
                    if ee_text.layer_id in KI_LAYERS
                    else "F.Fab"
                ),
                font_size=max(ee_text.font_size, 1),
                thickness=max(ee_text.stroke_width, 0.01),
                display=" hide" if ee_text.is_displayed is False else "",
                mirror="",
            )
            ki_text.layers = (
                ki_text.layers.replace(".SilkS", ".Fab")
                if ee_text.type == "N"
                else ki_text.layers
            )
            ki_text.mirror = " mirror" if ki_text.layers[0] == "B" else ""
            self.output.texts.append(ki_text)

    def get_ki_footprint(self) -> KiFootprint:
        return self.output

    def export(
        self,
        footprint_full_path: str,
        model_3d_path: str,
        model_3d_path_is_explicit: bool = False,
    ) -> None:
        ki = self.output
        ki_lib = ""

        ki_lib += KI_MODULE_INFO.format(
            package_lib="easyeda2kicad", package_name=ki.info.name, edit="5DC5F6A4"
        )

        if ki.info.fp_type:
            ki_lib += KI_FP_TYPE.format(
                component_type=("smd" if ki.info.fp_type == "smd" else "through_hole")
            )

        # Get y_min and y_max to put component info
        y_low = min(pad.pos_y for pad in ki.pads)
        y_high = max(pad.pos_y for pad in ki.pads)

        ki_lib += KI_REFERENCE.format(pos_x="0", pos_y=y_low - 4)

        ki_lib += KI_PACKAGE_VALUE.format(
            package_name=ki.info.name, pos_x="0", pos_y=y_high + 4
        )
        ki_lib += KI_FAB_REF

        # ---------------------------------------

        for track in ki.tracks + ki.rectangles:
            for i in range(len(track.points_start_x)):
                ki_lib += KI_LINE.format(
                    start_x=track.points_start_x[i],
                    start_y=track.points_start_y[i],
                    end_x=track.points_end_x[i],
                    end_y=track.points_end_y[i],
                    layers=track.layers,
                    stroke_width=track.stroke_width,
                )

        for pad in ki.pads:
            rr_s = ""
            chamfer_s = ""
            if pad.shape == "roundrect":
                rrv = max(0.0, min(1.0, float(pad.roundrect_rratio or 0.0)))
                if rrv > 0:
                    rr_s = f" (roundrect_rratio {rrv:.4f})"
            elif pad.shape == "chamfrect":
                tl = max(0.0, min(1.0, float(pad.chamfer_tl or 0.0)))
                tr = max(0.0, min(1.0, float(pad.chamfer_tr or 0.0)))
                br = max(0.0, min(1.0, float(pad.chamfer_br or 0.0)))
                bl = max(0.0, min(1.0, float(pad.chamfer_bl or 0.0)))
                if tl + tr + br + bl > 1e-9:
                    chamfer_s = f" (chamfer {tl:.4f} {tr:.4f} {br:.4f} {bl:.4f})"
            ki_lib += KI_PAD.format(
                number=pad.number,
                type=pad.type,
                shape=pad.shape,
                pos_x=pad.pos_x,
                pos_y=pad.pos_y,
                orientation=pad.orientation,
                width=pad.width,
                height=pad.height,
                roundrect=rr_s,
                chamfer=chamfer_s,
                layers=pad.layers,
                drill=pad.drill or "",
                polygon=pad.polygon or "",
            )

        for hole in ki.holes:
            ki_lib += KI_HOLE.format(**vars(hole))

        for via in ki.vias:
            ki_lib += KI_VIA.format(**vars(via))

        for circle in ki.circles:
            ki_lib += KI_CIRCLE.format(**vars(circle))

        for arc in ki.arcs:
            ki_lib += KI_ARC.format(**vars(arc))

        for text in ki.texts:
            ki_lib += KI_TEXT.format(**vars(text))

        if ki.model_3d is not None:
            model_base_name = sanitize_model_filename(ki.model_3d.name)
            model_path = (model_3d_path or "").strip()
            if model_3d_path_is_explicit:
                trimmed = model_path.rstrip("/\\")
                file_3d = f"{trimmed}/{model_base_name}.wrl"
            else:
                model_path = model_path.replace("\\", "/").rstrip("/")
            if not model_3d_path_is_explicit and "${KIPRJMOD}" in model_path:
                cleaned = model_path.replace("..${KIPRJMOD}", "${KIPRJMOD}")
                file_3d = f"{cleaned}/{model_base_name}.wrl"
            elif not model_3d_path_is_explicit and model_path.startswith("${"):
                file_3d = f"{model_path}/{model_base_name}.wrl"
            elif not model_3d_path_is_explicit:
                file_3d = f"..{model_path}/{model_base_name}.wrl"
            ki_lib += KI_MODEL_3D.format(
                file_3d=file_3d,
                pos_x=ki.model_3d.translation.x,
                pos_y=ki.model_3d.translation.y,
                pos_z=ki.model_3d.translation.z,
                rot_x=ki.model_3d.rotation.x,
                rot_y=ki.model_3d.rotation.y,
                rot_z=ki.model_3d.rotation.z,
            )

        ki_lib += KI_END_FILE

        with open(
            file=footprint_full_path,
            mode="w",
            encoding="utf-8",
        ) as my_lib:
            my_lib.write(ki_lib)
