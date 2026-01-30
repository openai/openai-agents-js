import { chromium, Browser, Page } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { Agent, run, withTrace, computerTool, Computer } from '@openai/agents';

const AUTO_APPROVE_HITL = process.env.AUTO_APPROVE_HITL === '1';

async function confirm(question: string): Promise<boolean> {
  if (AUTO_APPROVE_HITL) {
    console.log(`[auto-approve] ${question}`);
    return true;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(`${question} (y/n): `);
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

function describeInterruption(interruption: { rawItem?: unknown }): string {
  const rawItem = interruption.rawItem;
  if (rawItem && typeof rawItem === 'object') {
    const itemType = (rawItem as { type?: string }).type;
    if (itemType === 'computer_call') {
      const action = (rawItem as { action?: { type?: string } }).action;
      if (action?.type === 'type') {
        const text = (action as { text?: string }).text ?? '';
        const trimmed = text.length > 120 ? `${text.slice(0, 117)}...` : text;
        return `computer action "type" with text "${trimmed}"`;
      }
      if (action?.type === 'keypress') {
        const keys = (action as { keys?: string[] }).keys ?? [];
        return `computer action "keypress" with keys [${keys.join(', ')}]`;
      }
      if (action?.type === 'click') {
        const { x, y, button } = action as {
          x?: number;
          y?: number;
          button?: string;
        };
        const buttonLabel = button ? ` (${button})` : '';
        return `computer action "click" at (${x}, ${y})${buttonLabel}`;
      }
      if (action?.type === 'scroll') {
        const { scroll_x, scroll_y } = action as {
          scroll_x?: number;
          scroll_y?: number;
        };
        return `computer action "scroll" by (${scroll_x}, ${scroll_y})`;
      }
      if (action?.type === 'move') {
        const { x, y } = action as { x?: number; y?: number };
        return `computer action "move" to (${x}, ${y})`;
      }
      if (action?.type) {
        return `computer action "${action.type}"`;
      }
      return 'computer action';
    }
  }
  return 'tool action';
}

async function singletonComputer() {
  // If your app never runs multiple computer using agents at the same time,
  // you can create a singleton computer and use it in all your agents.
  const computer = await new LocalPlaywrightComputer().init();
  try {
    const agent = new Agent({
      name: 'Browser user',
      model: 'computer-use-preview',
      instructions: 'You are a helpful agent.',
      tools: [
        computerTool({
          computer,
          needsApproval: async (_ctx, action) =>
            ['click', 'type', 'keypress'].includes(action.type),
        }),
      ],
      modelSettings: { truncation: 'auto' },
    });
    await withTrace('CUA Example', async () => {
      const result = await runWithHitl(agent, "What's the weather in Tokyo?");
      console.log(`\nFinal response:\n${result.finalOutput}`);
    });
  } finally {
    await computer.dispose();
  }
}

async function computerPerRequest() {
  // If your app runs multiple computer using agents at the same time,
  // you can create a computer per request.
  const agent = new Agent({
    name: 'Browser user',
    model: 'computer-use-preview',
    instructions: 'You are a helpful agent.',
    tools: [
      computerTool({
        // initialize a new computer for each run and dispose it after the run is complete
        computer: {
          create: async ({ runContext }) => {
            console.log('Initializing computer for run context:', runContext);
            return await new LocalPlaywrightComputer().init();
          },
          dispose: async ({ runContext, computer }) => {
            console.log('Disposing of computer for run context:', runContext);
            await computer.dispose();
          },
        },
        onSafetyCheck: async ({ pendingSafetyChecks }) => {
          console.log('Pending safety checks:', pendingSafetyChecks);
          // acknowledge all pending safety checks
          return { acknowledgedSafetyChecks: pendingSafetyChecks };
          // or return true to acknowledge all pending safety checks
        },
        needsApproval: async (_ctx, action) =>
          ['click', 'type', 'keypress'].includes(action.type),
      }),
    ],
    modelSettings: { truncation: 'auto' },
  });
  await withTrace('CUA Example', async () => {
    const result = await runWithHitl(agent, "What's the weather in Tokyo?");
    console.log(`\nFinal response:\n${result.finalOutput}`);
  });
}

async function runWithHitl(agent: Agent<unknown, any>, input: string) {
  let result = await run(agent, input);
  while (result.interruptions?.length) {
    const state = result.state;
    for (const interruption of result.interruptions) {
      const description = describeInterruption(interruption);
      const approved = await confirm(
        `Agent ${interruption.agent.name} requested ${description}. Approve?`,
      );
      if (approved) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }
    result = await run(agent, state);
  }
  return result;
}

// --- CUA KEY TO PLAYWRIGHT KEY MAP ---

const CUA_KEY_TO_PLAYWRIGHT_KEY: Record<string, string> = {
  '/': 'Divide',
  '\\': 'Backslash',
  alt: 'Alt',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  backspace: 'Backspace',
  capslock: 'CapsLock',
  cmd: 'Meta',
  ctrl: 'Control',
  delete: 'Delete',
  end: 'End',
  enter: 'Enter',
  esc: 'Escape',
  home: 'Home',
  insert: 'Insert',
  option: 'Alt',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  shift: 'Shift',
  space: ' ',
  super: 'Meta',
  tab: 'Tab',
  win: 'Meta',
};

// --- LocalPlaywrightComputer Implementation ---

class LocalPlaywrightComputer implements Computer {
  private _browser: Browser | null = null;
  private _page: Page | null = null;

  get dimensions(): [number, number] {
    return [1024, 768];
  }

  get environment(): 'browser' {
    return 'browser';
  }

  get browser(): Browser {
    if (!this._browser) throw new Error('Browser not initialized');
    return this._browser;
  }

  get page(): Page {
    if (!this._page) throw new Error('Page not initialized');
    return this._page;
  }

  async _get_browser_and_page(): Promise<[Browser, Page]> {
    const [width, height] = this.dimensions;
    const browser = await chromium.launch({
      headless: false,
      args: [`--window-size=${width},${height}`],
    });
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });
    await page.goto('https://www.bing.com/');
    return [browser, page];
  }

  async init(): Promise<this> {
    [this._browser, this._page] = await this._get_browser_and_page();
    return this;
  }

  async dispose(): Promise<void> {
    console.log('Disposing of browser and page');
    if (this._browser) await this._browser.close();
    this._browser = null;
    this._page = null;
  }

  async screenshot(): Promise<string> {
    console.log('Taking a screenshot');
    try {
      if (!this._page) throw new Error('Page not initialized');
      if (!this._browser) throw new Error('Browser not initialized');
      if (typeof this._page.isClosed === 'function' && this._page.isClosed()) {
        throw new Error('Page is already closed');
      }
      // Be more lenient: fall back to 'load' if networkidle stalls (e.g., long polling ads/widgets).
      try {
        await this._page.waitForLoadState('networkidle', { timeout: 15000 });
      } catch (_err) {
        console.warn('networkidle wait timed out; retrying with load state');
        await this._page.waitForLoadState('load', { timeout: 15000 });
      }
      // One retry of the screenshot to reduce transient failures.
      const buf = await this._page.screenshot({ fullPage: false });
      return Buffer.from(buf).toString('base64');
    } catch (err) {
      console.error('Screenshot failed:', err);
      throw err;
    }
  }

  async click(
    x: number,
    y: number,
    button: 'left' | 'right' | 'wheel' | 'back' | 'forward' = 'left',
  ): Promise<void> {
    console.log(`Clicking at (${x}, ${y})`);
    // Playwright only supports 'left', 'right', 'middle'; others fallback to 'left'
    let playwrightButton: 'left' | 'right' | 'middle' = 'left';
    if (button === 'right') playwrightButton = 'right';
    await this.page.mouse.click(x, y, { button: playwrightButton });
  }

  async doubleClick(x: number, y: number): Promise<void> {
    console.log('doubleClick');
    await this.page.mouse.dblclick(x, y);
  }

  async scroll(
    x: number,
    y: number,
    scrollX: number,
    scrollY: number,
  ): Promise<void> {
    console.log(`Scrolling to (${x}, ${y}) by (${scrollX}, ${scrollY})`);
    await this.page.mouse.move(x, y);
    await this.page.evaluate(
      ([sx, sy]) => window.scrollBy(sx, sy),
      [scrollX, scrollY],
    );
  }

  async type(text: string): Promise<void> {
    console.log(`Typing: ${text}`);
    await this.page.keyboard.type(text);
  }

  async wait(): Promise<void> {
    console.log('Waiting');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async move(x: number, y: number): Promise<void> {
    console.log(`Moving to (${x}, ${y})`);
    await this.page.mouse.move(x, y);
  }

  async keypress(keys: string[]): Promise<void> {
    console.log(`Pressing keys: ${keys}`);
    const mappedKeys = keys.map(
      (key) => CUA_KEY_TO_PLAYWRIGHT_KEY[key.toLowerCase()] || key,
    );
    for (const key of mappedKeys) {
      await this.page.keyboard.down(key);
    }
    for (const key of mappedKeys.reverse()) {
      await this.page.keyboard.up(key);
    }
  }

  async drag(path: Array<[number, number]>): Promise<void> {
    console.log(`Dragging path: ${path}`);
    if (!path.length) return;
    await this.page.mouse.move(path[0][0], path[0][1]);
    await this.page.mouse.down();
    for (const [px, py] of path.slice(1)) {
      await this.page.mouse.move(px, py);
    }
    await this.page.mouse.up();
  }
}

const mode = (process.argv[2] ?? '').toLowerCase();

if (mode === 'singleton') {
  // Choose singleton mode for cases where concurrent runs are not expected.
  singletonComputer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  // Default to per-request mode to avoid sharing state across runs.
  computerPerRequest().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
