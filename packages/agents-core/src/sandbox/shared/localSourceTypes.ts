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
  readFile(name: string): Promise<Uint8Array>;
  entries(): Promise<NativeSourceEntry[]>;
  close(): Promise<void>;
}
