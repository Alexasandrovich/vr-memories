import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from photo_album import AlbumPairing, PhotoAlbum


class AlbumTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.folder = self.base / "Пейзажи"
        self.folder.mkdir()
        self.album = PhotoAlbum(self.folder, self.base / "outputs")
        self.addCleanup(self.album.worker.shutdown)

    def test_catalog_refresh_and_thumbnail_orientation(self):
        image = Image.new("RGB", (1080, 720))
        exif = Image.Exif()
        exif[274] = 6
        photo = self.folder / "Лето.JPG"
        image.save(photo, exif=exif)
        (self.folder / ".скрытое.jpg").write_bytes(photo.read_bytes())
        (self.base / "private.jpg").write_bytes(photo.read_bytes())
        (self.folder / "link.jpg").symlink_to(self.base / "private.jpg")
        listing = self.album.catalog()["photos"]
        self.assertEqual([p["name"] for p in listing], [photo.name])
        key = listing[0]["id"]
        with Image.open(io.BytesIO(self.album.make_thumbnail(key, self.album.photo(key)))) as thumb:
            self.assertEqual(thumb.size, (320, 480))
        image.save(photo)
        self.assertNotEqual(self.album.catalog()["photos"][0]["id"], key)
        with self.assertRaises(KeyError):
            self.album.select(key)

    def test_repeated_selection_joins_job_and_failed_job_can_retry(self):
        Image.new("RGB", (200, 320)).save(self.folder / "a.jpg")
        key = self.album.catalog()["photos"][0]["id"]
        with patch.object(self.album.worker, "submit") as submit:
            self.assertEqual(self.album.select(key)["state"], "queued")
            self.album.select(key)
            submit.assert_called_once_with(self.album.build, key)
            self.album.update(key, state="error")
            self.album.select(key)
            self.assertEqual(submit.call_count, 2)

    def test_single_use_pairing_survives_restart(self):
        devices = self.base / "devices.json"
        pairing = AlbumPairing(devices)
        code = pairing.local_code()
        self.assertEqual(code, pairing.local_code())
        token = pairing.authorize(code)
        self.assertIsNotNone(token)
        self.assertIsNone(pairing.authorize(code))
        self.assertNotIn(token, devices.read_text())
        self.assertTrue(AlbumPairing(devices).accepts(token))
        self.assertFalse(pairing.accepts("unknown"))
