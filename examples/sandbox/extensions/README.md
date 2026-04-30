# Cloud Sandbox Extension Examples

These examples mirror the Python sandbox extension runners and keep the same environment-variable names and flag shapes where that makes sense.

They intentionally stay small:

1. Build a tiny manifest in memory.
2. Create a `SandboxAgent` that inspects that workspace through one shell tool.
3. Run the agent against the requested cloud backend.

Unlike the first-party Unix-local and Docker examples, these scripts depend on provider clients under dedicated subpaths such as `@openai/agents-extensions/sandbox/cloudflare`. Each example also depends on the matching provider SDK and credentials or endpoint configuration.

Sandbox-specific SDK types such as `SandboxAgent` and `Manifest` now come from `@openai/agents/sandbox`, while generic runtime types such as `Runner` still come from `@openai/agents`.

## Common setup

All scripts require `OPENAI_API_KEY` because they call the model through the normal `Runner` path.

These scripts read credentials from the current shell environment. They do not load `.env` or `.env.local` automatically, so if you keep secrets in a local env file, load that file into your shell before running an example:

```bash
set -a
source .env.local
set +a
```

## E2B

Required environment variables:

```bash
export OPENAI_API_KEY=...
export E2B_API_KEY=...
```

How to get `E2B_API_KEY`:

1. Sign in to the E2B dashboard at `https://e2b.dev/dashboard`.
2. Create or copy an API key from the dashboard.
3. Export it in your shell before running the example.

E2B also has a CLI access token for `e2b auth login`, but E2B documents that token as CLI-only. This example checks `E2B_API_KEY` explicitly at startup, so CLI login on its own is not enough.

Run:

```bash
pnpm -F sandbox start:e2b -- --stream
```

## Modal

Required environment variables:

```bash
export OPENAI_API_KEY=...
```

Modal authentication can come from either of these sources:

1. A local Modal config file, typically created by `modal setup` or `modal token set`, usually at `~/.modal.toml`.
2. Environment variables:

```bash
export MODAL_TOKEN_ID=...
export MODAL_TOKEN_SECRET=...
```

If you already authenticated with the Modal CLI locally, you usually do not need to export the token variables again. The config path can also be overridden with `MODAL_CONFIG_PATH`.

Run:

```bash
pnpm -F sandbox start:modal -- --stream
```

## Cloudflare

Required environment variables:

```bash
export OPENAI_API_KEY=...
export CLOUDFLARE_SANDBOX_WORKER_URL=...
```

Optional bearer auth:

```bash
export CLOUDFLARE_SANDBOX_API_KEY=...
```

Cloudflare Sandbox SDK is currently available on the Workers Paid plan. You must deploy a Worker-backed sandbox endpoint first, then point this example at that deployment.

This example expects a worker created from the Cloudflare Sandbox bridge template:

```bash
npm create cloudflare@latest -- my-sandbox --template=cloudflare/sandbox-sdk/bridge/worker
```

Cloudflare's Sandbox SDK guides also require Docker locally when you deploy with Wrangler because the container image is built during `wrangler deploy`.

After creating the project, deploy it and copy the worker URL:

```bash
cd my-sandbox
npx wrangler deploy
```

Point `CLOUDFLARE_SANDBOX_WORKER_URL` at that deployed worker. A generic Worker URL will not expose the bridge endpoints this example expects.

If your bridge worker enforces bearer auth, set `CLOUDFLARE_SANDBOX_API_KEY` to the same secret value that worker expects. This is not a generic Cloudflare account API token; this example forwards it as `Authorization: Bearer ...` to your worker.

Run:

```bash
pnpm -F sandbox start:cloudflare -- --stream
```

## Vercel

Required environment variables:

```bash
export OPENAI_API_KEY=...
```

Recommended local setup for `VERCEL_OIDC_TOKEN`:

1. Link this directory to the Vercel project you want to use for Sandbox auth:

