import { Environment } from '@openai/agents';
import {
  Manifest,
  sandboxEnvironment,
  renderStorageLayout,
} from '@openai/agents/sandbox';
import { createHermesVoiceControl } from '@openai/agents/voice/control.hermes';
import { PortableVoiceControlBinding } from '@openai/agents/voice/portable';
import portableCjs = require('@openai/agents-codex/voice/portable');
import hermesCjs = require('@openai/agents-codex/voice/control.hermes');

const manifest = new Manifest({
  root: '/workspace',
  environment: { MODE: 'local' },
});
renderStorageLayout(manifest);
sandboxEnvironment({
  manifest,
  client: {
    backendId: 'identity-fixture',
    async create() {
      return { state: { manifest }, async close() {} };
    },
  },
  async connect() {
    return Environment.lease(Environment.local({ cwd: '.' }), () => {});
  },
});
const control: PortableVoiceControlBinding =
  hermesCjs.createHermesVoiceControl();
const cjsControl: portableCjs.PortableVoiceControlBinding =
  createHermesVoiceControl();
void [control, cjsControl];
