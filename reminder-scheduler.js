// schedule_reminders.js
// Frontend: recomputes carpool from the same sheet inputs you already use,
// extracts phone numbers, then POSTs to /.netlify/functions/schedule-reminders
//
// Requirements on the page (already present in your index.html / script.js):
// - PapaParse loaded (window.Papa)
// - Inputs: #sheetUrl, #gid, #eventCap, and the new #smsSchedulerForm w/ #orgName, #eventDate, #eventTime
//
// Notes:
// - We detect phone column flexibly (Phone / Phone Number / Phone # / anything containing 'phone').
// - We only "read" phone numbers; final E.164 formatting happens in the Netlify function.
// - Roles mapping follows your current logic: driver(2), self-driver(1), rider(3).
// - Waitlist = everyone beyond capacity after assignments.

(function () {
  const $ = (s) => document.querySelector(s);

  // IDs from your page
  const sheetUrlInput = $('#sheetUrl');
  const gidInput      = $('#gid');
  const eventCapInput = $('#eventCap');

  const form          = $('#smsSchedulerForm');
  const statusEl      = $('#scheduleStatus');

  if (!form) return; // no-op if form isn't on the page yet

  function setStatus(s) { if (statusEl) statusEl.textContent = s || ''; }

  // ---- Helpers copied/adapted to mirror your script.js ----

  function toCsvExportUrl(sheetLink, gidManual) {
    let id = null;
    let gid = '0';
    try {
      const dIdx = sheetLink.indexOf('/d/');
      if (dIdx >= 0) {
        const start = dIdx + 3;
        let end = sheetLink.indexOf('/', start);
        if (end < 0) end = sheetLink.length;
        id = sheetLink.substring(start, end);
      }
      const gidIdx = sheetLink.indexOf('gid=');
      if (gidIdx >= 0) {
        const start = gidIdx + 4;
        let end = sheetLink.indexOf('&', start);
        if (end < 0) end = sheetLink.length;
        gid = sheetLink.substring(start, end);
      }
    } catch {}
    if (gidManual) gid = gidManual;
    if (!id) throw new Error('Could not parse spreadsheet ID from the link.');
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }

  async function fetchCsv(url) {
    const res = await fetch(url, { headers: { 'Accept': 'text/csv' } });
    if (!res.ok) throw new Error(`Failed to fetch CSV (${res.status}). Make sure the sheet is public.`);
    return await res.text();
  }

  function parseCsv(text) {
    const parsed = Papa.parse(text, { dynamicTyping: false });
    return parsed?.data || [];
  }

  function headerIndex(headerRow) {
    const map = new Map();
    for (let i = 0; i < headerRow.length; i++) {
      const h = (headerRow[i] ?? '').toString().trim();
      if (h) map.set(h, i);
    }
    return map;
  }

  function findCol(map, wantedPrefix) {
    const w = wantedPrefix.toLowerCase();
    for (const [key, idx] of map.entries()) {
      const k = key.toLowerCase();
      if (k === w || k.startsWith(w)) return idx;
    }
    return -1;
  }

  function findPhoneCol(map) {
    // First try common labels
    const candidates = [
      'Phone', 'Phone Number', 'Phone #', 'Phone # (digits only)'
    ];
    for (const c of candidates) {
      const idx = findCol(map, c);
      if (idx >= 0) return idx;
    }
    // Fallback: any column containing 'phone'
    for (const [key, idx] of map.entries()) {
      if (String(key).toLowerCase().includes('phone')) return idx;
    }
    return -1;
  }

  function safe(row, idx) {
    if (idx < 0 || idx >= row.length) return '';
    const v = row[idx];
    return (v == null) ? '' : String(v);
  }

  function toTransportationCode(val) {
    const n = (val ?? '').trim().toLowerCase();
    if (n === 'i can provide transportation for others') return 2;
    if (n === 'i have transportation for myself') return 1;
    if (n === 'i need transportation provided') return 3;
    return -1;
  }

  function parsePositiveIntOrMinusOne(s) {
    if (!s || !s.trim()) return -1;
    const digits = s.replace(/[^0-9-]/g, '');
    if (!digits) return -1;
    const n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n < 0) return -1;
    return n;
  }

  // Build normalized carpool payload (with phone) exactly as the server expects
  function buildNormalizedPayload(rows, cap) {
    const header = rows[0];
    const headerMap = headerIndex(header);

    const nameCol = findCol(headerMap, "Name");
    const transCol = findCol(headerMap, "Transportation?");
    const capCol   = findCol(headerMap, "If you can provide transportation for others");
    const phoneCol = findPhoneCol(headerMap);

    if (nameCol < 0 || transCol < 0 || capCol < 0) {
      throw new Error("Missing one or more required columns: 'Name', 'Transportation?', 'If you can provide transportation for others'");
    }
    if (phoneCol < 0) {
      console.warn("No phone column found. We'll still try to send, but numbers may be missing.");
    }

    const hasTransport = []; // self-drivers
    const drivers = [];
    const needRides = [];

    // Build queues
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;

      const name = safe(row, nameCol).trim();
      if (!name) continue;

      const phone = safe(row, phoneCol).trim(); // may be empty
      const tVal  = safe(row, transCol);
      const tCode = toTransportationCode(tVal);

      let carCap = -1;
      if (tCode === 2) {
        carCap = parsePositiveIntOrMinusOne(safe(row, capCol));
        if (carCap <= 0) {
          console.warn(`Driver "${name}" invalid/zero car capacity; skipping as driver.`);
          continue;
        }
      }

      const person = { name, phone, transportation: tCode, carCap };
      if (tCode === 1) hasTransport.push(person);
      else if (tCode === 2) drivers.push(person);
      else if (tCode === 3) needRides.push(person);
    }

    // Assign
    let numPeople = hasTransport.length;
    const carpools = [];
    if (hasTransport.length) {
      carpools.push([...hasTransport]); // self-driver bucket (transportation === 1)
    }

    while (drivers.length && numPeople < cap) {
      const driver = drivers.shift();
      const car = [driver];
      numPeople++;
      const seats = Math.max(0, driver.carCap);
      for (let i = 0; i < seats && needRides.length && numPeople < cap; i++) {
        car.push(needRides.shift());
        numPeople++;
      }
      carpools.push(car);
    }

    const waitlist = needRides; // everyone left

    // Normalize to backend payload:
    // driver items: { name, phone, role:"driver", passengers:[names] }
    // passenger items: { name, phone, role:"passenger", driverName }
    // self-driver items: { name, phone, role:"self-driver" }
    // waitlist items: { name, phone, role:"waitlist" }
    const normalized = [];

    // Self-drivers bucket first (if present)
    if (carpools.length && carpools[0].every(p => p.transportation === 1)) {
      for (const s of carpools[0]) {
        normalized.push({ name: s.name, phone: s.phone, role: "self-driver" });
      }
    }

    // Cars (driver + passengers)
    for (const group of carpools) {
      if (!group.length) continue;
      if (group.every(p => p.transportation === 1)) continue; // skip self-driver bucket already handled

      const driver = group[0];
      const passengers = group.slice(1);

      normalized.push({
        name: driver.name,
        phone: driver.phone,
        role: "driver",
        passengers: passengers.map(p => p.name),
      });

      for (const p of passengers) {
        normalized.push({
          name: p.name,
          phone: p.phone,
          role: "passenger",
          driverName: driver.name,
        });
      }
    }

    // Waitlist
    for (const w of waitlist) {
      normalized.push({ name: w.name, phone: w.phone, role: "waitlist" });
    }

    return normalized;
  }

  async function postSchedule(payload) {
    const resp = await fetch('/.netlify/functions/schedule-reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || ('HTTP ' + resp.status));
    }
    return resp.json();
  }

  async function onSubmit(e) {
    e.preventDefault();
    try {
      setStatus('Gathering data…');

      const organization = $('#orgName')?.value?.trim();
      const eventDate    = $('#eventDate')?.value; // YYYY-MM-DD
      const eventTime    = $('#eventTime')?.value; // HH:mm (24h)
      if (!organization || !eventDate || !eventTime) {
        setStatus('Please fill Organization, Date, and Time.');
        return;
      }

      // Use your *existing* inputs to get the same sheet & capacity
      const link = sheetUrlInput?.value?.trim();
      const capStr = eventCapInput?.value?.trim();
      const cap = parseInt(capStr, 10);
      const gidManual = gidInput?.value?.trim();

      if (!link) return setStatus('Please paste the Google Sheet link above.');
      if (!Number.isFinite(cap) || cap <= 0) return setStatus('Enter a valid positive event capacity above.');

      setStatus('Fetching sheet…');
      const csvUrl = toCsvExportUrl(link, gidManual);
      const csvText = await fetchCsv(csvUrl);

      setStatus('Parsing CSV…');
      const rows = parseCsv(csvText);
      if (!rows || rows.length === 0) {
        setStatus('No data found in the sheet.');
        return;
      }

      setStatus('Building carpool…');
      const carpool = buildNormalizedPayload(rows, cap);

      if (!carpool.length) {
        setStatus('No participants found to message.');
        return;
      }

      setStatus('Scheduling… (Twilio)');
      const res = await postSchedule({ organization, eventDate, eventTime, carpool });
      setStatus(`Done. UTC sendAt=${res.dayOfIsoUTC}. Processed ${res.results.length} people.`);
      console.log('schedule-reminders result:', res);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message || 'Unexpected error'}`);
    }
  }

  form.addEventListener('submit', onSubmit);
})();