```bash
vercel link
```

If the Vercel CLI is not authenticated yet, this command prompts you to sign in first.

2. Pull the development environment variables for that linked project:

```bash
vercel env pull .env.local
```

This writes `VERCEL_OIDC_TOKEN` into `.env.local`. The development token expires after 12 hours, so rerun `vercel env pull .env.local` if authentication starts failing.

3. Load `.env.local` into your current shell before starting the example:

```bash
set -a
source .env.local
set +a
```

When this code runs on Vercel, the platform manages OIDC automatically and you do not need to set `VERCEL_OIDC_TOKEN` yourself.

Run:

```bash
pnpm -F sandbox start:vercel -- --stream
```

## Blaxel

Recommended local setup:

1. Install the Blaxel CLI and sign in first:

```bash
bl login
```

If you have access to multiple workspaces, confirm which one is active:

```bash
bl workspaces
```

This is the easiest way to verify that the workspace exists and that your account can access it before running the example.

This example currently expects these environment variables at startup:

```bash
export OPENAI_API_KEY=...
export BL_API_KEY=...
export BL_WORKSPACE=...
```

How to get `BL_API_KEY` and `BL_WORKSPACE`:

1. Sign in to the Blaxel console at `https://app.blaxel.ai`.
2. Create an API key in `Profile > Security`.
3. Copy your workspace name from the console URL. Blaxel documents this as the `{workspace}` part of `app.blaxel.ai/{workspace}`.

Set them in your shell before running the example:

```bash
export BL_WORKSPACE=your-workspace
export BL_API_KEY=your-api-key
export BL_REGION=us-pdx-1
```

You can also keep them in a local env file and load that file into your shell first:

```bash
cat > .env.local <<'EOF'
BL_WORKSPACE=your-workspace
BL_API_KEY=your-api-key
BL_REGION=us-pdx-1
EOF

set -a
source .env.local
set +a
```

Blaxel SDKs can authenticate from CLI login or local config, and starting with `bl login` is recommended for local setup. This example still checks `BL_API_KEY` and `BL_WORKSPACE` explicitly at startup, so export both values from the same workspace you logged into.

For production-style access that should not depend on a personal user account, Blaxel recommends using service accounts.

Run:

```bash
pnpm -F sandbox start:blaxel -- --stream
```

## Daytona

Required environment variables:

```bash
export OPENAI_API_KEY=...
export DAYTONA_API_KEY=...
```

How to get `DAYTONA_API_KEY`:

1. Sign in to the Daytona Dashboard at `https://app.daytona.io`.
2. Click `Create Key`.
3. Choose the permissions and expiration you want.
4. Copy the API key and export it in your shell before running the example.

Optional Daytona environment variables:

```bash
export DAYTONA_API_URL=...
export DAYTONA_TARGET=us
```

Use `DAYTONA_API_URL` when you are targeting a self-hosted or non-default Daytona API endpoint. Use `DAYTONA_TARGET` when you want to force a specific target region such as `us` or `eu`.

The Daytona SDK can read configuration from environment variables or a `.env` file, but this example still checks `DAYTONA_API_KEY` explicitly at startup, so make sure it is present in your shell environment first.

Run:

```bash
pnpm -F sandbox start:daytona -- --stream
```

## Runloop

Required environment variables:

```bash
export OPENAI_API_KEY=...
export RUNLOOP_API_KEY=...
```

How to get `RUNLOOP_API_KEY`:

1. Create a Runloop account or sign in at `https://platform.runloop.ai`.
2. Open the `Settings` page in the Runloop Dashboard.
3. Create an API key.
4. Export it in your shell before running the example.

The Runloop SDK quickstart uses the same `RUNLOOP_API_KEY` variable name, and this example also checks it explicitly at startup, so it must already be present in your shell environment when you launch `start:runloop`.

Run:

```bash
pnpm -F sandbox start:runloop -- --stream
```
