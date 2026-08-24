/* The temporal half of the encoding, written out rather than handed to
 * `Date.parse` or to a library.
 *
 * A corpus reader is a second opinion about the text, and a second
 * opinion that calls the same code the client calls is not one.
 * `Date.parse` also takes a great deal this encoding does not, and is
 * allowed by its own specification to take anything else it likes: it
 * reads `2024-1-1`, it reads `Jan 1 2024`, and what it does with a
 * date-only string is a rule that has changed twice. Writing the four
 * spellings out is thirty lines and it says exactly what is accepted.
 *
 * The spellings are the ones the engine prints, which is the extended
 * ISO 8601 form and nothing else: 2024-01-01 for a date, 12:34:56 with
 * an optional fraction of one to nine digits for a time, the two joined
 * with a T for a datetime, and Z or +07:00 for an offset. A basic-form
 * 20240101 is refused, because a case that writes one is a case the
 * other runners would read differently or not at all.
 *
 * A count of nanoseconds is a `bigint` here for the reason it is one
 * everywhere else in this client: nanoseconds from the epoch pass 2^53
 * in 1970, so a `number` holding one is a value that is quietly not the
 * value that went in. A count of days is a `number`, which is what
 * `ZuDate` holds, and a day count stays exact for eight million years
 * either side of the epoch.
 *
 * The failure spelling is `undefined` rather than an exception, because
 * every caller of these is asking a question about text rather than
 * running a step that can fail, and the one refusal message belongs at
 * the place that knows which type was declared.
 */

import { ZuDate, ZuDuration, ZuTime, ZuTimestamp } from 'zudb'

export const NANOS_PER_SECOND = 1000000000n
export const NANOS_PER_MINUTE = 60n * NANOS_PER_SECOND
export const NANOS_PER_HOUR = 60n * NANOS_PER_MINUTE
export const NANOS_PER_DAY = 24n * NANOS_PER_HOUR

const MILLIS_PER_DAY = 86400000

/* The widest count of nanoseconds or months the engine holds, which is
 * a signed 64 bit integer. A duration past it is refused here rather
 * than handed to a constructor that would throw, since what a case
 * wrote is either a value or it is not and that is the same answer
 * either way.
 */
const MIN_I64 = -9223372036854775808n
const MAX_I64 = 9223372036854775807n

/* A date, as the count of days from 1970-01-01 that the client holds one
 * as.
 */
export function parseDate(text) {
  const days = dateDays(text)
  return days === undefined ? undefined : new ZuDate(days)
}

/* A time of day with no offset on the end. */
export function parseLocalTime(text) {
  const nanos = clockNanos(text)
  return nanos === undefined ? undefined : new ZuTime(nanos, null)
}

/* A time of day with an offset, which it carries as written: the count
 * of nanoseconds is midnight in the offset's own day rather than
 * midnight UTC, which is what this client's `ZuTime` holds and what
 * makes 12:00:00+07:00 and 05:00:00Z two values rather than one.
 */
export function parseZonedTime(text) {
  const zone = splitOffset(text)
  if (zone === undefined) return undefined
  const nanos = clockNanos(zone.rest)
  return nanos === undefined ? undefined : new ZuTime(nanos, zone.offset)
}

/* A date and a time with no offset, as the count of nanoseconds from
 * 1970-01-01T00:00:00 read with no zone at all.
 */
export function parseLocalDateTime(text) {
  const nanos = stampNanos(text)
  return nanos === undefined ? undefined : new ZuTimestamp(nanos, null)
}

/* An instant and the offset it was written with.
 *
 * The client holds the instant in UTC and the offset beside it, so the
 * wall clock that was written is moved back by the offset to get there.
 * Two texts an hour apart in zones an hour apart are the same instant
 * and hold the same count, which is the point of keeping it that way.
 */
export function parseZonedDateTime(text) {
  const zone = splitOffset(text)
  if (zone === undefined) return undefined
  const nanos = stampNanos(zone.rest)
  if (nanos === undefined) return undefined
  return new ZuTimestamp(nanos - BigInt(zone.offset) * NANOS_PER_MINUTE, zone.offset)
}

