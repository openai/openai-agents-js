import { chromium, Browser, Page } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { Agent, run, withTrace, computerTool, Computer } from '@openai/agents';

const AUTO_APPROVE_HITL = process.env.AUTO_APPROVE_HITL === '1';
const HEADLESS = process.env.COMPUTER_USE_HEADLESS !== '0';
const START_URL = process.env.COMPUTER_USE_START_URL;
const DEMO_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <title>Tokyo Weather Demo</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 40px;
      }
      section {
        max-width: 520px;
      }
      button {
        font: inherit;
        padding: 8px 12px;
      }
    </style>
    <script>
      function refreshForecast() {
        document.querySelector('[data-testid="status"]').textContent =
          'Forecast refreshed at demo time.';
        document.querySelector('[data-testid="current"]').textContent =
          'Current conditions: partly cloudy, 22C.';
        document.querySelector('[data-testid="details"]').textContent =
          'Wind: 37 km/h. Visibility: 10 km. Precipitation: 0.1 mm.';
        document.querySelector('[data-testid="outlook"]').hidden = false;
      }
    </script>
  </head>
  <body>
    <section>
      <h1>Tokyo Weather Demo</h1>
      <p data-testid="status">Forecast pending.</p>
      <button type="button" onclick="refreshForecast()">Refresh forecast</button>
      <p data-testid="current">Current conditions: not loaded.</p>
      <p data-testid="details">Details: not loaded.</p>
      <div data-testid="outlook" hidden>
        <h2>Today</h2>
        <ul>
          <li>Morning: partly cloudy, 19C.</li>
          <li>Noon: sunny, 20C.</li>
          <li>Evening: partly cloudy, 20C.</li>
          <li>Night: clear, 19C.</li>
        </ul>
      </div>
    </section>
  </body>
</html>`;
const AGENT_INSTRUCTIONS =
  'You are a helpful agent. Use the browser computer tool to inspect web pages.';
const WEATHER_PROMPT =
  'Use the browser computer tool to click the Refresh forecast button, then summarize the Tokyo weather shown on the page.';

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
      const candidate = rawItem as {
        action?: { type?: string };
        actions?: Array<{ type?: string }>;
      };
      const actions =
        Array.isArray(candidate.actions) && candidate.actions.length > 0
          ? candidate.actions
          : candidate.action
            ? [candidate.action]
            : [];
      const action = actions[0];
      if (actions.length > 1) {
        const summary = actions
          .map((entry) => entry?.type ?? 'unknown')
          .join(', ');
        return `computer actions [${summary}]`;
      }
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
      model: 'gpt-5.4',
      instructions: AGENT_INSTRUCTIONS,
      modelSettings: { toolChoice: 'required' },
      tools: [
        computerTool({
          computer,
          needsApproval: async (_ctx, action) =>
            ['click', 'type', 'keypress'].includes(action.type),
        }),
      ],
    });
    await withTrace('CUA Example', async () => {
      const result = await runWithHitl(agent, WEATHER_PROMPT);
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
    model: 'gpt-5.4',
    instructions: AGENT_INSTRUCTIONS,
    modelSettings: { toolChoice: 'required' },
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
  });
  await withTrace('CUA Example', async () => {
    const result = await runWithHitl(agent, WEATHER_PROMPT);
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
        // Optional: provide a custom rejection message for the agent to see.
        // If not provided, toolErrorFormatter (if configured) or the SDK default is used.
        state.reject(interruption, {
          message: `Tool execution for "${interruption.name}" was dismissed by the user. You may ask to run it again if needed.`,
        });
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
      headless: HEADLESS,
      args: [`--window-size=${width},${height}`],
    });
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });
    if (START_URL) {
      await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    } else {
      await page.setContent(DEMO_PAGE_HTML, { waitUntil: 'domcontentloaded' });
    }
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
