"""Offline admission tests; no Docker daemon or kernel policy load."""

import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name("native-executor-docker.py")
SPEC = importlib.util.spec_from_file_location("qualification_docker", SOURCE)
WRAPPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WRAPPER)


class QualificationDockerTest(unittest.TestCase):
    def setUp(self):
        self.config = {
            "host": "unix:///selected.sock",
            "image": "sha256:" + "a" * 64,
            "imageId": "sha256:" + "b" * 64,
            "profile": {
                "apparmor": {"name": "agents-native-ci-1-1"},
                "seccomp": {"path": "/etc/openai-agents-native-docker/seccomp.json", "sha256": "c" * 64},
            },
        }
        self.global_arguments = ["--config", "/private/config", "--host", self.config["host"]]

    def run_arguments(self, options=None, image=None):
        return self.global_arguments + ["run", "-d", "--network", "none", *(options or []), image or self.config["image"], "/bin/sh", "-c", "sleep 300"]

    def test_injection_preserves_selected_daemon_image_and_command(self):
        original = self.run_arguments(["-v", "/host:/tools:ro", "--label", "fixture=true"])
        updated, created = WRAPPER.invocation(original, self.config)
        self.assertTrue(created)
        position = len(self.global_arguments) + 1
        self.assertEqual(updated[:position], original[:position])
        self.assertEqual(updated[position:position + 6], ["--label", "agents-native-ci-profile=agents-native-ci-1-1", "--security-opt", "apparmor=agents-native-ci-1-1", "--security-opt", "seccomp=/etc/openai-agents-native-docker/seccomp.json"])
        self.assertEqual(updated[position + 6:], original[position:])

    def test_ordinary_exec_preserves_command_arguments_and_streaming_path(self):
        # Existing shell/PTY, filesystem helper, and account-provisioning builders.
        for command in (
            ["exec", "-i", "-u", "root", "-w", "/", "container", "/bin/sh", "-c", "printf --privileged"],
            ["exec", "-i", "-t", "-w", "/workspace", "-e", "FIXTURE=value", "-u", "1001:1001", "container", "/bin/sh", "-lc", "true"],
            ["exec", "-i", "-w", "/", "-e", "LD_PRELOAD=", "-u", "root", "container", "/tools/launch", "--codex-run-as-fs-helper"],
            ["exec", "-u", "root", "container", "/bin/sh", "-c", "id -u"],
        ):
            original = self.global_arguments + command
            self.assertEqual(WRAPPER.invocation(original, self.config), (original, False))

    def test_native_gateway_exec_preserves_existing_long_form_transport(self):
        # openDockerGatewayScope emits these literal options for native stdio.
        for identity in ([], ["--user=1001:1001"]):
            original = self.global_arguments + ["exec", "--interactive", *identity, "--workdir=/workspace", "container", "/tools/launch", "stdio"]
            self.assertEqual(WRAPPER.invocation(original, self.config), (original, False))

    def test_provider_bind_grants_preserve_readonly_writable_and_csv_paths(self):
        # dockerExtraPathGrantMountArgs/dockerMountArg emit these exact forms.
        for writable in ("type=bind,source=/tmp/writable,target=/data-write", "type=bind,source=/tmp/writable,target=/data-write,readonly"):
            for readonly in ("type=bind,source=/tmp/tools,target=/tools,readonly", 'type=bind,"source=/tmp/tools,with ""quotes""",target=/tools,readonly'):
                options = ["--name", "openai-agents-sandbox-fixture", "--label", "fixture=true", "-v", "/tmp/workspace:/workspace", "--mount", readonly, "--mount", writable, "-w", "/workspace", "--user", "1001:1001", "-e", "FIXTURE=value"]
                original = self.run_arguments(options)
                updated, created = WRAPPER.invocation(original, self.config)
                self.assertTrue(created)
                position = len(self.global_arguments) + 1
                self.assertEqual(updated[:position], original[:position])
                self.assertEqual(updated[position + 6:], original[position:])

    def test_rejects_nonprovider_mount_forms_and_added_bind_authority(self):
        for mount in (
            "type=volume,source=data,target=/tools", "type=tmpfs,target=/tools",
            "type=bind,source=/tmp/tools,target=/tools,bind-propagation=rshared",
            "type=bind,source=/tmp/tools,target=/tools,bind-recursive=enabled",
            "type=bind,source=/tmp/tools,target=/tools,volume-opt=device=/dev/sda",
            "type=bind,source=/tmp/tools,target=/tools,readonly=false",
            "type=bind,source=/tmp/tools,target=/tools,target=/other",
            "type=bind,source=relative,target=/tools", "type=bind,source=/tmp/tools,target=relative",
            "type=bind,source=,target=/tools", "type=bind,source=/tmp/tools",
            'type=bind,"source=/tmp/tools,target=/tools',
            'type=bind,source=/tmp/"tools,target=/tools',
            "type=bind,source=/tmp/tools\x00,target=/tools",
        ):
            with self.subTest(mount=mount), self.assertRaises((RuntimeError, ValueError)):
                WRAPPER.invocation(self.run_arguments(["--mount", mount]), self.config)

    def test_rejects_unselected_daemon_mutable_image_and_network_change(self):
        mutations = [
            ["--host", "unix:///other.sock", *self.run_arguments()[4:]],
            self.run_arguments(image="python:latest"),
            self.run_arguments(["--network", "bridge"]),
            ["--host", self.config["host"], "--host", self.config["host"], *self.run_arguments()[4:]],
        ]
        for arguments in mutations:
            with self.subTest(arguments=arguments), self.assertRaises(RuntimeError):
                WRAPPER.invocation(arguments, self.config)

    def test_rejects_additional_authority_and_profile_bypasses(self):
        for options in (["--privileged"], ["--cap-add", "SYS_ADMIN"], ["--security-opt", "apparmor=unconfined"], ["--security-opt", "seccomp=unconfined"], ["--device", "/dev/fuse"], ["--pid", "host"], ["-p", "1234:1234"]):
            with self.subTest(options=options), self.assertRaises(RuntimeError):
                WRAPPER.invocation(self.run_arguments(options), self.config)
        with self.assertRaises(RuntimeError):
            WRAPPER.invocation(self.global_arguments + ["exec", "--privileged", "container", "/bin/true"], self.config)
        with self.assertRaises(RuntimeError):
            WRAPPER.invocation(self.global_arguments + ["create", self.config["image"]], self.config)

    def inspected(self):
        return {"HostConfig": {"Privileged": False, "CapAdd": None, "Devices": [], "DeviceRequests": None, "NetworkMode": "none", "SecurityOpt": ["apparmor=agents-native-ci-1-1", 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}']}, "Image": self.config["imageId"], "AppArmorProfile": "agents-native-ci-1-1", "Config": {"Labels": {"fixture": "true", "agents-native-ci-profile": "agents-native-ci-1-1"}}}

    def inspect(self, record, current="agents-native-ci-1-1 (enforce)\n", status="Seccomp:\t2\n"):
        outputs = [json.dumps([record]).encode(), current, status]
        with patch.object(WRAPPER.subprocess, "check_output", side_effect=outputs), patch.object(WRAPPER, "root_file", return_value=b'{"defaultAction":"SCMP_ACT_ERRNO"}'):
            return WRAPPER.inspect_container(self.global_arguments, "d" * 64, self.config)

    def test_inspection_requires_enforced_profiles_and_unchanged_authority(self):
        self.assertEqual(self.inspect(self.inspected())["seccomp"], 2)
        for key, value in [("Privileged", True), ("CapAdd", ["SYS_ADMIN"]), ("Devices", [{"PathOnHost": "/dev/fuse"}]), ("NetworkMode", "bridge"), ("SecurityOpt", ["seccomp=unconfined"])]:
            record = self.inspected()
            record["HostConfig"][key] = value
            with self.subTest(key=key), self.assertRaises((RuntimeError, ValueError)):
                self.inspect(record)
        with self.assertRaises(RuntimeError):
            self.inspect(self.inspected(), current="agents-native-ci-1-1 (complain)\n")
        with self.assertRaises(RuntimeError):
            self.inspect(self.inspected(), status="Seccomp:\t0\n")

    def test_rejects_noncanonical_policy_path_before_reading_it(self):
        with self.assertRaises(RuntimeError):
            WRAPPER.root_file("/tmp/attacker/seccomp.json", "0" * 64)


if __name__ == "__main__":
    unittest.main()
