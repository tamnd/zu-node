//! `Temporal`, for the runtimes that have it.
//!
//! zu's temporal values are counts: a date is days from 1970-01-01, a
//! time is nanoseconds from midnight, a timestamp is nanoseconds from
//! the epoch, and a duration is months or nanoseconds. The classes in
//! [`crate::value`] hand those counts over as they are, which is exact,
//! portable and no help at all to a program that wants to know what day
//! of the week it was.
//!
//! `Temporal` is the standard answer to that, and it reached Stage 4 in
//! March 2026. It is unflagged in Node 26 and the current browsers, and
//! Node 24 is still the active LTS and has it behind
//! `--harmony-temporal`, so a client that returned `Temporal` values by
//! default would be a client half its users cannot load. Hence the
//! opt-in: `{ temporal: true }` when connecting, refused there and then
//! on a runtime without one, and `toTemporal()` on each of the four
//! classes for a program that wants one value converted rather than all
//! of them.
//!
//! The other direction needs no opt-in. A `Temporal` value passed as a
//! parameter binds as the zu value it is, on every connection, because
//! recognizing one costs a property read and refusing one would be a
//! rule nobody could guess.
//!
//! Nothing here is cached. A `Temporal` value is a JavaScript object and
//! the constructors are properties of a JavaScript object, and neither
//! can be held by a struct that crosses to a threadpool thread, so each
//! conversion looks the constructor up: a global, a namespace and a
//! class, three property reads. That is the price of the opt-in and it
//! is paid per temporal value rather than per row.

use napi::bindgen_prelude::*;
use napi::{Env, ValueType};
use zu_common::{DurationKind, Temporal};

/// What a program asking for `Temporal` on a runtime without one is
/// told, wherever it asked.
pub const MISSING: &str = "this runtime has no Temporal: Node 26 and the current browsers have \
                           it, Node 24 has it behind --harmony-temporal, and until then the \
                           ZuDate, ZuTime, ZuTimestamp and ZuDuration classes are the spelling \
                           there is";

/// What a zoned time is told, which is the one value zu holds and
/// `Temporal` has no type for.
pub const NO_ZONED_TIME: &str = "a time with an offset has no Temporal type: PlainTime is local \
                                 and ZonedDateTime carries a date, so this value stays a ZuTime \
                                 in temporal mode rather than losing its offset or gaining a day \
                                 nobody wrote";

/// Whether this runtime has `Temporal` at all.
pub fn present(env: &Env) -> Result<bool> {
    Ok(namespace(env)?.is_some())
}

/// The `Temporal` namespace, or nothing on a runtime that has none.
///
/// Read off the global each time rather than remembered, for the reason
/// the module comment gives.
fn namespace<'env>(env: &'env Env) -> Result<Option<Object<'env>>> {
    let found: Unknown<'env> = env.get_global()?.get_named_property("Temporal")?;
    match found.get_type()? {
        ValueType::Object => Ok(Some(found.coerce_to_object()?)),
        _ => Ok(None),
    }
}

/// The `Temporal` value for a zu one, or `None` for the zoned time that
/// has no `Temporal` type.
///
/// The classes are reached through their constructors rather than
/// through `from`, because a constructor takes the fields as arguments
/// and `from` takes them as an object, and the object is an allocation
/// spent to say the same thing.
///
/// A count outside what `Temporal` holds throws from the constructor
/// itself, which is a `RangeError` naming the field, and that is a
/// better message than one written here: zu's dates run to five million
/// years and `Temporal` stops at 271821 BCE, so the two disagree about
/// values no calendar has an opinion on either.
pub fn to_temporal<'env>(env: &'env Env, value: Temporal) -> Result<Option<Unknown<'env>>> {
    let Some(temporal) = namespace(env)? else {
        return Err(Error::new(Status::GenericFailure, MISSING));
    };
    let made = match value {
        Temporal::Date(days) => {
            let (year, month, day) = civil(i64::from(days));
            build(&temporal, "PlainDate", FnArgs::from((year, month, day)))?
        }
        Temporal::LocalTime(nanos) => {
            let (hour, minute, second, milli, micro, nano) = clock(nanos);
            build(
                &temporal,
                "PlainTime",
                FnArgs::from((hour, minute, second, milli, micro, nano)),
            )?
        }
        // The one zu holds and `Temporal` does not. Said with `None`
        // rather than an error, because a result full of them should
        // still arrive: the values that have a `Temporal` type get one
        // and this keeps its class.
        Temporal::ZonedTime { .. } => return Ok(None),
        Temporal::LocalDatetime(nanos) => {
            let (year, month, day) = civil(nanos.div_euclid(DAY));
            let (hour, minute, second, milli, micro, nano) = clock(nanos.rem_euclid(DAY));
            build(
                &temporal,
                "PlainDateTime",
                FnArgs::from((year, month, day, hour, minute, second, milli, micro, nano)),
            )?
        }
        // The instant and the offset, which is exactly what the value
        // is. A named zone would be a rule that changes under a stored
        // value when the zone database is updated, and the engine does
        // not store one.
        Temporal::ZonedDatetime { nanos, offset } => build(
            &temporal,
            "ZonedDateTime",
            FnArgs::from((BigInt::from(nanos), zone(offset))),
        )?,
        Temporal::Duration(DurationKind::YearMonth, months) => {
            build(&temporal, "Duration", FnArgs::from((0, months)))?
        }
        // Seconds and nanoseconds rather than nanoseconds alone,
        // because a `Temporal.Duration` field is a JavaScript number and
        // a count of nanoseconds passes 2^53 after fourteen weeks.
        Temporal::Duration(DurationKind::DayTime, nanos) => build(
            &temporal,
            "Duration",
            FnArgs::from((0, 0, 0, 0, 0, 0, nanos / SECOND, 0, 0, nanos % SECOND)),
        )?,
    };
    Ok(Some(made))
}

