import type { TransportEvent } from '@openai/agents-realtime';

export function log(event: TransportEvent) {
  const log = document.querySelector<HTMLDivElement>('#eventLog')!;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.innerText = event.type;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(event, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  log.appendChild(details);
}

export const muteButton =
  document.querySelector<HTMLButtonElement>('#muteButton')!;
export const disconnectButton =
  document.querySelector<HTMLButtonElement>('#disconnectButton')!;
export const connectButton =
  document.querySelector<HTMLButtonElement>('#connectButton')!;

type ButtonState = 'muted' | 'unmuted' | 'disconnected';
export function setButtonStates(newState: ButtonState) {
  if (newState === 'muted') {
    disconnectButton.style.display = 'block';
    connectButton.style.display = 'none';
    muteButton.style.display = 'block';
    muteButton.classList.replace('bg-gray-500', 'bg-green-500');
    muteButton.innerText = 'Unmute';
  } else if (newState === 'unmuted') {
    disconnectButton.style.display = 'block';
    connectButton.style.display = 'none';
    muteButton.style.display = 'block';
    muteButton.classList.replace('bg-green-500', 'bg-gray-500');
    muteButton.innerText = 'Mute';
  } else if (newState === 'disconnected') {
    muteButton.style.display = 'none';
    disconnectButton.style.display = 'none';
    connectButton.style.display = 'block';
  }
}

const mcpToolsList = document.querySelector<HTMLUListElement>('#mcpToolsList')!;
const mcpToolsEmptyState = document.querySelector<HTMLParagraphElement>(
  '#mcpToolsEmptyState',
)!;

export function setMcpTools(toolNames: string[]) {
  mcpToolsList.innerHTML = '';
  if (toolNames.length === 0) {
    mcpToolsEmptyState.style.display = 'block';
    return;
  }
  mcpToolsEmptyState.style.display = 'none';
  for (const name of toolNames) {
    const item = document.createElement('li');
    item.className = 'text-xs';
    item.innerText = name;
    mcpToolsList.appendChild(item);
  }
}
