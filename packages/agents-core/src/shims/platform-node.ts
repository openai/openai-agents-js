// Keep ordinary declarations separate from optional MCP implementation types.
export type { EventEmitter, EventEmitterEvents } from './interface';
export { EventEmitter as RuntimeEventEmitter } from 'node:events';
export { Readable } from 'node:stream';
