/**
 * Shell-quote a string for safe interpolation into a shell command.
 * Wraps the value in single quotes and escapes any embedded single quotes
 * using the standard '\'' idiom (end quote, escaped literal quote, restart quote).
 *
 * This is the safest general-purpose quoting strategy — single-quoted strings
 * in POSIX shells treat every character literally except the single quote itself.
 */
export function sq(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
