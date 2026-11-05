// Fail the example's synthetic HTTP model boundary without changing its cases.
import { Server } from 'node:http';
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && args[0].url === '/v1/responses') {
    args[0].resume();
    args[1]
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'synthetic-private-error' } }));
    return true;
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
