export function formatInvoiceTotal(subtotal, taxRate) {
  const total = subtotal + taxRate;
  return `$${total.toFixed(2)}`;
}