/// `new Temporal.<class>(...)`.
fn build<'env, Args: JsValuesTupleIntoVec>(
    temporal: &Object<'env>,
    class: &str,
    args: Args,
) -> Result<Unknown<'env>> {
    let class: Function<'env, Args, Unknown<'env>> = temporal.get_named_property(class)?;
    class.new_instance(args)
}

/// The zu value a `Temporal` one binds as, or `None` when the value is
/// not a `Temporal` one at all.
///
/// Recognized by `Symbol.toStringTag`, which every `Temporal` class sets
/// to its own name, rather than by `instanceof`: the tag is one property
/// read for all eight of them where `instanceof` is one call each, and
/// it is the same answer `Object.prototype.toString` gives, so a value
/// that prints as a `PlainDate` binds as one.
pub fn from_temporal(env: &Env, name: &str, value: &Unknown<'_>) -> Result<Option<Temporal>> {
    let Some(tag) = tag(env, value)? else {
        return Ok(None);
    };
    let Some(kind) = tag.strip_prefix("Temporal.") else {
        return Ok(None);
    };
    let object = Object::from_unknown(*value)?;
    let bound = match kind {
        "PlainDate" => Temporal::Date(days(name, &object)?),
        "PlainTime" => Temporal::LocalTime(nanos_of(&object)?),
        "PlainDateTime" => Temporal::LocalDatetime(epoch(
            name,
            i64::from(days(name, &object)?),
            nanos_of(&object)?,
        )?),
        // The instant and the offset are read off the value rather than
        // its fields, so the zone it carries can be a named one: what
        // zu stores is the instant and how far from UTC it was written,
        // and a name is exactly the part that cannot survive being
        // stored.
        "ZonedDateTime" => Temporal::ZonedDatetime {
            nanos: since(name, &object)?,
            offset: offset(name, &object)?,
        },
        // UTC, because that is what an instant is.
        "Instant" => Temporal::ZonedDatetime {
            nanos: since(name, &object)?,
            offset: 0,
        },
        "Duration" => duration(name, &object)?,
        other => {
            return Err(refused(format!(
                "parameter {name} is a Temporal.{other}, and the temporal values zu holds are a \
                 date, a time, a timestamp and a duration"
            )));
        }
    };
    Ok(Some(bound))
}

/// The value's `Symbol.toStringTag`, when it has one that is a string.
fn tag(env: &Env, value: &Unknown<'_>) -> Result<Option<String>> {
    // `Symbol` is a function and the well-known symbols hang off it as
    // properties of that function.
    let symbols: Function<'_, (), Unknown<'_>> = env.get_global()?.get_named_property("Symbol")?;
    let key: Unknown<'_> = symbols.get_named_property("toStringTag")?;
    if key.get_type()? != ValueType::Symbol {
        return Ok(None);
    }
    let found: Unknown<'_> = Object::from_unknown(*value)?.get_property(key)?;
    match found.get_type()? {
        ValueType::String => Ok(Some(String::from_unknown(found)?)),
        _ => Ok(None),
    }
}

