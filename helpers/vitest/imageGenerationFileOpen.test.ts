import { describe, expect, it } from 'vitest';
import { getFileOpenInvocation } from '../../examples/tools/open-file';

describe('image generation file opening', () => {
  it('opens files directly with the platform helper on macOS', () => {
    expect(getFileOpenInvocation('/tmp/image file.png', 'darwin', {})).toEqual({
      command: 'open',
      args: ['/tmp/image file.png'],
    });
  });

  it('opens files through cmd.exe without shell:true on Windows', () => {
    const filePath = 'C:\\Users\\Example User\\AppData\\Local\\Temp\\image file.png';
    expect(getFileOpenInvocation(filePath, 'win32', {})).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', filePath],
    });
  });

  it('honors ComSpec on Windows', () => {
    expect(
      getFileOpenInvocation('C:\\Temp\\image.png', 'win32', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      }),
    ).toMatchObject({
      command: 'C:\\Windows\\System32\\cmd.exe',
    });
  });

  it('uses xdg-open on other platforms', () => {
    expect(getFileOpenInvocation('/tmp/image.png', 'linux', {})).toEqual({
      command: 'xdg-open',
      args: ['/tmp/image.png'],
    });
  });
});
