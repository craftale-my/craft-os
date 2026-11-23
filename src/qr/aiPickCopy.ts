// src/qr/aiPickCopy.ts
/** The AI Pick card's lines (spec 2026-11-22-qr-ai-pick-mascot-design.md §3). Pre-written, English.
 *  They never name the product: its name, photo and price sit right under the line on the card, so a
 *  line reads the same with any name (long, plural, starting with a number). They make no claim about
 *  what other guests do — a new outlet's suggestions come from the owner's choices, not from sales.
 *  Rules, checked by the test: at most 60 characters, no health or allergy claims, no "best", no price
 *  talk, no "!". */
export type Situation = 'drinks_only' | 'food_only' | 'solo_small' | 'mixed'

export const AI_PICK_COPY: Readonly<Record<Situation, readonly string[]>> = {
  // the table's guest has only drinks: the card suggests food
  drinks_only: [
    'A drink on its own? This would keep it company.',
    'Something to nibble with that?',
    'Sips go better with a bite. How about this one?',
    'Your cup looks a little lonely. This could help.',
    'A little something on the side?',
    'Good drinks like good company. Try this with it.',
  ],
  // only food: the card suggests a drink
  food_only: [
    'That needs a drink. This one goes down well.',
    'Thirsty work, eating. Something to sip?',
    'Something to sip between bites?',
    'Every plate likes a cup beside it.',
    'A drink with that? This is a good match.',
    'Wash it all down with this one.',
  ],
  // one unit in the whole table cart
  solo_small: [
    'Room for one more?',
    'Just the one? This would make it two.',
    'Go on, a little extra.',
    'Treat yourself. We like this one.',
    'One more can\u2019t hurt. How about this?',
    'A small something to go with it?',
  ],
  mixed: [
    'One for the table?',
    'Something to share?',
    'This would round things off nicely.',
    'Still deciding? This is a safe bet.',
    'A little extra for the table?',
    'Before you send it: one more idea.',
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
  void productName                                              // kept for a later source that writes its own line
  return list[hash(`${seed}|${productId}`) % list.length]
}
