// netlify/functions/schedule-reminders.js
// Serverless function to (a) send immediate confirmations and (b) schedule day-of reminders via Twilio Scheduling
// Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID

const twilio = require("twilio");
const { DateTime } = require("luxon");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

// Helpers -----------------------------

/**
 * Normalize a phone string to E.164. Defaults to US if no country code is present.
 * - Reads only digits; formats to +1XXXXXXXXXX if 10 digits.
 * - Uses libphonenumber-js for proper parsing/validation when possible.
 */
function toE164(raw, defaultCountry = "US") {
  if (!raw) return null;
  // keep only digits and plus
  const cleaned = String(raw).replace(/[^\d+]/g, "");
  // Try robust parser first
  let parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (parsed && parsed.isValid()) return parsed.number; // E.164

  // Fallbacks: numbers-only heuristics (US default)
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("00") && digits.length > 4) return `+${digits.slice(2)}`;

  return null; // reject unusable numbers
}

/**
 * Build the immediate confirmation body based on role.
 */
function buildImmediateBody({ role, name, organization, date, time, driverName, passengersList }) {
  const base = `Hi ${name}, you have been confirmed for the ${organization} volunteer opportunity on ${date} at ${time}.`;
  switch (role) {
    case "driver": {
      const riders = passengersList && passengersList.length
        ? `\nSince you signed up as a driver, here are the people you will be taking:\n\t${passengersList.join("\n\t")}\nFor directions to the event check the GroupMe Volunteer Opportunities Section!\nIf you have any questions or concerns please text (206) 886-5085.`
        : `\nSince you signed up as a driver, we’ll send riders as soon as they’re assigned.\nFor directions to the event check the GroupMe Volunteer Opportunities Section!\nIf you have any questions or concerns please text (206) 886-5085.`;
      return `${base} ${riders}`;
    }
    case "passenger": {
      return `${base} Since you signed up for the carpool, you will be riding with ${driverName}\nIf you have any questions or concerns please text (206) 886-5085.`;
    }
    case "self-driver": {
      return `${base} See you then!\nFor directions to the event check the GroupMe Volunteer Opportunities Section!\nIf you have any questions or concerns please text (206) 886-5085.`;
    }
    case "waitlist": {
      return `Hi ${name}, you are currently on the WAITLIST for the ${organization} volunteer opportunity on ${date} at ${time}. If any spots open up we will let you know!`;
    }
    default:
      return base;
  }
}

/**
 * Build the day-of reminder body (not for waitlist).
 */
function buildReminderBody({ name, organization, date, time }) {
  return `Hi ${name}, this is a reminder that you signed up for the ${organization} volunteer opportunity on ${date} at ${time}. See you then!\nIf you have any questions or concerns please text (206) 886-5085.`;
}

/**
 * Convert an Event Date + Time (as strings) in America/Los_Angeles to ISO UTC for Twilio sendAt.
 * If 9:00am is requested, pass "09:00".
 */
function laLocalToSendAtUTCISO(eventDateYYYYMMDD, hhmm /* "HH:mm" */) {
  const [H, M] = hhmm.split(":").map(Number);
  const dtLA = DateTime.fromISO(`${eventDateYYYYMMDD}T${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}:00`, {
    zone: "America/Los_Angeles",
  });
  return dtLA.toUTC().toISO(); // ISO-8601 with Z
}

/**
 * Validate scheduled window for Twilio (15 min to 35 days). If too soon, return {tooSoon: true}
 * Docs: scheduleType "fixed" and sendAt ISO-8601. :contentReference[oaicite:1]{index=1}
 */
function validateScheduleTime(sendAtISO) {
  const nowUTC = DateTime.utc();
  const sendAt = DateTime.fromISO(sendAtISO, { zone: "utc" });
  const diffMinutes = sendAt.diff(nowUTC, "minutes").minutes;
  const diffDays = sendAt.diff(nowUTC, "days").days;
  if (diffMinutes < 15) return { ok: false, tooSoon: true, diffMinutes };
  if (diffDays > 35.1) return { ok: false, tooFar: true, diffDays };
  return { ok: true };
}

// Netlify Function handler -----------------------------

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const {
      organization,
      eventDate, // "YYYY-MM-DD"
      eventTime, // "HH:mm" (24h)
      carpool,   // array of participants with roles, driver links, passenger lists, raw phone, etc.
    } = JSON.parse(event.body || "{}");

    if (!organization || !eventDate || !eventTime || !Array.isArray(carpool)) {
      return { statusCode: 400, body: "Missing organization, eventDate, eventTime, or carpool[]" };
    }

    // Twilio client
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    if (!accountSid || !authToken || !messagingServiceSid) {
      return { statusCode: 500, body: "Twilio environment not configured" };
    }
    const client = twilio(accountSid, authToken);

    const dayOfIso = laLocalToSendAtUTCISO(eventDate, "09:00");
    const scheduleCheck = validateScheduleTime(dayOfIso);

    // Build and send messages
    const results = [];

    // For quick lookups of a driver's passenger list by driverId/name
    const passengersByDriver = {};
    for (const p of carpool) {
      if (p.role === "passenger" && p.driverName) {
        passengersByDriver[p.driverName] = passengersByDriver[p.driverName] || [];
        passengersByDriver[p.driverName].push(p.name);
      }
    }

    for (const person of carpool) {
      const name = person.name || "Volunteer";
      const role = (person.role || "").toLowerCase(); // driver | passenger | self-driver | waitlist
      const phone = toE164(person.phone);
      if (!phone) {
        results.push({ name, role, phoneRaw: person.phone, error: "Invalid phone" });
        continue;
      }

      // Immediate confirmation
      const immediateBody = buildImmediateBody({
        role,
        name,
        organization,
        date: eventDate,
        time: eventTime,
        driverName: person.driverName || null,
        passengersList: passengersByDriver[person.name] || person.passengers || [],
      });

      // send now (non-scheduled)
      let immediateSid = null;
      try {
        const msg = await client.messages.create({
          to: phone,
          body: immediateBody,
          messagingServiceSid, // ensures Messaging Service is used
        });
        immediateSid = msg.sid;
      } catch (e) {
        results.push({ name, role, phone, error: "Immediate send failed", detail: e.message });
        continue; // skip scheduling if immediate fails
      }

      // Day-of reminder (skip waitlist)
      let reminderSid = null;
      if (role !== "waitlist") {
        const reminderBody = buildReminderBody({ name, organization, date: eventDate, time: eventTime });

        try {
          if (scheduleCheck.ok) {
            // Use Twilio Scheduling (ScheduleType/SendAt)
            const scheduled = await client.messages.create({
              to: phone,
              body: reminderBody,
              messagingServiceSid,
              scheduleType: "fixed",          // Twilio Scheduling flag
              sendAt: dayOfIso,               // ISO-8601 UTC string
            });
            reminderSid = scheduled.sid;
          } else if (scheduleCheck.tooSoon) {
            // Too close to 9:00am — send immediately as fallback
            const sent = await client.messages.create({
              to: phone,
              body: reminderBody,
              messagingServiceSid,
            });
            reminderSid = sent.sid;
          } else {
            results.push({ name, role, phone, warning: "Reminder not scheduled (outside Twilio window)" });
          }
        } catch (e) {
          results.push({ name, role, phone, error: "Reminder schedule/send failed", detail: e.message });
        }
      }

      results.push({ name, role, phone, immediateSid, reminderSid });
    }

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true, dayOfIsoUTC: dayOfIso, results }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
