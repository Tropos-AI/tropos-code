# Providers and models

Tropos thinks with a model from a provider you choose. Seventeen providers are built in, from Anthropic and OpenAI to a
local Ollama, and you can add any endpoint that speaks the OpenAI or Anthropic API: a proxy, vLLM, LiteLLM or a
hosted gateway. You can switch models at any time, give each specialist its own, and let the chief pick a cheaper or
stronger model for a single task.

## Built-in providers

| Provider | Id | Key variable | API |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, or `ant auth login` | Messages |
| OpenAI | `openai` | `OPENAI_API_KEY` | Responses |
| xAI | `xai` | `XAI_API_KEY` | Responses |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | Chat Completions |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Chat Completions |
| NVIDIA | `nvidia` | `NVIDIA_API_KEY` | Chat Completions |
| Google Gemini | `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Chat Completions |
| Groq | `groq` | `GROQ_API_KEY` | Chat Completions |
| Mistral | `mistral` | `MISTRAL_API_KEY` | Chat Completions |
| Together AI | `together` | `TOGETHER_API_KEY` | Chat Completions |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` | Chat Completions |
| Moonshot (Kimi) | `moonshot` | `MOONSHOT_API_KEY` | Chat Completions |
| Z.ai (GLM) | `zai` | `ZAI_API_KEY` | Chat Completions |
| Qwen (Alibaba Cloud) | `qwen` | `DASHSCOPE_API_KEY` | Chat Completions |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | Chat Completions |
| Ollama (local) | `ollama` | none (`http://localhost:11434/v1`) | Chat Completions |
| LM Studio (local) | `lmstudio` | none (`http://localhost:1234/v1`) | Chat Completions |

Model lists aren't hard-coded: Tropos asks each provider for its current models.

Anthropic models keep server-side compaction and prompt caching. Cost is shown for Anthropic models, and for
OpenRouter and xAI, which report it; elsewhere it shows as unknown (and `cost_usd` is `null` in JSON output).

## Connecting a provider

Any one of these:

- **Setup:** `tcode onboard`, the Provider step (the key is checked with a real request first).
- **Dashboard:** Settings → Models & keys, then connect the provider and paste its key.
- **In a session:** `/providers` lists them, asks for a key the first time, and shows each provider's models.
- **Ask the agent:** "connect OpenRouter, here is my key: sk-or-…". The key is sealed before the model sees it.
- **Environment:** export the provider's variable, for example `export DEEPSEEK_API_KEY=…`.

A key saved by Tropos goes to `~/.tropos/credentials.json`, readable only by you (mode 0600), and is sent only to that
provider. A provider's environment variable wins over a saved key.

## Model ids

Model ids are `provider/model`; an id without a provider prefix is an Anthropic model.

```bash
tcode --model deepseek/deepseek-chat
tcode --model openrouter/<vendor>/<model>
tcode --model claude-opus-5-5              # the default
DEEPSEEK_API_KEY=… tcode -p "fix the failing test" --model deepseek/deepseek-chat
```

Agent files and specialists may also use the aliases `opus`, `sonnet` and `haiku`.

## Choosing the model

| Where | How |
|---|---|
| One run | `tcode --model <id>`, `tcode --effort <level>` |
| In a session | `/model` opens a picker: search, favourites (`ctrl+f`), recent models, and `←`/`→` for effort. `/model <id>` sets one directly; `/effort` picks the effort |
| Dashboard | The model picker in Chat; the default model and effort in Settings → Models & keys |
| Default for new sessions | `model` and `effort` in `~/.tropos/settings.json`, or ask the agent ("use claude-sonnet-5-5 by default") |

Effort is `low`, `medium`, `high` (default), `xhigh` or `max`; providers with fewer levels get the closest one at or
below it. Favourites and recent models are kept in `~/.tropos/models.json`.

## Specialists and per-task models

Each specialist can have its own model; without one it uses the chief's. The chief can also pick a model for a single
delegated task (a cheaper, faster or stronger one), and you can ask for one. A model on another provider is checked
first, so a missing key is a clear message rather than a failed run. See
[Agents and specialists](agents-and-specialists.md#models-per-specialist-and-per-task).

## Adding your own endpoint

### In the dashboard

Settings → Models & keys → **Add a provider**:

| Field | What to enter |
|---|---|
| Name | Any name; it becomes the id (`My gateway` → `my-gateway`), and models are picked as `my-gateway/<model>` |
| API | OpenAI-compatible (Chat Completions), Anthropic-compatible (Messages), or OpenAI Responses |
| Base URL | The full address, like `https://api.example.com/v1` (Anthropic-compatible: `https://gateway.example.com`). `http://` is accepted for this computer or your network |
| API key (optional) | Saved to `~/.tropos/credentials.json` and sent only to this address |

### In settings.json

```json
{
  "providers": {
    "my-vllm": { "name": "My vLLM", "baseURL": "http://localhost:8000/v1" },
    "my-gateway": { "name": "My gateway", "api": "anthropic", "baseURL": "https://gateway.example.com" },
    "ollama": { "baseURL": "http://gpu-box:11434/v1" }
  }
}
```

- A new id adds an endpoint; `api` is `chat` (default), `responses` or `anthropic`.
- A built-in id with a `baseURL` moves that provider, for example Ollama on another machine.
- An added endpoint's key comes from `<ID>_API_KEY` (`my-vllm` → `MY_VLLM_API_KEY`) or a key saved in the dashboard.
  An Anthropic-compatible endpoint never receives your `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.
- Provider ids are lowercase letters, digits and dashes.

Only your own settings files may set `providers`, or a model on another provider. A repository's
`.tropos/settings.json` may only choose among Anthropic models: anything else would send your session, and your key,
wherever the repository chose.

## Models that can't see images

Images you attach reach models that can see them as images. DeepSeek and Cerebras models read text only, and get a
short note in each image's place; another model that refuses images gets the note from then on. See
[Images and attachments](images-and-attachments.md).

## Troubleshooting

- **"no key" or an authentication error.** Check `tcode status` (providers row) or `tcode doctor --deep`, which lists
  models with each key. An environment variable wins over a saved key: an old exported key can hide a new saved one.
- **A model id isn't found.** Use `/providers` or the dashboard picker to see the provider's current model ids, and
  write them as `provider/model`.
- **A repository's model setting is ignored.** Repository settings can't pick a model on another provider; you get a
  warning naming what was ignored. Put it in `~/.tropos/settings.json`.
- **A local model doesn't respond.** Check that Ollama or LM Studio runs and serves on the address shown above, or set
  its `baseURL`.
