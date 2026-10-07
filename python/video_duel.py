"""Duel vidéo (outil de développement de Jaris) : génère avec Kandinsky 6.0 Video Lite distillé les mêmes
descriptions que FastWan, et mesure le temps de chaque vidéo. Lancé par electron/services/videoDuel.ts, dans un
environnement Python à part (torch CUDA + diffusers figés dans video-duel-requirements.txt) : rien de ce qui sert à la
voix n'est touché.

Deux phases, dans le même processus pour Léo, séparables pour vérifier le script sur une petite machine :
- `encode` : le lecteur de description (Qwen2.5-VL 7B, 16,6 Go) lit les descriptions, toujours sur le processeur —
  il ne tient pas dans une carte de 8 Go. Le résultat est gardé dans `embeddings.pt`, puis le lecteur est libéré.
- `generate` : le modèle vidéo (3B), son décodeur et la voix sur la carte graphique, morceau par morceau si besoin.

Sortie : une ligne JSON par évènement sur stdout (progress, result, error, done), lue par Jaris.
"""

import argparse
import gc
import json
import os
import sys
import time

# Même raison que voice_server.py : sur un Windows en cp1252, les accents arriveraient cassés à Jaris.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def gib(value):
    return round(value / 1024**3, 1)


def encode(args, jobs):
    import psutil
    import torch
    from diffusers.pipelines.kandinsky6.pipeline_kandinsky6_ti2va import _PROMPT_TEMPLATE, _QWEN_CROP_START
    from transformers import AutoTokenizer, CLIPTextModel, CLIPTokenizer, Qwen2_5_VLForConditionalGeneration

    start = time.time()
    emit("progress", message="Chargement du lecteur de description de Kandinsky (16,6 Go, sur le processeur)…")
    # Ce qui ne tient pas dans la mémoire vive libre est lu depuis le disque au besoin, plutôt que de tout faire planter.
    free = psutil.virtual_memory().available / 1024**3
    budget = max(4, int(free - 3))
    text_encoder = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        os.path.join(args.model, "text_encoder"),
        torch_dtype=torch.bfloat16,
        device_map="auto",
        max_memory={"cpu": f"{budget}GiB"},
        offload_folder=os.path.join(args.out, "offload"),
    )
    # Le texte seul, sans image : le tokenizer donne exactement les jetons du « processeur » Qwen (vérifié), sans torchvision.
    tokenizer = AutoTokenizer.from_pretrained(os.path.join(args.model, "tokenizer"))
    clip = CLIPTextModel.from_pretrained(os.path.join(args.model, "text_encoder_2"), torch_dtype=torch.bfloat16)
    clip_tokenizer = CLIPTokenizer.from_pretrained(os.path.join(args.model, "tokenizer_2"))
    embeddings = {}
    with torch.no_grad():
        for job in jobs:
            emit("progress", message=f"Kandinsky lit la description « {job['name']} »…")
            # Sans remplissage : le modèle lit de gauche à droite, les vrais jetons donnent les mêmes valeurs qu'avec les
            # 1 000 jetons de remplissage du pipeline (que son masque ignore ensuite), en lisant 6 fois moins.
            ids = tokenizer([_PROMPT_TEMPLATE.format(job["prompt"])], max_length=1024 + _QWEN_CROP_START, truncation=True, return_tensors="pt")
            hidden = text_encoder(input_ids=ids["input_ids"], attention_mask=ids["attention_mask"], output_hidden_states=True, return_dict=True)
            clip_ids = clip_tokenizer([job["prompt"]], max_length=77, truncation=True, padding="max_length", return_tensors="pt")
            embeddings[job["name"]] = {
                "prompt_embeds": hidden["hidden_states"][-1][:, _QWEN_CROP_START:].to(torch.bfloat16).clone(),
                "pooled_prompt_embeds": clip(**clip_ids)["pooler_output"].to(torch.bfloat16).clone(),
            }
    torch.save(embeddings, os.path.join(args.out, "embeddings.pt"))
    del text_encoder, clip
    gc.collect()
    return time.time() - start


