"""Engine tests for the **footprint-template** carry-over (Issue #9).

Covers the pure-filesystem helpers added to
``easyeda2kicad.service.conversion`` for the footprint slice — copying a
user-curated ``.kicad_mod`` from a template ``.pretty`` into the target
library, and repointing a symbol's Footprint property at the chosen
template footprint. No network / no EasyEDA API is touched here (the full
``run_conversion`` path stays covered indirectly via the phase2 stub-runner
suite); these exercise the engine primitives directly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from easyeda2kicad.service.conversion import (
    ConversionError,
    ConversionRequest,
    _apply_footprint_template_ref,
    _export_footprint_from_template,
    _resolve_template_footprint_file,
)

# A minimal but realistic template footprint: two SMD pads + a 3D model ref so
# the carry-over ("3D follows the Footprint", #6) is observable.
_TEMPLATE_MOD = """(footprint "stale_internal_name" (layer "F.Cu")
  (pad "1" smd roundrect (at -0.5 0) (size 0.6 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd roundrect (at 0.5 0) (size 0.6 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
  (model "${KIPRJMOD}/3d/R0603.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
"""


def _make_request(
    tmp_path: Path,
    *,
    name: str = "R0603_Custom",
    lib_path: str | None = None,
    overwrite: bool = True,
    force: bool = False,
) -> ConversionRequest:
    return ConversionRequest(
        lcsc_id="C22548",
        output_prefix=str(tmp_path / "MyLib"),
        overwrite=overwrite,
        generate_footprint=True,
        use_footprint_template=True,
        footprint_template_name=name,
        footprint_template_lib_path=lib_path,
        force_footprint_template=force,
    )


def _make_template_pretty(tmp_path: Path, name: str = "R0603_Custom") -> Path:
    pretty = tmp_path / "Templates.pretty"
    pretty.mkdir()
    (pretty / f"{name}.kicad_mod").write_text(_TEMPLATE_MOD, encoding="utf-8")
    return pretty


# ---------------------------------------------------------------------------
# _resolve_template_footprint_file
# ---------------------------------------------------------------------------


def test_resolve_from_pretty_dir(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    found = _resolve_template_footprint_file(str(pretty), "R0603_Custom")
    assert found is not None
    assert found.name == "R0603_Custom.kicad_mod"


def test_resolve_from_direct_kicad_mod_path(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    direct = pretty / "R0603_Custom.kicad_mod"
    found = _resolve_template_footprint_file(str(direct), "ignored_name")
    assert found == direct


def test_resolve_from_kicad_sym_resolves_sibling_pretty(tmp_path: Path) -> None:
    """A template library is identified by its ``.kicad_sym``; the footprint
    layer is the sibling ``Foo.pretty/`` — same identifier across both layers."""
    # Sibling layout: Templates.kicad_sym + Templates.pretty/<name>.kicad_mod
    pretty = tmp_path / "Templates.pretty"
    pretty.mkdir()
    (pretty / "R0603_Custom.kicad_mod").write_text(_TEMPLATE_MOD, encoding="utf-8")
    sym = tmp_path / "Templates.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n", encoding="utf-8")

    found = _resolve_template_footprint_file(str(sym), "R0603_Custom")
    assert found == pretty / "R0603_Custom.kicad_mod"


def test_resolve_missing_returns_none(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    assert _resolve_template_footprint_file(str(pretty), "DoesNotExist") is None


# ---------------------------------------------------------------------------
# _export_footprint_from_template
# ---------------------------------------------------------------------------


def test_copies_template_into_target_pretty(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    request = _make_request(tmp_path, lib_path=str(pretty))

    written = _export_footprint_from_template(request, str(fp_dir))

    assert written == str(fp_dir / "R0603_Custom.kicad_mod")
    assert Path(written).is_file()


def test_preserves_3d_model_reference(tmp_path: Path) -> None:
    """Carry-over: the template footprint's own 3D model ref rides along."""
    pretty = _make_template_pretty(tmp_path)
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    request = _make_request(tmp_path, lib_path=str(pretty))

    written = _export_footprint_from_template(request, str(fp_dir))

    content = Path(written).read_text(encoding="utf-8")
    assert "${KIPRJMOD}/3d/R0603.step" in content


def test_carries_3d_model_into_target_and_repoints_ref(tmp_path: Path) -> None:
    """Part B: with a target context, the template's referenced 3D model is
    copied into the target library's ``.3dshapes`` and the ``(model …)`` ref is
    repointed there — so the imported library is self-contained."""
    pretty = tmp_path / "Templates.pretty"
    pretty.mkdir()
    mod = (
        '(footprint "x" (layer "F.Cu")\n'
        '  (pad "1" smd roundrect (at 0 0) (size 0.6 0.6) (layers "F.Cu"))\n'
        '  (model "${KIPRJMOD}/../library/templates/Templates.3dshapes/R0603.wrl"'
        " (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))\n"
        ")\n"
    )
    (pretty / "R0603_Custom.kicad_mod").write_text(mod, encoding="utf-8")
    (tmp_path / "Templates.kicad_sym").write_text("(kicad_symbol_lib)\n", encoding="utf-8")
    tpl_shapes = tmp_path / "Templates.3dshapes"
    tpl_shapes.mkdir()
    (tpl_shapes / "R0603.wrl").write_text("wrl", encoding="utf-8")
    (tpl_shapes / "R0603.step").write_text("step", encoding="utf-8")

    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    model_dir = tmp_path / "MyLib.3dshapes"
    request = _make_request(tmp_path, lib_path=str(tmp_path / "Templates.kicad_sym"))

    written = _export_footprint_from_template(
        request, str(fp_dir), model_dir=str(model_dir), output_path=tmp_path / "MyLib"
    )

    # 3D files copied into the TARGET library's .3dshapes …
    assert (model_dir / "R0603.wrl").is_file()
    assert (model_dir / "R0603.step").is_file()
    # … and the ref repointed there, away from the template's own path.
    content = Path(written).read_text(encoding="utf-8")
    assert "MyLib.3dshapes/R0603.wrl" in content
    assert "Templates.3dshapes" not in content


def test_no_3d_carry_when_model_file_missing(tmp_path: Path) -> None:
    """If the referenced 3D file isn't beside the template, the ref rides along
    verbatim (no copy, no rewrite) — the prior carry-over behavior."""
    pretty = tmp_path / "Templates.pretty"
    pretty.mkdir()
    (pretty / "R0603_Custom.kicad_mod").write_text(_TEMPLATE_MOD, encoding="utf-8")
    (tmp_path / "Templates.kicad_sym").write_text("(kicad_symbol_lib)\n", encoding="utf-8")
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    request = _make_request(tmp_path, lib_path=str(tmp_path / "Templates.kicad_sym"))

    written = _export_footprint_from_template(
        request,
        str(fp_dir),
        model_dir=str(tmp_path / "MyLib.3dshapes"),
        output_path=tmp_path / "MyLib",
    )

    content = Path(written).read_text(encoding="utf-8")
    # _TEMPLATE_MOD references ${KIPRJMOD}/3d/R0603.step, which has no file beside
    # the template (no Templates.3dshapes) → unchanged, nothing copied.
    assert "${KIPRJMOD}/3d/R0603.step" in content
    assert not (tmp_path / "MyLib.3dshapes" / "R0603.step").exists()


def test_rewrites_identity_to_destination_name(tmp_path: Path) -> None:
    """The embedded ``(footprint "…")`` token is synced to the file stem so
    KiCad never sees a stem ↔ identity mismatch."""
    pretty = _make_template_pretty(tmp_path)
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    request = _make_request(tmp_path, lib_path=str(pretty))

    written = _export_footprint_from_template(request, str(fp_dir))

    content = Path(written).read_text(encoding="utf-8")
    assert '(footprint "R0603_Custom"' in content
    assert "stale_internal_name" not in content


def test_accepts_direct_kicad_mod_lib_path(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    direct = pretty / "R0603_Custom.kicad_mod"
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    request = _make_request(tmp_path, lib_path=str(direct))

    written = _export_footprint_from_template(request, str(fp_dir))

    assert Path(written).is_file()
    assert Path(written).name == "R0603_Custom.kicad_mod"


def test_missing_template_returns_none(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    request = _make_request(tmp_path, name="NotThere", lib_path=str(pretty))

    assert _export_footprint_from_template(request, str(fp_dir)) is None


def test_blank_name_or_lib_returns_none(tmp_path: Path) -> None:
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    no_lib = _make_request(tmp_path, lib_path=None)
    assert _export_footprint_from_template(no_lib, str(fp_dir)) is None


def test_existing_dest_not_overwritten_when_overwrite_false(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    dest = fp_dir / "R0603_Custom.kicad_mod"
    dest.write_text("(footprint \"PRIOR\")\n", encoding="utf-8")
    request = _make_request(tmp_path, lib_path=str(pretty), overwrite=False)

    written = _export_footprint_from_template(request, str(fp_dir))

    assert written == str(dest)
    # Untouched — the prior content stays put.
    assert dest.read_text(encoding="utf-8") == "(footprint \"PRIOR\")\n"


def test_existing_dest_overwritten_when_overwrite_true(tmp_path: Path) -> None:
    pretty = _make_template_pretty(tmp_path)
    fp_dir = tmp_path / "MyLib.pretty"
    fp_dir.mkdir()
    dest = fp_dir / "R0603_Custom.kicad_mod"
    dest.write_text("(footprint \"PRIOR\")\n", encoding="utf-8")
    request = _make_request(tmp_path, lib_path=str(pretty), overwrite=True)

    _export_footprint_from_template(request, str(fp_dir))

    content = dest.read_text(encoding="utf-8")
    assert "PRIOR" not in content
    assert '(footprint "R0603_Custom"' in content


# ---------------------------------------------------------------------------
# _apply_footprint_template_ref — symbol Footprint property repoint
# ---------------------------------------------------------------------------


class _FakeInfo:
    def __init__(self) -> None:
        self.package = "EasyEDA_R0603"


class _FakeOutput:
    def __init__(self) -> None:
        self.info = _FakeInfo()


class _FakeExporter:
    def __init__(self) -> None:
        self.output = _FakeOutput()


def test_apply_ref_sets_bare_package_name(tmp_path: Path) -> None:
    """Sets the bare name; export() then prepends the lib nickname."""
    exporter = _FakeExporter()
    request = _make_request(tmp_path, lib_path="x")
    _apply_footprint_template_ref(exporter, request)
    assert exporter.output.info.package == "R0603_Custom"


def test_apply_ref_noop_without_footprint_template(tmp_path: Path) -> None:
    exporter = _FakeExporter()
    request = ConversionRequest(
        lcsc_id="C1",
        output_prefix=str(tmp_path / "MyLib"),
        generate_symbol=True,
        use_footprint_template=False,
    )
    _apply_footprint_template_ref(exporter, request)
    assert exporter.output.info.package == "EasyEDA_R0603"


def test_apply_ref_tolerates_missing_output() -> None:
    """A degenerate exporter (no .output / .info) must not crash."""

    class _Bare:
        output = None

    # Build a minimal valid request with a footprint template.
    request = ConversionRequest(
        lcsc_id="C1",
        output_prefix="MyLib",
        generate_symbol=True,
        use_footprint_template=True,
        footprint_template_name="R0603",
    )
    _apply_footprint_template_ref(_Bare(), request)  # no raise
