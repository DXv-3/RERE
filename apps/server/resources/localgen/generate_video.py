"""Makes one short video from a still image on this computer's graphics card for CodeWrench Campaigns.

The still becomes the first frame; the prompt says how things move. Run by the server, never through a
shell. The last line printed to stdout is one line of JSON:
  {"ok": true, "path": ..., "seconds": ..., "model": ...}  or  {"ok": false, "reason": "..."}
A refusal because too little graphics memory is free also carries "busy": true, "freeGb" and "needGb".
Progress and notes go to stderr. Exit code 0 means success, 1 means failure.

Modes:
  (default)   make one H.264 mp4 at --out from the picture at --image
  --check     report, line by line, whether this setup can make a video
  --download  fetch the chosen preset's files into --models-dir (the only mode that uses the network)

There is no smaller video model to fall back on, so a card that is too busy is always a refusal
(busy=true). --no-fallback is accepted so the server can call both scripts the same way.

Needs the standard library plus torch, diffusers, transformers, numpy, Pillow and ftfy, and ffmpeg on the
PATH. Nothing in the prompt is ever executed.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GIB = 1024**3
COMPLETE_MARKER = ".codewrench-complete"
FPS = 24

# Keep in step with LOCAL_GPU_VIDEO_PRESETS in packages/shared/src/campaignRules.ts.
# `need_gib` is the free graphics memory the preset wants for a 5 second clip, measured.


@dataclass(frozen=True)
class Preset:
    id: str
    repo: str
    license: str
    need_gib: float
    download_gb: float
    steps: int
    guidance: float
    # Pixels in a picture of the "480p" size; a shape with another aspect ratio keeps this area.
    pixel_budget: int
    min_seconds: int
    max_seconds: int
    allow: tuple[str, ...]


PRESETS: dict[str, Preset] = {
    "wan22-ti2v-5b": Preset(
        id="wan22-ti2v-5b",
        # License: Apache-2.0 (front matter and "License Agreement" of the model card of
        # Wan-AI/Wan2.2-TI2V-5B-Diffusers, which also says the makers claim no rights over what
        # you generate). The repo is ungated. The transformer is stored in 32-bit, which is why the
        # download is large; it is run in bfloat16 and streamed through the card block by block.
        repo="Wan-AI/Wan2.2-TI2V-5B-Diffusers",
        license="Apache-2.0",
        need_gib=7.5,
        download_gb=34.2,
        steps=30,
        guidance=5.0,
        pixel_budget=640 * 640,
        min_seconds=3,
        max_seconds=5,
        allow=(
            "model_index.json",
            "scheduler/*",
            "tokenizer/*",
            "text_encoder/config.json",
            "text_encoder/*.safetensors",
            "text_encoder/model.safetensors.index.json",
            "transformer/config.json",
            "transformer/*.safetensors",
            "transformer/diffusion_pytorch_model.safetensors.index.json",
            "vae/config.json",
            "vae/diffusion_pytorch_model.safetensors",
        ),
    ),
}

# The model card's own list of things that spoil a clip, used when the person gives none.
DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，"
    "低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，"
    "毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

NOT_DOWNLOADED = "This model has not been downloaded yet. Download it in Settings first."
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


class Refusal(Exception):
    """A problem the person can act on. The message is shown to them as written."""

    def __init__(self, message: str, busy: tuple[float, float] | None = None) -> None:
        super().__init__(message)
        # (free GB, needed GB) when the only problem is that the card is shared and full right now.
        self.busy = busy


def say(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def finish(payload: dict[str, Any], ok: bool) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    sys.exit(0 if ok else 1)


def models_root(raw: str) -> Path:
    return Path(os.path.expanduser(raw)).resolve()


def resolve_model(model: str, models_dir: str) -> tuple[Preset, Path]:
    if model in PRESETS:
        return PRESETS[model], models_root(models_dir) / model
    raise Refusal(f"'{model}' is not a known video model. Choose one of: {', '.join(PRESETS)}.")


def is_downloaded(folder: Path) -> bool:
    return (folder / COMPLETE_MARKER).is_file() and (folder / "model_index.json").is_file()


def video_size(preset: Preset, width: int, height: int) -> tuple[int, int]:
    """A width and height with the shape asked for, about `pixel_budget` pixels, in steps of 32."""
    ratio = max(0.2, min(5.0, width / max(1, height)))
    h = math.sqrt(preset.pixel_budget / ratio)

    def snap(value: float) -> int:
        return max(256, int(round(value / 32)) * 32)

    return snap(h * ratio), snap(h)


def frame_count(seconds: int) -> int:
    """The model wants a multiple of 4 plus 1 frames; whole seconds at 24 per second always are."""
    return seconds * FPS + 1


def import_gpu_stack() -> tuple[Any, Any]:
    try:
        import torch  # type: ignore[import-not-found]
    except Exception as error:  # noqa: BLE001
        raise Refusal(f"PyTorch is not installed for this Python ({error}).") from error
    try:
        import diffusers  # type: ignore[import-not-found]
    except Exception as error:  # noqa: BLE001
        raise Refusal(f"The diffusers package is not installed for this Python ({error}).") from error
    return torch, diffusers


def import_helpers() -> None:
    for name, label in (("PIL", "Pillow"), ("numpy", "numpy"), ("ftfy", "ftfy"), ("transformers", "transformers")):
        try:
            __import__(name)
        except Exception as error:  # noqa: BLE001
            raise Refusal(f"The {label} package is not installed for this Python ({error}).") from error
    if shutil.which("ffmpeg") is None:
        raise Refusal("ffmpeg is not installed, so the video cannot be written. Install ffmpeg first.")


def free_gib(torch: Any) -> tuple[float, float]:
    if not torch.cuda.is_available():
        raise Refusal("No usable NVIDIA graphics card was found (CUDA is not available).")
    free, total = torch.cuda.mem_get_info()
    return free / GIB, total / GIB


def require_memory(torch: Any, need: float) -> float:
    free, _ = free_gib(torch)
    if free < need:
        raise Refusal(
            f"The GPU has {free:.1f} GB free and this model needs about {need:.1f} GB. "
            "Text models are using the rest.",
            busy=(free, need),
        )
    return free


def run_check(args: argparse.Namespace) -> None:
    lines: list[dict[str, Any]] = []
    ok = True

    def note(good: bool, text: str) -> None:
        nonlocal ok
        ok = ok and good
        lines.append({"ok": good, "text": text})

    note(True, f"Python {sys.version.split()[0]} at {sys.executable}.")
    free = 0.0
    try:
        torch, diffusers = import_gpu_stack()
        note(True, f"PyTorch {torch.__version__} and diffusers {diffusers.__version__} are installed.")
        free, total = free_gib(torch)
        note(True, f"Graphics card: {torch.cuda.get_device_name(0)}, {free:.1f} GB free of {total:.1f} GB.")
    except Refusal as refusal:
        note(False, str(refusal))
        finish({"ok": False, "reason": str(refusal), "lines": lines}, False)
    try:
        import_helpers()
        note(True, "Pillow, numpy, ftfy, transformers and ffmpeg are installed.")
    except Refusal as refusal:
        note(False, str(refusal))
    try:
        preset, folder = resolve_model(args.model, args.models_dir)
        if is_downloaded(folder):
            note(True, f"The model is downloaded ({folder}).")
            if free >= preset.need_gib:
                note(True, f"Enough memory is free for it (needs about {preset.need_gib:.1f} GB).")
            else:
                note(
                    False,
                    f"The GPU has {free:.1f} GB free and this model needs about {preset.need_gib:.1f} GB. "
                    "Text models are using the rest. It will be tried again each time you make a video.",
                )
        else:
            note(False, NOT_DOWNLOADED + f" It is about {preset.download_gb} GB.")
    except Refusal as refusal:
        note(False, str(refusal))
    finish({"ok": ok, "lines": lines, "reason": None if ok else next(l["text"] for l in lines if not l["ok"])}, ok)


def run_download(args: argparse.Namespace) -> None:
    preset, folder = resolve_model(args.model, args.models_dir)
    try:
        from huggingface_hub import HfApi, hf_hub_download  # type: ignore[import-not-found]
        from huggingface_hub.utils import disable_progress_bars  # type: ignore[import-not-found]
    except Exception as error:  # noqa: BLE001
        raise Refusal(f"The huggingface_hub package is not installed for this Python ({error}).") from error
    disable_progress_bars()
    started = time.monotonic()
    info = HfApi().model_info(preset.repo, files_metadata=True)
    wanted = [
        (s.rfilename, s.size or 0)
        for s in info.siblings or []
        if any(fnmatch.fnmatch(s.rfilename, pattern) for pattern in preset.allow)
    ]
    if not wanted:
        raise Refusal(f"{preset.repo} did not list the files this preset needs.")
    total = sum(size for _, size in wanted)
    disk = os.statvfs(folder.parent if folder.parent.exists() else Path.home())
    free_disk = disk.f_bavail * disk.f_frsize
    if total * 1.1 > free_disk:
        raise Refusal(f"The download is {total / GIB:.1f} GB and the disk has {free_disk / GIB:.1f} GB free.")
    folder.mkdir(parents=True, exist_ok=True)
    say(f"Downloading {preset.repo} ({preset.license}): {len(wanted)} files, {total / GIB:.2f} GB.")
    done = 0
    for index, (name, size) in enumerate(wanted, start=1):
        hf_hub_download(preset.repo, name, local_dir=str(folder), revision=info.sha)
        done += size
        say(f"File {index} of {len(wanted)}: {name} ({size / 1e6:.0f} MB). {done / GIB:.2f} of {total / GIB:.2f} GB.")
    (folder / COMPLETE_MARKER).write_text(json.dumps({"repo": preset.repo, "revision": info.sha}))
    finish(
        {
            "ok": True,
            "model": preset.id,
            "path": str(folder),
            "bytes": total,
            "seconds": round(time.monotonic() - started, 1),
        },
        True,
    )


def open_first_frame(path: str) -> Any:
    from PIL import Image  # type: ignore[import-not-found]

    file = Path(path)
    if file.suffix.lower() not in IMAGE_SUFFIXES or not file.is_file():
        raise Refusal("The first frame must be a png, jpg or webp image file that exists.")
    try:
        with Image.open(file) as opened:
            return opened.convert("RGB")
    except Exception as error:  # noqa: BLE001
        raise Refusal(f"The first frame could not be read as a picture ({type(error).__name__}).") from error


def fit_first_frame(image: Any, width: int, height: int) -> Any:
    """The still, cropped to the shape of the video from the middle and sized to it exactly."""
    from PIL import Image  # type: ignore[import-not-found]

    scale = max(width / image.width, height / image.height)
    size = (max(width, round(image.width * scale)), max(height, round(image.height * scale)))
    resized = image.resize(size, Image.LANCZOS)
    left, top = (resized.width - width) // 2, (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def write_mp4(frames: Any, out: Path) -> None:
    """H.264 in yuv420p with the index at the front, so a browser plays it as it loads."""
    import numpy as np  # type: ignore[import-not-found]

    pixels = (np.clip(np.asarray(frames), 0.0, 1.0) * 255).round().astype("uint8")
    _, height, width, _ = pixels.shape
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", str(out),
    ]  # fmt: skip
    done = subprocess.run(command, input=pixels.tobytes(), capture_output=True, check=False)
    if done.returncode != 0 or not out.is_file():
        detail = done.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no detail"]
        raise Refusal(f"ffmpeg could not write the video: {detail[0][:200]}")


def make_wan_video(
    torch: Any, diffusers: Any, folder: Path, preset: Preset, call: dict[str, Any]
) -> Any:
    """Wan 2.2 TI2V 5B in three steps so it fits in about 7 GB of graphics memory.

    (1) Read the prompts with the 5.7 billion parameter text encoder on the processor, then free it;
    (2) run the 5 billion parameter transformer in bfloat16, one block at a time on the card while
    the next is copied in, so only a sliver of it is ever there (the VAE and the working memory take
    the rest); (3) decode the video in tiles. The picture is the first frame: the pipeline keeps it
    fixed and animates the rest.
    """
    import gc

    from diffusers.hooks import apply_group_offloading  # type: ignore[import-not-found]
    from transformers import AutoTokenizer, UMT5EncoderModel  # type: ignore[import-not-found]

    bf16 = torch.bfloat16
    common: dict[str, Any] = {"torch_dtype": bf16, "local_files_only": True}
    started = time.monotonic()

    def lap(label: str) -> None:
        say(f"{label} ({time.monotonic() - started:.0f}s)")

    tokenizer = AutoTokenizer.from_pretrained(str(folder), subfolder="tokenizer", local_files_only=True)
    encoder = UMT5EncoderModel.from_pretrained(str(folder), subfolder="text_encoder", **common)
    reader = diffusers.WanImageToVideoPipeline.from_pretrained(
        str(folder), transformer=None, vae=None, text_encoder=encoder, tokenizer=tokenizer, **common
    )
    with torch.no_grad():
        prompt_embeds, negative_embeds = reader.encode_prompt(
            call["prompt"], call["negative_prompt"], device="cpu", max_sequence_length=226, dtype=bf16
        )
    del reader, encoder
    gc.collect()
    lap("Read the prompt")

    transformer = diffusers.WanTransformer3DModel.from_pretrained(
        str(folder), subfolder="transformer", **common
    )
    vae = diffusers.AutoencoderKLWan.from_pretrained(
        str(folder), subfolder="vae", torch_dtype=torch.float32, local_files_only=True
    )
    pipe = diffusers.WanImageToVideoPipeline.from_pretrained(
        str(folder), transformer=transformer, vae=vae, text_encoder=None, tokenizer=None, **common
    )
    apply_group_offloading(
        pipe.transformer,
        onload_device=torch.device("cuda"),
        offload_device=torch.device("cpu"),
        offload_type="block_level",
        num_blocks_per_group=1,
        use_stream=True,
    )
    pipe.vae.to("cuda")
    pipe.vae.enable_tiling()
    lap("Loaded the model")

    def progress(_pipe: Any, step: int, _timestep: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        say(f"Step {step + 1} of {call['num_inference_steps']} ({time.monotonic() - started:.0f}s)")
        return kwargs

    result = pipe(
        image=call["image"],
        prompt_embeds=prompt_embeds.to("cuda"),
        negative_prompt_embeds=negative_embeds.to("cuda"),
        height=call["height"],
        width=call["width"],
        num_frames=call["num_frames"],
        num_inference_steps=call["num_inference_steps"],
        guidance_scale=preset.guidance,
        generator=torch.Generator("cpu").manual_seed(call["seed"]),
        callback_on_step_end=progress,
        output_type="np",
    ).frames[0]
    lap("Decoded the video")
    return result


def run_generate(args: argparse.Namespace) -> None:
    if not args.out or not args.prompt:
        raise Refusal("A prompt and an output file are required.")
    if not args.image:
        raise Refusal("This computer makes video from a still image. Choose an image to start from.")
    preset, folder = resolve_model(args.model, args.models_dir)
    if not is_downloaded(folder):
        raise Refusal(NOT_DOWNLOADED)
    if not preset.min_seconds <= args.seconds <= preset.max_seconds:
        raise Refusal(f"{preset.id} makes {preset.min_seconds} to {preset.max_seconds} second videos.")
    # Nothing here may reach the network: the files are on disk already.
    os.environ["HF_HUB_OFFLINE"] = "1"
    # Fewer, larger holes in the card's memory: the shared card has little to spare.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    torch, diffusers = import_gpu_stack()
    import_helpers()
    free = require_memory(torch, preset.need_gib)

    started = time.monotonic()
    still = open_first_frame(args.image)
    # 0 for either side means "the shape of the picture itself".
    shape = (args.width, args.height) if args.width > 0 and args.height > 0 else still.size
    width, height = video_size(preset, *shape)
    image = fit_first_frame(still, width, height)
    seed = args.seed if args.seed is not None and args.seed >= 0 else random.randrange(2**31)
    call: dict[str, Any] = {
        "prompt": args.prompt,
        "negative_prompt": args.negative or DEFAULT_NEGATIVE,
        "image": image,
        "width": width,
        "height": height,
        "num_frames": frame_count(args.seconds),
        "num_inference_steps": args.steps or preset.steps,
        "seed": seed,
    }
    torch.cuda.reset_peak_memory_stats()
    try:
        frames = make_wan_video(torch, diffusers, folder, preset, call)
    except torch.cuda.OutOfMemoryError as error:
        # Another program took the room while this ran. Say so as "busy" so a waiting job tries again.
        free_now, _ = free_gib(torch)
        raise Refusal(
            "The GPU ran out of memory while making the video. Something else is using the card.",
            busy=(free_now, preset.need_gib),
        ) from error
    out = Path(args.out)
    write_mp4(frames, out)
    finish(
        {
            "ok": True,
            "path": str(out),
            "seconds": round(time.monotonic() - started, 1),
            "model": preset.id,
            "width": width,
            "height": height,
            "durationSeconds": args.seconds,
            "seed": seed,
            "peakGb": round(torch.cuda.max_memory_reserved() / GIB, 2),
            "freeGbBefore": round(free, 2),
        },
        True,
    )


def parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--negative", default="")
    parser.add_argument("--image", default="", help="the still image that becomes the first frame")
    parser.add_argument("--width", type=int, default=0, help="with --height, the shape of the video; 0 follows the picture")
    parser.add_argument("--height", type=int, default=0)
    parser.add_argument("--seconds", type=int, default=5)
    parser.add_argument("--steps", type=int, default=0, help="0 uses the preset's own number")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--model", required=True, help="a preset id")
    parser.add_argument("--out", default="")
    parser.add_argument("--models-dir", default="~/.codewrench/localgen/models")
    parser.add_argument("--no-fallback", action="store_true", help="accepted for parity; there is no smaller model")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--download", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> None:
    args = parse(argv)
    try:
        if args.check:
            run_check(args)
        elif args.download:
            run_download(args)
        else:
            run_generate(args)
    except Refusal as refusal:
        busy = (
            {"busy": True, "freeGb": round(refusal.busy[0], 2), "needGb": round(refusal.busy[1], 2)}
            if refusal.busy
            else {}
        )
        finish({"ok": False, "reason": str(refusal), **busy}, False)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        finish({"ok": False, "reason": f"The video could not be made: {type(error).__name__}: {error}"}, False)


if __name__ == "__main__":
    main(sys.argv[1:])