/// The days from the epoch a `PlainDate` or a `PlainDateTime` stands
/// for.
///
/// The calendar is checked rather than assumed. `year`, `month` and
/// `day` are the calendar's own fields, so a Hebrew date read as though
/// it were ISO is a different day rather than an unreadable one, and a
/// wrong day that stores cleanly is the worst kind of wrong.
fn days(name: &str, object: &Object<'_>) -> Result<i32> {
    if let Some(calendar) = calendar(object)?
        && calendar != "iso8601"
    {
        return Err(refused(format!(
            "parameter {name} is in the {calendar} calendar, and zu stores a date as days from \
             1970-01-01, which is the ISO calendar: convert it with .withCalendar('iso8601')"
        )));
    }
    let year: i32 = object.get_named_property("year")?;
    let month: i64 = object.get_named_property("month")?;
    let day: i64 = object.get_named_property("day")?;
    Ok(civil_days(i64::from(year), month, day) as i32)
}

/// What the value's calendar is called, when it can be got to say.
///
/// Three ways of asking, because the proposal changed under the
/// runtimes and the runtimes are still where they were when it did.
/// `calendarId` is a string and is what the standard settled on;
/// `calendar` was a string for a while and an object with the name on
/// it before that, which is what Node 24 behind `--harmony-temporal`
/// still hands over. A value that answers none of them is taken as ISO,
/// because that is the default in every version of the proposal and a
/// refusal on a question nobody can answer helps nobody.
fn calendar(object: &Object<'_>) -> Result<Option<String>> {
    let named: Unknown<'_> = object.get_named_property("calendarId")?;
    if named.get_type()? == ValueType::String {
        return Ok(Some(String::from_unknown(named)?));
    }
    let calendar: Unknown<'_> = object.get_named_property("calendar")?;
    match calendar.get_type()? {
        ValueType::String => Ok(Some(String::from_unknown(calendar)?)),
        ValueType::Object => {
            let id: Unknown<'_> = calendar.coerce_to_object()?.get_named_property("id")?;
            match id.get_type()? {
                ValueType::String => Ok(Some(String::from_unknown(id)?)),
                _ => Ok(None),
            }
        }
        _ => Ok(None),
    }
}

/// The nanoseconds from midnight a `PlainTime` or a `PlainDateTime`
/// stands for.
fn nanos_of(object: &Object<'_>) -> Result<i64> {
    let hour: i64 = object.get_named_property("hour")?;
    let minute: i64 = object.get_named_property("minute")?;
    let second: i64 = object.get_named_property("second")?;
    let milli: i64 = object.get_named_property("millisecond")?;
    let micro: i64 = object.get_named_property("microsecond")?;
    let nano: i64 = object.get_named_property("nanosecond")?;
    Ok(((hour * 60 + minute) * 60 + second) * SECOND + milli * 1_000_000 + micro * 1_000 + nano)
}

/// The nanoseconds from the epoch, from a day and a time of day.
fn epoch(name: &str, days: i64, nanos: i64) -> Result<i64> {
    days.checked_mul(DAY)
        .and_then(|start| start.checked_add(nanos))
        .ok_or_else(|| {
            refused(format!(
                "parameter {name} is outside what a zu timestamp holds, which is nanoseconds in \
                 an INT64 and so runs from 1677-09-21 to 2262-04-11"
            ))
        })
}

/// The nanoseconds from the epoch an instant carries.
fn since(name: &str, object: &Object<'_>) -> Result<i64> {
    let nanos: BigInt = object.get_named_property("epochNanoseconds")?;
    let (nanos, lossless) = nanos.get_i64();
    match lossless {
        true => Ok(nanos),
        false => Err(refused(format!(
            "parameter {name} is outside what a zu timestamp holds, which is nanoseconds in an \
             INT64 and so runs from 1677-09-21 to 2262-04-11"
        ))),
    }
}

/// The offset from UTC in minutes a zoned value was written at.
///
/// Read as nanoseconds and divided, because that is the field that is a
/// number rather than a string nobody should be parsing. An offset that
/// is not a whole number of minutes is refused: zu stores minutes, and
/// the zones that had seconds in their offsets stopped in 1972.
fn offset(name: &str, object: &Object<'_>) -> Result<i16> {
    let nanos: i64 = object.get_named_property("offsetNanoseconds")?;
    let minutes = nanos / (60 * SECOND);
    if nanos % (60 * SECOND) != 0 || i16::try_from(minutes).is_err() {
        let offset: String = object.get_named_property("offset")?;
        return Err(refused(format!(
            "parameter {name} is at {offset} from UTC, and zu stores an offset as whole minutes"
        )));
    }
    Ok(minutes as i16)
}

