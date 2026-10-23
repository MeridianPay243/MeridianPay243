const crypto = require('crypto');
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

function createSmtpTransporter(cfg) {
  if (!nodemailer) {
    throw new Error('Nodemailer module is not available');
  }
  const host = (cfg.smtpHost || 'smtp.gmail.com').trim();
  const port = Number(cfg.smtpPort || 587);
  const user = (cfg.smtpUser || cfg.fromEmail || '').trim();
  // Strip any spaces from Google's 16-character App Password ("xxxx xxxx xxxx xxxx" -> "xxxxxxxxxxxxxxxx")
  const pass = String(cfg.smtpPass || '').replace(/\s+/g, '');

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendCustomerEmail(state, { to, subject, html, tag, meta }) {
  const cfg = state.config || {};
  const smtpUser = (cfg.smtpUser || '').trim();
  const smtpPass = String(cfg.smtpPass || '').replace(/\s+/g, '');
  const fromEmail = (cfg.fromEmail || smtpUser || 'billing@meridianpay.co').trim();
  const brandName = cfg.brandName || 'Meridian Pay';

  let deliveryStatus = 'logged_in_outbox';
  let deliveryDetail = 'Saved in Admin Outbox (Add your Gmail & 16-digit App Password in Settings to send live emails)';

  if (smtpUser && smtpPass && nodemailer) {
    try {
      const transporter = createSmtpTransporter(cfg);
      await transporter.sendMail({
        from: `"${brandName}" <${fromEmail}>`,
        to,
        subject,
        html
      });
      deliveryStatus = 'sent_gmail_smtp';
      deliveryDetail = `Delivered via Gmail SMTP (${fromEmail})`;
    } catch (err) {
      deliveryStatus = 'error';
      deliveryDetail = `Gmail SMTP Error: ${err.message}`;
    }
  }

  const emailRecord = {
    id: 'em_' + crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    to,
    from: fromEmail,
    subject,
    tag: tag || 'NOTIFICATION',
    deliveryStatus,
    deliveryDetail,
    meta: meta || {},
    html
  };

  state.emails.unshift(emailRecord);
  state.emails = state.emails.slice(0, 50);
  return emailRecord;
}

async function verifyAndSendTestEmail(state, recipientEmail) {
  const cfg = state.config || {};
  const smtpUser = (cfg.smtpUser || '').trim();
  const smtpPass = String(cfg.smtpPass || '').replace(/\s+/g, '');
  if (!smtpUser || !smtpPass) {
    throw new Error('Please enter both your Gmail address and your 16-character Gmail App Password.');
  }

  const transporter = createSmtpTransporter(cfg);
  await transporter.verify();

  const target = (recipientEmail || smtpUser).trim();
  const brandName = cfg.brandName || 'Meridian Pay';
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff">
    <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:#E7F6F0;color:#07714E;font-size:11px;font-weight:700;margin-bottom:12px">GMAIL SMTP VERIFIED</div>
    <h2 style="margin:0 0 8px;color:#0a1220;font-size:20px">${brandName} — Live Email Integration Active</h2>
    <p style="color:#475467;font-size:14px;line-height:1.6;margin:0 0 16px">
      Your Gmail SMTP connection (<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${smtpUser}</code>) is working properly.
    </p>
    <p style="color:#475467;font-size:13.5px;line-height:1.6;margin:0">
      Your customers will now automatically receive micro-deposit verification links, auto-debit payment confirmations (<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">IN_PROCESS</code>), and final settlement receipts (<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">PAID</code>) directly from this address.
    </p>
  </div>`;

  const rec = await sendCustomerEmail(state, {
    to: target,
    subject: `${brandName}: Gmail SMTP Test Successful`,
    tag: 'SMTP_TEST',
    html
  });

  if (rec.deliveryStatus === 'error') {
    throw new Error(rec.deliveryDetail);
  }
  return rec;
}

module.exports = { sendCustomerEmail, verifyAndSendTestEmail };
