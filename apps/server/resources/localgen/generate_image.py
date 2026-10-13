"""Makes one image on this computer's graphics card for CodeWrench Campaigns.

Run by the server, never through a shell. The last line printed to stdout is one line of JSON:
  {"ok": true, "path": ..., "seconds": ..., "model": ...}  or  {"ok": false, "reason": "..."}
A refusal because too little graphics memory is free also carries "busy": true, "freeGb" and "needGb".
Progress and notes go to stderr. Exit code 0 means success, 1 means failure.

Modes:
  (default)   make one PNG at --out; with --no-fallback it refuses (busy) rather than use a smaller model
  --check     report, line by line, whether this setup can make an image
  --download  fetch the chosen preset's files into --models-dir (the only mode that uses the network)

Needs only the standard library plus torch and diffusers. Nothing in the prompt is ever executed.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GIB = 1024**3
COMPLETE_MARKER = ".codewrench-complete"

# Keep in step with LOCAL_GPU_PRESETS in packages/shared/src/campaignRules.ts.
# `need_gib` is the free graphics memory the preset wants, measured with model offloading on.


@dataclass(frozen=True)
class Preset:
    id: str
    repo: str
    kind: str  # "lcm", "sdxl", "flux" or "zimage"
    license: str
    need_gib: float
    download_gb: float
    steps: int
    guidance: float
    variant: str | None
    allow: tuple[str, ...]
    long_edge: int


PRESETS: dict[str, Preset] = {
    "lcm-dreamshaper-v7": Preset(
        id="lcm-dreamshaper-v7",
        repo="SimianLuo/LCM_Dreamshaper_v7",
        kind="lcm",
        license="MIT",
        need_gib=3.0,
        download_gb=4.3,
        steps=4,
        guidance=8.0,
        variant=None,
        allow=(
            "model_index.json",
            "scheduler/*",
            "tokenizer/*",
            "text_encoder/config.json",
            "text_encoder/model.safetensors",
            "unet/config.json",
            "unet/diffusion_pytorch_model.safetensors",
            "vae/config.json",
            "vae/diffusion_pytorch_model.safetensors",
        ),
        long_edge=768,
    ),
    "sdxl-base-1.0": Preset(
        id="sdxl-base-1.0",
        repo="stabilityai/stable-diffusion-xl-base-1.0",
        kind="sdxl",
        license="CreativeML Open RAIL++-M",
        # Measured on a 16 GB card with model offloading: 5.4 GB peak at 1024x1024.
        need_gib=6.5,
        download_gb=6.9,
        steps=25,
        guidance=6.0,
        variant="fp16",
        allow=(
            "model_index.json",
            "scheduler/*",
            "tokenizer/*",
            "tokenizer_2/*",
            "text_encoder/config.json",
            "text_encoder/model.fp16.safetensors",
            "text_encoder_2/config.json",
            "text_encoder_2/model.fp16.safetensors",
            "unet/config.json",
            "unet/diffusion_pytorch_model.fp16.safetensors",
            "vae/config.json",
            "vae/diffusion_pytorch_model.fp16.safetensors",
        ),
        long_edge=1024,
    ),
    "flux-schnell": Preset(
        id="flux-schnell",
        # License: Apache-2.0 (model card of black-forest-labs/FLUX.1-schnell). That repo needs a
        # Hugging Face login, so this is an ungated mirror of the same files: the file sizes and the
        # config files' hashes match. Swap `repo` for the official one if you prefer to log in.
        # Measured on a 16 GB card: 6.9 GB peak at 1024x1024, about 13 seconds once the files are cached.
        repo="unsloth/FLUX.1-schnell",
        kind="flux",
        license="Apache-2.0",
        need_gib=7.5,
        download_gb=33.7,
        steps=4,
        guidance=0.0,
        variant=None,
        allow=(
            "model_index.json",
            "scheduler/*",
            "tokenizer/*",
            "tokenizer_2/*",
            "text_encoder/config.json",
            "text_encoder/model.safetensors",
            "text_encoder_2/config.json",
            "text_encoder_2/*.safetensors",
            "text_encoder_2/model.safetensors.index.json",
            "transformer/config.json",
            "transformer/*.safetensors",
            "transformer/diffusion_pytorch_model.safetensors.index.json",
            "vae/config.json",
            "vae/diffusion_pytorch_model.safetensors",
        ),
        long_edge=1024,
    ),
    "z-image-turbo": Preset(
        id="z-image-turbo",
        # License: Apache-2.0 (front matter of the model card of Tongyi-MAI/Z-Image-Turbo). The repo is
        # ungated. The transformer is stored in 32-bit, which is why the download is large; it is loaded
        # in 8-bit. Measured on a 16 GB card: 8.3 GB peak at 1024x1024, about 9 seconds per picture.
        repo="Tongyi-MAI/Z-Image-Turbo",
        kind="zimage",
        license="Apache-2.0",
        need_gib=9.0,
        download_gb=32.8,
        steps=9,
        guidance=0.0,
        variant=None,
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
        long_edge=1024,
    ),
}


# Smallest to largest. When the chosen model does not fit, the largest downloaded one below it that does is used.
SIZE_ORDER = ("lcm-dreamshaper-v7", "sdxl-base-1.0", "flux-schnell", "z-image-turbo")


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


def resolve_model(model: str, models_dir: str) -> tuple[Preset | None, Path]:
    """A preset id maps to a folder under models_dir; an absolute path is a diffusers folder."""
    if model in PRESETS:
        return PRESETS[model], models_root(models_dir) / model
    if model.startswith(("/", "~")):
        return None, Path(os.path.expanduser(model)).resolve()
    known = ", ".join(PRESETS)
    raise Refusal(f"'{model}' is not a known model. Choose one of: {known}, or a folder path.")


def is_downloaded(preset: Preset | None, folder: Path) -> bool:
    if preset is None:
        return (folder / "model_index.json").is_file()
    return (folder / COMPLETE_MARKER).is_file() and (folder / "model_index.json").is_file()


NOT_DOWNLOADED = "This model has not been downloaded yet. Download it in Settings first."


def folder_need_gib(folder: Path) -> float:
    """For a folder the owner supplied: the biggest single part (the rest is offloaded) plus room to work."""
    largest = 0.0
    for part in folder.iterdir():
        if not part.is_dir():
            continue
        size = sum(
            f.stat().st_size / (1 if "fp16" in f.name else 2)
            for f in part.glob("*.safetensors")
        )
        largest = max(largest, size)
    return largest / GIB + 1.5


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


def import_bitsandbytes() -> None:
    try:
        import bitsandbytes  # type: ignore[import-not-found]  # noqa: F401
    except Exception as error:  # noqa: BLE001
        raise Refusal(f"The bitsandbytes package is not installed for this Python ({error}).") from error


def make_flux_image(
    torch: Any, diffusers: Any, folder: Path, call: dict[str, Any], seed: int
) -> Any:
    """FLUX.1 schnell in three steps so it fits in about 7 GB of graphics memory.

    The 12 billion parameter transformer and the 4.7 billion parameter text encoder do not fit
    together, so: (1) read the prompt with the text encoder in 4-bit, then free it; (2) load the
    transformer in 4-bit (NF4) and make the picture's latents; (3) free it and decode the picture.
    The other parts are small. Only the part in use is ever on the card.
    """
    import gc

    import_bitsandbytes()
    from transformers import BitsAndBytesConfig as TextQuant  # type: ignore[import-not-found]
    from transformers import T5EncoderModel  # type: ignore[import-not-found]

    bf16 = torch.bfloat16
    common: dict[str, Any] = {"torch_dtype": bf16, "local_files_only": True}

    def encode() -> tuple[Any, Any]:
        quant = TextQuant(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=bf16)
        t5 = T5EncoderModel.from_pretrained(
            str(folder), subfolder="text_encoder_2", quantization_config=quant, **common
        )
        reader = diffusers.FluxPipeline.from_pretrained(
            str(folder), transformer=None, vae=None, text_encoder_2=t5, **common
        )
        reader.text_encoder.to("cuda")
        with torch.no_grad():
            text, pooled, _ = reader.encode_prompt(
                call["prompt"], prompt_2=None, device="cuda", max_sequence_length=256
            )
        return text.cpu(), pooled.cpu()

    def release() -> None:
        gc.collect()
        torch.cuda.empty_cache()

    text, pooled = encode()
    release()
    quant = diffusers.BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=bf16
    )
    transformer = diffusers.FluxTransformer2DModel.from_pretrained(
        str(folder), subfolder="transformer", quantization_config=quant, **common
    )
    pipe = diffusers.FluxPipeline.from_pretrained(
        str(folder),
        transformer=transformer,
        text_encoder=None,
        tokenizer=None,
        text_encoder_2=None,
        tokenizer_2=None,
        **common,
    )
    pipe.vae.to("cuda")
    pipe.vae.enable_tiling()
    latents = pipe(
        prompt_embeds=text.to("cuda"),
        pooled_prompt_embeds=pooled.to("cuda"),
        width=call["width"],
        height=call["height"],
        num_inference_steps=call["num_inference_steps"],
        guidance_scale=0.0,
        generator=torch.Generator("cpu").manual_seed(seed),
        output_type="latent",
    ).images
    # The transformer is done; take it off the card so decoding has room.
    pipe.transformer = None
    del transformer
    release()
    latents = pipe._unpack_latents(latents, call["height"], call["width"], pipe.vae_scale_factor)
    latents = latents / pipe.vae.config.scaling_factor + pipe.vae.config.shift_factor
    with torch.no_grad():
        decoded = pipe.vae.decode(latents.to(pipe.vae.dtype), return_dict=False)[0]
    return pipe.image_processor.postprocess(decoded, output_type="pil")[0]


def make_zimage_image(
    torch: Any, diffusers: Any, folder: Path, call: dict[str, Any], seed: int
) -> Any:
    """Z-Image Turbo in two steps so it fits in about 9 GB of graphics memory.

    (1) Read the prompt with the 4 billion parameter text encoder in bfloat16 (7.5 GB), then free it;
    (2) load the 6 billion parameter transformer in 8-bit (about 6 GB) and make and decode the picture.
    Only the part in use is ever on the card.
    """
    import gc

    import_bitsandbytes()
    from transformers import AutoModel, AutoTokenizer  # type: ignore[import-not-found]

    bf16 = torch.bfloat16
    common: dict[str, Any] = {"torch_dtype": bf16, "local_files_only": True}

    tokenizer = AutoTokenizer.from_pretrained(str(folder), subfolder="tokenizer", local_files_only=True)
    encoder = AutoModel.from_pretrained(str(folder), subfolder="text_encoder", **common).to("cuda")
    reader = diffusers.ZImagePipeline.from_pretrained(
        str(folder), transformer=None, vae=None, text_encoder=encoder, tokenizer=tokenizer, **common
    )
    with torch.no_grad():
        embeds, _ = reader.encode_prompt(call["prompt"], device="cuda", do_classifier_free_guidance=False)
    embeds = [item.cpu() for item in embeds]
    del reader, encoder
    gc.collect()
    torch.cuda.empty_cache()

    transformer = diffusers.ZImageTransformer2DModel.from_pretrained(
        str(folder),
        subfolder="transformer",
        quantization_config=diffusers.BitsAndBytesConfig(load_in_8bit=True),
        **common,
    )
    pipe = diffusers.ZImagePipeline.from_pretrained(
        str(folder), transformer=transformer, text_encoder=None, tokenizer=None, **common
    )
    pipe.vae.to("cuda")
    pipe.vae.enable_tiling()
    return pipe(
        prompt_embeds=[item.to("cuda") for item in embeds],
        negative_prompt_embeds=[],
        width=call["width"],
        height=call["height"],
        num_inference_steps=call["num_inference_steps"],
        guidance_scale=0.0,
        generator=torch.Generator("cpu").manual_seed(seed),
        output_type="pil",
    ).images[0]


def round8(value: int) -> int:
    return max(64, (value // 8) * 8)


def run_check(args: argparse.Namespace) -> None:
    lines: list[dict[str, Any]] = []
    ok = True

    def note(good: bool, text: str) -> None:
        nonlocal ok
        ok = ok and good
        lines.append({"ok": good, "text": text})

    note(True, f"Python {sys.version.split()[0]} at {sys.executable}.")
    try:
        torch, diffusers = import_gpu_stack()
        note(True, f"PyTorch {torch.__version__} and diffusers {diffusers.__version__} are installed.")
        free, total = free_gib(torch)
        note(True, f"Graphics card: {torch.cuda.get_device_name(0)}, {free:.1f} GB free of {total:.1f} GB.")
    except Refusal as refusal:
        note(False, str(refusal))
        finish({"ok": False, "reason": str(refusal), "lines": lines}, False)
    try:
        preset, folder = resolve_model(args.model, args.models_dir)
        if preset is not None and preset.kind in ("flux", "zimage"):
            try:
                import_bitsandbytes()
                note(True, "The bitsandbytes package (4-bit and 8-bit loading) is installed.")
            except Refusal as refusal:
                note(False, str(refusal))
        if is_downloaded(preset, folder):
            note(True, f"The model is downloaded ({folder}).")
            need = preset.need_gib if preset else folder_need_gib(folder)
            if free >= need:
                note(True, f"Enough memory is free for it (needs about {need:.1f} GB).")
            else:
                note(
                    False,
                    f"The GPU has {free:.1f} GB free and this model needs about {need:.1f} GB. "
                    "Text models are using the rest. It will be tried again each time you make an image.",
                )
        elif preset is None:
            note(False, f"{folder} is not a diffusers model folder (no model_index.json).")
        else:
            note(False, NOT_DOWNLOADED + f" It is about {preset.download_gb} GB.")
    except Refusal as refusal:
        note(False, str(refusal))
    finish({"ok": ok, "lines": lines, "reason": None if ok else next(l["text"] for l in lines if not l["ok"])}, ok)


def run_download(args: argparse.Namespace) -> None:
    preset, folder = resolve_model(args.model, args.models_dir)
    if preset is None:
        raise Refusal("A model folder you chose yourself is already on this computer; nothing to download.")
    try:
        from huggingface_hub import HfApi, hf_hub_download  # type: ignore[import-not-found]
        from huggingface_hub.utils import disable_progress_bars  # type: ignore[import-not-found]
        import fnmatch
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


def run_generate(args: argparse.Namespace) -> None:
    if not args.out or not args.prompt:
        raise Refusal("A prompt and an output file are required.")
    preset, folder = resolve_model(args.model, args.models_dir)
    if not is_downloaded(preset, folder):
        raise Refusal(NOT_DOWNLOADED)
    need = preset.need_gib if preset else folder_need_gib(folder)
    # Nothing here may reach the network: the files are on disk already.
    os.environ["HF_HUB_OFFLINE"] = "1"
    torch, diffusers = import_gpu_stack()
    note: str | None = None
    try:
        free = require_memory(torch, need)
    except Refusal:
        # The card is shared with text models. When the chosen model does not fit, make the image
        # with the largest smaller model that is downloaded and does fit, and say so, rather than
        # make nothing. A caller that would rather wait asks for --no-fallback.
        if args.no_fallback or preset is None or preset.id not in SIZE_ORDER:
            raise
        smaller = [
            PRESETS[name]
            for name in reversed(SIZE_ORDER[: SIZE_ORDER.index(preset.id)])
            if is_downloaded(PRESETS[name], models_root(args.models_dir) / name)
        ]
        free_now, _ = free_gib(torch)
        fits = next((p for p in smaller if free_now >= p.need_gib), None)
        if fits is None:
            raise
        free = free_now
        shrink = min(1.0, fits.long_edge / max(args.width, args.height))
        args.width, args.height = int(args.width * shrink), int(args.height * shrink)
        note = f"The graphics card was busy, so {fits.id} made this image instead of {preset.id}."
        preset, folder, need = fits, models_root(args.models_dir) / fits.id, fits.need_gib

    started = time.monotonic()
    kind = preset.kind if preset else "auto"
    width, height = round8(args.width), round8(args.height)
    steps = args.steps or (preset.steps if preset else 25)
    seed = args.seed if args.seed is not None and args.seed >= 0 else random.randrange(2**31)
    kwargs: dict[str, Any] = {"torch_dtype": torch.float16, "local_files_only": True}
    if preset and preset.variant:
        kwargs["variant"] = preset.variant
    if kind == "lcm":
        # The safety checker is not downloaded; the distilled model has no negative prompt either.
        kwargs.update(safety_checker=None, feature_extractor=None, requires_safety_checker=False)
    call: dict[str, Any] = {
        "prompt": args.prompt,
        "width": width,
        "height": height,
        "num_inference_steps": steps,
        "generator": torch.Generator("cpu").manual_seed(seed),
    }
    if preset:
        call["guidance_scale"] = preset.guidance
    if args.negative and kind != "lcm":
        call["negative_prompt"] = args.negative
    torch.cuda.reset_peak_memory_stats()
    try:
        if kind == "flux":
            image = make_flux_image(torch, diffusers, folder, call, seed)
        elif kind == "zimage":
            image = make_zimage_image(torch, diffusers, folder, call, seed)
        else:
            pipe = diffusers.DiffusionPipeline.from_pretrained(str(folder), **kwargs)
            if free >= need + 4:
                pipe.to("cuda")
            else:
                pipe.enable_model_cpu_offload()
            pipe.enable_attention_slicing()
            if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
                pipe.vae.enable_tiling()
            image = pipe(**call).images[0]
    except torch.cuda.OutOfMemoryError as error:
        raise Refusal(
            "The GPU ran out of memory while making the image. Text models are using most of it."
        ) from error
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, "PNG")
    finish(
        {
            "ok": True,
            "path": str(out),
            "seconds": round(time.monotonic() - started, 1),
            "model": preset.id if preset else args.model,
            **({"note": note} if note else {}),
            "width": image.width,
            "height": image.height,
            "seed": seed,
            "peakGb": round(torch.cuda.max_memory_allocated() / GIB, 2),
            "freeGbBefore": round(free, 2),
        },
        True,
    )


def parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--negative", default="")
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--steps", type=int, default=0, help="0 uses the preset's own number")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--model", required=True, help="a preset id or the path of a diffusers folder")
    parser.add_argument("--out", default="")
    parser.add_argument("--models-dir", default="~/.codewrench/localgen/models")
    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="refuse with busy=true when the chosen model does not fit, instead of using a smaller one",
    )
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
        finish({"ok": False, "reason": f"The image could not be made: {type(error).__name__}: {error}"}, False)


if __name__ == "__main__":
    main(sys.argv[1:])
