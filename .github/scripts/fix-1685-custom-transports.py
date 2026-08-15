from pathlib import Path

base = Path("packages/agents-realtime/src/openaiRealtimeBase.ts")
text = base.read_text()

text = text.replace(
"""  protected _onOpen() {
    this.#resetSessionUpdateTracking();
    this.emit('connected');
  }
""",
"""  protected _onOpen() {
    this.emit('connected');
  }
""",
1,
)

anchor = """  protected _recordClientEventSent(event: RealtimeClientMessage): void {
"""
helper = """  /**
   * Send a client event while keeping session.update acknowledgement ordering
   * in sync with the wire. Custom transports extending OpenAIRealtimeBase
   * should route their public sendEvent implementation through this helper.
   */
  protected _sendClientEventWithTracking(
    event: RealtimeClientMessage,
    send: (preparedEvent: RealtimeClientMessage) => void,
  ): RealtimeClientMessage {
    const preparedEvent = this._prepareClientEventForSend(event);
    send(preparedEvent);
    this._recordClientEventSent(preparedEvent);
    return preparedEvent;
  }

"""
if anchor not in text:
    raise SystemExit("record helper anchor not found")
text = text.replace(anchor, helper + anchor, 1)
base.write_text(text)

for rel in [
    "packages/agents-realtime/src/openaiRealtimeWebsocket.ts",
    "packages/agents-realtime/src/openaiRealtimeWebRtc.ts",
]:
    path = Path(rel)
    src = path.read_text()
    old = """    const preparedEvent = this._prepareClientEventForSend(event);
    this.#sendEventNow(preparedEvent);
    this._recordClientEventSent(preparedEvent);
"""
    new = """    this._sendClientEventWithTracking(event, (preparedEvent) => {
      this.#sendEventNow(preparedEvent);
    });
"""
    if old not in src:
        raise SystemExit(f"tracked send block not found in {rel}")
    path.write_text(src.replace(old, new, 1))

rn = Path("examples/realtime-react-native/src/ReactNativeWebRTCTransport.ts")
src = rn.read_text()
old = """    if (event.type === 'response.cancel' && this.#activeResponse) {
      this.#cancelRequested = true;
    }
    this.#sendEventNow(event);
  }
"""
new = """    if (event.type === 'response.cancel' && this.#activeResponse) {
      this.#cancelRequested = true;
    }
    this._sendClientEventWithTracking(event, (preparedEvent) => {
      this.#sendEventNow(preparedEvent);
    });
  }
"""
if old not in src:
    raise SystemExit("React Native sendEvent block not found")
rn.write_text(src.replace(old, new, 1))

test_path = Path("packages/agents-realtime/test/sessionPayloadTransform.test.ts")
tests = test_path.read_text()
old_send = """  sendEvent(event: RealtimeClientMessage) {
    const preparedEvent = this._prepareClientEventForSend(event);
    if (this.throwOnSend) {
      throw new Error('send failed');
    }
    this.events.push(preparedEvent);
    this._recordClientEventSent(preparedEvent);
  }
"""
new_send = """  sendEvent(event: RealtimeClientMessage) {
    this._sendClientEventWithTracking(event, (preparedEvent) => {
      if (this.throwOnSend) {
        throw new Error('send failed');
      }
      this.events.push(preparedEvent);
    });
  }
"""
if old_send not in tests:
    raise SystemExit("TestBase sendEvent block not found")
tests = tests.replace(old_send, new_send, 1)

old_helpers = """  updateTracing(tracing: 'auto' | null) {
    this._updateTracingConfig(tracing);
  }

  get rawSessionConfig() {
"""
new_helpers = """  updateTracing(tracing: 'auto' | null) {
    this._updateTracingConfig(tracing);
  }

  open() {
    this._onOpen();
  }

  get rawSessionConfig() {
"""
if old_helpers not in tests:
    raise SystemExit("TestBase helper anchor not found")
tests = tests.replace(old_helpers, new_helpers, 1)

anchor_test = """  it('tracks direct session update acknowledgements after transformed updates', () => {
"""
new_test = """  it('preserves an initial transformed update across the open transition', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    base.updateSessionConfig({ instructions: 'initial sdk update' });
    base.open();
    base.receiveSessionUpdated({ instructions: 'provider acknowledgement' });

    expect(base.rawSessionConfig?.instructions).toBe('initial sdk update');
  });

"""
if anchor_test not in tests:
    raise SystemExit("initial ack test anchor not found")
tests = tests.replace(anchor_test, new_test + anchor_test, 1)
test_path.write_text(tests)

changeset = Path(".changeset/calm-session-provider-hook.md")
cs = changeset.read_text()
old_cs = """---
'@openai/agents-realtime': patch
---

feat(realtime): allow transports to rewrite session update payloads (#466)
"""
new_cs = """---
'@openai/agents-realtime': patch
'realtime-react-native': patch
---

feat(realtime): allow transports to rewrite session update payloads (#466)
"""
if old_cs not in cs:
    raise SystemExit("changeset block not found")
changeset.write_text(cs.replace(old_cs, new_cs, 1))

Path(".github/workflows/fix-1685-custom-transports.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
