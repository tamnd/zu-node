// The temporal half of the encoding, tested in both directions.
//
// These four spellings are written out in the reader rather than handed
// to `Date.parse`, and the reason is the list of refusals here: a general
// reader takes `2024-1-1`, takes `Jan 1 2024`, and has its own opinion
// about what a date with no time in it means. A case that wrote one of
// those would read as a different instant in every client, which is the
// one failure a conformance corpus cannot report.
//
// The printing half is tested just as closely, because the report a
// failing case prints is diffed against the reference runner's. A time
// that prints six fraction digits here and nine there is a diff on every
// line of a report that agrees about every value in it.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ZuDuration } from 'zudb'

import { quote } from '../conformance/reader.mjs'
import { same, show } from '../conformance/values.mjs'
import {
  NANOS_PER_DAY,
  NANOS_PER_HOUR,
  NANOS_PER_MINUTE,
  NANOS_PER_SECOND,
  clockNanos,
  dateDays,
  parseDate,
  parseDuration,
  parseLocalDateTime,
  parseLocalTime,
  parseZonedDateTime,
  parseZonedTime,
  showClock,
  showDate,
  showMonths,
  showNanos,
  showOffset,
  showStamp,
  splitOffset,
  stampNanos,
} from '../conformance/temporal.mjs'

test('a date is a count of days from the epoch', () => {
  for (const [text, want] of [
    ['1970-01-01', 0],
    ['1970-01-02', 1],
    ['1969-12-31', -1],
    ['2024-01-01', 19723],
    ['2024-02-29', 19782],
  ]) {
    assert.equal(dateDays(text), want, text)
  }
  // A year under a hundred is that year and not that year plus nineteen
  // hundred, which is what `Date.UTC` would make of it and the reason the
  // reader builds the date the long way round.
  assert.equal(showDate(dateDays('0024-01-01')), '0024-01-01')
})

test('a date the calendar does not have is refused', () => {
  for (const text of [
    '2023-02-29', // not a leap year
    '2023-02-30',
    '2024-13-01',
    '2024-00-01',
    '2024-01-00',
    '2024-01-32',
    '2024-04-31',
  ]) {
    assert.equal(dateDays(text), undefined, `${quote(text)} was read as a date`)
  }
})

// The spellings a general reader takes and this one does not. Every one
// of them is a date somebody could mean, and every one of them means
// something different in at least one of the five clients.
test('a date written any way but the one way is refused', () => {
  for (const text of [
    '2024-1-01', // a month in one digit
    '2024-01-1',
    '24-01-01', // a year in two
    '20240101', // the basic form
    '2024/01/01',
    '+2024-01-01', // an expanded year
    '2024-01-01T00:00:00', // a datetime under a date
    '2024-01-01 ', // trailing space, which nothing takes off by here
    ' 2024-01-01',
    '',
    'today',
  ]) {
    assert.equal(dateDays(text), undefined, `${quote(text)} was read as a date`)
  }
})

test('a clock is nanoseconds since midnight', () => {
  for (const [text, want] of [
    ['00:00:00', 0n],
    ['12:34:56', 45296n * NANOS_PER_SECOND],
    ['23:59:59', 86399n * NANOS_PER_SECOND],
    ['00:00:00.5', 500000000n],
    ['00:00:00.000000001', 1n],
    ['00:00:00.123456789', 123456789n],
    // A fraction is padded on the right, so a tenth is a tenth however
    // many digits it was written in.
    ['00:00:00.1', 100000000n],
    ['00:00:00.100000000', 100000000n],
  ]) {
    assert.equal(clockNanos(text), want, text)
  }
})

test('a clock outside the day, or spelt loosely, is refused', () => {
  for (const text of [
    '24:00:00', // midnight at the far end, which the engine writes as the next day
    '23:60:00',
    // There is no leap second, because a time here is a count of
    // nanoseconds since midnight and this is a second the count does not
    // have.
    '23:59:60',
    '12:34', // no seconds
    '1:34:56', // an hour in one digit
    '12:34:56.', // a point and no fraction
    '12:34:56.1234567890', // ten digits, which is finer than the engine counts
    '12:34:56.abc',
    '12-34-56',
    '123456',
    '',
  ]) {
    assert.equal(clockNanos(text), undefined, `${quote(text)} was read as a clock`)
  }
})

