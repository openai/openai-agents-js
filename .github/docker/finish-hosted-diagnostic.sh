#!/usr/bin/env bash
# Collect only this job's synthetic policy evidence, then unload only its profile.
set -uo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || exit 78
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] || exit 78
profile="agents-native-ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
directory=/etc/openai-agents-native-docker
mkdir -p results/native-docker
status=0
# Evidence errors must not prevent resource/profile cleanup.
if [[ -f "$RUNNER_TEMP/native-docker-profile-start" ]]; then
  since=$(cat "$RUNNER_TEMP/native-docker-profile-start")
  sudo journalctl -k --since "$since" --no-pager 2>results/native-docker/audit-error.txt \
    | python3 -c 'import sys; needle="profile=\""+sys.argv[1]+"\""; sys.stdout.writelines(line for line in sys.stdin if needle in line)' "$profile" \
    > results/native-docker/profile-audit.log || status=1
fi
if [[ ! -f "$directory/manifest.json" ]]; then
  printf '%s\n' 'No installed manifest; no profile load could have completed.' >results/native-docker/profile-cleanup.txt
  exit "$status"
fi
# Bind cleanup to this run and immutable root-owned files before using sudo.
python3 - "$profile" <<'PY' || exit 78
import hashlib,json,os,stat,sys
from pathlib import Path
root=Path('/etc/openai-agents-native-docker')
for path in (root,root/'manifest.json',root/'apparmor.profile',root/'seccomp.json'):
 s=path.lstat()
 if s.st_uid!=0 or s.st_mode&0o022 or stat.S_ISLNK(s.st_mode): raise SystemExit('Untrusted cleanup policy')
m=json.loads((root/'manifest.json').read_text())
if m['apparmor']['name']!=sys.argv[1] or m['runId']!=os.environ['GITHUB_RUN_ID'] or m['runAttempt']!=os.environ['GITHUB_RUN_ATTEMPT']: raise SystemExit('Cleanup profile binding changed')
for key,file in [('apparmor','apparmor.profile'),('seccomp','seccomp.json')]:
 if hashlib.sha256((root/file).read_bytes()).hexdigest()!=m[key]['sha256']: raise SystemExit('Cleanup policy bytes changed')
PY
ids=$(/usr/bin/docker --host unix:///var/run/docker.sock ps -aq --filter "label=agents-native-ci-profile=$profile") || status=1
for id in $ids; do
  [[ $id =~ ^[a-f0-9]{12,64}$ ]] || { status=1; continue; }
  /usr/bin/docker --host unix:///var/run/docker.sock rm -f "$id" >>results/native-docker/profile-cleanup.txt 2>&1 || status=1
done
remaining=$(/usr/bin/docker --host unix:///var/run/docker.sock ps -aq --filter "label=agents-native-ci-profile=$profile") || exit 1
[[ -z "$remaining" ]] || exit 1
sudo apparmor_parser --remove --skip-cache "$directory/apparmor.profile" >>results/native-docker/profile-cleanup.txt 2>&1 || exit 1
for file in manifest.json apparmor.profile seccomp.json; do
  sudo rm -- "$directory/$file" || status=1
done
sudo rmdir -- "$directory" || status=1
exit "$status"
