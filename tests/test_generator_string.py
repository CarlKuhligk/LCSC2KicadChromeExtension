"""The exported files must credit THIS project, not the uPesy upstream.

``helpers.py`` and the kicad exporters are shared with the upstream
(``uPesy/easyeda2kicad.py``); an upstream merge could silently reintroduce the
upstream generator / attribution strings. These guards fail loudly if that
regresses — the generator credit is part of the project's licensing posture
(footprints/3D are derived from EasyEDA → own generator string, not upstream's).
"""

from pathlib import Path

from easyeda2kicad.helpers import add_component_in_symbol_lib_file
from easyeda2kicad.kicad.export_kicad_3d_model import VRML_HEADER
from easyeda2kicad.kicad.parameters_kicad_footprint import KI_DESCRIPTION

OWN = "theautomatist/KiCad-Parts-Importer"


def test_symbol_lib_generator_is_own_not_upstream(tmp_path: Path) -> None:
    lib = tmp_path / "Lib.kicad_sym"
    lib.write_text(
        "(kicad_symbol_lib (version 20240618) (generator kicad_symbol_editor)\n)\n",
        encoding="utf-8",
    )
    add_component_in_symbol_lib_file(str(lib), '(symbol "New")')
    out = lib.read_text(encoding="utf-8")
    assert OWN in out
    assert "uPesy" not in out
    assert "easyeda2kicad.py" not in out


def test_3d_and_footprint_attribution_is_own_not_upstream() -> None:
    assert OWN in VRML_HEADER
    assert "uPesy" not in VRML_HEADER
    assert "easyeda2kicad.py" not in VRML_HEADER
    assert "kicad-parts-importer" in KI_DESCRIPTION
    assert "easyeda2kicad.py" not in KI_DESCRIPTION