/* YYYY-MM-DD as a count of days from the epoch.
 *
 * The date is built and read back rather than checked field by field,
 * because that is the calendar answering the question about February
 * rather than this file having an opinion about it. Built through
 * `setUTCFullYear` rather than through `Date.UTC`, which reads a year
 * under a hundred as that year plus nineteen hundred and would turn
 * 0024-01-01 into a date in the twentieth century.
 */
export function dateDays(text) {
  if (text.length !== 10 || text[4] !== '-' || text[7] !== '-') return undefined
  const year = number(text.slice(0, 4))
  const month = number(text.slice(5, 7))
  const day = number(text.slice(8, 10))
  if (year === undefined || month === undefined || day === undefined) return undefined
  const when = new Date(0)
  when.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  if (Number.isNaN(when.getTime())) return undefined
  // A date the calendar does not have comes back as the one it rolled
  // over into, so 2023-02-30 reads back as March and is refused here.
  if (
    BigInt(when.getUTCFullYear()) !== year ||
    BigInt(when.getUTCMonth() + 1) !== month ||
    BigInt(when.getUTCDate()) !== day
  ) {
    return undefined
  }
  return when.getTime() / MILLIS_PER_DAY
}

/* HH:MM:SS, with a fraction of one to nine digits when there is one, as
 * nanoseconds since midnight.
 */
export function clockNanos(text) {
  const dot = text.indexOf('.')
  const head = dot < 0 ? text : text.slice(0, dot)
  const frac = dot < 0 ? null : text.slice(dot + 1)
  if (head.length !== 8 || head[2] !== ':' || head[5] !== ':') return undefined
  const hours = number(head.slice(0, 2))
  const minutes = number(head.slice(3, 5))
  const seconds = number(head.slice(6, 8))
  if (hours === undefined || minutes === undefined || seconds === undefined) return undefined
  // No leap second, because the engine has no value for one: a time is
  // nanoseconds since midnight and 23:59:60 is a second the count does
  // not have.
  if (hours > 23n || minutes > 59n || seconds > 59n) return undefined
  const nanos = hours * NANOS_PER_HOUR + minutes * NANOS_PER_MINUTE + seconds * NANOS_PER_SECOND
  if (frac === null) return nanos
  // A point with nothing after it is not a fraction, and ten digits is
  // finer than the engine counts, so neither is read as the number it
  // resembles.
  if (frac === '' || frac.length > 9) return undefined
  const part = number(frac)
  if (part === undefined) return undefined
  return nanos + part * 10n ** BigInt(9 - frac.length)
}

/* A date and a time joined with a T, as nanoseconds from
 * 1970-01-01T00:00:00.
 */
export function stampNanos(text) {
  const cut = text.indexOf('T')
  if (cut < 0) return undefined
  const days = dateDays(text.slice(0, cut))
  if (days === undefined) return undefined
  const nanos = clockNanos(text.slice(cut + 1))
  if (nanos === undefined) return undefined
  return BigInt(days) * NANOS_PER_DAY + nanos
}

/* Takes the offset off the end of a zoned value and gives back what came
 * before it, with the offset in minutes east of UTC.
 *
 * Zero is written Z rather than +00:00, which is what the engine prints,
 * and both are read here because a case may assert either. Which one it
 * was is not kept, since it is not part of the value: the engine holds
 * an offset in minutes and prints zero as Z whichever way it went in.
 */
export function splitOffset(text) {
  if (text.endsWith('Z')) return { rest: text.slice(0, -1), offset: 0 }
  if (text.length < 7) return undefined
  const zone = text.slice(-6)
  const mark = zone[0]
  if (mark !== '+' && mark !== '-') return undefined
  if (zone[3] !== ':') return undefined
  const hours = number(zone.slice(1, 3))
  const minutes = number(zone.slice(4, 6))
  if (hours === undefined || minutes === undefined || minutes > 59n) return undefined
  const total = Number(hours) * 60 + Number(minutes)
  // The standard's own limit, which is wider than any zone in use and is
  // here so that a typo lands as a refusal rather than as a date a day
  // away from the one that was meant.
  if (total > 18 * 60) return undefined
  return { rest: text.slice(0, -6), offset: mark === '-' ? -total : total }
}

