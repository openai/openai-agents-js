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
# Only a successfully created private directory enters pre-load rollback.
rollback_owned=0
finish_install() {
  install_status=$?
  trap - EXIT
  if [[ $rollback_owned == 1 ]]; then
    if ! sudo python3 - <<'PY'
import os
import stat

root = '/etc/openai-agents-native-docker'
known = {'apparmor.profile', 'seccomp.json', 'manifest.json'}
def need(value):
    if not value:
        raise RuntimeError('Installer rollback ownership changed; preserving files')
def trusted(s, directory=False):
    need(s.st_uid == 0 and not s.st_mode & 0o022)
    need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode))
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    owner = os.fstat(fd)
    trusted(owner, directory=True)
    names = os.listdir(fd)
    need(set(names) <= known)
    entries = {}
    # Validate every entry before the first unlink, including truncated files.
    for name in names:
        item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(item)
            trusted(info)
            entries[name] = (info.st_dev, info.st_ino)
        finally:
            os.close(item)
    for name in names:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        trusted(info)
        need((info.st_dev, info.st_ino) == entries[name])
        os.unlink(name, dir_fd=fd)
    current = os.stat(root, follow_symlinks=False)
    need((current.st_dev, current.st_ino) == (owner.st_dev, owner.st_ino))
    os.rmdir(root)
finally:
    os.close(fd)
PY
    then
      if [[ $install_status == 0 ]]; then install_status=1; fi
    fi
  fi
  if ! rm -rf -- "$stage_parent"; then
    if [[ $install_status == 0 ]]; then install_status=1; fi
  fi
  exit "$install_status"
}
trap finish_install EXIT
python3 "$base/generate.py" --output-dir "$stage_parent/generated" \
  --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT" \
  --source-commit "$source_commit" --image-id "$CODEX_DOCKER_TEST_IMAGE" \
  --recipe-sha256 "$recipe_sha256"
apparmor_parser --skip-kernel-load --skip-cache --stdout \
  "$stage_parent/generated/apparmor.profile" > "$stage_parent/apparmor.compiled"
# Refuse existing host state; the shared/default profile never enters this route.
sudo mkdir -m 0755 -- /etc/openai-agents-native-docker
rollback_owned=1
for file in apparmor.profile seccomp.json manifest.json; do
  sudo install -o root -g root -m 0644 "$stage_parent/generated/$file" \
    "/etc/openai-agents-native-docker/$file"
done
# Handoff precedes loading: finalizer owns revocation even after partial load.
rollback_owned=0
sudo apparmor_parser --replace --skip-cache /etc/openai-agents-native-docker/apparmor.profile
# The calling workflow sets its qualifier env explicitly from this fixed path.
printf '%s\n' 'Diagnostic manifest: /etc/openai-agents-native-docker/manifest.json'

# Record installation at the owner, after successful load and enforce observation.
sudo grep -Fx "agents-native-ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT (enforce)" \
  /sys/kernel/security/apparmor/profiles
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const m=JSON.parse(readFileSync('/etc/openai-agents-native-docker/manifest.json','utf8'));
writeFileSync('results/native-docker/installed-policy.json',JSON.stringify({profile:m.apparmor.name,sourceCommit:m.sourceCommit,runId:m.runId,runAttempt:m.runAttempt,enforced:true},null,2)+'\n');
JS
