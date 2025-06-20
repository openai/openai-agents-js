# Publishing to GitHub Packages

This repository publishes packages to GitHub Packages under the `@chollier` scope.

## Setup for Publishing

### 1. Create GitHub Repository

Create a new repository at `https://github.com/chollier/openai-agents-js`

### 2. Set up Authentication

Create a Personal Access Token (PAT) with `packages:write` permission:

1. Go to GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)
2. Generate new token with `write:packages` scope
3. Copy the token

### 3. Configure npm authentication locally

```bash
# Set your GitHub token
export GITHUB_TOKEN=your_personal_access_token_here

# Or add it to your shell profile
echo "export GITHUB_TOKEN=your_token" >> ~/.bashrc
```

### 4. Build and Publish

```bash
# Install dependencies
pnpm install

# Build packages
pnpm build

# Publish all packages
pnpm ci:publish
```

## Installing Packages

### For end users installing your packages:

1. Create `.npmrc` in your project root:

```
@chollier:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

2. Install packages:

```bash
npm install @chollier/agents
# or
npm install @chollier/agents-core
npm install @chollier/agents-realtime
# etc.
```

### For React Native projects:

The packages are configured with proper export conditions for React Native. The bundler should automatically pick up the React Native-specific shims when `react-native` condition is detected.

## Package Structure

- `@chollier/agents` - Main package (depends on all others)
- `@chollier/agents-core` - Core functionality
- `@chollier/agents-openai` - OpenAI integration
- `@chollier/agents-realtime` - Realtime/voice agents
- `@chollier/agents-extensions` - Extensions (AI SDK, Twilio, etc.)

## Automated Publishing

The repository includes a GitHub Actions workflow that automatically publishes packages when:

- A tag starting with `v` is pushed (e.g., `v0.0.10`)
- The workflow is manually triggered

To create a release:

```bash
git tag v0.0.10
git push origin v0.0.10
```
