import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';
import { getRouterManifest } from '@tanstack/react-start/router-manifest';

import { createRouter } from './router';

const streamHandler = defaultStreamHandler;

export default createStartHandler({
  createRouter,
  getRouterManifest,
})(streamHandler);
