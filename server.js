const express = require('express');
const twilio = require('twilio');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_FROM_NUMBER,
  TWILIO_AUTH_TOKEN,
  DEVICE_TOKEN,
  BASE_URL
} = process.env;

const numbers = [
  '+31614582569',
  '+31645060220',
  '+31645060221',
  '+31654308997',
  '+31651515353'
];

// --- VERSCHILLENDE TEKSTEN OP BASIS VAN EEN ID ---
const MESSAGES = {
  "1": "Inbraakalarm bij familie de Jong",
  "2": "Inbraakalarm bij familie de Jong sensor woonkamer.",
  "3": "Inbraakalarm bij familie de Jong sensor kantoor.",
  "4": "Inbraak alarm bij familie de Jong sensor hal.",
  "5": "Inbraak alarm bij familie de Jong sensor bijkeuken.",
  "6": "Inbraak alarm bij familie de Jong schuifdeur woonkamer.",
  "7": "Inbraak alarm bij familie de Jong buitendeur bijkeuken.",
  "8": "Inbraak alarm bij familie de Jong sabotage behuizing alarmunit.",
  "9": "Inbraak alarm bij familie de Jong sabotage sensor woonkamer.",
  "10": "Inbraak alarm bij familie de Jong sabotage sensor kantoor.",
  "11": "Inbraak alarm bij familie de Jong sabotage sensor hal.",
  "12": "Inbraak alarm bij familie de Jong sabotage sensor bijkeuken.",
  "default": "Alarm bij familie de Jong."
};

const RESET_TIMEOUT_SECONDS = 45;
const RING_TIMEOUT_SECONDS = 30;

const client = process.env.TWILIO_AUTH_MODE === 'account'
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID });

// Het alarm-object houdt nu ook de actieve spraaktekst bij
let alarm = { active: false, id: null, index: -1, callSid: null, revision: 0, text: "" };
let advancing = false;

function deviceAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!DEVICE_TOKEN || token.length !== DEVICE_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(DEVICE_TOKEN))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function twilioAuth(req, res, next) {
  const signature = req.get('X-Twilio-Signature') || '';
  const url = `${BASE_URL}${req.originalUrl}`;
  const valid = Boolean(TWILIO_AUTH_TOKEN) && twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
  if (!valid) {
    console.error('Twilio-webhook afgewezen:', {
      method: req.method,
      path: req.originalUrl,
      configuredBaseUrl: BASE_URL || '(ontbreekt)',
      requestHost: req.get('host'),
      hasSignature: Boolean(signature),
      hasAuthToken: Boolean(TWILIO_AUTH_TOKEN)
    });
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}

function publicUrl(path) { return `${BASE_URL}${path}`; }
function sendTwiml(res, xml) {
  return res.status(200).set('Content-Type', 'application/xml; charset=utf-8').send(xml);
}

async function startNextCall(alarmId) {
  if (!alarm.active || alarm.id !== alarmId || advancing) return;
  advancing = true;
  try {
    const nextIndex = alarm.index + 1;
    if (nextIndex >= numbers.length) {
      alarm.index = -1;
    }
    const index = alarm.index + 1;
    alarm.index = index;
    alarm.callSid = null;
    alarm.revision++;
    try {
      const call = await client.calls.create({
        to: numbers[index],
        from: TWILIO_FROM_NUMBER,
        url: publicUrl(`/voice/answer?alarmId=${encodeURIComponent(alarmId)}&index=${index}`),
        method: 'POST',
        statusCallback: publicUrl(`/voice/status?alarmId=${encodeURIComponent(alarmId)}&index=${index}`),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['completed'],
        timeout: RING_TIMEOUT_SECONDS
      });
      if (alarm.active && alarm.id === alarmId && alarm.index === index) alarm.callSid = call.sid;
    } catch (err) {
      console.error(`Bellen naar positie ${index + 1} mislukt:`, {
        message: err.message,
        code: err.code,
        status: err.status,
        moreInfo: err.moreInfo
      });
      if (alarm.active && alarm.id === alarmId && alarm.index === index) {
        alarm.index = index - 1;
        setTimeout(() => startNextCall(alarmId), 1000);
      }
    }
  } finally {
    advancing = false;
  }
}

function resetAlarm(stopCurrentCall = true) {
  const oldCallSid = alarm.callSid;
  alarm.active = false;
  alarm.callSid = null;
  alarm.text = ""; // Reset de tekst
  alarm.revision++;
  if (stopCurrentCall && oldCallSid) client.calls(oldCallSid).update({ status: 'completed' }).catch(() => {});
}

app.get('/', (_req, res) => res.type('text').send('ESP32 Twilio alarm server is running'));

// --- GEWIJZIGDE ENDPOINT: ACCEPTEERT NU textId OF customText ---
app.post('/alarm', deviceAuth, async (req, res) => {
  if (req.body.active !== true) return res.status(400).json({ error: 'active must be true' });
  if (alarm.active) return res.json({ active: true, alarmId: alarm.id });

  // Bepaal welke tekst moet worden uitgesproken
  let activeText = MESSAGES["default"];
  if (req.body.customText) {
    activeText = req.body.customText; // Directe opgestuurde tekst heeft prioriteit
  } else if (req.body.textId && MESSAGES[req.body.textId]) {
    activeText = MESSAGES[req.body.textId]; // Selecteer tekst op basis van ID
  }

  alarm = { 
    active: true, 
    id: crypto.randomUUID(), 
    index: -1, 
    callSid: null, 
    revision: alarm.revision + 1,
    text: activeText // Sla de geselecteerde tekst op in de actieve sessie
  };

  const id = alarm.id;
  res.json({ active: true, alarmId: id });
  startNextCall(id);
});

app.post('/reset', deviceAuth, (_req, res) => {
  resetAlarm();
  res.json({ active: false, reset: true });
});

app.get('/status', deviceAuth, (_req, res) => {
  res.json({ active: alarm.active, alarmId: alarm.id, revision: alarm.revision });
});

// --- GEWIJZIGDE ENDPOINT: GEBRUIKT DYNAMISCHE TEKST ---
app.post('/voice/answer', twilioAuth, (req, res) => {
  const alarmId = String(req.query.alarmId || '');
  const index = Number(req.query.index);
  if (!alarm.active || alarm.id !== alarmId || alarm.index !== index) {
    return sendTwiml(res, '<Response><Hangup/></Response>');
  }

  const gatherAction = `/voice/key?alarmId=${encodeURIComponent(alarmId)}&amp;index=${index}`;
  
  // Gebruik de dynamisch opgeslagen tekst (alarm.text) in de <Say> tag
  sendTwiml(res,
    `<Response><Gather input="dtmf" numDigits="1" timeout="${RESET_TIMEOUT_SECONDS}" action="${gatherAction}" method="POST"><Say language="nl-NL">${alarm.text} Druk binnen 45 seconden op nul om het alarm te bevestigen en te resetten.</Say></Gather><Say language="nl-NL">Geen reset ontvangen. We bellen de volgende contactpersoon.</Say><Hangup/></Response>`
  );
});

app.post('/voice/key', twilioAuth, (req, res) => {
  const alarmId = String(req.query.alarmId || '');
  const index = Number(req.query.index);
  const digit = String(req.body.Digits || '');
  if (digit === '0' && alarm.active && alarm.id === alarmId && alarm.index === index) {
    resetAlarm(false);
    return sendTwiml(res, '<Response><Say language="nl-NL">Het alarm is gereset. Bedankt.</Say><Hangup/></Response>');
  }
  sendTwiml(res, '<Response><Say language="nl-NL">Geen geldige reset ontvangen.</Say><Hangup/></Response>');
});

app.post('/voice/status', twilioAuth, (req, res) => {
  res.sendStatus(204);
  const alarmId = String(req.query.alarmId || '');
  const index = Number(req.query.index);
  const status = String(req.body.CallStatus || '');
  if (alarm.active && alarm.id === alarmId && alarm.index === index &&
      ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    setTimeout(() => startNextCall(alarmId), 300);
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Alarmserver luistert op poort ${port}`);
  console.log(`Twilio-authmodus: ${process.env.TWILIO_AUTH_MODE === 'account' ? 'account' : 'api-key'}`);
  if (!BASE_URL || !DEVICE_TOKEN || !TWILIO_ACCOUNT_SID || !TWILIO_API_KEY ||
      !TWILIO_API_SECRET || !TWILIO_FROM_NUMBER || !TWILIO_AUTH_TOKEN) {
    console.warn('Vul alle vereiste omgevingsvariabelen in voor gebruik.');
  }
});
