import { describe, it, expect } from 'vitest';
import { applyDiff } from '../../src/utils/applyDiff';

describe('applyDiff', () => {
  it('applies added lines to empty input via V4A floating hunk', () => {
    const diff = ['@@', '+hello', '+world'].join('\n');
    const result = applyDiff('', diff);
    expect(result).toBe('hello\nworld\n');
  });

  it('applies plus-prefixed content for create mode', () => {
    const diff = ['+hello', '+world', '+'].join('\n');
    const result = applyDiff('', diff, 'create');
    expect(result).toBe('hello\nworld\n');
  });

  it('rejects create diff without + prefixes', () => {
    const diff = ['line1', 'line2'].join('\n');
    expect(() => applyDiff('', diff, 'create')).toThrow();
  });

  it('applies floating hunk without marker or line numbers', () => {
    const input = ['- Milk', '- Bread', '- Eggs', '- Apples', '- Coffee'].join(
      '\n',
    );
    const diff = [
      '@@',
      ' - Milk',
      ' - Bread',
      ' - Eggs',
      '-- Apples',
      '-- Coffee',
      '+- [x] Apples',
      '+- [x] Coffee',
    ].join('\n');
    const result = applyDiff(input, diff);
    expect(result).toBe(
      ['- Milk', '- Bread', '- Eggs', '- [x] Apples', '- [x] Coffee'].join(
        '\n',
      ),
    );
  });

  it('applies V4A replacements with context', () => {
    const input = ['line1', 'line2', 'line3'].join('\n') + '\n';
    const diff = ['@@ line1', '-line2', '+updated', ' line3'].join('\n');
    const result = applyDiff(input, diff);
    expect(result).toBe(['line1', 'updated', 'line3'].join('\n') + '\n');
  });

  it('applies V4A deletions', () => {
    const input = ['keep', 'remove me', 'stay'].join('\n') + '\n';
    const diff = ['@@ keep', '-remove me', ' stay'].join('\n');
    const result = applyDiff(input, diff);
    expect(result).toBe(['keep', 'stay'].join('\n') + '\n');
  });

  it('applies V4A context marker diffs (class method rename)', () => {
    const input =
      [
        'class Foo:',
        '    def baz(self):',
        '        return f"foo {randint()}"',
        '',
        'def main():',
        '    foo = Foo()',
        '    print(foo.baz())',
      ].join('\n') + '\n';
    const diff = [
      '@@ class Foo:',
      '-    def baz(self):',
      '+    def rand(self):',
      '        return f"foo {randint()}"',
      '@@ def main():',
      '     foo = Foo()',
      '-    print(foo.baz())',
      '+    print(foo.rand())',
    ].join('\n');
    const result = applyDiff(input, diff);
    expect(result).toBe(
      [
        'class Foo:',
        '    def rand(self):',
        '        return f"foo {randint()}"',
        '',
        'def main():',
        '    foo = Foo()',
        '    print(foo.rand())',
      ].join('\n') + '\n',
    );
  });

  it('treats line-number markers as context anchors', () => {
    const input = 'one\ntwo\n';
    const diff = ['@@ -1,2 +1,2 @@', ' one', '-two', '+2'].join('\n');
    const result = applyDiff(input, diff);
    expect(result).toBe('one\n2\n');
  });

  it('throws on context mismatch', () => {
    const input = 'one\ntwo\n';
    const diff = ['@@ -1,2 +1,2 @@', ' x', '-two', '+2'].join('\n');
    expect(() => applyDiff(input, diff)).toThrow();
  });

  //
  // Example 1 – Simple text replacement
  //
  it('Example 1: README.md basic replacement', () => {
    const input = ['Hello, world!', 'This is my project.'].join('\n');

    const diff = ['-Hello, world!', '+Hello, V4A diff format!'].join('\n');

    const expected = ['Hello, V4A diff format!', 'This is my project.'].join(
      '\n',
    );

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 2 – Replace a whole function (no extra context)
  //
  it('Example 2: greet.py function replacement', () => {
    const input = [
      'def greet(name):',
      '    return "Hello " + name',
      '',
      'if __name__ == "__main__":',
      '    print(greet("Alice"))',
    ].join('\n');

    const diff = [
      '-def greet(name):',
      '-    return "Hello " + name',
      '+def greet(name: str) -> str:',
      '+    return f"Hello, {name}!"',
    ].join('\n');

    const expected = [
      'def greet(name: str) -> str:',
      '    return f"Hello, {name}!"',
      '',
      'if __name__ == "__main__":',
      '    print(greet("Alice"))',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 3 – Toggle a config value with context lines
  //
  it('Example 3: config.yml toggle debug flag', () => {
    const input = ['env: dev', 'debug: false', 'log_level: info'].join('\n');

    const diff = [
      ' env: dev',
      '-debug: false',
      '+debug: true',
      ' log_level: info',
    ].join('\n');

    const expected = ['env: dev', 'debug: true', 'log_level: info'].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 4 – Insert a new import (pure insertion)
  //
  it('Example 4: app.py insert import sys', () => {
    const input = [
      'import os',
      '',
      'def main():',
      '    print("Running app")',
      '',
      'if __name__ == "__main__":',
      '    main()',
    ].join('\n');

    const diff = [
      ' import os',
      '+import sys',
      '',
      ' def main():',
      '     print("Running app")',
      '',
      ' if __name__ == "__main__":',
      '     main()',
    ].join('\n');

    const expected = [
      'import os',
      'import sys',
      '',
      'def main():',
      '    print("Running app")',
      '',
      'if __name__ == "__main__":',
      '    main()',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 5 – Remove a logging line
  //
  it('Example 5: service.py remove debug logging', () => {
    const input = [
      'def handle_request(req):',
      '    print("DEBUG: got request", req)',
      '    return {"status": "ok"}',
    ].join('\n');

    const diff = [
      ' def handle_request(req):',
      '-    print("DEBUG: got request", req)',
      '     return {"status": "ok"}',
    ].join('\n');

    const expected = [
      'def handle_request(req):',
      '    return {"status": "ok"}',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 6 – Use @@ for function context
  //
  it('Example 6: math_utils.py update add() with @@ context', () => {
    const input = [
      'def add(a, b):',
      '    return a + b',
      '',
      'def mul(a, b):',
      '    return a * b',
    ].join('\n');

    const diff = [
      '@@',
      '-def add(a, b):',
      '-    return a + b',
      '+def add(a: int, b: int) -> int:',
      '+    """Add two integers."""',
      '+    return a + b',
    ].join('\n');

    const expected = [
      'def add(a: int, b: int) -> int:',
      '    """Add two integers."""',
      '    return a + b',
      '',
      'def mul(a, b):',
      '    return a * b',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 7 – Nested @@ (class + method)
  //
  it('Example 7: repository.py update get_user method', () => {
    const input = [
      'class UserRepository:',
      '    def get_user(self, user_id):',
      '        raise NotImplementedError',
      '',
      '    def save_user(self, user):',
      '        raise NotImplementedError',
    ].join('\n');

    const diff = [
      '@@ class UserRepository:',
      '     def get_user(self, user_id):',
      '-        raise NotImplementedError',
      '+        """Fetch a user by ID or return None."""',
      '+        return self._db.get(user_id)',
    ].join('\n');

    const expected = [
      'class UserRepository:',
      '    def get_user(self, user_id):',
      '        """Fetch a user by ID or return None."""',
      '        return self._db.get(user_id)',
      '',
      '    def save_user(self, user):',
      '        raise NotImplementedError',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 8 – Single hunk, simple constant change
  //
  it('Example 8: settings.py bump timeout', () => {
    const input = [
      'API_URL = "https://api.example.com"',
      'TIMEOUT_SECONDS = 5',
      'RETRIES = 1',
    ].join('\n');

    const diff = [
      ' API_URL = "https://api.example.com"',
      '-TIMEOUT_SECONDS = 5',
      '+TIMEOUT_SECONDS = 10',
      ' RETRIES = 1',
    ].join('\n');

    const expected = [
      'API_URL = "https://api.example.com"',
      'TIMEOUT_SECONDS = 10',
      'RETRIES = 1',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 9 – Add a new text file
  //
  it('Example 9: docs/intro.txt create file', () => {
    const input = '';

    const diff = [
      '+Welcome to the project!',
      '+This documentation will guide you through setup.',
    ].join('\n');

    const expected = [
      'Welcome to the project!',
      'This documentation will guide you through setup.',
    ].join('\n');

    expect(applyDiff(input, diff, 'create')).toBe(expected);
  });

  //
  // Example 10 – Add a new Python module
  //
  it('Example 10: utils/strings.py create module', () => {
    const input = '';

    const diff = [
      '+def slugify(text: str) -> str:',
      '+    return text.lower().replace(" ", "-")',
      '+',
      '+__all__ = ["slugify"]',
    ].join('\n');

    const expected = [
      'def slugify(text: str) -> str:',
      '    return text.lower().replace(" ", "-")',
      '',
      '__all__ = ["slugify"]',
    ].join('\n');

    expect(applyDiff(input, diff, 'create')).toBe(expected);
  });

  //
  // Example 11 – Add app.py and (conceptually) update main.py
  //
  it('Example 11: app.py create + main.py update', () => {
    // main.py before
    const mainInput = [
      'from app import run',
      '',
      'if __name__ == "__main__":',
      '    run()',
    ].join('\n');

    // app.py before (does not exist)
    const appInput = '';

    // Diff body for app.py (from *** Add File: app.py ...)
    const appDiff = [
      '+def run():',
      '+    print("Hello from app.run()")',
      '+',
    ].join('\n');

    // Diff body for main.py (from *** Update File: main.py ...)
    const mainDiff = [
      '-from app import run',
      '+from app import run',
      ' ',
      ' if __name__ == "__main__":',
      '     run()',
    ].join('\n');

    const appExpected = [
      'def run():',
      '    print("Hello from app.run()")',
      '',
    ].join('\n');

    const mainExpected = [
      'from app import run',
      '',
      'if __name__ == "__main__":',
      '    run()',
    ].join('\n');

    expect(applyDiff(appInput, appDiff, 'create')).toBe(appExpected);
    expect(applyDiff(mainInput, mainDiff, 'default')).toBe(mainExpected);
  });

  //
  // Example 12 – Add a file with a blank line
  //
  it('Example 12: LICENSE create file with blank line', () => {
    const input = '';

    const diff = ['+MIT License', '+', '+Copyright (c) 2025'].join('\n');

    const expected = ['MIT License', '', 'Copyright (c) 2025'].join('\n');

    expect(applyDiff(input, diff, 'create')).toBe(expected);
  });

  //
  // Example 13 – Delete a file
  // NOTE: In V4A, the delete is signaled by *** Delete File, with NO diff body.
  // Here we assert that applyDiff is a no-op when diff is empty; the caller
  // is responsible for actually removing the file.
  //
  it('Example 13: temp/debug.log delete is orchestrated outside applyDiff', () => {
    const input = ['DEBUG something...', 'more debug...'].join('\n');

    const diff = ''; // nothing between *** Delete File and *** End Patch

    const expected = input;

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 14 – Rename (move) a file with *** Move to:
  // NOTE: The path change is handled outside applyDiff; the diff body only
  // contains context, so applyDiff should be a no-op on the content.
  //
  it('Example 14: old_name.txt moved to docs/new_name.txt (content unchanged)', () => {
    const input = 'Legacy content';

    // Body between *** Move to: ... and *** End Patch
    const diff = [' Legacy content'].join('\n');

    const expected = 'Legacy content';

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 15 – Multi-file patch (two updates)
  //
  it('Example 15: api/client.py & api/version.py updates', () => {
    const clientInput = 'BASE_URL = "https://old.example.com"';
    const versionInput = 'VERSION = "1.0.0"';

    const clientDiff = [
      '-BASE_URL = "https://old.example.com"',
      '+BASE_URL = "https://api.example.com"',
    ].join('\n');

    const versionDiff = ['-VERSION = "1.0.0"', '+VERSION = "1.1.0"'].join('\n');

    const clientExpected = 'BASE_URL = "https://api.example.com"';
    const versionExpected = 'VERSION = "1.1.0"';

    expect(applyDiff(clientInput, clientDiff, 'default')).toBe(clientExpected);
    expect(applyDiff(versionInput, versionDiff, 'default')).toBe(
      versionExpected,
    );
  });

  //
  // Example 16 – Insert new test case in the middle of a file
  //
  it('Example 16: tests/test_math.py insert test_sub', () => {
    const input = [
      'def test_add():',
      '    assert add(1, 2) == 3',
      '',
      'def test_mul():',
      '    assert mul(2, 3) == 6',
    ].join('\n');

    const diff = [
      ' def test_add():',
      '     assert add(1, 2) == 3',
      '',
      '+def test_sub():',
      '+    assert sub(5, 2) == 3',
      '+',
      ' def test_mul():',
      '     assert mul(2, 3) == 6',
    ].join('\n');

    const expected = [
      'def test_add():',
      '    assert add(1, 2) == 3',
      '',
      'def test_sub():',
      '    assert sub(5, 2) == 3',
      '',
      'def test_mul():',
      '    assert mul(2, 3) == 6',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 17 – Update last lines near EOF (originally used *** End of File)
  //
  it('Example 17: footer.txt update last two lines', () => {
    const input = ['Line A', 'Line B', 'Line C'].join('\n');

    // Body between *** Update File and *** End of File
    const diff = [
      ' Line A',
      '-Line B',
      '-Line C',
      '+Line B (updated)',
      '+Line C (updated)',
    ].join('\n');

    const expected = ['Line A', 'Line B (updated)', 'Line C (updated)'].join(
      '\n',
    );

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 18 – Markdown heading change with context
  //
  it('Example 18: docs/guide.md update heading and intro', () => {
    const input = [
      '# Getting Started',
      '',
      'This is the old intro text.',
      '',
      '## Installation',
      '',
      'Steps go here.',
    ].join('\n');

    const diff = [
      '-# Getting Started',
      '-',
      '-This is the old intro text.',
      '+# Quick Start Guide',
      '+',
      '+This is the updated introduction, with clearer instructions.',
      '',
      ' ## Installation',
    ].join('\n');

    const expected = [
      '# Quick Start Guide',
      '',
      'This is the updated introduction, with clearer instructions.',
      '',
      '## Installation',
      '',
      'Steps go here.',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 19 – JSON field update
  //
  it('Example 19: config.json enabled -> true', () => {
    const input = [
      '{',
      '  "name": "demo",',
      '  "enabled": false,',
      '  "retries": 3',
      '}',
    ].join('\n');

    const diff = [
      ' {',
      '   "name": "demo",',
      '-  "enabled": false,',
      '+  "enabled": true,',
      '   "retries": 3',
      ' }',
    ].join('\n');

    const expected = [
      '{',
      '  "name": "demo",',
      '  "enabled": true,',
      '  "retries": 3',
      '}',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 20 – Two separate hunks in one file using @@
  //
  it('Example 20: web/app.js update add() and greet()', () => {
    const input = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'function greet(name) {',
      '  return "Hello " + name;',
      '}',
    ].join('\n');

    const diff = [
      '@@',
      '-function add(a, b) {',
      '-  return a + b;',
      '-}',
      '+function add(a, b) {',
      '+  return a + b; // simple add',
      '+}',
      ' ',
      ' function greet(name) {',
      '-  return "Hello " + name;',
      '-}',
      '+  return `Hello ${name}!`;',
      '+}',
    ].join('\n');

    const expected = [
      'function add(a, b) {',
      '  return a + b; // simple add',
      '}',
      '',
      'function greet(name) {',
      '  return `Hello ${name}!`;',
      '}',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 21 – Anchor on function signature but edit body
  //
  it('Example 21: controller.py insert logging after validate', () => {
    const input = [
      'def handle(req):',
      '    validate(req)',
      '    return process(req)',
    ].join('\n');

    const diff = [
      '@@ def handle(req):',
      '     validate(req)',
      '+    log_request(req)',
      '     return process(req)',
    ].join('\n');

    const expected = [
      'def handle(req):',
      '    validate(req)',
      '    log_request(req)',
      '    return process(req)',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });

  //
  // Example 22 – Anchor near EOF with indent
  //
  it('Example 22: greeter.py update main print message', () => {
    const input = [
      'class Greeter:',
      '    def hello(self):',
      '        return "hi"',
      '',
      'def main():',
      '    g = Greeter()',
      '    print(g.hello())',
    ].join('\n');

    const diff = [
      '@@ def main():',
      '     g = Greeter()',
      '-    print(g.hello())',
      '+    print(f"Greeting: {g.hello()}")',
    ].join('\n');

    const expected = [
      'class Greeter:',
      '    def hello(self):',
      '        return "hi"',
      '',
      'def main():',
      '    g = Greeter()',
      '    print(f"Greeting: {g.hello()}")',
    ].join('\n');

    expect(applyDiff(input, diff, 'default')).toBe(expected);
  });
});
