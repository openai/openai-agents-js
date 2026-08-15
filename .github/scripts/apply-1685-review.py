from pathlib import Path

src = Path("packages/agents-realtime/src/openaiRealtimeBase.ts")
text = src.read_text()

old_fields = """  #transformSessionPayload: RealtimeSessionPayloadTransformer | undefined;\n  #tracingConfig: RealtimeTracingConfig | null = null;\n  #rawSessionConfig: Record<string, any> | null = null;\n"""
new_fields = """  #transformSessionPayload: RealtimeSessionPayloadTransformer | undefined;\n  #tracingConfig: RealtimeTracingConfig | null = null;\n  #rawSessionConfig: Record<string, any> | null = null;\n  #pendingTransformedSessionUpdates = 0;\n"""
if old_fields not in text:
    raise SystemExit("field block not found")
text = text.replace(old_fields, new_fields, 1)

old_ack = """    if (parsed.type === 'session.updated') {\n      if (!this.#transformSessionPayload || this.#rawSessionConfig === null) {\n        this.#rawSessionConfig = parsed.session;\n      }\n    }\n"""
new_ack = """    if (parsed.type === 'session.updated') {\n      if (\n        this.#transformSessionPayload &&\n        this.#pendingTransformedSessionUpdates > 0\n      ) {\n        // Provider-transformed acknowledgements may use a different schema, so\n        // do not overwrite the canonical SDK state with them. Direct/raw\n        // session.update acknowledgements still update the canonical cache.\n        this.#pendingTransformedSessionUpdates -= 1;\n      } else {\n        this.#rawSessionConfig = parsed.session;\n      }\n    }\n"""
if old_ack not in text:
    raise SystemExit("session.updated block not found")
text = text.replace(old_ack, new_ack, 1)

old_send = """  protected _sendSessionUpdate(payload: RealtimeSessionPayload): void {\n    this.#rawSessionConfig = mergeCanonicalSessionPayload(\n      this.#rawSessionConfig,\n      payload,\n    );\n    const session = this.#transformSessionPayload?.(payload) ?? payload;\n    this.sendEvent({\n      type: 'session.update',\n      session,\n    });\n  }\n"""
new_send = """  protected _sendSessionUpdate(payload: RealtimeSessionPayload): void {\n    const canonicalPayload = cloneRealtimeEvent(payload);\n    this.#rawSessionConfig = mergeCanonicalSessionPayload(\n      this.#rawSessionConfig,\n      canonicalPayload,\n    );\n\n    const session = this.#transformSessionPayload\n      ? this.#transformSessionPayload(cloneRealtimeEvent(canonicalPayload))\n      : canonicalPayload;\n    if (this.#transformSessionPayload) {\n      this.#pendingTransformedSessionUpdates += 1;\n    }\n    this.sendEvent({\n      type: 'session.update',\n      session,\n    });\n  }\n"""
if old_send not in text:
    raise SystemExit("_sendSessionUpdate block not found")
text = text.replace(old_send, new_send, 1)
src.write_text(text)

test = Path("packages/agents-realtime/test/sessionPayloadTransform.test.ts")
t = test.read_text()
anchor = """  it('keeps buildSessionPayload canonical', () => {\n"""
insert = """  it('does not let an in-place transform mutate canonical state', () => {\n    const base = new TestBase({\n      transformSessionPayload: (payload) => {\n        const turnDetection = payload.audio?.input?.turn_detection;\n        if (turnDetection) {\n          delete turnDetection.interrupt_response;\n        }\n        return payload;\n      },\n    });\n\n    base.updateSessionConfig({\n      turnDetection: {\n        type: 'server_vad',\n        interruptResponse: true,\n      },\n    });\n\n    expect(\n      base.events[0]?.session.audio?.input?.turn_detection?.interrupt_response,\n    ).toBeUndefined();\n    expect(\n      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,\n    ).toBe(true);\n  });\n\n  it('tracks direct session update acknowledgements after transformed updates', () => {\n    const base = new TestBase({\n      transformSessionPayload: ({ type: _type, ...rest }) => rest,\n    });\n\n    base.updateSessionConfig({ instructions: 'sdk managed' });\n    base.receiveSessionUpdated({ instructions: 'provider acknowledgement' });\n\n    expect(base.rawSessionConfig?.instructions).toBe('sdk managed');\n\n    base.sendEvent({\n      type: 'session.update',\n      session: {\n        audio: {\n          input: {\n            turn_detection: {\n              type: 'server_vad',\n              interrupt_response: false,\n            },\n          },\n        },\n      },\n    });\n    base.receiveSessionUpdated({\n      audio: {\n        input: {\n          turn_detection: {\n            type: 'server_vad',\n            interrupt_response: false,\n          },\n        },\n      },\n    });\n\n    expect(\n      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,\n    ).toBe(false);\n  });\n\n"""
if anchor not in t:
    raise SystemExit("test insertion anchor not found")
t = t.replace(anchor, insert + anchor, 1)
test.write_text(t)

Path(".github/workflows/apply-1685-review.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
