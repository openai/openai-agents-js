import { session } from './agent';

session.on('tool_approval_requested', (_context, _agent, request) => {
  // show a UI to the user to approve or reject the tool call
  // you can use the `session.approve(...)` or `session.reject(...)` methods to approve or reject the tool call

  session.approve(request.approvalItem); // or session.reject(request.approvalItem);
});
