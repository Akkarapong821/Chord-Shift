"""Local six-stem separation; only the requested guitar clip is saved."""
import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("TORCH_HOME", str(ROOT / ".tools" / "guitar-models"))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float)
    args = parser.parse_args()
    import torch
    from demucs.pretrained import get_model
    torch.set_num_threads(min(4, os.cpu_count() or 2))
    model = get_model("htdemucs_6s").cpu().eval()
    if args.prepare:
        assert "guitar" in model.sources
        print("Guitar separation model ready", flush=True)
        return
    if not args.input or not args.output or args.end is None or not (0 <= args.start < args.end <= 900) or args.end - args.start > 60:
        raise ValueError("Choose a guitar clip from 0.1 to 60 seconds")
    import subprocess
    import numpy as np
    import soundfile as sf
    import imageio_ffmpeg
    from demucs.apply import apply_model
    import torchaudio.functional as audio_functions
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", args.input,
        "-ss", str(args.start), "-t", str(args.end - args.start),
        "-f", "f32le", "-ar", str(model.samplerate), "-ac", "2", "pipe:1",
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    samples = np.frombuffer(result.stdout, dtype="<f4").reshape(-1, 2).copy()
    if len(samples) < int((args.end - args.start) * model.samplerate) - model.samplerate // 10:
        raise ValueError("Selected range extends beyond the available audio")
    if len(samples) < model.samplerate // 10:
        raise ValueError("Empty audio clip")
    wav = torch.from_numpy(samples.T)
    reference = wav.mean(0)
    mean = reference.mean()
    deviation = reference.std().clamp_min(1e-6)
    with torch.inference_mode():
        sources = apply_model(model, ((wav - mean) / deviation)[None],
                              device="cpu", shifts=0, split=True, overlap=0.25,
                              segment=5, progress=False)[0]
        guitar = sources[model.sources.index("guitar")] * deviation + mean
        mono = audio_functions.resample(guitar.mean(0), model.samplerate, 22050)
    peak = mono.abs().max().item()
    if peak > 0.98:
        mono = mono * (0.98 / peak)
    sf.write(args.output, mono.numpy(), 22050, subtype="PCM_16")
    print("Guitar clip saved", flush=True)

if __name__ == "__main__":
    main()
