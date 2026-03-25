import type { RealtimeClientMessage } from './clientMessages';

export type ResponseCreateControl =
  | 'free'
  | 'create_requested'
  | 'cancel_requested';

type PendingResponseCreate = {
  event: RealtimeClientMessage;
  eventId: string;
  requestVersion: number;
  targetVersion: number;
  manual: boolean;
};

type ResponseCreateErrorEvent = {
  error?: {
    code?: unknown;
    message?: unknown;
    event_id?: unknown;
  };
};

export class ResponseCreateSequencer {
  #ongoingResponse = false;
  #responseControl: ResponseCreateControl = 'free';
  #responseCreateRequestVersion = 0;
  #responseCreateEventCounter = 0;
  #pendingRequestVersions = new Set<number>();
  #manualResponseCreateVersions = new Set<number>();
  #pendingResponseCreate: PendingResponseCreate | null = null;
  #waiters = new Set<() => void>();
  #generation = 0;

  constructor(
    private readonly sendEventNow: (event: RealtimeClientMessage) => void,
    private readonly onError?: (error: unknown) => void,
  ) {}

  get ongoingResponse(): boolean {
    return this.#ongoingResponse;
  }

  get responseControl(): ResponseCreateControl {
    return this.#responseControl;
  }

  get pendingResponseCreateEventId(): string | null {
    return this.#pendingResponseCreate?.eventId ?? null;
  }

