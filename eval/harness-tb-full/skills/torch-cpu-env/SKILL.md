---
name: torch-cpu-env
description: Getting a Python with torch and transformers running in a bare Linux container with no python on PATH and no GPU, and running multi-process torch tests with torchrun
---
# Torch on CPU in a bare container

## Find or install Python
- Check `command -v python3 python` first. A fresh container often has neither.
- On Ubuntu/Debian run `apt-get update` before `apt-get install`, in the same command. Until the index exists, install fails with 'Unable to locate package'.
- Install `python3 python3-venv python3-pip`.

## Keep the environment out of the project
- Create the venv outside the project, for example `python3 -m venv /tmp/venv`.
- CPU wheels: `/tmp/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu`, then `/tmp/venv/bin/pip install transformers`.
- Verify with `/tmp/venv/bin/python -c "import torch, transformers; print(torch.__version__, transformers.__version__)"`.

## Running multi-process tests
- Use `torchrun --nproc_per_node N script.py` with the gloo backend on CPU.
- Set `OMP_NUM_THREADS=1` so several ranks don't oversubscribe the cores.
- Give each torchrun run its own `--master_port` so back-to-back runs don't collide.
- Wrap every run in `timeout`. A hung collective blocks forever, and a broken copy that skips a send or receive will hang.
- Importing a project module writes `__pycache__` into the project. Set `PYTHONDONTWRITEBYTECODE=1`, or delete the directory afterwards, so the project stays clean.