/* A run of ASCII digits as the number it spells, and `undefined` for
 * anything else.
 *
 * Not `BigInt`, which takes a sign, a `0x` and whitespace around the
 * whole of it, none of which belongs inside a temporal field.
 */
function number(text) {
  if (text === '') return undefined
  for (const c of text) if (c < '0' || c > '9') return undefined
  return BigInt(text)
}

/* An ISO 8601 duration, in the two kinds the engine keeps apart.
 *
 * A duration is months or it is nanoseconds and never both, because a
 * month is not a number of days: adding one to a date is a different
 * operation from adding thirty of them, and a type that held both would
 * have to say which happens first. The client has a kind for each, so
 * which one this is is part of what the case asserts.
 *
 * The text says which. A duration whose fields are years and months is
 * the month kind and everything else is the nanosecond kind, and a
 * duration with a field of each is refused rather than guessed at. That
 * leaves one text the fields decide and the numbers cannot, which is a
 * duration of nothing: P0M is no months and PT0S is no nanoseconds, and
 * they are two values here where the Python runner has to call them one.
 */
export function parseDuration(text) {
  let rest = text
  const negative = rest.startsWith('-')
  if (negative || rest.startsWith('+')) rest = rest.slice(1)
  if (!rest.startsWith('P')) return undefined
  rest = rest.slice(1)
  const cut = rest.indexOf('T')
  const dated = cut >= 0
  const day = dated ? rest.slice(0, cut) : rest
  const clock = dated ? rest.slice(cut + 1) : ''
  // A P with nothing under it is not a duration, and neither is a T with
  // nothing after it.
  if (day === '' && clock === '') return undefined
  if (dated && clock === '') return undefined

  let months = 0n
  let nanos = 0n
  let sawMonths = !dated
  for (const field of pieces(day)) {
    if (!field.ok) return undefined
    switch (field.unit) {
      case 'Y':
        months += field.whole * 12n
        break
      case 'M':
        months += field.whole
        break
      case 'W':
        nanos += field.whole * 7n * NANOS_PER_DAY
        sawMonths = false
        break
      case 'D':
        nanos += field.whole * NANOS_PER_DAY
        sawMonths = false
        break
      default:
        return undefined
    }
    // A fraction of a year, a month, a week or a day is a length that
    // depends on which one it lands on, so it is refused here rather
    // than turned into a number of nanoseconds that is right for some of
    // them.
    if (field.frac !== 0n) return undefined
  }
  for (const field of pieces(clock)) {
    if (!field.ok) return undefined
    switch (field.unit) {
      case 'H':
        nanos += field.whole * NANOS_PER_HOUR
        break
      case 'M':
        nanos += field.whole * NANOS_PER_MINUTE
        break
      case 'S':
        nanos += field.whole * NANOS_PER_SECOND + field.frac
        break
      default:
        return undefined
    }
    if (field.frac !== 0n && field.unit !== 'S') return undefined
  }
  if (months !== 0n && nanos !== 0n) return undefined
  if (negative) {
    months = -months
    nanos = -nanos
  }
  if (months < MIN_I64 || months > MAX_I64 || nanos < MIN_I64 || nanos > MAX_I64) return undefined
  if (months !== 0n || (nanos === 0n && sawMonths)) return ZuDuration.ofMonths(months)
  return ZuDuration.ofNanos(nanos)
}

/* Half a duration split into its fields, each one number and the letter
 * after it.
 *
 * A half that does not split gives back one field that is not ok, so
 * that the caller refuses the text at the same place it refuses a unit
 * it does not know.
 */
function pieces(text) {
  const out = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if ((c >= '0' && c <= '9') || c === '.') continue
    const one = { whole: 0n, frac: 0n, unit: c, ok: true }
    const run = text.slice(start, i)
    const dot = run.indexOf('.')
    const head = dot < 0 ? run : run.slice(0, dot)
    const frac = dot < 0 ? null : run.slice(dot + 1)
    const whole = number(head)
    if (whole === undefined) one.ok = false
    else one.whole = whole
    if (frac !== null) {
      const part = frac === '' || frac.length > 9 ? undefined : number(frac)
      if (part === undefined) one.ok = false
      else one.frac = part * 10n ** BigInt(9 - frac.length)
    }
    out.push(one)
    start = i + 1
  }
  // Digits with no unit after them, which is the one thing left over
  // that a caller has to hear about.
  if (start !== text.length) out.push({ whole: 0n, frac: 0n, unit: '', ok: false })
  return out
}

