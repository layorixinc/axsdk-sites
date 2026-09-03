/**
 * Terminal bytes → named events. Pure, so the whole input layer is testable without a terminal.
 *
 * Decoding is done on the DECODED STRING, not on bytes: a profile name may be typed in any language
 * and a byte-wise reader splits `팩` into three characters that are not characters.
 *
 * Anything unrecognised is DROPPED rather than passed through as text. A mouse report or a bracketed
 * paste marker arriving as keystrokes would type `[<0;10;10M` into a prompt, and the prompt is where
 * a profile name is confirmed before a delete.
 */

/** Recognised CSI finals mapped to names; every other sequence is dropped. */
const CSI = { A: 'up', B: 'down', C: 'right', D: 'left' };

const event = (name, char) => (char === undefined
  ? { type: 'key', name }
  : { type: 'key', name, char });

export function decodeKeys(chunk) {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const characters = [...text];
  const events = [];
  let index = 0;

  while (index < characters.length) {
    const current = characters[index];

    if (current === '\u001b') {
      const next = characters[index + 1];
      if (next === '[' || next === 'O') {
        // A CSI/SS3 sequence ends at its first final byte (@ through ~); consume the whole run so
        // parameters never leak into a prompt.
        let cursor = index + 2;
        while (cursor < characters.length && !/[@-~]/.test(characters[cursor])) cursor += 1;
        const final = characters[cursor];
        const parameters = characters.slice(index + 2, cursor).join('');
        // Only a bare arrow is a key; `[<0;10;10M` and `[200~` carry parameters and are not.
        if (parameters === '' && CSI[final] !== undefined) events.push(event(CSI[final]));
        index = cursor + 1;
        continue;
      }
      events.push(event('escape'));
      index += 1;
      continue;
    }

    if (current === '\r' || current === '\n') events.push(event('enter'));
    else if (current === '\u007f' || current === '\b') events.push(event('backspace'));
    else if (current === '\u0003') events.push(event('ctrl-c'));
    else if (current >= ' ') events.push(event('char', current));
    // Every other control character is dropped.
    index += 1;
  }
  return events;
}
