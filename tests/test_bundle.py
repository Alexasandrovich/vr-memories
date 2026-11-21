import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from scene_bundle import pack_scene, inspect_bundle, MAGIC, MAX_METADATA


class BundleIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "scene.ply").write_bytes(b"ply\noriginal unchanged payload\x00\xff")
        (self.root / "scene.json").write_text(json.dumps({"schema_version":1, "title":"Горы"}))

    def test_roundtrip_and_payload_unchanged(self):
        path = pack_scene(self.root)
        self.assertEqual(inspect_bundle(path)["title"], "Горы")
        raw = path.read_bytes()
        length = struct.unpack("<I", raw[8:12])[0]
        self.assertEqual(raw[12+length:], (self.root / "scene.ply").read_bytes())
        with self.assertRaises(FileExistsError):
            pack_scene(self.root)

    def test_corruption_and_truncation_detected(self):
        path = pack_scene(self.root)
        original = path.read_bytes()
        path.write_bytes(original[:-1])
        with self.assertRaisesRegex(ValueError, "Truncated"):
            inspect_bundle(path)
        path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, "checksum"):
            inspect_bundle(path)

    def test_bad_header_rejected_before_payload(self):
        path = self.root / "invalid.vrmemory"
        path.write_bytes(MAGIC + struct.pack("<I", MAX_METADATA+1))
        with self.assertRaisesRegex(ValueError, "metadata length"):
            inspect_bundle(path)


if __name__ == "__main__":
    unittest.main()
