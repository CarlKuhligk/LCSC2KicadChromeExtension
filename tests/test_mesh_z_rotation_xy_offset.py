from easyeda2kicad.kicad.export_kicad_footprint import (
    mesh_z_rotation_xy_offset_adjustment_mm,
)


def test_c841795_scale_matches_manual_kicad_offset():
    """LCSC C841795: base offset (-1, 0) + adjustment ≈ (4, -2.3)."""
    cx = 0.9055118110236219
    cy = 1.9474748031496065
    dx, dy = mesh_z_rotation_xy_offset_adjustment_mm(cx, cy, 90.0, 270.0)
    assert abs(dx - 4.945) < 0.06
    assert abs(dy + 2.301) < 0.02
    assert abs((-1.0 + dx) - 4.0) < 0.08
    assert abs((0.0 + dy) - (-2.3)) < 0.03


def test_zero_easyeda_z_rotation_no_adjustment():
    assert mesh_z_rotation_xy_offset_adjustment_mm(1.0, 2.0, 0.0, 0.0) == (0.0, 0.0)
    assert mesh_z_rotation_xy_offset_adjustment_mm(1.0, 2.0, 360.0, 0.0) == (0.0, 0.0)
