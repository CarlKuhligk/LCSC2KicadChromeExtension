"""V3 **3D Layer** resolver — drives the rule "3D follows the Footprint" (ADR-0005).

When the user picks a **Template Footprint**, Phase 2 reads the Template
``.kicad_mod`` and consults this module to resolve every ``(model "...")``
reference. References that resolve **inside the Template Library** trigger a
**Template-3D Carry-Over**: the underlying ``.step`` / ``.wrl`` is copied into
the active library's ``<ActiveLib>.3dshapes/`` (idempotent + deduplicated by
SHA-256 content hash) and the reference is rewritten to
``${KIPRJMOD}/<ActiveLib>.3dshapes/<basename>``. References using a KiCad
system variable (``${KICAD9_3DMODEL_DIR}``, ``${KISYS3DMOD}``, …) or any
absolute path outside the Template Library are passed through verbatim — the
KiCad user is assumed to have these resolvable in their environment.

Resolution is a pure function of the input text plus a few path arguments;
the caller (Phase 2) is responsible for executing the carry-over file ops
returned in :class:`ThreeDResolution`. Splitting analysis from I/O keeps the
unit tests offline and the collision-detection logic deterministic.

EasyEDA fallback (``Footprint = Template`` but the template ``.kicad_mod``
carries no ``(model …)`` reference at all) is the *caller's* responsibility:
:attr:`ThreeDResolution.had_refs` is ``False`` in that case and Phase 2 may
proceed to fetch + append EasyEDA-3D as in V2.

See also:

- ``docs/adr/0005-3d-follows-footprint.md`` — the decision.
- ``V3-SPEC.md §2`` — the four-case resolution order.
- ``CONTEXT.md`` — terms **3D Layer**, **Template-3D Carry-Over**.
"""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional

logger = logging.getLogger(__name__)


# KiCad system-variable prefixes that point to the bundled 3D library or
# similar "owned by the install, not the project" locations. References
# starting with any of these are left verbatim and never trigger a file copy.
SYSTEM_VAR_PREFIXES = (
    "${KICAD6_3DMODEL_DIR}",
    "${KICAD7_3DMODEL_DIR}",
    "${KICAD8_3DMODEL_DIR}",
    "${KICAD9_3DMODEL_DIR}",
    "${KISYS3DMOD}",
)


# ``(model "<path>"`` — the writer in parameters_kicad_footprint.py always
# emits the path quoted, so a single-line regex suffices.
_MODEL_REF_RE = re.compile(r'\(model\s+"([^"]+)"')


class ThreeDResolutionError(RuntimeError):
    """Raised when carry-over would silently overwrite a *different* file.

    Same basename, different content hash → user-actionable: rename the
    Template's 3D asset or curate the active library, but never let the
    importer silently clobber bytes.
    """


@dataclass(frozen=True)
class CarryOverOp:
    """One file the caller must copy into the active library."""

    source: Path
    destination: Path
    sha256: str


@dataclass
class ResolvedRef:
    """One ``(model …)`` reference after resolution.

    ``note`` records *why* the resolver made its choice — handy for diagnostic
    messages (Phase 2 surfaces these as ``progress`` frames).
    """

    original: str
    rewritten: str
    carry_over: Optional[CarryOverOp] = None
    note: str = ""  # 'system_var' | 'absolute_external' | 'template_internal' | 'unresolved'


@dataclass
class ThreeDResolution:
    refs: List[ResolvedRef] = field(default_factory=list)
    rewritten_kicad_mod: str = ""

    @property
    def carry_overs(self) -> List[CarryOverOp]:
        return [r.carry_over for r in self.refs if r.carry_over is not None]

    @property
    def had_refs(self) -> bool:
        """``False`` ⇒ Template Footprint has no 3D references → caller may
        fall back to EasyEDA-3D (or write the footprint with no model)."""
        return bool(self.refs)


def parse_model_refs(kicad_mod_text: str) -> List[str]:
    """Return all ``(model "...")`` path strings in source order.

    Multiple references per footprint are valid KiCad syntax (a SOIC with a
    body model + a separate pin-1 marker, for example), so the resolver
    handles all of them, not just the first.
    """
    return _MODEL_REF_RE.findall(kicad_mod_text)


def is_system_variable_ref(path: str) -> bool:
    return path.startswith(SYSTEM_VAR_PREFIXES)


