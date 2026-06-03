#!/usr/bin/env python3
"""
Print GPU info as a single JSON line: {"vram_mb": int, "gpu_name": str, "cuda_ok": bool}.
Used to confirm the training environment (CUDA visible under WSL2) before a run.
"""
import json


def main():
    out = {"vram_mb": 0, "gpu_name": "", "cuda_ok": False}
    try:
        import torch
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            out["cuda_ok"] = True
            out["gpu_name"] = props.name
            out["vram_mb"] = int(props.total_memory / (1024 * 1024))
    except Exception as e:
        out["error"] = str(e)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
