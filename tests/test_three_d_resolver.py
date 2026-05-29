"""Tests for the V3 3D Layer resolver (Issue #6, ADR-0005).

Walks every acceptance-criteria case from the issue:

1. **Footprint=EasyEDA + EasyEDA has 3D** — covered by the existing default
   pipeline tests (``test_native_host_phase2.py`` flips
   ``generate_model=True`` once Issue #6 lands). Not a resolver concern.
2. **Footprint=Template + Template-FP has 3D-Ref to Template-internal path**
   → file is carried over to ``<ActiveLib>.3dshapes/`` and the reference is
   rewritten to ``${KIPRJMOD}/<ActiveLib>.3dshapes/<basename>``.
3. **Footprint=Template, two FPs share the same 3D file** → the file lands in
   ``<ActiveLib>.3dshapes/`` exactly once (content-hash dedup) and both
   rewritten ``.kicad_mod`` files reference the same path.
4. **Footprint=Template + System-Variable-Ref** (e.g. ``${KICAD9_3DMODEL_DIR}``)
   → reference passes through unchanged, no file copy.
5. **Footprint=Template without 3D-Ref** → resolver reports ``had_refs=False``
   so the caller can fall back to EasyEDA-3D.
6. **No 3D source at all** → resolver still reports ``had_refs=False``; the
   caller writes the footprint without a model ref (handled by Phase 2, not
   the resolver itself).

Plus the **hash-collision** safeguard from the issue: same basename, different
bytes → :class:`ThreeDResolutionError`, no silent overwrite.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from easyeda2kicad.kicad.three_d_resolver import (
    CarryOverOp,
    ThreeDResolutionError,
    execute_carry_overs,
    is_system_variable_ref,
    parse_model_refs,
    resolve_template_three_d,
)


# ---------------------------------------------------------------------------
# Test fixtures — minimal Template-Library on disk
# ---------------------------------------------------------------------------


def _make_template_lib(tmp_path: Path, lib_name: str = "MyTemplates") -> Path:
    """Lay out a tmp Template Library with .pretty + .3dshapes sub-dirs."""
    root = tmp_path / lib_name
    (root / f"{lib_name}.pretty").mkdir(parents=True)
    (root / f"{lib_name}.3dshapes").mkdir(parents=True)
    return root


def _make_active_lib(tmp_path: Path, lib_name: str = "MyLib") -> Path:
    """The active library scaffold lives in its own dir next to the templates."""
    root = tmp_path / "active"
    root.mkdir()
    return root


def _kicad_mod_with_models(*paths: str) -> str:
    """Stitch a minimal .kicad_mod skeleton with one (model …) per path."""
    refs = "\n".join(
        f'\t(model "{p}"\n'
        f"\t\t(offset (xyz 0 0 0))\n"
        f"\t\t(scale (xyz 1 1 1))\n"
        f"\t\t(rotate (xyz 0 0 0))\n"
        f"\t)"
        for p in paths
    )
    return (
        '(footprint "Demo" (version 20211014)\n'
        '\t(layer "F.Cu")\n'
        f"{refs}\n"
        ")"
    )


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------


def test_parse_model_refs_returns_all_in_source_order() -> None:
    text = _kicad_mod_with_models("a.step", "b.wrl", "c.step")
    assert parse_model_refs(text) == ["a.step", "b.wrl", "c.step"]


def test_parse_model_refs_on_kicad_mod_without_models() -> None:
    text = '(footprint "Demo" (version 20211014)\n\t(layer "F.Cu")\n)'
    assert parse_model_refs(text) == []


@pytest.mark.parametrize(
    "ref",
    [
        "${KICAD9_3DMODEL_DIR}/Resistor_SMD/R_0603.step",
        "${KICAD8_3DMODEL_DIR}/foo.wrl",
        "${KICAD7_3DMODEL_DIR}/bar.step",
        "${KICAD6_3DMODEL_DIR}/baz.step",
        "${KISYS3DMOD}/legacy.wrl",
    ],
)
def test_is_system_variable_ref_true_for_kicad_prefixes(ref: str) -> None:
    assert is_system_variable_ref(ref) is True


@pytest.mark.parametrize(
    "ref",
    [
        "${KIPRJMOD}/MyTemplates.3dshapes/foo.step",
        "MyTemplates.3dshapes/foo.step",
        "/absolute/path/to/foo.step",
        "${SOMETHING_ELSE}/foo.step",
    ],
)
def test_is_system_variable_ref_false_otherwise(ref: str) -> None:
    assert is_system_variable_ref(ref) is False


# ---------------------------------------------------------------------------
# Case 2 — Template-internal 3D ref → carry-over + rewrite
# ---------------------------------------------------------------------------


def test_case2_template_internal_ref_is_carried_over(tmp_path: Path) -> None:
    template_root = _make_template_lib(tmp_path)
    step_src = template_root / "MyTemplates.3dshapes" / "DEMO.step"
    step_src.write_bytes(b"FAKE-STEP-BYTES")

    text = _kicad_mod_with_models("${KIPRJMOD}/MyTemplates.3dshapes/DEMO.step")
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )

    assert res.had_refs
    assert len(res.refs) == 1
    ref = res.refs[0]
    assert ref.note == "template_internal"
    assert ref.rewritten == "${KIPRJMOD}/MyLib.3dshapes/DEMO.step"
    assert ref.carry_over is not None
    assert ref.carry_over.source == step_src
    assert ref.carry_over.destination == Path("MyLib.3dshapes/DEMO.step")
    assert (
        ref.carry_over.sha256
        == hashlib.sha256(b"FAKE-STEP-BYTES").hexdigest()
    )
    assert '(model "${KIPRJMOD}/MyLib.3dshapes/DEMO.step"' in res.rewritten_kicad_mod
    assert "DEMO.step" not in res.rewritten_kicad_mod.replace(
        "MyLib.3dshapes/DEMO.step", ""
    )


def test_case2_executes_carry_over_into_active_lib_dir(tmp_path: Path) -> None:
    template_root = _make_template_lib(tmp_path)
    step_src = template_root / "MyTemplates.3dshapes" / "DEMO.step"
    step_src.write_bytes(b"FAKE-STEP-BYTES")
    active_root = _make_active_lib(tmp_path)

    text = _kicad_mod_with_models("${KIPRJMOD}/MyTemplates.3dshapes/DEMO.step")
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )
    written = execute_carry_overs(res.carry_overs, active_lib_parent_dir=active_root)

    assert written == [active_root / "MyLib.3dshapes" / "DEMO.step"]
    assert (active_root / "MyLib.3dshapes" / "DEMO.step").read_bytes() == b"FAKE-STEP-BYTES"


def test_case2_template_internal_plain_relative_path(tmp_path: Path) -> None:
    """A relative ``MyTemplates.3dshapes/DEMO.step`` (no ``${KIPRJMOD}``) is
    also valid and must resolve against the Template Library root."""
    template_root = _make_template_lib(tmp_path)
    step_src = template_root / "MyTemplates.3dshapes" / "DEMO.step"
    step_src.write_bytes(b"BYTES")

    text = _kicad_mod_with_models("MyTemplates.3dshapes/DEMO.step")
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )
    assert res.refs[0].note == "template_internal"
    assert res.refs[0].rewritten == "${KIPRJMOD}/MyLib.3dshapes/DEMO.step"


# ---------------------------------------------------------------------------
# Case 3 — two Template Footprints share the same 3D file → dedup
# ---------------------------------------------------------------------------


def test_case3_shared_three_d_file_lands_once_via_content_hash_dedup(tmp_path: Path) -> None:
    template_root = _make_template_lib(tmp_path)
    step_src = template_root / "MyTemplates.3dshapes" / "SHARED.step"
    step_src.write_bytes(b"SHARED-BYTES")
    active_root = _make_active_lib(tmp_path)

    text_a = _kicad_mod_with_models("${KIPRJMOD}/MyTemplates.3dshapes/SHARED.step")
    text_b = _kicad_mod_with_models("${KIPRJMOD}/MyTemplates.3dshapes/SHARED.step")

    res_a = resolve_template_three_d(
        text_a, template_lib_root=template_root, active_lib_name="MyLib"
    )
    written_a = execute_carry_overs(
        res_a.carry_overs, active_lib_parent_dir=active_root
    )

    res_b = resolve_template_three_d(
        text_b, template_lib_root=template_root, active_lib_name="MyLib"
    )
    written_b = execute_carry_overs(
        res_b.carry_overs, active_lib_parent_dir=active_root
    )

    # First import writes it, second hash-matches and skips.
    assert written_a == [active_root / "MyLib.3dshapes" / "SHARED.step"]
    assert written_b == []
    assert (active_root / "MyLib.3dshapes" / "SHARED.step").read_bytes() == b"SHARED-BYTES"

    # Both rewritten footprints reference the same active-lib path.
    target = "${KIPRJMOD}/MyLib.3dshapes/SHARED.step"
    assert target in res_a.rewritten_kicad_mod
    assert target in res_b.rewritten_kicad_mod


# ---------------------------------------------------------------------------
# Case 4 — system-variable references pass through verbatim
# ---------------------------------------------------------------------------


def test_case4_system_variable_ref_passes_through_no_copy(tmp_path: Path) -> None:
    template_root = _make_template_lib(tmp_path)
    active_root = _make_active_lib(tmp_path)

    text = _kicad_mod_with_models(
        "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"
    )
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )

    assert res.had_refs
    assert len(res.refs) == 1
    assert res.refs[0].note == "system_var"
    assert res.refs[0].rewritten == res.refs[0].original
    assert res.carry_overs == []
    written = execute_carry_overs(res.carry_overs, active_lib_parent_dir=active_root)
    assert written == []
    # The rewritten footprint still carries the original verbatim reference.
    assert (
        '(model "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"'
        in res.rewritten_kicad_mod
    )
    # No file was written under the active lib.
    assert not (active_root / "MyLib.3dshapes").exists() or not any(
        (active_root / "MyLib.3dshapes").iterdir()
    )


def test_case4_absolute_path_outside_template_lib_passes_through(tmp_path: Path) -> None:
    """ADR-0005 covers system-variable refs *or* any absolute path outside
    the Template Library. Both classes share the pass-through branch."""
    template_root = _make_template_lib(tmp_path)
    outside = tmp_path / "outside" / "FOREIGN.step"
    outside.parent.mkdir()
    outside.write_bytes(b"FOREIGN")

    text = _kicad_mod_with_models(str(outside))
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )
    assert res.refs[0].note == "absolute_external"
    assert res.refs[0].carry_over is None
    assert res.refs[0].rewritten == str(outside)


# ---------------------------------------------------------------------------
# Case 5 & 6 — Template-FP without (model …) → caller falls back
# ---------------------------------------------------------------------------


def test_case5_template_without_model_ref_signals_no_refs(tmp_path: Path) -> None:
    """No ``(model …)`` in the Template ``.kicad_mod`` → :attr:`had_refs` is
    ``False``. Phase 2 sees that and either downloads EasyEDA-3D as a
    fallback (case 5) or writes the footprint without a model ref (case 6).
    """
    template_root = _make_template_lib(tmp_path)
    text = '(footprint "Demo" (version 20211014)\n\t(layer "F.Cu")\n)'
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )
    assert res.had_refs is False
    assert res.refs == []
    assert res.carry_overs == []
    # rewritten == input — nothing to rewrite when there are no refs.
    assert res.rewritten_kicad_mod == text


# ---------------------------------------------------------------------------
# Hash-collision safeguard
# ---------------------------------------------------------------------------


def test_hash_collision_same_basename_different_bytes_raises(tmp_path: Path) -> None:
    template_root = _make_template_lib(tmp_path)
    step_src = template_root / "MyTemplates.3dshapes" / "DEMO.step"
    step_src.write_bytes(b"NEW-BYTES")
    active_root = _make_active_lib(tmp_path)

    # Pre-seed a different file under the active lib's .3dshapes — simulates
    # an earlier import of a different Template that happened to use the same
    # basename.
    (active_root / "MyLib.3dshapes").mkdir()
    (active_root / "MyLib.3dshapes" / "DEMO.step").write_bytes(b"OLD-BYTES")

    text = _kicad_mod_with_models("${KIPRJMOD}/MyTemplates.3dshapes/DEMO.step")
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )

    with pytest.raises(ThreeDResolutionError) as exc:
        execute_carry_overs(res.carry_overs, active_lib_parent_dir=active_root)
    msg = str(exc.value)
    assert "collision" in msg.lower()
    assert "DEMO.step" in msg


# ---------------------------------------------------------------------------
# Multi-model footprint (issue notes "alle behandeln, nicht nur die erste")
# ---------------------------------------------------------------------------


def test_multiple_model_refs_per_footprint_all_resolve(tmp_path: Path) -> None:
    template_root = _make_template_lib(tmp_path)
    body = template_root / "MyTemplates.3dshapes" / "BODY.step"
    body.write_bytes(b"BODY")
    marker = template_root / "MyTemplates.3dshapes" / "MARKER.wrl"
    marker.write_bytes(b"MARKER")

    text = _kicad_mod_with_models(
        "${KIPRJMOD}/MyTemplates.3dshapes/BODY.step",
        "${KICAD9_3DMODEL_DIR}/some/global.step",
        "${KIPRJMOD}/MyTemplates.3dshapes/MARKER.wrl",
    )
    res = resolve_template_three_d(
        text,
        template_lib_root=template_root,
        active_lib_name="MyLib",
    )
    assert [r.note for r in res.refs] == [
        "template_internal",
        "system_var",
        "template_internal",
    ]
    assert len(res.carry_overs) == 2
    # All three refs survive in the rewritten output: two rewritten, one as-is.
    assert "${KIPRJMOD}/MyLib.3dshapes/BODY.step" in res.rewritten_kicad_mod
    assert "${KIPRJMOD}/MyLib.3dshapes/MARKER.wrl" in res.rewritten_kicad_mod
    assert (
        "${KICAD9_3DMODEL_DIR}/some/global.step" in res.rewritten_kicad_mod
    )


def test_carry_over_op_is_hashable_dataclass(tmp_path: Path) -> None:
    """Frozen dataclass keeps callers safe — Phase 2 can stash carry-overs
    in a set when deduping refs across multi-footprint imports."""
    op = CarryOverOp(
        source=Path("/tmp/a.step"),
        destination=Path("MyLib.3dshapes/a.step"),
        sha256="deadbeef",
    )
    assert {op, op} == {op}
