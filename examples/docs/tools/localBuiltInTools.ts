import {
  Agent,
  applyPatchTool,
  computerTool,
  shellTool,
  Computer,
  Editor,
  Shell,
} from '@openai/agents';

const computer: Computer = {
  environment: 'browser',
  dimensions: [1024, 768],
  screenshot: async () => '',
  click: async () => {},
  doubleClick: async () => {},
  scroll: async () => {},
  type: async () => {},
  wait: async () => {},
  move: async () => {},
  keypress: async () => {},
  drag: async () => {},
};

const shell: Shell = {
  run: async () => ({
    output: [
      {
        stdout: '',
        stderr: '',
        outcome: { type: 'exit', exitCode: 0 },
      },
    ],
  }),
};

const editor: Editor = {
  createFile: async () => ({ status: 'completed' }),
  updateFile: async () => ({ status: 'completed' }),
  deleteFile: async () => ({ status: 'completed' }),
};

const agent = new Agent({
  name: 'Local tools agent',
  tools: [
    computerTool({ computer }),
    shellTool({ shell, needsApproval: true }),
    applyPatchTool({ editor, needsApproval: true }),
  ],
});

void agent;