def _resolve_template_internal_path(
    ref_path: str,
    template_lib_root: Path,
) -> Optional[Path]:
    """If ``ref_path`` points to a file inside the Template Lib, return its
    resolved :class:`Path`; otherwise ``None``.

    The Template was edited in some past KiCad project where ``${KIPRJMOD}``
    pointed at that project's root — but its 3D files are conventionally kept
    next to the ``.pretty`` / ``.kicad_sym`` inside the Template Library
    folder. So at V3 import time we re-interpret ``${KIPRJMOD}`` (and any
    plain relative path) against the Template Library root.

    Recognized forms:

    - ``${KIPRJMOD}/<anything>`` → ``template_lib_root / <anything>``
    - Plain relative ``foo/bar.step`` → resolved against ``template_lib_root``
      (after a ``relative_to`` containment check, so ``../../etc/passwd``
      style escapes are rejected).
    - Absolute path under ``template_lib_root`` → returned as-is.
    """
    p = ref_path.strip()
    root_resolved = template_lib_root.resolve()

    candidate: Optional[Path] = None
    if p.startswith("${KIPRJMOD}"):
        rest = p[len("${KIPRJMOD}"):].lstrip("/\\")
        candidate = (template_lib_root / rest).resolve()
    elif p.startswith("$"):
        # Some other env-var prefix we don't recognise — not template-internal.
        return None
    elif Path(p).is_absolute():
        candidate = Path(p).resolve()
    else:
        candidate = (template_lib_root / p).resolve()

    if candidate is None or not candidate.is_file():
        return None
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        # Resolved outside template_lib_root — treat as external.
        return None
    return candidate


def _content_sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_template_three_d(
    template_kicad_mod_text: str,
    *,
    template_lib_root: Path,
    active_lib_name: str,
) -> ThreeDResolution:
    """Resolve all ``(model …)`` refs in a Template ``.kicad_mod``.

    Args:
        template_kicad_mod_text: Raw contents of the Template footprint file.
        template_lib_root: The Template Library directory (parent of the
            ``.pretty`` folder containing the footprint and the ``.3dshapes``
            folder containing the model files).
        active_lib_name: Used to rewrite carried-over refs to
            ``${KIPRJMOD}/<active_lib_name>.3dshapes/<basename>`` so they
            resolve in the user's *current* KiCad project, not whichever
            project edited the Template.

    Returns:
        A :class:`ThreeDResolution`. The caller writes
        ``rewritten_kicad_mod`` into the active library and feeds
        ``carry_overs`` to :func:`execute_carry_overs`.
    """
    refs = parse_model_refs(template_kicad_mod_text)
    resolved: List[ResolvedRef] = []
    rewritten = template_kicad_mod_text

    for original in refs:
        if is_system_variable_ref(original):
            resolved.append(
                ResolvedRef(original=original, rewritten=original, note="system_var")
            )
            continue

        internal = _resolve_template_internal_path(original, template_lib_root)
        if internal is None:
            note = (
                "absolute_external"
                if Path(original).is_absolute() or original.startswith("$")
                else "unresolved"
            )
            resolved.append(
                ResolvedRef(original=original, rewritten=original, note=note)
            )
            continue

        basename = internal.name
        new_ref = f"${{KIPRJMOD}}/{active_lib_name}.3dshapes/{basename}"
        carry = CarryOverOp(
            source=internal,
            destination=Path(f"{active_lib_name}.3dshapes") / basename,
            sha256=_content_sha256(internal),
        )
        # Replace the exact quoted occurrence once — the regex captures the
        # path inside the same double-quote pair, so substitution can't
        # collide with an unrelated string elsewhere in the file.
        rewritten = rewritten.replace(
            f'(model "{original}"', f'(model "{new_ref}"', 1
        )
        resolved.append(
            ResolvedRef(
                original=original,
                rewritten=new_ref,
                carry_over=carry,
                note="template_internal",
            )
        )

    return ThreeDResolution(refs=resolved, rewritten_kicad_mod=rewritten)


def execute_carry_overs(
    ops: Iterable[CarryOverOp],
    *,
    active_lib_parent_dir: Path,
) -> List[Path]:
    """Run carry-over copies with content-hash dedup + collision detection.

    For each op:

    - Destination missing → ``shutil.copy2`` the source bytes into place.
    - Destination present and SHA-256 matches → skip (dedup; multiple Template
      Footprints sharing one ``.step`` only land in the active library once).
    - Destination present and hash differs → :class:`ThreeDResolutionError`.
      Silently overwriting risks breaking a previously imported footprint
      whose reference still points at the old bytes.

    Args:
        ops: The :attr:`ThreeDResolution.carry_overs` list.
        active_lib_parent_dir: The directory containing
            ``<active_lib_name>.3dshapes/``. Carry-over ``destination`` paths
            are *relative* to this dir (matching how the rewritten reference
            resolves via ``${KIPRJMOD}``).

    Returns:
        The list of files actually written (excludes hash-match skips).
    """
    written: List[Path] = []
    parent = active_lib_parent_dir.resolve()
    for op in ops:
        dest = (parent / op.destination).resolve()
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            existing_hash = _content_sha256(dest)
            if existing_hash == op.sha256:
                logger.info(
                    "3D carry-over: %s already present (hash match), skipping.",
                    dest,
                )
                continue
            raise ThreeDResolutionError(
                f"3D carry-over collision at {dest}: existing file has hash "
                f"{existing_hash} but Template source ({op.source}) has hash "
                f"{op.sha256}. Refusing to overwrite. Rename the Template's "
                f"3D asset or curate the active library before re-importing."
            )
        shutil.copy2(op.source, dest)
        written.append(dest)
    return written
