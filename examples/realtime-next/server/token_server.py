import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

# Allow local dev origins; adjust for production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3002"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TokenRequest(BaseModel):
    model: str = "gpt-realtime"


# Load .env from this server directory if present
BASE_DIR = Path(__file__).resolve().parent
env_path = BASE_DIR / ".env"
if env_path.exists():
    load_dotenv(env_path)


@app.post("/api/token")
async def get_token(req: TokenRequest):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500, detail="Missing OPENAI_API_KEY environment variable"
        )

    url = "https://api.openai.com/v1/realtime/client_secrets"
    payload = {
        "session": {
            "type": "realtime",
            "model": req.model,
            "tools": [
                {
                    "type": "mcp",
                    "server_label": "deepwiki",
                    "server_url": "https://mcp.deepwiki.com/sse",
                    "require_approval": "always",
                },
                {
                    "type": "mcp",
                    "server_label": "dnd",
                    "server_url": "https://dmcp-server.deno.dev/sse",
                    "require_approval": "always",
                },
            ],
        }
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10,
        )

    if resp.status_code >= 400:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=502, detail={"upstream_error": detail})

    data = resp.json()
    return JSONResponse({"token": data.get("value")})
