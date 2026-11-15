#!/usr/bin/python3
"""Confine Docker run injection to the native qualification child process."""

import csv
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

DOCKER = "/usr/bin/docker"
POLICY_DIRECTORY = Path("/etc/openai-agents-native-docker")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def root_file(path, expected_hash):
    path = Path(path)
    require(path.parent == POLICY_DIRECTORY, "Unexpected runner policy path")
    for item in (POLICY_DIRECTORY, path):
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "Writable runner policy")
        require(not stat.S_ISLNK(info.st_mode), "Symlink runner policy")
    require(stat.S_ISREG(path.lstat().st_mode), "Non-file runner policy")
    content = path.read_bytes()
    require(hashlib.sha256(content).hexdigest() == expected_hash, "Runner policy changed")
    return content


def bind_grant(value):
    """Accept only the existing provider's bind-grant CSV serialization."""
    try:
        rows = list(csv.reader([value], strict=True))
    except csv.Error as error:
        raise RuntimeError("Malformed bind grant") from error
    require(len(rows) == 1, "Malformed bind grant")
    fields = rows[0]
    require(len(fields) in (3, 4) and fields[0] == "type=bind", "Unsupported mount type or fields")
    require(fields[1].startswith("source=") and os.path.isabs(fields[1][7:]), "Bind grant requires an absolute source")
    require(fields[2].startswith("target=") and os.path.isabs(fields[2][7:]), "Bind grant requires an absolute target")
    require(len(fields) == 3 or fields[3] == "readonly", "Unsupported bind grant option")
    require("\x00" not in value, "NUL in bind grant")
    encoded = ["\"" + field.replace("\"", "\"\"") + "\"" if any(char in field for char in '\",\n\r') else field for field in fields]
    require(value == ",".join(encoded), "Noncanonical bind grant CSV")


def selected_daemon(host, expected):
    """Admit the selected Unix socket and its provider-resolved canonical path."""
    if host == expected:
        return True
    if not expected.startswith("unix:///"):
        return False
    path = expected.removeprefix("unix://")
    if host != "unix://" + os.path.realpath(path):
        return False
    try:
        selected = os.stat(path)
        canonical = os.stat(host.removeprefix("unix://"))
    except OSError:
        return False
    return stat.S_ISSOCK(selected.st_mode) and stat.S_ISSOCK(canonical.st_mode) and (selected.st_dev, selected.st_ino) == (canonical.st_dev, canonical.st_ino)


def invocation(arguments, config):
    """Preserve the SDK's exact daemon selection and all ordinary arguments."""
    index = 0
    host = None
    while index < len(arguments) and arguments[index].startswith("-"):
        option = arguments[index]
        require(option in ("--host", "--config"), "Unsupported Docker global option")
        require(index + 1 < len(arguments), "Missing Docker global option value")
        value = arguments[index + 1]
        if option == "--host":
            require(host is None, "Duplicate Docker host")
            host = value
        else:
            require(os.path.isabs(value), "Relative Docker config directory")
        index += 2
    require(selected_daemon(host, config["host"]), "Docker daemon changed")
    require(index < len(arguments), "Missing Docker operation")
    operation = arguments[index]
    require(operation in {"run", "exec", "inspect", "info", "version", "rm", "cp", "ps", "stop", "kill", "wait", "logs"}, "Unsupported qualification Docker operation")
    if operation != "run":
        if operation == "info":
            require(arguments[index + 1:] == ["--format", "{{json .}}"], "Unsupported qualification Docker daemon inspection")
        if operation == "exec":
            cursor = index + 1
            while cursor < len(arguments) and arguments[cursor].startswith("-"):
                option = arguments[cursor]
                if option in {"-i", "-t", "--interactive"}:
                    cursor += 1
                    continue
                if option.startswith(("--user=", "--workdir=")):
                    require(bool(option.split("=", 1)[1]), "Empty Docker exec option value")
                    cursor += 1
                    continue
                require(option in {"-w", "-e", "-u"}, "Unsupported qualification Docker exec option")
                require(cursor + 1 < len(arguments), "Missing Docker exec option value")
                cursor += 2
            require(cursor < len(arguments), "Missing Docker exec container")
        return list(arguments), False
    cursor = index + 1
    detached = False
    network = None
    while cursor < len(arguments) and arguments[cursor].startswith("-"):
        option = arguments[cursor]
        if option == "-d":
            require(not detached, "Duplicate detached flag")
            detached = True
            cursor += 1
            continue
        require(option in {"--name", "--label", "-v", "--mount", "-w", "--network", "--user", "-e"}, "Unsupported qualification Docker run option")
        require(cursor + 1 < len(arguments), "Missing Docker run option value")
        if option == "--mount":
            bind_grant(arguments[cursor + 1])
        if option == "--network":
            require(network is None, "Duplicate Docker network")
            network = arguments[cursor + 1]
        cursor += 2
    require(detached and network == "none", "Qualification requires detached network-off containers")
    require(cursor < len(arguments) and arguments[cursor] == config["image"], "Qualification image changed")
    profile = config["profile"]
    injected = ["--label", "agents-native-ci-profile=" + profile["apparmor"]["name"], "--security-opt", "apparmor=" + profile["apparmor"]["name"], "--security-opt", "seccomp=" + profile["seccomp"]["path"]]
    return arguments[: index + 1] + injected + arguments[index + 1 :], True


