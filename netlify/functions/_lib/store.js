const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function resolveDataFile() {
  const localDir = path.join(__dirname, '..', '..', '..', 'data');
  try {
    fs.mkdirSync(localDir, { recursive: true });
    fs.accessSync(localDir, fs.constants.W_OK);
    return path.join(localDir, 'store.json');
  } catch {
    return path.join(os.tmpdir(), 'checkbook-netlify-store.json');
  }
}

const DATA_FILE = resolveDataFile();

function getEncryptionKey() {
  const secret = process.env.STORE_ENCRYPTION_KEY || process.env.CHECKBOOK_SECRET || 'default-netlify-store-secret-key-32b';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptText(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptText(payload) {
  if (!payload || !String(payload).includes(':')) return payload || '';
  try {
    const [ivHex, tagHex, encHex] = String(payload).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return '';
  }
}

const DEFAULT_STATE = {
  config: {
    brandName: process.env.BRAND_NAME || 'Meridian Pay',
    checkbookEnv: process.env.CHECKBOOK_ENV || 'sandbox',
    checkbookKey: process.env.CHECKBOOK_KEY || '',
    checkbookSecret: process.env.CHECKBOOK_SECRET || '',
    webhookSecret: process.env.CHECKBOOK_WEBHOOK_SECRET || '',
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: process.env.SMTP_PORT || '587',
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    fromEmail: process.env.FROM_EMAIL || process.env.SMTP_USER || ''
  },
  customers: [],
  invoices: [],
  payouts: [],
  webhooks: [],
  emails: [],
  apiLogs: []
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const mergedConfig = { ...DEFAULT_STATE.config, ...(raw.config || {}) };
      if (!mergedConfig.smtpHost) mergedConfig.smtpHost = 'smtp.gmail.com';
      if (!mergedConfig.smtpPort) mergedConfig.smtpPort = '587';
      return {
        ...DEFAULT_STATE,
        ...raw,
        config: mergedConfig
      };
    }
  } catch (err) {
    console.error('Error reading store.json:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving store.json:', err.message);
  }
  return state;
}

function logApiCall(state, entry) {
  state.apiLogs.unshift({
    id: 'log_' + crypto.randomBytes(4).toString('hex'),
    ts: new Date().toISOString(),
    ...entry
  });
  state.apiLogs = state.apiLogs.slice(0, 60);
}

module.exports = {
  loadState,
  saveState,
  encryptText,
  decryptText,
  logApiCall
};
