#!/usr/bin/env python3
"""
QLoRA fine-tuning sidecar (Unsloth + TRL). Trains a LoRA adapter on a chat-format
JSONL dataset produced by the dataset generator and saves it to --out.

Progress is emitted as JSON-lines on stdout for the Node training-worker to parse:
  {"type":"start","total_steps":N}
  {"type":"step","step":N,"loss":x,"vram_mb":y}
  {"type":"done","adapter_path":"..."}
  {"type":"error","message":"..."}

Run under WSL2 + CUDA (see README). Example:
  python train.py --dataset ds.jsonl --out ./adapters/1 \
    --base-model unsloth/Qwen2.5-Coder-7B-bnb-4bit --max-steps 60
"""
import argparse
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def vram_mb():
    try:
        import torch
        if torch.cuda.is_available():
            return int(torch.cuda.memory_reserved() / (1024 * 1024))
    except Exception:
        pass
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-model", default="unsloth/Qwen2.5-Coder-7B-bnb-4bit")
    ap.add_argument("--max-steps", type=int, default=60)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--seq-len", type=int, default=2048)
    ap.add_argument("--lora-r", type=int, default=16)
    args = ap.parse_args()

    try:
        from unsloth import FastLanguageModel
        from datasets import load_dataset
        from trl import SFTTrainer, SFTConfig
        from transformers import TrainerCallback
        import torch
    except Exception as e:  # pragma: no cover - import-time env failure
        emit({"type": "error", "message": f"import failed: {e}"})
        sys.exit(1)

    try:
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=args.base_model,
            max_seq_length=args.seq_len,
            load_in_4bit=True,
        )
        model = FastLanguageModel.get_peft_model(
            model,
            r=args.lora_r,
            lora_alpha=args.lora_r * 2,
            lora_dropout=0.0,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"],
            use_gradient_checkpointing="unsloth",
        )

        def fmt(rows):
            texts = [
                tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False)
                for m in rows["messages"]
            ]
            return {"text": texts}

        ds = load_dataset("json", data_files=args.dataset, split="train").map(
            fmt, batched=True, remove_columns=["messages"]
        )

        class Progress(TrainerCallback):
            def on_train_begin(self, a, state, control, **kw):
                emit({"type": "start", "total_steps": int(state.max_steps or 0)})

            def on_log(self, a, state, control, logs=None, **kw):
                if logs and "loss" in logs:
                    emit({"type": "step", "step": int(state.global_step),
                          "loss": float(logs["loss"]), "vram_mb": vram_mb()})

        trainer = SFTTrainer(
            model=model,
            tokenizer=tokenizer,
            train_dataset=ds,
            dataset_text_field="text",
            max_seq_length=args.seq_len,
            callbacks=[Progress()],
            args=SFTConfig(
                per_device_train_batch_size=1,
                gradient_accumulation_steps=8,
                warmup_steps=5,
                max_steps=args.max_steps,
                num_train_epochs=args.epochs,
                learning_rate=2e-4,
                logging_steps=1,
                optim="adamw_8bit",
                output_dir=args.out + "/checkpoints",
                report_to="none",
            ),
        )
        trainer.train()

        model.save_pretrained(args.out)
        tokenizer.save_pretrained(args.out)
        emit({"type": "done", "adapter_path": args.out})
    except Exception as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
