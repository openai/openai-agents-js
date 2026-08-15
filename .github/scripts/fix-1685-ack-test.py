from pathlib import Path

path = Path("packages/agents-realtime/test/sessionPayloadTransform.test.ts")
text = path.read_text()
old = """    base.updateTracing('auto');\n\n    expect(\n      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,\n    ).toBe(true);\n    expect(base.rawSessionConfig?.tracing).toBe('auto');\n"""
new = """    base.updateTracing('auto');\n    base.receiveSessionUpdated({ tracing: 'provider acknowledgement' });\n\n    expect(\n      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,\n    ).toBe(true);\n    expect(base.rawSessionConfig?.tracing).toBe('auto');\n"""
if old not in text:
    raise SystemExit("tracing acknowledgement test block not found")
path.write_text(text.replace(old, new, 1))
Path(".github/workflows/fix-1685-ack-test.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
