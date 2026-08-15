from pathlib import Path

path = Path("packages/agents-realtime/test/sessionPayloadTransform.test.ts")
text = path.read_text()
old = """  it('drops rejected transformed updates by client event id', () => {\n    const base = new TestBase({\n      transformSessionPayload: ({ type: _type, ...rest }) => rest,\n    });\n\n    base.updateSessionConfig({ instructions: 'will be rejected' });\n"""
new = """  it('drops rejected transformed updates by client event id', () => {\n    const base = new TestBase({\n      transformSessionPayload: ({ type: _type, ...rest }) => rest,\n    });\n    base.on('error', () => {});\n\n    base.updateSessionConfig({ instructions: 'will be rejected' });\n"""
if old not in text:
    raise SystemExit("error-path test block not found")
path.write_text(text.replace(old, new, 1))
Path(".github/workflows/validate-1685-reset.yml").unlink(missing_ok=True)
Path(".github/workflows/fix-1685-error-test.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