def inspect_container(global_arguments, container, config):
    profile = config["profile"]
    record = json.loads(subprocess.check_output([DOCKER, *global_arguments, "inspect", "--type", "container", container]))[0]
    require(record["Config"].get("Labels", {}).get("agents-native-ci-profile") == profile["apparmor"]["name"], "Container ownership label changed")
    host = record["HostConfig"]
    require(host["Privileged"] is False and not host.get("CapAdd") and not host.get("Devices") and not host.get("DeviceRequests"), "Unexpected container authority")
    require(host["NetworkMode"] == "none", "Container networking changed")
    require(record["Image"] == config["imageId"], "Container image changed")
    require(record["AppArmorProfile"] == profile["apparmor"]["name"], "AppArmor profile changed")
    options = host.get("SecurityOpt") or []
    require(len(options) == 2 and "apparmor=" + profile["apparmor"]["name"] in options, "Unexpected security options")
    seccomp = [value.removeprefix("seccomp=") for value in options if value.startswith("seccomp=")]
    expected = json.loads(root_file(profile["seccomp"]["path"], profile["seccomp"]["sha256"]))
    require(len(seccomp) == 1 and json.loads(seccomp[0]) == expected, "Seccomp profile changed")
    current = subprocess.check_output([DOCKER, *global_arguments, "exec", container, "/bin/cat", "/proc/self/attr/current"], text=True).strip()
    require(current == profile["apparmor"]["name"] + " (enforce)", "AppArmor is not enforcing")
    status = subprocess.check_output([DOCKER, *global_arguments, "exec", container, "/bin/cat", "/proc/self/status"], text=True)
    require(re.search(r"^Seccomp:\s+2$", status, re.MULTILINE) is not None, "Seccomp is not filtering")
    return {"id": container, "imageId": record["Image"], "labels": record["Config"].get("Labels", {}), "hostConfig": host, "apparmor": current, "seccomp": 2}


def main():
    directory = Path(__file__).resolve().parent
    require(directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o077 == 0, "Untrusted wrapper directory")
    config = json.loads((directory / "configuration.json").read_text())
    profile = config["profile"]
    root_file(profile["apparmor"]["path"], profile["apparmor"]["sha256"])
    root_file(profile["seccomp"]["path"], profile["seccomp"]["sha256"])
    arguments, created = invocation(sys.argv[1:], config)
    if not created:
        os.execv(DOCKER, [DOCKER, *arguments])
    result = subprocess.run([DOCKER, *arguments], stdout=subprocess.PIPE, check=False)
    if result.returncode:
        sys.stdout.buffer.write(result.stdout)
        return result.returncode
    container = result.stdout.decode().strip()
    require(re.fullmatch(r"[a-f0-9]{64}", container) is not None, "Unexpected Docker container ID")
    global_arguments = arguments[: arguments.index("run")]
    try:
        record = inspect_container(global_arguments, container, config)
        record["argv"] = arguments
        with open(config["evidence"], "a", encoding="utf8") as evidence:
            evidence.write(json.dumps(record, sort_keys=True) + "\n")
    except BaseException:
        subprocess.run([DOCKER, *global_arguments, "rm", "-f", container], stdout=subprocess.DEVNULL, check=False)
        raise
    sys.stdout.buffer.write(result.stdout)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Native Docker qualification wrapper refused: " + str(error), file=sys.stderr)
        sys.exit(78)