test('a datetime is a date and a clock joined with a T', () => {
  assert.equal(stampNanos('1970-01-01T00:00:00'), 0n)
  assert.equal(stampNanos('1970-01-02T00:00:00'), NANOS_PER_DAY)
  assert.equal(stampNanos('1969-12-31T23:59:59.999999999'), -1n)
  assert.equal(stampNanos('2024-01-01T12:00:00'), 19723n * NANOS_PER_DAY + 12n * NANOS_PER_HOUR)
  for (const text of [
    '1970-01-01 00:00:00', // a space where the T belongs
    '1970-01-01t00:00:00', // the lower case one, which ISO 8601 allows and the engine does not print
    '1970-01-01',
    'T00:00:00',
    '1970-01-01T',
  ]) {
    assert.equal(stampNanos(text), undefined, `${quote(text)} was read as a datetime`)
  }
})

test('an offset is minutes east of UTC and zero is Z', () => {
  for (const [text, rest, offset] of [
    ['00:00:00Z', '00:00:00', 0],
    // Both spellings of zero are read, since a case may assert either,
    // and neither is kept apart from the other because the engine holds a
    // count of minutes and prints zero as Z whichever way it went in.
    ['00:00:00+00:00', '00:00:00', 0],
    ['00:00:00+07:00', '00:00:00', 420],
    ['00:00:00-05:30', '00:00:00', -330],
    ['00:00:00+18:00', '00:00:00', 1080],
    ['00:00:00-18:00', '00:00:00', -1080],
  ]) {
    assert.deepEqual(splitOffset(text), { rest, offset }, text)
  }
  for (const text of [
    '00:00:00+18:01', // past the standard's own limit
    '00:00:00-18:01',
    '00:00:00+00:60',
    '00:00:00+0700', // the basic form
    '00:00:00+07', // hours alone
    '00:00:00z',
    '00:00:00', // no offset at all
    '+07:00', // an offset and nothing in front of it
  ]) {
    assert.equal(splitOffset(text), undefined, `${quote(text)} split into an offset`)
  }
})

// A zoned time keeps the clock that was written and the offset beside it,
// so noon in Bangkok and five in the morning UTC are two values. A zoned
// datetime does the opposite, holding the instant in UTC, so the same two
// are one value with two spellings. That difference is the engine's and
// it is what these two assert.
test('a zoned time keeps its own clock and a zoned datetime keeps its instant', () => {
  const bangkok = parseZonedTime('12:00:00+07:00')
  const utc = parseZonedTime('05:00:00Z')
  assert.equal(bangkok.nanos, 12n * NANOS_PER_HOUR)
  assert.equal(bangkok.offset, 420)
  assert.ok(!same(bangkok, utc), 'two zoned times an offset apart came out as one value')

  const there = parseZonedDateTime('1970-01-01T12:00:00+07:00')
  const here = parseZonedDateTime('1970-01-01T05:00:00Z')
  assert.equal(there.nanos, 5n * NANOS_PER_HOUR, 'the instant was not moved back by the offset')
  assert.equal(there.offset, 420)
  assert.equal(here.nanos, there.nanos, 'one instant in two zones came out as two instants')
  // And the offset each was written with is still there, which is what
  // keeps them apart as values.
  assert.ok(!same(there, here))
})

test('a local temporal has no offset on it and a zoned one must have', () => {
  assert.equal(parseLocalTime('00:00:00').offset, null)
  assert.equal(parseLocalDateTime('1970-01-01T00:00:00').offset, null)
  assert.equal(parseLocalTime('00:00:00Z'), undefined, 'a local time took an offset')
  assert.equal(parseLocalDateTime('1970-01-01T00:00:00Z'), undefined, 'a local datetime took an offset')
  assert.equal(parseZonedTime('00:00:00'), undefined, 'a zoned time went without an offset')
  assert.equal(parseZonedDateTime('1970-01-01T00:00:00'), undefined, 'a zoned datetime went without an offset')
  // A space in front of the offset is left on the clock by the split and
  // refused there, which is why it is not in the list of splits that give
  // nothing back.
  assert.equal(parseZonedTime('00:00:00 +07:00'), undefined)
})

