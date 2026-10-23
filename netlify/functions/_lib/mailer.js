const crypto = require('crypto');
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

async function sendCustomerEmail(state, { to, subject, html, tag, meta }) {
  const cfg = state.config || {};
  const fromEmail = cfg.fromEmail || cfg.smtpUser || 'billing@meridianpay.co';
  const brandName = cfg.brandName || 'Meridian Pay';

  let deliveryStatus = 'logged_in_outbox';
  let deliveryDetail = 'Saved to Admin Outbox (add Brevo key or SMTP in Admin Settings to send live emails)';

  // Option 1: Brevo HTTP API (Best for @hotmail.com / @outlook.com free tier — 300 emails/day $0)
  if (cfg.brevoApiKey) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': cfg.brevoApiKey
        },
        body: JSON.stringify({
          sender: { name: brandName, email: fromEmail },
          to: [{ email: to }],
          subject,
          htmlContent: html
        })
      });
      if (res.ok) {
        deliveryStatus = 'sent_brevo';
        deliveryDetail = `Delivered via Brevo API from ${fromEmail}`;
      } else {
        const errText = await res.text();
        deliveryStatus = 'error';
        deliveryDetail = `Brevo error (${res.status}): ${errText.slice(0, 140)}`;
      }
    } catch (err) {
      deliveryStatus = 'error';
      deliveryDetail = `Brevo network error: ${err.message}`;
    }
  }
  // Option 2: Standard SMTP (Brevo SMTP relay, Gmail App Password, etc.)
  else if (cfg.smtpHost && cfg.smtpUser && cfg.smtpPass) {
    try {
      const port = Number(cfg.smtpPort || 587);
      const transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port,
        secure: port === 465,
        auth: {
          user: cfg.smtpUser,
          pass: cfg.smtpPass
        }
      });
      await transporter.sendMail({
        from: `"${brandName}" <${fromEmail}>`,
        to,
        subject,
        html
      });
      deliveryStatus = 'sent_smtp';
      deliveryDetail = `Sent via SMTP (${cfg.smtpHost}:${port}) from ${fromEmail}`;
    } catch (err) {
      deliveryStatus = 'error';
      deliveryDetail = `SMTP error: ${err.message}`;
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

module.exports = { sendCustomerEmail };
