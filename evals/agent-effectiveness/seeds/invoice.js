function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateInvoice({ subtotal, discountRate, taxRate }) {
  const discounted = roundMoney(subtotal * (1 - discountRate));
  return roundMoney(discounted * (1 + taxRate));
}

