import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(tempfile.gettempdir())
SOURCE = Path(__file__).with_name('finish-hosted-diagnostic.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]

class Cleanup(unittest.TestCase):
    def exercise(self, case, source=SOURCE):
        name, image = 'agents-native-ci-123-1', 'sha256:'+'a'*64
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            base = Path(temporary); root = base/'policy'; root.mkdir(mode=0o755); output=base/'results'; output.mkdir()
            policies = {'apparmor.profile': f'profile {name} {{}}\n'.encode(), 'seccomp.json': b'{}'}
            manifest = {'sourceCommit': 'a'*40, 'runId': '123', 'runAttempt': '1', 'imageId': image, 'apparmor': {'name': name, 'sha256': hashlib.sha256(policies['apparmor.profile']).hexdigest()}, 'seccomp': {'sha256': hashlib.sha256(policies['seccomp.json']).hexdigest()}}
            for filename, value in policies.items():
                (root/filename).write_bytes(value);(root/filename).chmod(0o644)
            (root/'manifest.json').write_text(json.dumps(manifest));(root/'manifest.json').chmod(0o644)
            (base/'native-docker-profile-start').write_text('2026-11-15T00:00:00Z')
            present, calls, profile_present = ['1'*64,'2'*64], [], True
            if case in ('directory-only','seccomp-only','apparmor-only','root-missing'):
                for p in root.iterdir():
                    if p.name != {'seccomp-only':'seccomp.json','apparmor-only':'apparmor.profile'}.get(case):p.unlink()
                present=[]
                if case=='root-missing':root.rmdir()
            if case=='missing-manifest':(root/'manifest.json').unlink()
            if case=='malformed-manifest':(root/'manifest.json').write_text('{bad json')
            if case=='missing-image':
                del manifest['imageId'];(root/'manifest.json').write_text(json.dumps(manifest))
            if case=='foreign-manifest':
                manifest['runId']='999';(root/'manifest.json').write_text(json.dumps(manifest));(root/'manifest.json').chmod(0o644);present=[]
            if case=='missing-audit-start':(base/'native-docker-profile-start').unlink()
            if case=='missing-seccomp':(root/'seccomp.json').unlink()
            real_lstat=Path.lstat
            def trusted_stat(path):
                info=real_lstat(path)
                return SimpleNamespace(st_uid=123 if case=='untrusted-root' and path==root else 0,st_mode=info.st_mode)
            def execute(args, **kwargs):
                nonlocal profile_present
                calls.append((args,kwargs))
                def result(stdout='',code=0):return SimpleNamespace(returncode=code,stdout=stdout,stderr='')
                if args[0]=='apparmor_parser':
                    self.assertEqual(args[1:],('--names','--skip-kernel-load','--skip-cache'))
                    return result(name+'\n')
                if args[0]=='/usr/bin/sudo':
                    if args[1]=='journalctl':return result('' if case=='audit-failure' else f'audit apparmor="DENIED" profile="{name}"\naudit profile="unrelated"\n',1 if case=='audit-failure' else 0)
                    if args[1]=='cat':return result(name+' (enforce)\n' if profile_present else '')
                    if args[1]=='apparmor_parser':
                        self.assertEqual(args[2:],('--remove','--skip-cache'))
                        self.assertEqual(kwargs.get('input'),f'profile {name} {{}}\n')
                        profile_present=False;return result()
                    if args[1]=='rm':Path(args[-1]).unlink();return result()
                    if args[1]=='rmdir':Path(args[-1]).rmdir();return result()
                    raise AssertionError(args)
                self.assertEqual(args[:3],('/usr/bin/docker','--host','unix:///var/run/docker.sock'))
                if args[3]=='ps':return result('\n'.join(present))
                if args[3]=='inspect':
                    identifier=args[-1]
                    row={'Id':identifier,'Image':image,'AppArmorProfile':name,'Config':{'Labels':{'agents-native-ci-profile':name}},'HostConfig':{'Privileged':False,'CapAdd':[],'Devices':[],'DeviceRequests':[],'NetworkMode':'none','SecurityOpt':['apparmor='+name,'seccomp={}']}}
                    if identifier=='1'*64:
                        if case=='mismatch':row['Image']='other'
                        if case=='device-request':row['HostConfig']['DeviceRequests']=[{'Count':-1}]
                        if case=='privileged':row['HostConfig']['Privileged']=True
                        if case=='seccomp-mismatch':row['HostConfig']['SecurityOpt']=['apparmor='+name,'seccomp={"wrong":true}']
                    return result(json.dumps([row]))
                if args[3]=='rm':
                    if case=='remove-failure':return result(code=1)
                    present.remove(args[-1]);return result()
                raise AssertionError(args)
            modified=source.replace("Path('/etc/openai-agents-native-docker')",repr(root)).replace("Path('results/native-docker')",repr(output))
            # Path repr is not a constructor in the sandboxed eval namespace.
            modified=modified.replace('PosixPath(', 'Path(')
            env={'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','RUNNER_TEMP':str(base),'CODEX_DOCKER_TEST_IMAGE':image}
            error=None;code=None
            with patch.dict(os.environ,env),patch.object(Path,'lstat',trusted_stat),patch.object(subprocess,'run',execute):
                try:exec(compile(modified,'cleanup-owner','exec'),{})
                except SystemExit as stopped:code=stopped.code
                except Exception as stopped:error=type(stopped).__name__+': '+str(stopped)
            receipt=json.loads((output/'cleanup.json').read_text()) if (output/'cleanup.json').exists() else None
            return dict(exitCode=code,error=error,present=present,profilePresent=profile_present,calls=[list(args) for args,kw in calls],receipt=receipt,rootPresent=root.exists())

    def test_early_diagnostic_or_audit_failure_cannot_block_cleanup(self):
        for case in ('early-diagnostic-throw', 'audit-failure', 'missing-audit-start'):
            with self.subTest(case=case):
                r = self.exercise(case)
                self.assertFalse(r['present']); self.assertFalse(r['profilePresent'])
                self.assertTrue(r['receipt']['filesRemoved'])
                self.assertEqual(bool(r['exitCode']), case != 'early-diagnostic-throw')

    def test_partial_installation_revokes_only_current_profile_and_fails_red(self):
        for case in ('directory-only', 'seccomp-only', 'apparmor-only', 'root-missing', 'missing-manifest', 'malformed-manifest', 'missing-image'):
            with self.subTest(case=case):
                r = self.exercise(case)
                self.assertTrue(r['exitCode']); self.assertFalse(r['present'])
                self.assertTrue(r['receipt']['profileAbsent'])
                self.assertEqual(r['rootPresent'], case == 'seccomp-only')

    def test_unproven_container_or_file_authority_stops_unsafe_removal(self):
        for case in ('mismatch', 'device-request', 'privileged', 'seccomp-mismatch', 'remove-failure', 'missing-seccomp', 'untrusted-root'):
            with self.subTest(case=case):
                r = self.exercise(case)
                self.assertTrue(r['exitCode']); self.assertTrue(r['present'])
                self.assertTrue(r['profilePresent'])
        r = self.exercise('foreign-manifest')
        self.assertTrue(r['exitCode']); self.assertTrue(r['rootPresent'])

INSTALLER = Path(__file__).with_name('install-hosted-diagnostic.sh')
SHIM = r'''#!/usr/bin/python3
import json,os,resource,signal,subprocess,sys
from pathlib import Path
program=Path(sys.argv[0]).name;args=sys.argv[1:];case=os.environ['INSTALL_CASE'];root=Path(os.environ['INSTALL_ROOT'])
def event(**record):
 with open(os.environ['INSTALL_EVENTS'],'a') as stream:stream.write(json.dumps(record)+'\n')
if program=='git':print('a'*40);sys.exit(0)
if program=='apparmor_parser':sys.exit(62 if case=='compile-failure' else 0)
if program=='node':sys.stdin.read();sys.exit(76 if case=='receipt-failure' else 0)
assert program=='sudo'
command,*args=args;event(command=command,args=args)
if command=='python3':
 code=sys.stdin.read().replace('s.st_uid == 0','s.st_uid == '+str(os.getuid()))
 sys.exit(subprocess.run([sys.executable,'-'],input=code,text=True).returncode)
if command=='apparmor_parser':
 Path(os.environ['INSTALL_LOADED']).write_text('simulated partial or complete load')
 sys.exit(74 if case=='partial-load' else 0)
if command=='grep':sys.exit(75 if case=='enforce-failure' else 0)
assert command in ('test','mkdir','install')
for flag,value in (('-o',str(os.getuid())),('-g',str(os.getgid()))):
 if flag in args:args[args.index(flag)+1]=value
if command=='install':
 filename=Path(args[-1]).name
 if case=='fail-'+filename:sys.exit(73)
 if filename=='apparmor.profile' and case=='root-symlink':
  root.rename(root.with_name('saved-owned'));root.symlink_to(root.with_name('foreign'),target_is_directory=True);sys.exit(73)
 if filename=='seccomp.json' and case in ('unknown','symlink','writable','fifo','writable-root'):
  if case=='unknown':(root/'foreign').write_text('foreign')
  if case=='symlink':(root/filename).symlink_to(root.with_name('outside'))
  if case=='writable':(root/filename).write_text('foreign');(root/filename).chmod(0o666)
  if case=='fifo':os.mkfifo(root/filename)
  if case=='writable-root':root.chmod(0o777)
  sys.exit(73)
 if filename=='apparmor.profile' and case=='efbig':
  def limit():
   resource.setrlimit(resource.RLIMIT_FSIZE,(256,256));signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
  result=subprocess.run(['/usr/bin/install',*args],preexec_fn=limit)
  event(partialBytes=(root/filename).stat().st_size,copyExit=result.returncode)
  sys.exit(result.returncode)
 result=subprocess.run(['/usr/bin/install',*args])
 if filename=='apparmor.profile' and case=='malformed':
  (root/filename).write_text('malformed truncated policy');event(malformed=True);sys.exit(73)
 sys.exit(result.returncode)
os.execv('/usr/bin/'+command,[command,*args])
'''
GENERATOR = r'''import hashlib,json,os,sys
from pathlib import Path
if os.environ['INSTALL_CASE']=='generate-failure':raise SystemExit(61)
p=Path(sys.argv[sys.argv.index('--output-dir')+1]);p.mkdir()
a=('profile agents-native-ci-123-1 {\n'+'# padding\n'*2000+'}\n').encode();s=b'{}'
(p/'apparmor.profile').write_bytes(a);(p/'seccomp.json').write_bytes(s)
(p/'manifest.json').write_text(json.dumps({'sourceCommit':'a'*40,'runId':'123','runAttempt':'1','imageId':'sha256:'+'b'*64,'apparmor':{'name':'agents-native-ci-123-1','sha256':hashlib.sha256(a).hexdigest()},'seccomp':{'sha256':hashlib.sha256(s).hexdigest()}}))
'''

class InstallerRollbackTest(unittest.TestCase):
    def exercise(self, case):
        with tempfile.TemporaryDirectory(prefix='installer-rollback-') as temporary:
            base=Path(temporary);root=base/'policy';binary=base/'bin';binary.mkdir();stage=base/'tmp';stage.mkdir()
            (base/'foreign').mkdir();(base/'foreign/marker').write_text('unchanged');(base/'outside').write_text('unchanged')
            if case.startswith('existing'):
                if case=='existing-symlink':root.symlink_to(base/'foreign',target_is_directory=True)
                else:root.mkdir();(root/'marker').write_text('unchanged');root.chmod(0o777 if case=='existing-writable' else 0o755)
            for name in ('sudo','git','apparmor_parser','node'):(binary/name).write_text(SHIM);(binary/name).chmod(0o755)
            script=base/'install.sh';script.write_text(INSTALLER.read_text().replace('/etc/openai-agents-native-docker',str(root)))
            (base/'generate.py').write_text(GENERATOR);(base/'Dockerfile').write_text('FROM synthetic\n')
            env={**os.environ,'PATH':str(binary)+os.pathsep+os.environ['PATH'],'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','RUNNER_TEMP':str(stage),'CODEX_DOCKER_TEST_IMAGE':'sha256:'+'b'*64,'NATIVE_DOCKER_RECIPE':str(base/'Dockerfile'),'INSTALL_CASE':case,'INSTALL_ROOT':str(root),'INSTALL_EVENTS':str(base/'events'),'INSTALL_LOADED':str(base/'loaded')}
            result=subprocess.run(['bash',str(script)],cwd=base,env=env,capture_output=True,text=True)
            events=[json.loads(line) for line in (base/'events').read_text().splitlines()] if (base/'events').exists() else []
            self.assertEqual((base/'foreign/marker').read_text(),'unchanged');self.assertEqual((base/'outside').read_text(),'unchanged')
            self.assertFalse(list(stage.iterdir()),'Staging must be removed after every exit')
            return result.returncode,root.exists(),sorted(p.name for p in root.iterdir()) if root.is_dir() else [],events,(base/'loaded').exists(),result.stderr

    def test_failed_owned_prefixes_and_truncation_are_rolled_back(self):
        for case,status in [('generate-failure',61),('compile-failure',62),('fail-apparmor.profile',73),('fail-seccomp.json',73),('fail-manifest.json',73),('efbig',1),('malformed',73)]:
            with self.subTest(case=case):
                code,present,files,events,loaded,error=self.exercise(case)
                self.assertEqual(code,status,error);self.assertFalse(present,error);self.assertFalse(loaded)
                if case=='efbig':self.assertTrue(any(x.get('partialBytes')==256 for x in events))

    def test_existing_or_foreign_state_is_preserved_without_partial_deletion(self):
        for case in ('existing','existing-writable','existing-symlink','unknown','symlink','writable','fifo','writable-root','root-symlink'):
            with self.subTest(case=case):
                code,present,files,events,loaded,error=self.exercise(case)
                self.assertNotEqual(code,0);self.assertTrue(present);self.assertFalse(loaded)
                if case in ('unknown','symlink','writable','fifo','writable-root'):self.assertIn('apparmor.profile',files)
                if case.startswith('existing'):self.assertFalse(any(x['command']=='python3' for x in events))

    def test_handoff_retains_complete_policy_for_finalizer_even_after_partial_load(self):
        for case,status in [('success',0),('partial-load',74),('enforce-failure',75),('receipt-failure',76)]:
            with self.subTest(case=case):
                code,present,files,events,loaded,error=self.exercise(case)
                self.assertEqual(code,status,error);self.assertTrue(present);self.assertTrue(loaded)
                self.assertEqual(files,['apparmor.profile','manifest.json','seccomp.json'])
                self.assertFalse(any(x['command']=='python3' for x in events))


if __name__ == '__main__': unittest.main()
