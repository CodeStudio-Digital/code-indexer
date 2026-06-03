#!/usr/bin/env python3
"""
Export a trained LoRA adapter to a single merged GGUF for local serving via
Ollama (LoRA is merged into the base — Ollama can't load a bare adapter).

Emits JSON-lines on stdout:
  {"type":"done","gguf_path":"..."}
  {"type":"error","message":"..."}

Example:
  python export_gguf.py --base-model unsloth/Qwen2.5-Coder-7B-bnb-4bit \
    --adapter ./adapters/1 --out ./gguf/1 --quant q4_k_m
"""
import argparse
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-model", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--quant", default="q4_k_m")
    ap.add_argument("--seq-len", type=int, default=2048)
    args = ap.parse_args()

    try:
        from unsloth import FastLanguageModel
    except Exception as e:
        emit({"type": "error", "message": f"import failed: {e}"})
        sys.exit(1)

    try:
        # Load the base, attach the trained adapter, then export merged GGUF.
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=args.adapter,
            max_seq_length=args.seq_len,
            load_in_4bit=True,
        )
        model.save_pretrained_gguf(args.out, tokenizer, quantization_method=args.quant)
        emit({"type": "done", "gguf_path": args.out})
    except Exception as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