def make_pipeline(args, device):
    import torch
    from diffusers import Kandinsky6TI2VAPipeline

    pipe = Kandinsky6TI2VAPipeline.from_pretrained(
        args.model, text_encoder=None, tokenizer=None, text_encoder_2=None, tokenizer_2=None, torch_dtype=torch.bfloat16
    )
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    if device == "cuda":
        pipe.enable_model_cpu_offload()
    return pipe


def generate(args, jobs):
    import torch
    from diffusers.utils import encode_video

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        emit("progress", message="Aucune carte graphique NVIDIA utilisable par PyTorch : Kandinsky tourne sur le processeur (très lent).")
    start = time.time()
    emit("progress", message="Chargement du modèle vidéo Kandinsky 6 Lite…")
    pipe = make_pipeline(args, device)
    load_seconds = time.time() - start
    offload = "model" if device == "cuda" else "cpu"
    embeddings = torch.load(os.path.join(args.out, "embeddings.pt"))
    for job in jobs:
        name = job["name"]
        output = os.path.join(args.out, f"kandinsky-{name}.mp4")
        for attempt in range(2):
            begun = time.time()
            last_step = [begun]

            def on_step(_pipe, index, _timestep, kwargs):
                last_step[0] = time.time()
                emit("progress", message=f"Kandinsky « {name} » : étape {index + 1}/{args.steps} ({time.time() - begun:.0f} s)")
                return kwargs

            if device == "cuda":
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
            try:
                result = pipe(
                    prompt_embeds=embeddings[name]["prompt_embeds"],
                    pooled_prompt_embeds=embeddings[name]["pooled_prompt_embeds"],
                    height=args.height,
                    width=args.width,
                    num_frames=args.frames,
                    frame_rate=float(args.fps),
                    num_inference_steps=args.steps,
                    guidance_scale=1.0,
                    generator=torch.Generator().manual_seed(args.seed),
                    callback_on_step_end=on_step,
                )
                break
            except torch.cuda.OutOfMemoryError:
                if attempt or device != "cuda":
                    raise
                # 8 Go ne suffisent pas pour le modèle entier : il passe sur la carte couche par couche (plus lent).
                emit("progress", message="Mémoire de la carte graphique pleine : Kandinsky repart morceau par morceau (plus lent).")
                pipe.remove_all_hooks()
                gc.collect()
                torch.cuda.empty_cache()
                pipe.enable_sequential_cpu_offload()
                offload = "sequential"
        seconds = time.time() - begun
        encode_video(result.frames[0], fps=args.fps, output_path=output, audio=result.audio[0][None], audio_sample_rate=pipe.audio_sample_rate)
        emit(
            "result",
            name=name,
            file=os.path.basename(output),
            seconds=round(seconds, 1),
            denoise_seconds=round(last_step[0] - begun, 1),
            peak_vram_gb=gib(torch.cuda.max_memory_allocated()) if device == "cuda" else None,
            offload=offload,
            device=torch.cuda.get_device_name(0) if device == "cuda" else "cpu",
        )
    return load_seconds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--phase", choices=["all", "encode", "generate"], default="all")
    parser.add_argument("--width", type=int, default=832)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--frames", type=int, default=49)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--steps", type=int, default=10)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    with open(args.jobs, encoding="utf-8") as f:
        jobs = json.load(f)
    os.makedirs(args.out, exist_ok=True)
    try:
        encode_seconds = encode(args, jobs) if args.phase in ("all", "encode") else None
        load_seconds = generate(args, jobs) if args.phase in ("all", "generate") else None
        emit("done", encode_seconds=encode_seconds and round(encode_seconds, 1), load_seconds=load_seconds and round(load_seconds, 1))
    except Exception as err:  # Une seule ligne lisible pour Jaris ; le détail part sur stderr.
        import traceback

        traceback.print_exc()
        emit("error", message=f"{type(err).__name__} : {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