  requestResponseCreate(
    event: RealtimeClientMessage,
    { manual = false }: { manual?: boolean } = {},
  ): void {
    const requestVersion = this.#reserveResponseCreateRequest(manual);
    const generation = this.#generation;
    const pending = this.#tryPrepareResponseCreate({
      event,
      manual,
      requestVersion,
    });
    if (pending) {
      this.#dispatchResponseCreate(pending, generation);
      return;
    }

    void this.#startResponseCreate({
      event,
      manual,
      requestVersion,
      generation,
    });
  }

  markResponseCreated(): void {
    this.#ongoingResponse = true;
    this.#clearAcceptedResponseCreate();
    this.#responseControl = 'free';
    this.#notifyWaiters();
  }

  markResponseDone(): void {
    this.#ongoingResponse = false;
    this.#clearAcceptedResponseCreate();
    this.#responseControl = 'free';
    this.#notifyWaiters();
  }

  releaseWaiters(): void {
    this.#generation += 1;
    this.#ongoingResponse = false;
    this.#pendingRequestVersions.clear();
    this.#manualResponseCreateVersions.clear();
    this.#pendingResponseCreate = null;
    this.#responseControl = 'free';
    this.#notifyWaiters();
  }

  beginCancelResponse(): boolean {
    if (
      !this.#ongoingResponse ||
      this.#responseControl === 'cancel_requested'
    ) {
      return false;
    }

    this.#responseControl = 'cancel_requested';
    this.#notifyWaiters();
    return true;
  }

  handleResponseCreateError(event: ResponseCreateErrorEvent): boolean {
    const error = event.error;
    const linkedEventId =
      typeof error?.event_id === 'string' ? error.event_id : undefined;
    if (linkedEventId) {
      return this.#clearPendingResponseCreate(linkedEventId);
    }

    if (this.#isResponseCreateLikeError(error)) {
      return this.#clearPendingResponseCreate();
    }

    return false;
  }

  #reserveResponseCreateRequest(manual: boolean): number {
    this.#responseCreateRequestVersion += 1;
    const requestVersion = this.#responseCreateRequestVersion;
    this.#pendingRequestVersions.add(requestVersion);
    if (manual) {
      this.#manualResponseCreateVersions.add(requestVersion);
    }
    this.#notifyWaiters();
    return requestVersion;
  }

  async #startResponseCreate({
    event,
    manual,
    requestVersion,
    generation,
  }: {
    event: RealtimeClientMessage;
    manual: boolean;
    requestVersion: number;
    generation: number;
  }): Promise<void> {
    const pending = await this.#waitForResponseCreateSlot({
      event,
      manual,
      requestVersion,
      generation,
    });
    if (!pending || generation !== this.#generation) {
      return;
    }

    this.#dispatchResponseCreate(pending, generation);
  }

  #dispatchResponseCreate(
    pending: PendingResponseCreate,
    generation: number,
  ): void {
    if (generation !== this.#generation) {
      return;
    }

    try {
      this.sendEventNow(pending.event);
    } catch (error) {
      this.#clearPendingResponseCreate(pending.eventId);
      this.onError?.(error);
      return;
    }
  }

  async #waitForResponseCreateSlot({
    event,
    manual,
    requestVersion,
    generation,
  }: {
    event: RealtimeClientMessage;
    manual: boolean;
    requestVersion: number;
    generation: number;
  }): Promise<PendingResponseCreate | null> {
    while (generation === this.#generation) {
      const pending = this.#tryPrepareResponseCreate({
        event,
        manual,
        requestVersion,
      });
      if (pending) {
        return pending;
      }

      await this.#waitForChange(generation);
    }

    return null;
  }

  #tryPrepareResponseCreate({
    event,
    manual,
    requestVersion,
  }: {
    event: RealtimeClientMessage;
    manual: boolean;
    requestVersion: number;
  }): PendingResponseCreate | null {
    if (!this.#pendingRequestVersions.has(requestVersion)) {
      return null;
    }

    if (
      this.#ongoingResponse ||
      this.#responseControl !== 'free' ||
      this.#nextPendingRequestVersion() !== requestVersion
    ) {
      return null;
    }

    this.#responseControl = 'create_requested';
    const eventId =
      typeof event.event_id === 'string'
        ? event.event_id
        : this.#nextResponseCreateEventId();
    const targetVersion = manual
      ? requestVersion
      : this.#autoResponseCreateTargetVersion(requestVersion);
    const pending: PendingResponseCreate = {
      event: {
        ...event,
        event_id: eventId,
      },
      eventId,
      requestVersion,
      targetVersion,
      manual,
    };
    this.#pendingResponseCreate = pending;
    return pending;
  }

  #clearPendingResponseCreate(eventId?: string): boolean {
    if (
      this.#responseControl !== 'create_requested' ||
      this.#pendingResponseCreate === null
    ) {
      return false;
    }

    if (eventId && this.#pendingResponseCreate.eventId !== eventId) {
      return false;
    }

    // Preserve later auto requests that were coalesced into the failed create
    // so they can trigger a fresh response.create.
    this.#restoreCoveredAutoRequestVersions(this.#pendingResponseCreate);
    this.#pendingRequestVersions.delete(
      this.#pendingResponseCreate.requestVersion,
    );
    if (this.#pendingResponseCreate.manual) {
      this.#manualResponseCreateVersions.delete(
        this.#pendingResponseCreate.requestVersion,
      );
    }
    this.#pendingResponseCreate = null;
    this.#responseControl = 'free';
    this.#notifyWaiters();
    return true;
  }

  #clearAcceptedResponseCreate(): void {
    if (this.#pendingResponseCreate === null) {
      return;
    }

    for (
      let version = this.#pendingResponseCreate.requestVersion;
      version <= this.#pendingResponseCreate.targetVersion;
      version += 1
    ) {
      this.#pendingRequestVersions.delete(version);
      this.#manualResponseCreateVersions.delete(version);
    }

    this.#pendingResponseCreate = null;
  }

  #restoreCoveredAutoRequestVersions(pending: PendingResponseCreate): void {
    for (
      let version = pending.requestVersion + 1;
      version <= pending.targetVersion;
      version += 1
    ) {
      this.#pendingRequestVersions.add(version);
    }
  }

  #nextPendingRequestVersion(): number | null {
    if (this.#pendingRequestVersions.size === 0) {
      return null;
    }

    return Math.min(...this.#pendingRequestVersions);
  }

  #autoResponseCreateTargetVersion(requestVersion: number): number {
    const nextManualVersion = Math.min(
      ...Array.from(this.#manualResponseCreateVersions).filter(
        (version) => version >= requestVersion,
      ),
    );
    const eligibleVersions = Number.isFinite(nextManualVersion)
      ? Array.from(this.#pendingRequestVersions).filter(
          (version) => version < nextManualVersion,
        )
      : Array.from(this.#pendingRequestVersions);

    return Math.max(...eligibleVersions);
  }

  #nextResponseCreateEventId(): string {
    this.#responseCreateEventCounter += 1;
    return `agents_js_response_create_${this.#responseCreateEventCounter}`;
  }

  #isResponseCreateLikeError(
    error: ResponseCreateErrorEvent['error'],
  ): boolean {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code.includes('response_create')) {
      return true;
    }

    const message = typeof error?.message === 'string' ? error.message : '';
    return message.includes('response.create');
  }

  #notifyWaiters(): void {
    const waiters = Array.from(this.#waiters);
    this.#waiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  #waitForChange(generation: number): Promise<void> {
    if (generation !== this.#generation) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#waiters.add(resolve);
    });
  }
}
