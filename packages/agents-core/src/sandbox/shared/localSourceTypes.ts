export type NativeSourceEntry = {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
};

/** A retained native directory authority; names are exactly one component. */
export interface NativeSourceDirectory {
  openDirectory(
    name: string,
    enumerate?: boolean,
  ): Promise<NativeSourceDirectory>;
  readFile(name: string, maxBytes?: number): Promise<Uint8Array>;
  entries(maxEntries?: number): Promise<NativeSourceEntry[]>;
  close(): Promise<void>;
}
