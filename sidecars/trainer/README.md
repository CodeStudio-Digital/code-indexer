# Training sidecar — QLoRA (Unsloth)

Python scripts the Node `training-worker` spawns to fine-tune a small coder model
on a generated JSONL dataset and export it for local serving.

| Script | Purpose |
|--------|---------|
| `train.py` | QLoRA-train a LoRA adapter on a chat JSONL → `--out` |
| `export_gguf.py` | Merge LoRA→base and export a `q4_k_m` GGUF for Ollama |
| `hardware_check.py` | Print `{vram_mb, gpu_name, cuda_ok}` to confirm CUDA |

All emit **JSON-lines on stdout** (`{"type":"step",...}`) so the worker can stream
live loss/progress to the UI.

## Platform: WSL2 + CUDA (recommended), not native Windows

`bitsandbytes` (the 4-bit core of QLoRA) only ships reliable CUDA wheels for Linux;
Unsloth is tested on Linux/WSL2. WSL2 uses the GPU through the host's NVIDIA driver
— no separate driver inside WSL.

```sh
# In Windows PowerShell (one time):
wsl --install -d Ubuntu

# Inside WSL2 Ubuntu:
sudo apt update && sudo apt install -y python3-venv build-essential
cd /mnt/d/MCP/sidecars/trainer        # the repo, via the WSL mount
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Confirm the GPU is visible:
python hardware_check.py              # → {"vram_mb": 12288, "gpu_name": "...", "cuda_ok": true}
```

The Node worker invokes these via `wsl.exe -d Ubuntu -- bash -lc "..."`. Because the
data dir is a Windows path, the worker converts it with `wslpath` before passing
`--dataset`/`--out`.

## Smoke test

```sh
python train.py --dataset /path/to/ds.jsonl --out ./adapters/smoke \
  --base-model unsloth/Qwen2.5-Coder-1.5B-bnb-4bit --max-steps 10
```

Expect a decreasing `loss` in the `{"type":"step",...}` lines and a final
`{"type":"done","adapter_path":...}`.

## VRAM notes (RTX 4070 Ti, 12GB)

7B 4-bit trains comfortably with `batch=1`, `grad_accum=8`, `seq_len=2048`,
gradient checkpointing. If you hit OOM: lower `--seq-len`, or pick a 3B base.
Close other GPU apps during a run (Windows/Electron already use ~1–1.5GB).
