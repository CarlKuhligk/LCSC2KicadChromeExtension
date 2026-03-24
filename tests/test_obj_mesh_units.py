"""3D metadata parsing tolerates sparse EasyEDA attrs."""

from easyeda2kicad.easyeda.easyeda_importer import Easyeda3dModelImporter


def test_parse_3d_model_info_tolerates_sparse_attrs():
    imp = Easyeda3dModelImporter.__new__(Easyeda3dModelImporter)
    m = Easyeda3dModelImporter.parse_3d_model_info(
        imp,
        {"title": "n", "uuid": "id", "c_origin": "1,2", "z": "0.5", "c_rotation": "90"},
    )
    assert m.name == "n"
    assert m.uuid == "id"
    assert m.translation.x == 1.0
    assert m.translation.y == 2.0
    assert m.translation.z == 0.5
    assert m.rotation.x == 90.0
    assert m.rotation.y == 0.0
    assert m.rotation.z == 0.0