/// The zu duration a `Temporal.Duration` is.
///
/// The two kinds do not mix, here or anywhere else in zu, because no
/// number of days is a month: a value holding both would have to invent
/// an answer for one month after 31 January. A `Temporal.Duration` can
/// hold both, so the one that does is refused rather than rounded into
/// one of them.
///
/// A week is seven days and a day is twenty-four hours, which is what
/// `Temporal` itself assumes when it converts one without a date to
/// hang it on.
fn duration(name: &str, object: &Object<'_>) -> Result<Temporal> {
    let field = |field: &str| -> Result<i64> { object.get_named_property(field) };
    let months = field("years")? * 12 + field("months")?;
    let days = field("weeks")? * 7 + field("days")?;
    let nanos = (((days * 24 + field("hours")?) * 60 + field("minutes")?) * 60 + field("seconds")?)
        * SECOND
        + field("milliseconds")? * 1_000_000
        + field("microseconds")? * 1_000
        + field("nanoseconds")?;
    match (months, nanos) {
        (0, nanos) => Ok(Temporal::Duration(DurationKind::DayTime, nanos)),
        (months, 0) => Ok(Temporal::Duration(DurationKind::YearMonth, months)),
        _ => Err(refused(format!(
            "parameter {name} counts both months and days, and a zu duration counts one or the \
             other: no number of days is a month, so a value holding both would have to invent an \
             answer for one month after 31 January"
        ))),
    }
}

/// A refusal, which is a mistake in the calling program rather than
/// anything the engine has an opinion about. `InvalidArg` is how
/// [`crate::conn`] tells one from a boundary failure.
fn refused(message: String) -> Error {
    Error::new(Status::InvalidArg, message)
}

/// The nanoseconds in a second and in a day.
const SECOND: i64 = 1_000_000_000;
const DAY: i64 = 86_400 * SECOND;

/// The offset written the way a `Temporal` time zone is named.
fn zone(minutes: i16) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let minutes = minutes.unsigned_abs();
    format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

/// A time of day split into the fields a `Temporal.PlainTime` is built
/// from.
fn clock(nanos: i64) -> (i64, i64, i64, i64, i64, i64) {
    (
        nanos / (3600 * SECOND),
        nanos / (60 * SECOND) % 60,
        nanos / SECOND % 60,
        nanos / 1_000_000 % 1_000,
        nanos / 1_000 % 1_000,
        nanos % 1_000,
    )
}

/// The year, month and day at `days` from 1970-01-01.
///
/// Howard Hinnant's `civil_from_days`, which is the shortest correct
/// one: it counts from 0000-03-01 rather than from January, so the leap
/// day is the last day of the year and every month from there has a
/// length that fits one linear formula. Proleptic Gregorian in both
/// directions, which is what the ISO calendar is.
fn civil(days: i64) -> (i32, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    ((year + i64::from(month <= 2)) as i32, month, day)
}

/// The days from 1970-01-01 to a year, month and day, which is
/// [`civil`] run backwards and Hinnant's `days_from_civil`.
fn civil_days(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two directions agree, over a range wide enough to cross
    /// every leap rule there is: the four year one, the hundred year
    /// one, and the four hundred year one that made 2000 a leap year
    /// and 1900 not.
    #[test]
    fn civil_round_trips() {
        for days in (-1_000_000..1_000_000).step_by(7) {
            let (year, month, day) = civil(days);
            assert_eq!(civil_days(i64::from(year), month, day), days);
        }
    }

    #[test]
    fn civil_knows_the_dates_everybody_checks() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(-1), (1969, 12, 31));
        assert_eq!(civil(11_016), (2000, 2, 29));
        assert_eq!(civil_days(2000, 2, 29), 11_016);
        assert_eq!(civil_days(1900, 3, 1) - civil_days(1900, 2, 28), 1);
        assert_eq!(civil_days(1, 1, 1), -719_162);
    }

    #[test]
    fn a_time_splits_into_its_fields() {
        assert_eq!(clock(0), (0, 0, 0, 0, 0, 0));
        assert_eq!(clock(DAY - 1), (23, 59, 59, 999, 999, 999));
        assert_eq!(clock(13 * 3600 * SECOND + 1), (13, 0, 0, 0, 0, 1));
    }

    #[test]
    fn an_offset_is_named_the_way_a_zone_is() {
        assert_eq!(zone(0), "+00:00");
        assert_eq!(zone(120), "+02:00");
        assert_eq!(zone(-330), "-05:30");
        assert_eq!(zone(-1), "-00:01");
    }
}
