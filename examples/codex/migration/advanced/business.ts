/** Application data and permissions, independent of either SDK runtime. */
export interface SupportContext {
  customerId: string;
  canNotify: boolean;
  lookups: string[];
  notifications: string[];
}

export const order = {
  orderId: 'ORDER-42',
  customerId: 'CUSTOMER-7',
  status: 'shipped',
  tracking: 'TRACK-42',
};

export const answer = {
  orderId: order.orderId,
  status: order.status,
  tracking: order.tracking,
};

export function applicationContext(canNotify = true): SupportContext {
  return {
    customerId: order.customerId,
    canNotify,
    lookups: [],
    notifications: [],
  };
}

export function lookupOrder(context: SupportContext, orderId: string) {
  if (context.customerId !== order.customerId || orderId !== order.orderId) {
    throw new Error('Order is unavailable to this customer');
  }
  context.lookups.push(orderId);
  return answer;
}

export function notifyCustomer(context: SupportContext, orderId: string) {
  if (!context.canNotify || context.customerId !== order.customerId) {
    throw new Error('Notification permission denied');
  }
  if (orderId !== order.orderId) throw new Error('Unknown order');
  // A local effect stand-in. A real service owns receipts and reconciliation.
  context.notifications.push(orderId);
  return { receipt: `notification:${orderId}` };
}

/** The application keeps this route for the next user turn. */
export function routeSupport(topic: 'shipping' | 'refund') {
  return topic === 'refund' ? 'refund-review' : 'order-support';
}

export const instructions =
  'Look up the requested order. Send a notification only when requested and permitted. ' +
  'Return the orderId, status and tracking. For recall, reuse the earlier facts without tools.';

/** Only reviewed business facts cross into a new native conversation. */
export function reviewedFacts(facts: typeof answer) {
  const { orderId, status, tracking } = facts;
  return `Reviewed order facts: ${JSON.stringify({ orderId, status, tracking })}. Recall these facts without tools.`;
}