// The two kinds the engine keeps apart. A month is not a number of days,
// so a duration is one or the other and never both, and a duration of
// nothing is two values here because the text says which one it is.
test('a duration is months or nanoseconds and the text says which', () => {
  for (const [text, kind, count] of [
    ['P1Y', 'yearMonth', 12n],
    ['P1Y2M', 'yearMonth', 14n],
    ['P2M', 'yearMonth', 2n],
    ['P0M', 'yearMonth', 0n],
    ['-P1Y2M', 'yearMonth', -14n],
    ['+P1Y', 'yearMonth', 12n],
    ['P1D', 'dayTime', NANOS_PER_DAY],
    ['P1W', 'dayTime', 7n * NANOS_PER_DAY],
    ['P0D', 'dayTime', 0n],
    ['PT0S', 'dayTime', 0n],
    ['PT1H', 'dayTime', NANOS_PER_HOUR],
    ['PT1M', 'dayTime', NANOS_PER_MINUTE],
    ['PT1S', 'dayTime', NANOS_PER_SECOND],
    ['PT1H30M', 'dayTime', NANOS_PER_HOUR + 30n * NANOS_PER_MINUTE],
    ['P1DT2H3M4S', 'dayTime', NANOS_PER_DAY + 2n * NANOS_PER_HOUR + 3n * NANOS_PER_MINUTE + 4n * NANOS_PER_SECOND],
    ['PT0.000000001S', 'dayTime', 1n],
    ['PT1.5S', 'dayTime', NANOS_PER_SECOND + 500000000n],
    ['-PT1H', 'dayTime', -NANOS_PER_HOUR],
  ]) {
    const got = parseDuration(text)
    assert.ok(got instanceof ZuDuration, `${quote(text)} was not read as a duration`)
    assert.equal(got.kind, kind, text)
    assert.equal(kind === 'yearMonth' ? got.months : got.nanos, count, text)
  }
  // The pair the numbers cannot tell apart and the fields can, which is
  // the reason the kind is read off the text rather than off the count.
  assert.ok(!same(parseDuration('P0M'), parseDuration('PT0S')))
})

test('a duration that mixes the two kinds is refused rather than guessed at', () => {
  for (const text of ['P1MT1S', 'P1Y1D', 'P1YT1H', 'P1M1D']) {
    assert.equal(parseDuration(text), undefined, `${quote(text)} was read as a duration`)
  }
})

test('a fraction of anything but a second is refused', () => {
  // A fraction of a year, a month, a week or a day is a length that
  // depends on which one it lands on, so there is no count of nanoseconds
  // that is right for all of them.
  for (const text of ['P0.5Y', 'P1.5M', 'P0.5W', 'P0.5D', 'PT1.5H', 'PT1.5M']) {
    assert.equal(parseDuration(text), undefined, `${quote(text)} was read as a duration`)
  }
  assert.equal(parseDuration('PT1.5S').nanos, NANOS_PER_SECOND + 500000000n)
})

test('a duration written loosely is refused', () => {
  for (const text of [
    'P', // nothing under it
    'PT', // a T and nothing after it
    '', // nothing at all
    'T1H', // no P
    '1D',
    'P1', // digits with no unit
    'PT1', // and the same on the other side
    'P1X', // a unit nothing knows
    'PT1D', // a day on the clock side
    'P1H', // an hour on the date side
    'PT1.S', // a point and no fraction
    'PT0.0000000001S', // ten digits
    'p1d', // the lower case one, which ISO 8601 allows and the engine does not print
    'P-1D', // a sign inside, where the whole duration carries the one sign
    'P 1D',
    // Past what a signed 64 bit count holds, which is what the client's
    // duration is, so this is refused here rather than handed to a
    // constructor that would throw.
    'PT9223372036854775808S',
    'P999999999999999999999Y',
  ]) {
    assert.equal(parseDuration(text), undefined, `${quote(text)} was read as a duration`)
  }
})

test('a date and a clock print the way the engine prints them', () => {
  for (const [days, want] of [
    [0, '1970-01-01'],
    [1, '1970-01-02'],
    [-1, '1969-12-31'],
    [19723, '2024-01-01'],
    [19782, '2024-02-29'],
  ]) {
    assert.equal(showDate(days), want)
  }
  for (const [nanos, want] of [
    // Nine digits when there is a fraction and nothing when there is not,
    // which is the engine's rule and not the shortest that reads back.
    [0n, '00:00:00'],
    [1n, '00:00:00.000000001'],
    [100000000n, '00:00:00.100000000'],
    [45296n * NANOS_PER_SECOND, '12:34:56'],
    [86399999999999n, '23:59:59.999999999'],
  ]) {
    assert.equal(showClock(nanos), want)
  }
})

