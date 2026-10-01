"""La mémoire : la conversation survit au redémarrage, le carnet ne retient que des faits, et s'efface."""
import tempfile
import unittest
from pathlib import Path

from memory import Memory


class MemoryTest(unittest.TestCase):
    def test_survives_restart_digests_and_forgets(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, seen = Path(tmp), []

            def digest(messages):
                seen.append(messages[-1]["content"])
                return "Voici le carnet :\n- Sam a un chat, Pixel.\nblabla"

            mem = Memory(folder, digest, idle=3600)
            mem.add("J'ai un chat qui s'appelle Pixel", "Joli nom !")
            mem.timer.cancel()
            again = Memory(folder, digest, idle=3600)  # redémarrage
            again.timer.cancel()
            self.assertEqual(again.recent()[0]["content"], "J'ai un chat qui s'appelle Pixel")
            again.consolidate()
            self.assertIn("Humain : J'ai un chat", seen[0])
            self.assertEqual(again.notes(), "- Sam a un chat, Pixel.")
            self.assertEqual(again.pending, [])
            self.assertIn("- Sam a un chat, Pixel.", again.system_prompt("Tu es Eli."))
            again.forget(everything=True)
            self.assertEqual((again.notes(), again.recent()), ("", []))


if __name__ == "__main__":
    unittest.main()
