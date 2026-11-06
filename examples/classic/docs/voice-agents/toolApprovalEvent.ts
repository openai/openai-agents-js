import { session } from './agent';

session.on('tool_approval_requested', (_context, _agent, request) => {
  // Show a UI to let the user approve or reject the tool call
  // Then resolve the request with `session.approve(...)` or `session.reject(...)`

  session.approve(request.approvalItem);
});
