Quickstart: local token proxy (FastAPI)

Prerequisites:

- Python 3.10+
- Set OPENAI_API_KEY in your environment (the server will use it to request ephemeral client secrets).

Install and run:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
# Run the server on port 8000
 # From the repository root this import may fail with "ModuleNotFoundError: No module named 'server'".
 # Run from the example folder or use the helper script below.
 # Option A: run from the example folder (recommended):
 #   cd examples/realtime-next
 #   uvicorn token_server:app --app-dir server --host 0.0.0.0 --port 8000 --reload
 # Option B: use the helper script (works from any cwd):
 #   ./server/run_token_server.sh
```

Notes:

- The example's client expects the token endpoint at `/api/token` on the same origin. When running Next dev on port 3000 and this FastAPI on port 8000, either run them under the same origin (proxy) or update `getToken()` to call `http://localhost:8000/api/token` directly.
- For production, secure this endpoint and do not expose your `OPENAI_API_KEY` to the browser.

Why you might see "ModuleNotFoundError: No module named 'server'"

- If you run `uvicorn server.token_server:app` from the repository root (or a directory
  that isn't the `examples/realtime-next` folder), Python's module import path won't
  include the `examples/realtime-next` folder and the `server` package can't be found.
- The helper script below and the `--app-dir` option for `uvicorn` ensure the correct
  directory is added to Python's import path.
