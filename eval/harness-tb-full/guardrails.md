# Standing rules

- Derive results from the provided inputs. Don't search logs, session history, caches or other directories for expected output or a reference solution.
- Build only what the task asks for. Don't add behaviour nobody asked for. Keep scratch scripts, virtualenvs, caches and intermediate output outside the project (for example in /tmp), and before finishing remove artifacts your runs created there, such as __pycache__. If you leave an extra file in the project, name it and say why in the final answer.
- Installing packages changes the environment. Install only what the build or a check needs, and say what was installed and where.
- Build a candidate deliverable at a scratch path, run the full checks on that copy, and copy it to the final path only after the checks pass. Do not write the final file in the same step as a check that has not yet run.
- After the last write, re-run the checks on the final file as it now sits, with the task's exact command, and report what that run showed. Do not cite an earlier run as covering code edited after it.
- When a check fails, locate the failing region before changing anything, change only that part, then re-run all checks.
- A check that shares an assumption with the code under test, or reuses data you tuned on, does not validate that assumption. Say so in the report; don't present it as independent verification.
- Report measured numbers with their margins and the conditions they depend on. Do not claim a pass that the last run did not show.
- Stop only processes you started, by PID. Never use a broad pattern (pkill -f, pgrep | xargs kill) that can match your own shell command.

# Skills

- Before starting a task, load the harness-lessons-general skill.
- When building C or C++ code or installing a compiler, load the cpp-toolchain skill.
- When a C++ binary crashes, leaks memory, or behaves differently between builds, load the cpp-debugging skill.
- When inspecting or extracting data from a compiled ELF binary, load the elf-binary skill.
- When analyzing a compiled executable to recover a hidden value or exploit an input bug (reverse engineering or binary exploitation), load the binary-analysis skill.
- When attacking a cipher, hash or key schedule, or recovering a key from encryption-oracle outputs, load the cipher-cryptanalysis skill.
- When recovering deleted or overwritten data, carving disk images or raw dumps, or verifying recovered file contents, load the forensic-carving skill.
- When building, packaging, publishing or installing a Python package, or serving a local package index, load the python-packaging skill.
- When writing, running or testing a Flask JSON API or another Python HTTP service, especially one that must run in the background, load the flask-json-service skill.
- When downloading, loading or running inference with a Hugging Face transformers model, load the hf-transformers-local-model skill.
- When the task needs Python with torch or transformers installed, or multi-process torch tests, load the torch-cpu-env skill.
- When reading a PyTorch .pth or .pt checkpoint without torch, load the torch-checkpoint-no-torch skill.
- When implementing or testing a Llama model split across ranks or pipeline stages, load the llama-pipeline-parallel skill.
- When running or porting a digit classifier on an image, load the mnist-inference skill.
- When recovering a Bayesian network's structure from data, fitting one, intervening on it, or sampling from it, load the bayes-net-causal skill.
- When designing a DNA sequence, gBlock or insert that encodes a fusion protein, load the dna-construct-design skill.
- When fetching PDB, RCSB or FPbase data, load the protein-db-lookup skill.
- When writing, assembling, tuning or testing a Redcode warrior, or running pMARS battles, load the corewars-pmars skill.
