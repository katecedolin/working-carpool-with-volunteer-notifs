// netlify/functions/send-broadcast.js
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { formUrl, numbers, emails } = JSON.parse(event.body || '{}');

    if (!formUrl) return bad(400, 'Missing formUrl');
    if (!Array.isArray(numbers) || !Array.isArray(emails)) return bad(400, 'numbers[] and emails[] are required arrays');

    // ---- Parse Google Form page (title + description) ----
    const html = await fetchFormHtml(formUrl);
    const title = extractTitle(html);
    const { date, time } = extractDateTimeFromTitle(title);
    const description = extractDescription(html);

    // ---- Send SMS blast via Twilio ----
    const smsCount = await sendSmsBlast(numbers, formUrl);

    // ---- Send Email blast via SendGrid ----
    const emailCount = await sendEmailBlast(emails, { date, time, description, formUrl });

    return ok({
      ok: true,
      date, time,
      smsCount,
      emailCount
    });
  } catch (err) {
    return bad(500, err.message || 'Broadcast failed');
  }
};

// ---------- helpers ----------
function ok(obj) {
  return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) };
}
function bad(code, msg) {
  return { statusCode: code, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: false, error: msg }) };
}

async function fetchFormHtml(url) {
  const res = await fetch(url, { headers: { 'Accept': 'text/html' } });
  if (!res.ok) throw new Error(`Failed to fetch form HTML (${res.status})`);
  return await res.text();
}

function extractTitle(html) {
  // Prefer <title> as it contains “Sign Up for … on …, …”
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (m && m[1]) return decode(m[1]);
  throw new Error('Could not read page title from the form');
}

function extractDateTimeFromTitle(title) {
  // Expect: "Sign Up for [organization] on [DATE], [TIME]"
  const onIdx = title.toLowerCase().lastIndexOf(' on ');
  if (onIdx < 0) throw new Error('Form title missing "on [date], [time]"');
  const tail = title.slice(onIdx + 4).trim();
  const m = tail.match(/^([^,]+),\s*(.+)$/); // [date], [time]
  if (!m) throw new Error('Date and time not present or ambiguous in title');
  const date = m[1].trim();
  const time = m[2].trim();
  if (!date || !time) throw new Error('Date and time not present or ambiguous in title');
  return { date, time };
}

function extractDescription(html) {
  // Google Forms exposes a meta og:description; fall back to meta[name=description]
  let m = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (m && m[1]) return decode(m[1]);
  m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (m && m[1]) return decode(m[1]);
  // Last resort: basic scrape for first <div role="heading">+next description block (best effort)
  const clean = html.replace(/\s+/g, ' ');
  const m2 = clean.match(/<div[^>]+role=["']heading["'][^>]*>.*?<\/div>\s*<div[^>]*>(.*?)<\/div>/i);
  if (m2 && m2[1]) return stripTags(decode(m2[1]));
  // If really nothing found, allow empty description (your spec says “entire form description”)
  return '';
}

function decode(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }

// ---- SMS ----
async function sendSmsBlast(numbers, formUrl) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || !messagingServiceSid) {
    throw new Error('Twilio environment not configured');
  }
  const client = twilio(accountSid, authToken);

  const body = `A new Helping Hands Volunteer event is available! Sign up here: ${formUrl}`;
  let sent = 0;
  for (const raw of numbers) {
    const to = normalizePhone(raw);
    if (!to) continue;
    try {
      await client.messages.create({ to, body, messagingServiceSid });
      sent++;
    } catch (e) {
      // ignore individual failures but continue
      console.warn('SMS failed', to, e.message);
    }
  }
  return sent;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  // naive normalization: if 10 digits, assume US +1
  const only = digits.replace(/\D/g, '');
  if (only.length === 10) return `+1${only}`;
  if (only.length === 11 && only.startsWith('1')) return `+${only}`;
  return digits.startsWith('+') ? digits : null;
}

// ---- Email (SendGrid) ----
async function sendEmailBlast(emails, { date, time, description, formUrl }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY not set');
  sgMail.setApiKey(apiKey);

  const from = 'hhhclubsdsu@gmail.com'; // per your request
  const subject = `New Volunteer Event on ${date}!`;
  const text = [
    'Hi,',
    `A new Helping Hands volunteer event is available for sign up on ${date} at ${time}!`,
    description,
    `Sign up here: ${formUrl}`,
    'We hope to see you there!'
  ].join('\n');

  // Send individually (simple and within free tier reasonable volumes)
  let sent = 0;
  for (const to of emails) {
    if (!to) continue;
    try {
      await sgMail.send({ to, from, subject, text });
      sent++;
    } catch (e) {
      console.warn('Email failed', to, e.message);
    }
  }
  return sent;
}
