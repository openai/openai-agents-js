import type { Session } from '../runtime/public-agent';
import type {
  MCPAppBinding,
  Session as NativeSession,
  Turn,
} from '../runtime/session';
import type { JsonObject, JsonValue } from '../runtime/binding';

/** Detached presentation data from one completed native MCP call. */
export interface MCPAppView {
  callId: string;
  toolName: string;
  arguments: JsonValue;
  result: JsonObject;
  resource: {
    uri: string;
    mimeType: string;
    text: string;
    _meta?: JsonObject;
  };
}

/**
 * A view of one successful MCP call from the latest settled root Turn.
 * Requires fixed, preapproved, callback-free ordinary session-lifetime MCP tools.
 * Resolves the current negotiated tool _meta.ui.resourceUri (or the pinned
 * ui/resourceUri alias) through its native connection. Without declared UI metadata,
 * accepts one embedded or linked result resource. The opened view keeps its resource.
 * Actions call only the originating tool; they do not start model inference.
 * A newer turn, tool update or Session close revokes action authority.
 * The host authenticates its routes and owns iframe sandbox and CSP settings.
 */
export class MCPApp {
  #binding: MCPAppBinding | undefined;
  private constructor(binding: MCPAppBinding) {
    this.#binding = binding;
  }

  /** Open the latest settled root call from a fixed, preapproved ordinary MCP server. */
  static async open(
    session: Session<any, any>,
    turn: Turn<any, any>,
    callId: string,
  ): Promise<MCPApp> {
    return new MCPApp(
      await (session as NativeSession<any, any>)._openMcpApp(turn, callId),
    );
  }

  /** Each read returns detached JSON; editing it does not change the associated tool. */
  get view(): MCPAppView {
    return structuredClone(this.assertOpen().view);
  }

  /** Invoke only the originating raw tool through the borrowed native Session. */
  async callTool(name: string, arguments_: JsonObject): Promise<JsonObject> {
    return this.assertOpen().callTool(name, arguments_);
  }

  /** Detach this view without closing its caller-owned Session or provider. */
  close(): void {
    this.#binding = undefined;
  }

  private assertOpen(): MCPAppBinding {
    if (!this.#binding) throw new Error('MCPApp is closed');
    return this.#binding;
  }
}
