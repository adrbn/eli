"""Séparation de la voix : le calcul spectral de MDX, et la livraison bloc par bloc."""
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

import mdx
from stems import Stems


class Identity:
    """Un « modèle » qui rend son entrée : la voix sortie doit alors être le mix lui-même."""

    def run(self, _outputs, feeds):
        return [feeds["input"]]


class MdxTest(unittest.TestCase):
    def test_stft_round_trip_rebuilds_the_signal(self):
        t = np.arange(mdx.CHUNK) / mdx.SR
        x = np.stack([np.sin(2 * np.pi * 440 * t), 0.5 * np.sin(2 * np.pi * 220 * t)]).astype(np.float32)
        y = mdx.istft(mdx.stft(x))
        core = slice(mdx.TRIM, -mdx.TRIM)  # les bords n'ont que la moitié de leurs fenêtres
        self.assertLess(np.abs(y[:, core] - x[:, core]).max(), 1e-3)

    def test_blocks_cover_the_whole_song_in_order(self):
        sep = mdx.Separator.__new__(mdx.Separator)
        sep.session = Identity()
        n = int(2.5 * mdx.BLOCK)
        mix = np.full((2, n), 0.25, dtype=np.float32)
        got = list(sep.blocks(mix))
        self.assertEqual([k for k, _, _ in got], [0, 1, 2])
        self.assertEqual(got[0][1], 3)
        voice = np.concatenate([v for _, _, v in got])
        self.assertAlmostEqual(len(voice), n * mdx.OUT_SR / mdx.SR, delta=3)
        self.assertAlmostEqual(float(np.median(voice)), 0.25, places=2)


class FakeSeparator:
    def blocks(self, mix):
        for k in range(3):
            yield k, 3, np.full(1000, 0.1 * (k + 1), dtype=np.float32)


class StemsTest(unittest.TestCase):
    def test_progress_then_cached_voice(self):
        events, done = [], threading.Event()
        with tempfile.TemporaryDirectory() as tmp:
            stems = Stems(FakeSeparator(), "ffmpeg", Path(tmp),
                          on_ready=lambda cid, sha, err: (events.append(("ready", cid, err)), done.set()),
                          on_progress=lambda ids, sha, k, total: events.append(("block", ids, k, total)))
            mdx_decode = mdx.decode
            try:
                import stems as stems_mod
                stems_mod.decode = lambda ffmpeg, src: np.zeros((2, 3000 * mdx.SR // mdx.OUT_SR), dtype=np.float32)
                self.assertFalse(stems.request(Path(tmp) / "a.mp3", "ab" * 32, "c1"))
                self.assertTrue(done.wait(5))
            finally:
                stems_mod.decode = mdx_decode
            self.assertEqual(events, [("block", ["c1"], 1, 3), ("block", ["c1"], 2, 3), ("ready", "c1", None)])
            wav = stems.audio("ab" * 32)
            pcm = np.frombuffer(wav[44:], dtype=np.int16)
            self.assertAlmostEqual(len(pcm), 3000, delta=1)
            self.assertAlmostEqual(pcm[2500] / 32767, 0.3, places=2)
            self.assertTrue(stems.request(Path(tmp) / "a.mp3", "ab" * 32, "c2"))  # en cache : prêt tout de suite


if __name__ == "__main__":
    unittest.main()
