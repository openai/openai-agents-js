#!/usr/bin/env bash
# Draft only: load a confined candidate on a disposable GitHub-hosted runner.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
: "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${RUNNER_TEMP:?}"
: "${CODEX_DOCKER_TEST_IMAGE:?}" "${NATIVE_DOCKER_RECIPE:?}"
[[ $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ ]]
[[ $CODEX_DOCKER_TEST_IMAGE =~ ^sha256:[0-9a-f]{64}$ ]]
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_commit=$(git rev-parse HEAD)
recipe_sha256=$(sha256sum -- "$NATIVE_DOCKER_RECIPE" | cut -d ' ' -f 1)
stage_parent=$(mktemp -d -- "$RUNNER_TEMP/native-profile.XXXXXXXX")
trap 'rm -rf -- "$stage_parent"' EXIT
python3 "$base/generate.py" --output-dir "$stage_parent/generated" \
  --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT" \
  --source-commit "$source_commit" --image-id "$CODEX_DOCKER_TEST_IMAGE" \
  --recipe-sha256 "$recipe_sha256"
apparmor_parser --skip-kernel-load --skip-cache --stdout \
  "$stage_parent/generated/apparmor.profile" > "$stage_parent/apparmor.compiled"
# Refuse existing host state; the shared/default profile never enters this route.
sudo test ! -e /etc/openai-agents-native-docker
sudo install -d -o root -g root -m 0755 /etc/openai-agents-native-docker
for file in seccomp.json apparmor.profile manifest.json; do
  sudo install -o root -g root -m 0644 "$stage_parent/generated/$file" \
    "/etc/openai-agents-native-docker/$file"
done
sudo apparmor_parser --replace --skip-cache /etc/openai-agents-native-docker/apparmor.profile
# The calling workflow sets its qualifier env explicitly from this fixed path.
printf '%s\n' 'Diagnostic manifest: /etc/openai-agents-native-docker/manifest.json'
