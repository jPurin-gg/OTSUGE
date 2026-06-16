const timezone = () => process.env.APP_TIMEZONE ?? "Asia/Tokyo";

function parts(date: Date) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(values.map(({ type, value }) => [type, value]));
}

export function localDateKey(date = new Date()) {
  const value = parts(date);
  return `${value.year}-${value.month}-${value.day}`;
}

export function localMinuteOfDay(date = new Date()) {
  const value = parts(date);
  return Number(value.hour) * 60 + Number(value.minute);
}

export function zonedDateTimeToUtc(dateKey: string, time: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;

  for (let index = 0; index < 3; index += 1) {
    const value = parts(new Date(guess));
    const represented = Date.UTC(
      Number(value.year),
      Number(value.month) - 1,
      Number(value.day),
      Number(value.hour),
      Number(value.minute),
    );
    guess += desired - represented;
  }

  return new Date(guess);
}

export function dayBounds(dateKey = localDateKey()) {
  const start = zonedDateTimeToUtc(dateKey, "00:00");
  const nextDate = new Date(`${dateKey}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextKey = nextDate.toISOString().slice(0, 10);
  return { start, end: zonedDateTimeToUtc(nextKey, "00:00") };
}

export function minutesFromTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function timeFromMinutes(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
