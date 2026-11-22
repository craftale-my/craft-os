// src/qr/aiPickCopy.ts
/** The AI Pick card's lines (spec 2026-11-22-qr-ai-pick-mascot-design.md §3). Pre-written, English,
 *  `{name}` = the suggested product's name. Rules, checked by the test: `{name}` once, at most 60 characters
 *  before the name is filled in, no health or allergy claims, no "best", no price talk, no "!". */
export type Situation = 'drinks_only' | 'food_only' | 'solo_small' | 'mixed'

export const AI_PICK_COPY: Readonly<Record<Situation, readonly string[]>> = {
  // the table's guest has only drinks: the card suggests food
  drinks_only: [
    'A drink on its own? {name} would keep it company.',
    'Something to nibble with that? Try {name}.',
    'Sips go better with a bite. How about {name}?',
    'Your cup looks a little lonely. {name} could help.',
    'A little something on the side? {name}.',
    '{name} and a good drink. Nice pair.',
  ],
  // only food: the card suggests a drink
  food_only: [
    'That needs a drink. {name} goes down well with it.',
    'Thirsty work, eating. {name}?',
    'Something to sip between bites? Try {name}.',
    'Wash it all down with {name}.',
    'Every plate likes a cup beside it. {name}?',
    'A drink with that? {name} is a good match.',
  ],
  // one unit in the whole table cart
  solo_small: [
    'Treat yourself — {name} is a favourite here.',
    'Room for one more? {name}.',
    'Just the one? {name} would make it two.',
    'Go on, a little extra: {name}.',
    'Lots of guests add {name} too.',
    '{name} is a quiet favourite here.',
  ],
  mixed: [
    'Tables like yours often add {name}.',
    'One for the table: {name}.',
    'Something to share? {name} goes round nicely.',
    '{name} would round this off.',
    'Still deciding? {name} is a safe bet.',
    'A little extra for the table: {name}.',
  ],
}

/** A small stable hash, so the same visit (seed) and product always get the same line. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** The line for this situation, product and visit: fixed for the visit (a refresh does not change it),
 *  different products usually get different lines. */
export function aiPickSentence(situation: Situation, productId: string, productName: string, seed: number): string {
  const list = AI_PICK_COPY[situation]
  return list[hash(`${seed}|${productId}`) % list.length].replace('{name}', productName)
}
