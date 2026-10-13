"""Harbor agent that runs Tropos Code on Terminal-Bench 2.0.

Written against harbor 0.24.0 (see eval/README.md). The tropos binary is not downloaded: it is
built from the current checkout by `bun scripts/eval.ts tb` and uploaded into each task container.
"""

import json
import os
import shlex
from pathlib import Path
from typing import Annotated, Literal, override

from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Prebuilt Linux binaries: tropos-linux-x64-baseline and tropos-linux-arm64.
BIN_DIR = Path(os.environ.get("TROPOS_BIN_DIR", Path(__file__).resolve().parents[2] / "dist" / "eval"))
# x64 task images may run under emulation on Apple Silicon, which lacks AVX2: use the baseline build.
BINARIES = {"x86_64": "tropos-linux-x64-baseline", "aarch64": "tropos-linux-arm64", "arm64": "tropos-linux-arm64"}
LOG = "tropos.jsonl"


class TroposOptions(InstalledAgentOptions):
    reasoning_effort: Annotated[
        Literal["low", "medium", "high", "xhigh", "max"] | None, Cli("--effort")
    ] = Field(default=None, description="Model reasoning effort.")
    max_turns: Annotated[int | None, Cli("--max-turns")] = Field(default=None, description="Maximum model turns.")


class TroposAgent(BaseInstalledAgent):
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)
    options_model = TroposOptions

    @staticmethod
    @override
    def name() -> str:
        return "tropos"

    @override
    def get_version_command(self) -> str | None:
        return "tropos --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        arch = (await self.exec_as_root(environment, command="uname -m")).stdout.strip()
        binary = BINARIES.get(arch)
        if binary is None:
            raise RuntimeError(f"no tropos build for architecture {arch!r}")
        source = BIN_DIR / binary
        if not source.is_file():
            raise FileNotFoundError(f"{source} is missing; build it with `bun scripts/eval.ts tb`")
        await environment.upload_file(source, "/usr/local/bin/tropos")
        await self.exec_as_root(environment, command="chmod 755 /usr/local/bin/tropos && tropos --version")

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model must look like anthropic/claude-opus-5-5 or deepseek/deepseek-flash")
        provider, rest = self.model_name.split("/", 1)
        # Tropos ids carry the provider prefix, except Anthropic's, which work bare.
        model = rest if provider == "anthropic" else self.model_name
        # `bun scripts/eval.ts tb` names the variable holding the model's key (e.g. DEEPSEEK_API_KEY).
        key_env = os.environ.get("TROPOS_KEY_ENV", "ANTHROPIC_API_KEY")
        key = os.environ.get(key_env) or (self.model_connection.api_key if provider == "anthropic" else None)
        if not key:
            raise ValueError(f"{key_env} is not set")
        env = {key_env: key}

        flags = self.build_cli_flags()
        log = (self.environment_logs_dir / LOG).as_posix()
        await self.exec_as_agent(
            environment,
            command=(
                f"tropos -p {shlex.quote(instruction)} --model {shlex.quote(model)} "
                f"--output-format stream-json --dangerously-skip-permissions {flags} "
                f"</dev/null 2>/dev/null | tee {shlex.quote(log)}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        result = last_result(self.logs_dir / LOG)
        if result is None:
            return
        usage = result.get("usage") or {}
        context.n_input_tokens = usage.get("input_tokens")
        context.n_output_tokens = usage.get("output_tokens")
        context.cost_usd = result.get("cost_usd")


def last_result(path: Path) -> dict | None:
    """The final `{"type": "result", ...}` line tropos prints in stream-json mode, if any."""
    if not path.is_file():
        return None
    found = None
    for line in path.read_text(errors="replace").splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("type") == "result":
            found = value
    return found
