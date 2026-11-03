"""Local separation: guitar alone, or aligned guitar/drums transport channels."""
import argparse
import os
import hashlib
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("TORCH_HOME", str(ROOT / ".tools" / "guitar-models"))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--stems", choices=["guitar", "guitar,drums"], default="guitar")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float)
    args = parser.parse_args()
    cache_file = None
    if args.full and args.input and args.output:
        digest = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        cache_key = 'guitar' if args.stems == 'guitar' else 'guitar-drums'
        cache_file = ROOT / '.tools' / 'guitar-cache' / f'{cache_key}-{digest}-v1.wav'
        if cache_file.is_file():
            shutil.copyfile(cache_file, args.output)
            print('Cached full-song stems saved', flush=True)
            return
    import torch
    from demucs.pretrained import get_model
    torch.set_num_threads(min(4, os.cpu_count() or 2))
    model = get_model("htdemucs_6s").cpu().eval()
    if args.prepare:
        assert {"guitar", "drums"}.issubset(model.sources)
        print("Guitar separation model ready", flush=True)
        return
    if not args.input or not args.output or (not args.full and (args.end is None or not (0 <= args.start < args.end <= 900) or args.end - args.start > 60)):
        raise ValueError("Choose a guitar clip from 0.1 to 60 seconds")
    import subprocess
    import numpy as np
    import soundfile as sf
    import imageio_ffmpeg
    from demucs.apply import apply_model
    import torchaudio.functional as audio_functions
    selection_args = ["-t", "900"] if args.full else ["-ss", str(args.start), "-t", str(args.end - args.start)]
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", args.input,
        *selection_args,
        "-f", "f32le", "-ar", str(model.samplerate), "-ac", "2", "pipe:1",
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    samples = np.frombuffer(result.stdout, dtype="<f4").reshape(-1, 2).copy()
    if not args.full and len(samples) < int((args.end - args.start) * model.samplerate) - model.samplerate // 10:
        raise ValueError("Selected range extends beyond the available audio")
    if len(samples) < model.samplerate // 10:
        raise ValueError("Empty audio clip")
    wav = torch.from_numpy(samples.T)
    print(f"Separating {args.stems}: {len(samples) / model.samplerate:.1f} seconds", flush=True)
    reference = wav.mean(0)
    mean = reference.mean()
    deviation = reference.std().clamp_min(1e-6)
    with torch.inference_mode():
        sources = apply_model(model, ((wav - mean) / deviation)[None],
                              device="cpu", shifts=0, split=True, overlap=0.25,
                              segment=5, progress=args.full)[0]
        channels = []
        for name in args.stems.split(','):
            stem = sources[model.sources.index(name)] * deviation + mean
            channels.append(audio_functions.resample(stem.mean(0), model.samplerate, 22050))
        output = torch.stack(channels, dim=1)
    peak = output.abs().max().item()
    if peak > 0.98:
        output = output * (0.98 / peak)
    # These channels are separate stems, not a stereo listening mix.
    # The browser selects/mixes them and exports a normal mono WAV.
    sf.write(args.output, output.numpy(), 22050, subtype="PCM_16")
    if cache_file is not None:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_file.with_suffix('.tmp')
        shutil.copyfile(args.output, temporary)
        temporary.replace(cache_file)
        old_files = sorted(cache_file.parent.glob('guitar-*-v1.wav'), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in old_files[5:]:
            if old != cache_file:
                old.unlink(missing_ok=True)
    print("Separated stems saved", flush=True)

if __name__ == "__main__":
    main()
