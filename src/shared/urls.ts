/**
 * Considers everything starting with a `<scheme>://` up to the first whitespace, `"` or
 * `'` as a url. Adapted from @xterm/addon-web-links's WebLinksAddon, except the scheme is
 * matched generically (RFC 3986: a letter followed by letters/digits/`+`/`-`/`.`) rather
 * than just http(s), so the app deep links an agent prints — `msteams://`, `vscode://` —
 * are recognized as well.
 *
 * Used on terminal rows, where the input is one line at a time. findUrls() below exists
 * because this must not be let loose on large text — see there.
 */
export const URL_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

/** A character URL_REGEX accepts inside a url — mirrors its body class. */
export const URL_BODY_CHAR = /[^\s"'!*(){}|\\^<>`]/;

/** A character URL_REGEX accepts as a url's last one — mirrors its final class. */
const URL_END_CHAR = /[^\s"':,.!?{}|\\^~[\]`()<>]/;

const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const LETTER = /[A-Za-z]/;

/**
 * Every url in a chunk of text, in order of appearance.
 *
 * Deliberately not URL_REGEX: its `[A-Za-z][A-Za-z0-9+.-]*` prefix has to backtrack
 * through every alphanumeric run that turns out not to be followed by a colon, which is
 * quadratic on the kind of text this gets called with (a session's messages as raw JSON,
 * with base64 blobs and file contents in it). Anchoring on "://" and expanding outwards
 * visits each character a bounded number of times instead. The result matches what
 * URL_REGEX would find, bar a url ending in "*" — which the regex accepts as a final
 * character but not inside the body.
 */
export function findUrls(text: string): string[] {
  const urls: string[] = [];
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    let start = at;
    while (start > 0 && SCHEME_CHAR.test(text[start - 1])) {
      start--;
    }
    // A scheme starts with a letter; anything before that belongs to whatever precedes it.
    while (start < at && !LETTER.test(text[start])) {
      start++;
    }
    if (start === at) {
      continue;
    }
    let end = at + 3;
    while (end < text.length && URL_BODY_CHAR.test(text[end])) {
      end++;
    }
    while (end > at + 3 && !URL_END_CHAR.test(text[end - 1])) {
      end--;
    }
    if (end > at + 3) {
      urls.push(text.slice(start, end));
    }
  }
  return urls;
}
