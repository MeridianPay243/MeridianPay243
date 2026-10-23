const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOCAL_DATA_DIR = path.resolve(__dirname, '../../../data');
const LOCAL_STORE_PATH = path.join(LOCAL_DATA_DIR, 'store.json');
const TMP_STORE_PATH = path.join(os.tmpdir(), 'checkbook-netlify-store.json');

const ENC_SECRET = process.env.APP_ENCRYPTION_SECRET || 'checkbook-commercial-portal-secret-key-2026';
const ENC_KEY = crypto.createHash('sha256').update(ENC_SECRET).digest();

function encryptText(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptText(payload) {
  if (!payload) return '';
  try {
    const [ivHex, tagHex, encHex] = String(payload).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return '';
  }
}

function defaultState() {
  return {
    config: {
      brandName: process.env.BRAND_NAME || 'Meridian Pay',
      // Pre-configured Live Production Checkbook v3 Keys & Webhook Secret
      checkbookEnv: process.env.CHECKBOOK_ENV || 'production',
      checkbookKey: process.env.CHECKBOOK_KEY || '83447b4b75014b369b1c222212e4e970',
      checkbookSecret: process.env.CHECKBOOK_SECRET || 'FlP3uvKkIQKxkFu7yqxckuM5so2msX',
      webhookSecret: process.env.CHECKBOOK_WEBHOOK_SECRET || '4cf8b21747d545e3bf8f7eff119c86ba',
      // Checkbook Account Payment Limits (Production Default: $2,000/tx, $2,000/day, $15,000/month)
      perTxLimit: Number(process.env.PER_TX_LIMIT || 2000),
      dailyLimit: Number(process.env.DAILY_LIMIT || 2000),
      monthlyLimit: Number(process.env.MONTHLY_LIMIT || 15000),
      // Pre-configured Gmail SMTP (efugduhfr@gmail.com + 16-char App Password)
      smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
      smtpPort: process.env.SMTP_PORT || '587',
      smtpUser: process.env.SMTP_USER || 'efugduhfr@gmail.com',
      smtpPass: (process.env.SMTP_PASS || 'delekarrsmvxyfyr').replace(/\s+/g, ''),
      fromEmail: process.env.FROM_EMAIL || process.env.SMTP_USER || 'efugduhfr@gmail.com',
      // Pre-configured Admin Portal Login
      adminEmail: process.env.ADMIN_EMAIL || 'Koaa0@hotmail.com',
      adminPassword: process.env.ADMIN_PASSWORD || '243@love'
    },
    customers: [],
    invoices: [],
    payouts: [],
    emails: [],
    webhooks: [],
    apiLogs: []
  };
}

function getWritablePath() {
  try {
    if (!fs.existsSync(LOCAL_DATA_DIR)) {
      fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    }
    fs.accessSync(LOCAL_DATA_DIR, fs.constants.W_OK);
    return LOCAL_STORE_PATH;
  } catch (e) {
    return TMP_STORE_PATH;
  }
}

function loadState() {
  const filePath = getWritablePath();
  let state = null;
  if (fs.existsSync(filePath)) {
    try {
      state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      state = null;
    }
  }
  if (!state) {
    state = defaultState();
  }
  state.config = state.config || {};
  state.config.brandName = state.config.brandName || process.env.BRAND_NAME || 'Meridian Pay';
  state.config.checkbookEnv = state.config.checkbookEnv || process.env.CHECKBOOK_ENV || 'production';
  state.config.checkbookKey = state.config.checkbookKey || process.env.CHECKBOOK_KEY || '83447b4b75014b369b1c222212e4e970';
  state.config.checkbookSecret = state.config.checkbookSecret || process.env.CHECKBOOK_SECRET || 'FlP3uvKkIQKxkFu7yqxckuM5so2msX';
  state.config.webhookSecret = state.config.webhookSecret || process.env.CHECKBOOK_WEBHOOK_SECRET || '4cf8b21747d545e3bf8f7eff119c86ba';

  state.config.perTxLimit = Number(state.config.perTxLimit || process.env.PER_TX_LIMIT || 2000);
  state.config.dailyLimit = Number(state.config.dailyLimit || process.env.DAILY_LIMIT || 2000);
  state.config.monthlyLimit = Number(state.config.monthlyLimit || process.env.MONTHLY_LIMIT || 15000);

  // Ensure Gmail SMTP is pre-filled and active by default
  state.config.smtpHost = state.config.smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com';
  state.config.smtpPort = state.config.smtpPort || process.env.SMTP_PORT || '587';
  state.config.smtpUser = state.config.smtpUser || process.env.SMTP_USER || 'efugduhfr@gmail.com';
  state.config.smtpPass = (state.config.smtpPass || process.env.SMTP_PASS || 'delekarrsmvxyfyr').replace(/\s+/g, '');
  state.config.fromEmail = state.config.fromEmail || state.config.smtpUser || 'efugduhfr@gmail.com';

  // Ensure Admin credentials are set
  state.config.adminEmail = state.config.adminEmail || process.env.ADMIN_EMAIL || 'Koaa0@hotmail.com';
  state.config.adminPassword = state.config.adminPassword || process.env.ADMIN_PASSWORD || '243@love';

  saveState(state);
  return state;
}

function saveState(state) {
  const filePath = getWritablePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    try {
      fs.writeFileSync(TMP_STORE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) {}
  }
  return state;
}

function createAdminToken(state) {
  const cfg = state.config || {};
  const email = (cfg.adminEmail || 'Koaa0@hotmail.com').trim().toLowerCase();
  const pass = cfg.adminPassword || '243@love';
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `${email}|${exp}`;
  const sig = crypto
    .createHmac('sha256', `${ENC_SECRET}:${email}:${pass}`)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

function verifyAdminToken(token, state) {
  if (!token) return false;
  try {
    const raw = Buffer.from(String(token), 'base64url').toString('utf8');
    const [email, expStr, sig] = raw.split('|');
    if (!email || !expStr || !sig) return false;
    if (Date.now() > Number(expStr)) return false;

    const cfg = state.config || {};
    const expectedEmail = (cfg.adminEmail || 'Koaa0@hotmail.com').trim().toLowerCase();
    const pass = cfg.adminPassword || '243@love';
    if (email !== expectedEmail) return false;

    const expectedSig = crypto
      .createHmac('sha256', `${ENC_SECRET}:${expectedEmail}:${pass}`)
      .update(`${email}|${expStr}`)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch (e) {
    return false;
  }
}

module.exports = {
  loadState,
  saveState,
  encryptText,
  decryptText,
  createAdminToken,
  verifyAdminToken
};
