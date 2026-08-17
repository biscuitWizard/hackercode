# Mock function-calling API

An OpenAI-compatible `/v1/chat/completions` server used to drive the HackerCode agent loop without a paid key.

```bash
docker build -f scripts/hackercode-agent/Dockerfile.mock-llm -t hackercode-mock-llm scripts/hackercode-agent
docker run --rm --network host -e MOCK_LLM_PORT=8740 hackercode-mock-llm
```

Or without Docker:

```bash
node scripts/hackercode-agent/mock-llm-server.mjs
```

Then add a provider with base URL `http://127.0.0.1:8740/v1` and model `mock-agent`.

Scripted prompts:

- `HELLO_ONLY` → `HELLO_OK` (no tools)
- `CORE_LOOP: create notes.txt...` → `list_dir`, then `create_file`, then `CORE_LOOP_DONE`
- a user message plus an image → `SAW_IMAGE`
