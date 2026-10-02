"""Eli's lines for the trailer, with the same Piper voice and phoneme alignments the app uses."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
from voice import PiperTTS  # noqa: E402

LINES = {
    "hi": "Oh. Hi!",
    "eli": "I'm Eli. I live on your Mac.",
    "sing": "Wanna hear me sing?",
    "night": "Good night.",
}

tts = PiperTTS(ROOT / "voices" / "en_US-kristin-medium.onnx")
out = Path(__file__).resolve().parents[1] / "public" / "voice"
for key, text in LINES.items():
    wav, phonemes = tts.synth(text)
    (out / f"{key}.wav").write_bytes(wav)
    (out / f"{key}.json").write_text(json.dumps(phonemes))
    print(key, len(wav), len(phonemes or []))