// An instant before the epoch is on the day it is on and not the day
// after it, which is what the division rounding towards minus infinity is
// there for and the one thing about printing an instant that is easy to
// get wrong in every language that has a `%`.
test('an instant before the epoch prints on its own day', () => {
  for (const [nanos, want] of [
    [0n, '1970-01-01T00:00:00'],
    [-1n, '1969-12-31T23:59:59.999999999'],
    [-NANOS_PER_DAY, '1969-12-31T00:00:00'],
    [-NANOS_PER_DAY - 1n, '1969-12-30T23:59:59.999999999'],
    [NANOS_PER_DAY, '1970-01-02T00:00:00'],
  ]) {
    assert.equal(showStamp(nanos), want)
  }
})

test('an offset prints as Z at zero and with a sign anywhere else', () => {
  for (const [offset, want] of [
    [0, 'Z'],
    [420, '+07:00'],
    [-330, '-05:30'],
    [1080, '+18:00'],
    [-1080, '-18:00'],
    [1, '+00:01'],
    [-1, '-00:01'],
  ]) {
    assert.equal(showOffset(offset), want)
  }
})

test('a duration prints as the text that reads back to it', () => {
  for (const [months, want] of [
    // A duration of nothing has to print as something, because a P on its
    // own is not a value, and the something says which kind it was.
    [0n, 'P0M'],
    [1n, 'P1M'],
    [12n, 'P1Y'],
    [14n, 'P1Y2M'],
    [-14n, '-P1Y2M'],
    [-1n, '-P1M'],
  ]) {
    assert.equal(showMonths(months), want)
  }
  for (const [nanos, want] of [
    [0n, 'PT0S'],
    [NANOS_PER_DAY, 'P1D'],
    [NANOS_PER_DAY + 1n, 'P1DT0.000000001S'],
    [NANOS_PER_HOUR, 'PT1H'],
    [NANOS_PER_MINUTE, 'PT1M'],
    [NANOS_PER_SECOND, 'PT1S'],
    [NANOS_PER_HOUR + 30n * NANOS_PER_MINUTE, 'PT1H30M'],
    [500000000n, 'PT0.500000000S'],
    [-NANOS_PER_HOUR, '-PT1H'],
    [NANOS_PER_DAY + 2n * NANOS_PER_HOUR + 3n * NANOS_PER_MINUTE + 4n * NANOS_PER_SECOND, 'P1DT2H3M4S'],
  ]) {
    assert.equal(showNanos(nanos), want)
  }
})

// The property the whole file is for: what a case writes is what the
// report prints, so a failing case can be read against the file it came
// from without translating either one.
test('every temporal value written and printed comes back the same', () => {
  for (const text of [
    '1970-01-01',
    '2024-02-29',
    '0024-01-01',
    '9999-12-31',
  ]) {
    assert.equal(show(parseDate(text)), `DATE ${quote(text)}`)
  }
  for (const text of ['00:00:00', '12:34:56', '23:59:59.999999999', '00:00:00.100000000']) {
    assert.equal(show(parseLocalTime(text)), `LOCALTIME ${quote(text)}`)
  }
  for (const text of ['00:00:00Z', '12:00:00+07:00', '12:00:00-05:30', '23:59:59.999999999+18:00']) {
    assert.equal(show(parseZonedTime(text)), `ZONEDTIME ${quote(text)}`)
  }
  for (const text of ['1970-01-01T00:00:00', '1969-12-31T23:59:59.999999999', '2024-02-29T12:34:56.500000000']) {
    assert.equal(show(parseLocalDateTime(text)), `LOCALDATETIME ${quote(text)}`)
  }
  for (const text of ['1970-01-01T00:00:00Z', '1970-01-01T12:00:00+07:00', '2024-01-01T00:00:00-05:30']) {
    assert.equal(show(parseZonedDateTime(text)), `ZONEDDATETIME ${quote(text)}`)
  }
  for (const text of ['P0M', 'P1Y', 'P1Y2M', '-P1Y2M', 'PT0S', 'P1D', 'PT1H30M', 'P1DT2H3M4S', '-PT1H']) {
    assert.equal(show(parseDuration(text)), `DURATION ${quote(text)}`)
  }
})