/* A date the way the engine prints one, from the count of days this
 * client holds it as.
 */
export function showDate(days) {
  const when = new Date(days * MILLIS_PER_DAY)
  return (
    pad(when.getUTCFullYear(), 4) +
    '-' +
    pad(when.getUTCMonth() + 1, 2) +
    '-' +
    pad(when.getUTCDate(), 2)
  )
}

/* A count of nanoseconds since midnight the way the engine prints one,
 * which is seconds always and a fraction of nine digits when there is
 * one.
 *
 * Nine and not the shortest that reads back: the report this goes into
 * is diffed against the one the reference runner writes, and that one
 * writes nine.
 */
export function showClock(nanos) {
  const hours = nanos / NANOS_PER_HOUR
  const minutes = (nanos % NANOS_PER_HOUR) / NANOS_PER_MINUTE
  const seconds = (nanos % NANOS_PER_MINUTE) / NANOS_PER_SECOND
  const frac = nanos % NANOS_PER_SECOND
  const out = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`
  return frac === 0n ? out : `${out}.${pad(frac, 9)}`
}

/* A count of nanoseconds from the epoch as a date and a time joined with
 * a T.
 */
export function showStamp(nanos) {
  const days = floorDiv(nanos, NANOS_PER_DAY)
  return `${showDate(Number(days))}T${showClock(nanos - days * NANOS_PER_DAY)}`
}

/* An offset in minutes east of UTC, which is Z at zero rather than
 * +00:00.
 */
export function showOffset(offset) {
  if (offset === 0) return 'Z'
  const sign = offset < 0 ? '-' : '+'
  const size = Math.abs(offset)
  return `${sign}${pad(Math.floor(size / 60), 2)}:${pad(size % 60, 2)}`
}

/* A month duration as the text that parses back to it: a field that is
 * zero is left out, and a duration with nothing left in it is P0M,
 * because P on its own is not a value.
 */
export function showMonths(count) {
  const sign = count < 0n ? '-' : ''
  const size = count < 0n ? -count : count
  const years = size / 12n
  const months = size % 12n
  let out = `${sign}P`
  if (years !== 0n) out += `${years}Y`
  if (months !== 0n || years === 0n) out += `${months}M`
  return out
}

/* A nanosecond duration as the text that parses back to it, under the
 * same rule, with PT0S for the one that is empty.
 */
export function showNanos(count) {
  const sign = count < 0n ? '-' : ''
  const size = count < 0n ? -count : count
  const days = size / NANOS_PER_DAY
  const rest = size % NANOS_PER_DAY
  let out = `${sign}P`
  if (days !== 0n) out += `${days}D`
  if (rest === 0n && days !== 0n) return out
  out += 'T'
  const hours = rest / NANOS_PER_HOUR
  const minutes = (rest % NANOS_PER_HOUR) / NANOS_PER_MINUTE
  const seconds = (rest % NANOS_PER_MINUTE) / NANOS_PER_SECOND
  const frac = rest % NANOS_PER_SECOND
  if (hours !== 0n) out += `${hours}H`
  if (minutes !== 0n) out += `${minutes}M`
  if (seconds !== 0n || frac !== 0n || (hours === 0n && minutes === 0n)) {
    out += `${seconds}`
    if (frac !== 0n) out += `.${pad(frac, 9)}`
    out += 'S'
  }
  return out
}

/* A number in at least width digits, zeroes in front of it. */
function pad(n, width) {
  return `${n}`.padStart(width, '0')
}

/* Division rounding towards minus infinity rather than towards zero,
 * which is what turns an instant before the epoch into the day it is on
 * rather than the day after it.
 */
function floorDiv(a, b) {
  const q = a / b
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q
}
