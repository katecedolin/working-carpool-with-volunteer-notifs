// notifications.js
(() => {
  const qs = (s) => document.querySelector(s);

  const formUrlInput  = () => qs('#formUrl');
  const announceBtn   = () => qs('#announceBtn');
  const statusEl      = () => qs('#announceStatus');

  function setStatus(msg) {
    statusEl().textContent = msg || '';
  }

  async function postJSON(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const text = await res.text();
    try { return { ok: res.ok, json: JSON.parse(text) }; }
    catch { return { ok: res.ok, text }; }
  }

  async function onAnnounce() {
    try {
      const formUrl = (formUrlInput().value || '').trim();
      if (!formUrl) {
        alert('Please paste the Google Form link.');
        return;
      }
      setStatus('Collecting contacts from the Sheet…');

      // Get contact lists (built from the Google Sheet whose CSV URL is in an env var on the server)
      const contactsResp = await postJSON('/.netlify/functions/get-contacts', {});
      if (!contactsResp.ok || !contactsResp.json?.ok) {
        throw new Error(contactsResp.json?.error || contactsResp.text || 'Failed to build contact lists.');
      }
      const { numbers, emails } = contactsResp.json;

      if ((!numbers || !numbers.length) && (!emails || !emails.length)) {
        throw new Error('No contacts found in the sheet.');
      }

      setStatus('Parsing the form for title/date/time/description…');
      // Send one request that:
      // 1) fetches and parses the form page (server-side to avoid CORS),
      // 2) validates date/time from title,
      // 3) sends text blasts to numbers and email blasts to emails.
      const sendResp = await postJSON('/.netlify/functions/send-broadcast', {
        formUrl,
        numbers,
        emails
      });

      if (!sendResp.ok || !sendResp.json?.ok) {
        throw new Error(sendResp.json?.error || sendResp.text || 'Broadcast failed.');
      }

      const { date, time, emailCount, smsCount } = sendResp.json;
      setStatus(`Done! Texted ${smsCount} numbers and emailed ${emailCount} addresses for ${date} at ${time}.`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message || String(err)}`);
      alert(err.message || 'Something went wrong.');
    }
  }

  function init() {
    const btn = announceBtn();
    if (!btn) return; // UI not present
    btn.addEventListener('click', onAnnounce);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
