"""Renders each Piper voice saying its hello, so the onboarding plays it before any download.

    .venv/bin/python server/make_samples.py /tmp/models    (run from the repo; re-run when PIPER changes)

Writes web/samples/<id>.m4a and web/samples/samples.json (the text and each clip's phonemes, for the lips).
Models already in ~/Library/Application Support/Eli/voices are reused; the others go to the given folder, one at a time.
"""
import json, subprocess, sys, tempfile, urllib.request
from pathlib import Path
sys.path.insert(0, "server")
import voice
TEXT = {"fr": "Salut ! Moi c’est Eli. Elle te plaît, cette voix ?", "en": "Hi! I’m Eli. Do you like this voice?"}
mine = Path.home() / "Library/Application Support/Eli/voices"   # read only
tmp = Path(sys.argv[1]); out = Path("web/samples"); out.mkdir(exist_ok=True)
phon = {}
for vid, (lang, label, remote, speaker) in voice.PIPER.items():
    name = remote.rsplit("/", 1)[1]
    model = mine / f"{name}.onnx"
    if not model.exists():
        model = tmp / f"{name}.onnx"
        for suffix in (".onnx.json", ".onnx"):
            if not (tmp / (name + suffix)).exists():
                urllib.request.urlretrieve(f"{voice.HF}/{remote}{suffix}", tmp / (name + suffix))
    wav, ph = voice.PiperTTS(model, speaker).synth(TEXT[lang])
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        f.write(wav); f.flush()
        subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "40000", f.name, str(out / f"{vid}.m4a")], check=True)
    phon[vid] = ph
    # done with this model unless the next voice shares it (upmc: jessica, pierre)
    if model.parent == tmp and not any(r == remote for v, (_, _, r, _) in voice.PIPER.items() if list(voice.PIPER).index(v) > list(voice.PIPER).index(vid)):
        for p in tmp.glob(name + "*"): p.unlink()
    print(vid, (out / f"{vid}.m4a").stat().st_size, flush=True)
(out / "samples.json").write_text(json.dumps({"text": TEXT, "phonemes": phon}, ensure_ascii=False, separators=(",", ":")))
