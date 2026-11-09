/** V2 fixes grammatical false negatives without changing the required claim.
 * This remains a lexical verifier; file citations and the other evidence checks
 * are independently required by the journey oracle. */
export function identifiesDisconnectedConfiguration(answer) {
  const text = answer.toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[*_]/g, '');
  return /\b(orfao|orfa|unused|nao participa|duplicad|duas fontes|segunda fonte|desconectad|independent|fonte paralela)/.test(text)
    || /\bnao\s+(?:(?:e|esta|sao|estao)\s+)?(?:usad[ao]s?|utilizad[ao]s?|consumid[ao]s?|conectad[ao]s?)\b/.test(text);
}
