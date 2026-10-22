---
name: python-packaging
description: Building, verifying, publishing and installing a Python package, and serving a local package index for pip --index-url. Use when writing pyproject.toml, running python -m build, copying artifacts into an index directory, or installing a package from a custom index.
---

# Python packaging

## Layout and metadata
- Flat layout: pyproject.toml at the project root, the importable package at <root>/<pkg>/__init__.py, and `[tool.setuptools] packages = ["<pkg>"]` so setuptools includes it.
- The version is set in `[project] version`. Keep it identical to any `__version__` string and to the version the install command pins.
- Use `requires = ["setuptools>=64", "wheel"]` with `build-backend = "setuptools.build_meta"`.

## Build and verify
- `pip install build`, then `python3 -m build` in the project root. It writes dist/<name>-<ver>-py3-none-any.whl and a .tar.gz.
- Check the wheel contents with `python3 -m zipfile -l dist/*.whl`. The package's __init__.py must sit at the top level of the wheel, and the filename must carry the expected version.
- Afterwards, remove the leftovers build/ and *.egg-info/ from the project.

## Serving a local index (pypiserver)
- `pip install pypiserver`, copy the artifacts into one directory, then run `pypi-server run -p <port> <dir>`. The simple index is then at http://localhost:<port>/simple/.
- To run it in the background: `nohup pypi-server run -p <port> <dir> > log 2>&1 &`, then `sleep` a few seconds before testing.
- Confirm it with `curl -s http://localhost:<port>/simple/<name>/`. The response should list each artifact with a sha256 fragment. Repeat this after copying new artifacts into the directory.
- `pgrep` may be missing. To check the server process, use `ps aux | grep pypi-server` or the curl check above.
- A server started with nohup does not survive a container restart. Say so in the final report, with the command needed to restart it.

## Installing from the index
- Test in a fresh venv created outside the project directory, so the local source tree cannot shadow the installed package: `python3 -m venv /tmp/t && /tmp/t/bin/pip install --index-url http://localhost:<port>/simple <name>==<ver>`.
- `--index-url` replaces PyPI for that install. Any dependencies must also be on that index, or be added with `--extra-index-url`.
- Then run the real import and call it, and print `importlib.metadata.version("<name>")` to confirm the installed version.
- Delete the test venv when finished.
