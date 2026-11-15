#!/usr/bin/env bash
# Keep evidence failure independent from owned container/profile cleanup.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ ${GITHUB_REPOSITORY:-} == openai/openai-agents-js ]]
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

root = Path('/etc/openai-agents-native-docker')
directory = Path('results/native-docker')
directory.mkdir(parents=True, exist_ok=True)
run_id, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
if not re.fullmatch('[0-9]+', run_id) or not re.fullmatch('[0-9]+', attempt):
    raise SystemExit('Invalid run identity')
name = f'agents-native-ci-{run_id}-{attempt}'
receipt = dict(profile=name, sourceCommit=None, runId=run_id, runAttempt=attempt, auditJournalExit=None, auditMatchCount=0, removed=[], remaining=None, profileRemoved=False, profileAbsent=False, filesRemoved=False, failures=[])

def require(value, message):
    if not value:
        raise RuntimeError(message)

def run(*args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)

def docker(*args):
    result = run('/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args)
    require(result.returncode == 0, result.stderr)
    return result.stdout

def trusted(path, directory=False):
    mode = path.lstat()
    require(mode.st_uid == 0 and not mode.st_mode & 0o022, 'Untrusted cleanup policy')
    require(stat.S_ISDIR(mode.st_mode) if directory else stat.S_ISREG(mode.st_mode), 'Unexpected cleanup file type')

# Installed files can corroborate removal, but never gate the run-derived revocation.
files, manifest, expected_seccomp, files_owned = {}, None, None, True
try:
    trusted(root, directory=True)
    for filename in ('manifest.json', 'apparmor.profile', 'seccomp.json'):
        path = root/filename
        try:
            trusted(path)
            files[filename] = path.read_bytes()
        except FileNotFoundError:
            receipt['failures'].append('Missing installed file: '+filename)
        except Exception:
            files_owned = False
            raise
except FileNotFoundError:
    receipt['failures'].append('Installed policy directory missing')
except Exception as error:
    files_owned = False
    receipt['failures'].append('Files: '+str(error))
try:
    manifest = json.loads(files['manifest.json'])
    if (manifest['apparmor']['name'], manifest['runId'], manifest['runAttempt']) != (name, run_id, attempt):
        files_owned = False
        raise RuntimeError('Foreign cleanup manifest')
    require(re.fullmatch('sha256:[a-f0-9]{64}', manifest['imageId']), 'Invalid manifest image')
    receipt['sourceCommit'] = manifest['sourceCommit']
    for key, filename in [('apparmor', 'apparmor.profile'), ('seccomp', 'seccomp.json')]:
        if filename in files:
            if hashlib.sha256(files[filename]).hexdigest() != manifest[key]['sha256']:
                files_owned = False
                raise RuntimeError('Cleanup policy bytes changed')
except Exception as error:
    manifest = None
    receipt['failures'].append('Manifest: '+str(error))
if manifest is None and files:
    try:
        names = run('apparmor_parser', '--names', '--skip-kernel-load', '--skip-cache', input=files['apparmor.profile'].decode())
        require(names.returncode == 0 and names.stdout.splitlines() == [name], 'Installed file ownership unproven')
    except Exception as error:
        files_owned = False
        receipt['failures'].append('File identity: '+str(error))
try:
    expected_seccomp = json.loads(files['seccomp.json'])
    if not files_owned:
        expected_seccomp = None
except Exception:
    pass
image = os.environ.get('CODEX_DOCKER_TEST_IMAGE', '')
if manifest is not None:
    if image and image != manifest['imageId']:
        files_owned = False
        expected_seccomp = None
        receipt['failures'].append('Live cleanup image changed')
    image = image or manifest['imageId']

# Audit/observation failures cannot suppress owned-container reconciliation.
try:
    since = (Path(os.environ['RUNNER_TEMP'])/'native-docker-profile-start').read_text().strip()
    journal = run('/usr/bin/sudo', 'journalctl', '-k', '--since', since, '--no-pager')
    records = [row for row in journal.stdout.splitlines() if f'profile="{name}"' in row]
    (directory/'profile-audit.log').write_text('\n'.join(records) + ('\n' if records else ''))
    (directory/'audit-error.txt').write_text(journal.stderr)
    receipt.update(auditJournalExit=journal.returncode, auditMatchCount=len(records))
    require(journal.returncode == 0 and records, 'Unique kernel audit collection failed')
except Exception as error:
    receipt['failures'].append('Audit: '+str(error))

try:
    query = ('ps', '-aq', '--no-trunc', '--filter', f'label=agents-native-ci-profile={name}')
    for identifier in docker(*query).split():
        try:
            require(re.fullmatch('[a-f0-9]{64}', identifier), 'Invalid owned container ID')
            require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Current immutable image unavailable')
            (row,) = json.loads(docker('inspect', '--type', 'container', identifier))
            require((row['Id'], row['Image'], row['Config']['Labels'].get('agents-native-ci-profile'), row['AppArmorProfile']) == (identifier, image, name, name), 'Container outside owned run')
            host = row['HostConfig']
            require(host['Privileged'] is False and not host.get('CapAdd') and not host.get('Devices') and not host.get('DeviceRequests') and host['NetworkMode'] == 'none', 'Owned container authority changed')
            options = host.get('SecurityOpt') or []
            require(len(options) == 2 and 'apparmor='+name in options, 'Owned security options changed')
            seccomp = [value.removeprefix('seccomp=') for value in options if value.startswith('seccomp=')]
            require(expected_seccomp is not None and len(seccomp) == 1 and json.loads(seccomp[0]) == expected_seccomp, 'Owned seccomp unavailable or changed')
            docker('rm', '-f', identifier)
            receipt['removed'].append(identifier)
        except Exception as error:
            receipt['failures'].append('Container: '+str(error))
    receipt['remaining'] = docker(*query).split()
    require(not receipt['remaining'], 'Owned containers remain; refusing profile unload')
    profiles = run('/usr/bin/sudo', 'cat', '/sys/kernel/security/apparmor/profiles')
    require(profiles.returncode == 0, 'Profile inspection failed')
    present = lambda output: any(row.startswith(name+' ') or row.startswith(name+'/') for row in output.splitlines())
    if present(profiles.stdout):
        # Remove only the exact current-run name, even if installed metadata broke.
        removed = run('/usr/bin/sudo', 'apparmor_parser', '--remove', '--skip-cache', input=f'profile {name} {{}}\n')
        require(removed.returncode == 0, 'Profile unload failed')
        receipt['profileRemoved'] = True
    profiles = run('/usr/bin/sudo', 'cat', '/sys/kernel/security/apparmor/profiles')
    require(profiles.returncode == 0, 'Profile absence inspection failed')
    receipt['profileAbsent'] = not present(profiles.stdout)
    require(receipt['profileAbsent'], 'Owned profile remains')
    require(files_owned, 'Installed files outside trusted ownership; preserving files')
    for filename in files:
        trusted(root/filename)
        require(run('/usr/bin/sudo', 'rm', '--', str(root/filename)).returncode == 0, 'Owned policy file removal failed')
    try:
        trusted(root, directory=True)
    except FileNotFoundError:
        pass
    else:
        require(run('/usr/bin/sudo', 'rmdir', '--', str(root)).returncode == 0, 'Owned policy directory removal failed')
    receipt['filesRemoved'] = True
except Exception as error:
    receipt['failures'].append('Cleanup: '+str(error))
(directory/'cleanup.json').write_text(json.dumps(receipt, indent=2)+'\n')
raise SystemExit(bool(receipt['failures']))
PY
