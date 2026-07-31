function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateInvoice({ subtotal, discountRate, taxRate }) {
  return roundMoney(subtotal * (1 - discountRate) * (1 + taxRate));
}
