"""Build two pinned public SDK sources and prove five WSL assertion paths each."""

import argparse
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import tomllib

SDK_PINS = {
    "python": "c210c3dc557aac30574612f5f900534bf3c93940",
    "js": "b7b32e73404b0b2ac493523085a18e312de76afb",
}
SELECTORS = [
    "suite::landlock::wsl_interop_cannot_run_windows_program_with_network_access",
    "suite::landlock::wsl_interop_bind_alias_cannot_run_windows_program",
    "suite::landlock::wsl_no_proc_masks_inherited_procfs_and_windows_interop",
    "suite::landlock::wsl_interop_cannot_reenter_distro_as_root_with_network_access",
    "suite::landlock::wslg_tests::wslg_duplicate_view_is_masked_with_and_without_fresh_procfs",
]
TEST_SOURCES = {
    "landlock.rs": "18946fc1129112eb8643da707354dd07d21b136b6ab6485f89491d8d3dbd8a65",
    "wslg_tests.rs": "b0e31282daf6604c2296ab8baf6000778d3631b9c82dfb368c63c5463c6902b9",
}
RMCP_SOURCE = (
    "git+https://github.com/modelcontextprotocol/rust-sdk?"
    "rev=3e636cab26c013eca5131103c03d20237f12c4df#"
    "3e636cab26c013eca5131103c03d20237f12c4df"
)
NODE = "node-v22.23.4-linux-x64"
NODE_HASH = "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"
V8 = {
    "librusty_v8_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.a.gz":
        "a35c75d1f26e6a983885a45b33490a4ebe54f05050568b32b89cfb421b30b583",
    "src_binding_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.rs":
        "7727826ae479bdb645e807239fb12d1f8e2e23de7a6cf16f5ee592690d1d8506",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def inventory(root):
    return {
        str(p.relative_to(root)): {
            "mode": p.lstat().st_mode & 0o777,
            **({"symlink": os.readlink(p)} if p.is_symlink() else {"sha256": sha(p)}),
        }
        for p in sorted(root.rglob("*")) if p.is_symlink() or p.is_file()
    }


def validate_lock(before_text, after_text):
    before = tomllib.loads(before_text)
    expected = copy.deepcopy(before)
    changed = []
    for package in expected["package"]:
        if package["name"] in ("rmcp", "rmcp-macros"):
            require(package["version"] == "3.3.0" and package.get("source") == RMCP_SOURCE,
                    "Unexpected RMCP lock identity")
            del package["source"]
            changed.append(package["name"])
    line = f'source = "{RMCP_SOURCE}"\n'
    require(sorted(changed) == ["rmcp", "rmcp-macros"], "Expected two RMCP packages")
    require(before_text.count(line) == 2, "Unexpected RMCP source-line count")
    require(tomllib.loads(after_text) == expected
            and after_text == before_text.replace(line, ""),
            "Lockfile changed beyond the two RMCP source removals")
    return changed


# Parse only successful execve syscalls, never tokens embedded in shell script argv.
# Process creation and final status connect each request to the traced integration ELF.
QUOTED = r'"(?:[^"\\]|\\.)*"'


def process_trace(text, executable):
    parents, exits, execs, pending = {}, {}, [], {}
    for raw in text.splitlines():
        match = re.match(r"^(\d+)\s+(.*)$", raw)
        require(match is not None, "Unrecognized process-trace line")
        pid, line = int(match[1]), match[2]
        if "<unfinished ...>" in line:
            require(pid not in pending, "Overlapping unfinished syscall")
            pending[pid] = line.replace("<unfinished ...>", "")
            continue
        if line.startswith("<... ") and " resumed>" in line:
            require(pid in pending, "Resumed syscall without prefix")
            line = pending.pop(pid) + line.split(" resumed>", 1)[1]
        match = re.match(r"(?:clone3?|fork|vfork)\(.*\)\s+= (\d+)$", line)
        if match:
            parents[int(match[1])] = pid
        match = re.match(r"\+\+\+ exited with (\d+) \+\+\+$", line)
        if match:
            exits[pid] = int(match[1])
        if re.match(r"\+\+\+ killed by SIG[A-Z]+", line):
            exits[pid] = "signal"
        if line.startswith("execve(") and re.search(r"\)\s+= 0$", line):
            match = re.match(rf"execve\(({QUOTED}), \[(.*)\], .*\)\s+= 0$", line)
            require(match is not None and not re.search(r'"\.\.\.', match[2]),
                    "Unparsed or truncated successful exec argv")
            execs.append({"pid": pid, "path": ast.literal_eval(match[1]),
                          "argv": [ast.literal_eval(s) for s in re.findall(QUOTED, match[2])]})
    roots = [e["pid"] for e in execs if e["path"] == str(executable)]
    require(len(roots) == 1 and exits.get(roots[0]) == 0, "Integration process did not finish successfully")

    def descendant(pid):
        seen = set()
        while pid not in seen:
            if pid == roots[0]:
                return True
            seen.add(pid)
            pid = parents.get(pid)
        return False

    for event in execs:
        event["descendant"] = descendant(event["pid"])
        event["exit"] = exits.get(event["pid"])
    return execs


def prove_execution(index, text, executable, helper, output):
    selector = SELECTORS[index]
    require(f"test {selector} ... ok" in output
            and re.search(r"test result: ok\. 1 passed; 0 failed; 0 ignored;", output)
            and "skipping" not in output.lower(), "Selected test did not pass without skip diagnostics")
    events = process_trace(text, executable)
    requests = []
    for event in events:
        argv = event["argv"]
        if event["path"] == str(helper) and argv[1:2] == ["--sandbox-policy-cwd"] and "--apply-seccomp-then-exec" not in argv:
            require(event["descendant"] and event["exit"] is not None, "Incomplete helper process lineage/status")
            require("--permission-profile" in argv and "--" in argv, "Missing public helper arguments")
            json.loads(argv[argv.index("--permission-profile") + 1])
            requests.append(event)

    def request(predicate, success):
        matches = [e for e in requests if predicate(e["argv"])]
        require(len(matches) == 1, "Missing or ambiguous post-skip helper request")
        event = matches[0]
        require((event["exit"] == 0) == success, "Unexpected helper completion status")
        return {"pid": event["pid"], "exit": event["exit"], "argv": event["argv"]}

    def baseline(marker, direct=False):
        require(any(e["descendant"] and e["exit"] == 0
                    and (e["path"] == "/init" if direct else e["path"].endswith("/powershell.exe"))
                    and f"Write-Output {marker}" in e["argv"] for e in events),
                "Alias baseline did not execute and complete")

    preflight = request(lambda a: a[a.index("--") + 1:] == ["bash", "-lc", "true"], True)
    proofs = []
    if index == 0:
        proofs.append(request(lambda a: "Write-Output interop-escaped" in a, False))
    elif index == 1:
        baseline("alias-baseline-ok")
        baseline("direct-init-baseline-ok", direct=True)
        proofs.append(request(lambda a: "Write-Output interop-escaped" in a, False))
        proofs.append(request(lambda a: any("Write-Output direct-init-escaped" in s for s in a), False))
    elif index == 2:
        proofs.append(request(lambda a: "--no-proc" in a and "test ! -e /proc/1" in a, True))
        proofs.append(request(lambda a: "--no-proc" in a and "Write-Output interop-escaped" in a, False))
    elif index == 3:
        proofs.append(request(lambda a: a[-5:] == ["-u", "root", "--", "/usr/bin/id", "-u"], False))
    else:
        for no_proc in (False, True):
            proofs.append(request(lambda a: ("--no-proc" in a) == no_proc
                                  and any(s.startswith("stat -c %a /mnt/wslg/distro &&") for s in a), True))
        rejection = request(lambda a: a[-2:] == ["--", "/mnt/wslg/distro/bin/true"], False)
        require(rejection["exit"] == 1, "WSLg forbidden-path rejection did not exit 1")
        proofs.append(rejection)
    return {"preflight": preflight, "assertion_requests": proofs}


class Run:
    def __init__(self, work, evidence, report):
        self.work, self.evidence, self.report = work, evidence, report
        self.deadline = time.monotonic() + 70 * 60
        self.stage = "initialize"
        self.env = {k: os.environ[k] for k in
                    ("HOME", "USER", "LOGNAME", "PATH", "WSL_INTEROP", "WSL_DISTRO_NAME") if k in os.environ}
        self.env.update({"CARGO_HOME": str(work / "cargo"), "RUSTUP_HOME": str(work / "rustup"),
                         "RUSTUP_TOOLCHAIN": "1.95.0", "CARGO_BUILD_JOBS": "2",
                         "CARGO_INCREMENTAL": "0", "CARGO_PROFILE_DEV_DEBUG": "0",
                         "CARGO_PROFILE_TEST_DEBUG": "0", "GIT_TERMINAL_PROMPT": "0",
                         "GIT_CONFIG_GLOBAL": "/dev/null", "LANG": "C.UTF-8"})

    def command(self, stage, args, cwd=None, check=True, limit=None):
        self.stage = stage
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "Source-test time budget exhausted")
        log = self.evidence / f"{stage}.log"
        with log.open("wb") as stream:
            process = subprocess.Popen(args, cwd=cwd or self.work, env=self.env,
                                       stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=min(remaining, limit or remaining))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    raise RuntimeError(f"{stage}: timeout; process-group cleanup unconfirmed") from None
                raise RuntimeError(f"{stage}: timeout") from None
        require(not check or code == 0, f"{stage}: native exit {code}")
        return code

    def download(self, url, destination, expected):
        self.command("download_" + destination.name,
                     ["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                      "--connect-timeout", "30", "--max-time", "600", "--output", str(destination), url], limit=610)
        require(sha(destination) == expected, "Downloaded archive digest mismatch")

    def prepare_tools(self):
        self.command("rust_install", ["rustup", "toolchain", "install", "1.95.0", "--profile", "minimal"])
        self.command("rust_version", ["rustup", "run", "1.95.0", "rustc", "--version"])
        self.command("cargo_version", ["rustup", "run", "1.95.0", "cargo", "--version"])
        archive = self.work / f"{NODE}.tar.xz"
        self.download(f"https://nodejs.org/dist/v22.23.4/{archive.name}", archive, NODE_HASH)
        with tarfile.open(archive) as contents:
            contents.extractall(self.work, filter="data")
        self.env["PATH"] = str(self.work / NODE / "bin") + ":" + self.env["PATH"]
        self.command("node_version", ["node", "--version"])
        self.command("package_versions", ["dpkg-query", "-W", "build-essential", "pkg-config", "libcap-dev",
                                          "libssl-dev", "cmake", "clang", "protobuf-compiler", "rustup",
                                          "python3", "git", "strace", "bubblewrap", "util-linux"])
        for name, digest in V8.items():
            self.download("https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0/" + name,
                          self.work / name, digest)
        names = list(V8)
        self.env["RUSTY_V8_ARCHIVE"] = str(self.work / names[0])
        self.env["RUSTY_V8_SRC_BINDING_PATH"] = str(self.work / names[1])

    def sdk(self, language, result):
        sdk = self.work / (language + "-sdk")
        sdk.mkdir()
        self.command(language + "_git_init", ["git", "init", "--quiet", str(sdk)])
        self.command(language + "_git_fetch", ["git", "fetch", "--depth=1",
                     f"https://github.com/openai/openai-agents-{language}.git", SDK_PINS[language]], cwd=sdk)
        self.command(language + "_git_checkout", ["git", "checkout", "--detach", "FETCH_HEAD"], cwd=sdk)
        self.command(language + "_git_pin", ["git", "rev-parse", "HEAD"], cwd=sdk)
        require((self.evidence / (language + "_git_pin.log")).read_text().strip() == SDK_PINS[language],
                "SDK checkout pin mismatch")
        if language == "python":
            package = sdk / "packages/codex"
            self.command(language + "_prepare", ["python3", str(package / "scripts/prepare_codex.py")], cwd=sdk)
            pristine, rmcp = package / ".upstream/codex", package / ".upstream/rust-sdk"
            manifest = pristine / "third_party/v8/rusty_v8_150_4_0.sha256"
            pinned_v8 = {line.split()[1]: line.split()[0] for line in manifest.read_text().splitlines() if line.strip()}
        else:
            package = sdk / "packages/agents-codex"
            self.command(language + "_prepare", ["node", str(package / "scripts/native.mjs"), "prepare"], cwd=sdk)
            pristine, rmcp = package / "native/.upstream/reviewed-codex", package / "native/.upstream/reviewed-rust-sdk"
            manifest = package / "scripts/v8-release.json"
            pinned_v8 = {entry["name"]: entry["digest"].removeprefix("sha256:")
                         for entry in json.loads(manifest.read_text())["assets"]}
        require(all(pinned_v8.get(name) == digest for name, digest in V8.items()), "SDK V8 manifest mismatch")
        shutil.copyfile(manifest, self.evidence / (language + "-v8-manifest" + manifest.suffix))
        source_records = {"codex": inventory(pristine), "rmcp": inventory(rmcp)}
        write_json(self.evidence / (language + "-prepared-files.json"), source_records)
        result["prepared_manifest_sha256"] = sha(self.evidence / (language + "-prepared-files.json"))
        for name, expected in TEST_SOURCES.items():
            require(sha(pristine / "codex-rs/linux-sandbox/tests/suite" / name) == expected,
                    "Test source differs from reviewed assertion paths")
        build = self.work / (language + "-build")
        target = self.work / (language + "-target")
        shutil.copytree(pristine, build, symlinks=True)
        rmcp_build = self.work / (language + "-rmcp-build")
        shutil.copytree(rmcp, rmcp_build, symlinks=True)
        require(inventory(build) == source_records["codex"] and inventory(rmcp_build) == source_records["rmcp"],
                "Disposable build copies differ from prepared input")
        expected_build = copy.deepcopy(source_records["codex"])
        config = self.work / (language + "-rmcp.toml")
        config.write_text('[patch."https://github.com/modelcontextprotocol/rust-sdk"]\n'
                          + "\n".join(f'{name} = {{ path = {json.dumps(str(rmcp_build / "crates" / name))} }}'
                                      for name in ("rmcp", "rmcp-macros")) + "\n")
        shutil.copyfile(config, self.evidence / (language + "-rmcp.toml"))
        workspace = build / "codex-rs"
        lock = workspace / "Cargo.lock"
        before = lock.read_text()
        shutil.copyfile(lock, self.evidence / (language + "-Cargo.lock.before"))
        self.env["CARGO_TARGET_DIR"] = str(target)
        cargo = ["rustup", "run", "1.95.0", "cargo", "--config", str(config)]
        try:
            # This is the sole lockfile-writing step, before fetching/building.
            self.command(language + "_resolve", cargo + ["metadata", "--format-version=1", "--filter-platform", "x86_64-unknown-linux-gnu"], cwd=workspace)
            after = lock.read_text()
            result["lock_changes"] = validate_lock(before, after)
            expected_build["codex-rs/Cargo.lock"]["sha256"] = sha(lock)
            shutil.copyfile(lock, self.evidence / (language + "-Cargo.lock.after"))
            self.command(language + "_fetch", cargo + ["fetch", "--locked", "--target", "x86_64-unknown-linux-gnu"], cwd=workspace)
            self.command(language + "_build", cargo + ["test", "--locked", "--offline", "-p", "codex-linux-sandbox",
                         "--test", "all", "--no-run", "--message-format=json-render-diagnostics"], cwd=workspace)
            result["compiled_sources_unchanged"] = (inventory(build) == expected_build
                                                      and inventory(rmcp_build) == source_records["rmcp"])
            require(result["compiled_sources_unchanged"], "Compiled source changed beyond reviewed lockfile adjustment")
            artifacts = []
            for line in (self.evidence / (language + "_build.log")).read_text().splitlines():
                if line.startswith("{"):
                    item = json.loads(line)
                    if item.get("reason") == "compiler-artifact" and item.get("executable"):
                        artifacts.append(item)
            binaries = [Path(a["executable"]) for a in artifacts if a["target"]["name"] == "all"
                        and "test" in a["target"]["kind"]]
            require(len(binaries) == 1, "Expected one integration ELF")
            executable, helper = binaries[0], target / "debug/codex-linux-sandbox"
            require(helper.is_file(), "Matching helper missing at compile-time Cargo path")
            result["artifacts"] = {"integration": {"sha256": sha(executable), "bytes": executable.stat().st_size},
                                   "helper": {"sha256": sha(helper), "bytes": helper.stat().st_size}}
            for index, selector in enumerate(SELECTORS):
                test = result["tests"][index]
                stage = f"{language}_test_{index + 1}"
                trace = self.evidence / (stage + ".trace")
                try:
                    code = self.command(stage, ["timeout", "--signal=TERM", "--kill-after=10s", "120s", "strace",
                                        "-f", "-s", "65535", "-e", "trace=%process", "-o", str(trace),
                                        str(executable), selector, "--exact", "--nocapture", "--test-threads=1"],
                                        cwd=workspace, check=False, limit=135)
                    test["exit"] = code
                    require(code == 0, "Test execution failed")
                    test["proof"] = prove_execution(index, trace.read_text(), executable, helper,
                                                    (self.evidence / (stage + ".log")).read_text())
                    test["status"] = "passed"
                except Exception as error:
                    test.update(status="failed", reason=str(error))
                finally:
                    if trace.is_file():
                        test["trace_sha256"] = sha(trace)
                        test["trace_bytes"] = trace.stat().st_size
                    log = self.evidence / (stage + ".log")
                    if log.is_file():
                        test["log_sha256"] = sha(log)
                write_json(self.evidence / "source-results.json", self.report)
            require(all(t["status"] == "passed" for t in result["tests"]), "Incomplete assertion coverage")
        finally:
            try:
                result["pristine_unchanged"] = source_records == {"codex": inventory(pristine), "rmcp": inventory(rmcp)}
                result["sources_after_tests_unchanged"] = (inventory(build) == expected_build
                                                            and inventory(rmcp_build) == source_records["rmcp"])
                if "artifacts" in result:
                    result["artifacts_after_tests"] = {
                        "integration": {"sha256": sha(executable), "bytes": executable.stat().st_size},
                        "helper": {"sha256": sha(helper), "bytes": helper.stat().st_size}}
                    result["artifacts_unchanged"] = result["artifacts"] == result["artifacts_after_tests"]
            finally:
                try:
                    for directory in (build, rmcp_build, target):
                        if directory.exists():
                            shutil.rmtree(directory)
                    result["build_cleanup"] = "passed"
                except OSError:
                    self.stage = language + "_build_cleanup"
                    result["build_cleanup"] = "failed"
                    raise
        require(result["pristine_unchanged"] and result["sources_after_tests_unchanged"]
                and result["artifacts_unchanged"], "Source or artifacts changed during build/test")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    args.evidence.mkdir(exist_ok=True)
    report = {"schema_version": 1, "status": "running", "helper_sha256": sha(__file__),
              "rust": "1.95.0", "node": {"version": "22.23.4", "sha256": NODE_HASH}, "v8": V8,
              "sdks": {language: {"pin": pin, "status": "not_run", "tests": [
                  {"selector": selector, "status": "not_run"} for selector in SELECTORS]}
                  for language, pin in SDK_PINS.items()}}
    output = args.evidence / "source-results.json"
    write_json(output, report)
    require(os.getuid() != 0 and os.environ.get("USER") == "wslprobe", "Tests must run as wslprobe")
    # All preparation, Cargo sources, cwd and test fixtures stay on the Linux filesystem.
    work = Path(tempfile.mkdtemp(prefix="native-wsl-build-", dir="/home/wslprobe"))
    run = Run(work, args.evidence, report)
    try:
        run.prepare_tools()
        for language, result in report["sdks"].items():
            result["status"] = "running"
            try:
                run.sdk(language, result)
                result["status"] = "passed"
            except Exception as error:
                result.update(status="failed", stage=run.stage, reason=str(error))
            write_json(output, report)
    except Exception as error:
        report.update(stage=run.stage, reason=str(error))
    finally:
        try:
            shutil.rmtree(work)
            report["owned_workspace_cleanup"] = "passed"
        except OSError as error:
            report.update(owned_workspace_cleanup="failed", reason=str(error))
        report["status"] = "passed" if (report["owned_workspace_cleanup"] == "passed"
                                           and all(r["status"] == "passed" for r in report["sdks"].values())) else "failed"
        write_json(output, report)
    for language, result in report["sdks"].items():
        print(f'{language}: {result["status"]}; {sum(t["status"] == "passed" for t in result["tests"])}/5 assertion paths')
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
