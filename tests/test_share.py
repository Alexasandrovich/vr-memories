import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from share_memory import byte_range


class DownloadRangeTests(unittest.TestCase):
    def test_resumed_and_suffix_download(self):
        self.assertEqual(byte_range("bytes=40-", 100), (40, 99, 206))
        self.assertEqual(byte_range("bytes=-10", 100), (90, 99, 206))
        self.assertEqual(byte_range("bytes=0-500", 100), (0, 99, 206))
        self.assertEqual(byte_range(None, 100), (0, 99, 200))

    def test_invalid_ranges_rejected(self):
        for value in ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=0-4,10-20", "bytes=-"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                byte_range(value, 100)


if __name__ == "__main__":
    unittest.main()
