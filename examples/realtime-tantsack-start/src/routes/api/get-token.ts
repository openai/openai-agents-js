import { getToken } from '@/server/token';
import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';

export const APIRoute = createAPIFileRoute('/api/get-token')({
  GET: async () => {
    const token = await getToken();
    return json({ token });
  },
});
