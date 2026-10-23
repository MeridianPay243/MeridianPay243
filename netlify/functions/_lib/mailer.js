const crypto = require('crypto');
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

function getGmailTransportConfig(cfg = {}) {
  const host = (cfg.smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(cfg.smtpPort || process.env.SMTP_PORT || 587);
  const user = (cfg.smtpUser || process.env.SMTP_USER || 'efugduhfr@gmail.com').trim();
  const pass = String(cfg.smtpPass || process.env.SMTP_PASS || 'delekarrsmvxyfyr').replace(/\s+/g, '');
  const fromEmail = (cfg.fromEmail || process.env.FROM_EMAIL || user || 'efugduhfr@gmail.com').trim();
  return { host, port, user, pass, fromEmail };
}

async function sendCustomerEmail(state, { to, subject, html, tag, meta }) {
  const cfg = state.config || {};
  const brandName = (cfg.brandName || process.env.BRAND_NAME || 'Meridian Pay').trim();
  const { host, port, user, pass, fromEmail } = getGmailTransportConfig(cfg);

  const prefixedSubject = subject.startsWith(brandName)
    ? subject
    : `${brandName} — ${subject}`;

  let deliveryStatus = 'logged_in_outbox';
  let deliveryDetail = 'Saved to Admin Outbox';

  if (nodemailer && host && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
      });
      await transporter.sendMail({
        from: {
          name: brandName,
          address: fromEmail
        },
        replyTo: {
          name: brandName,
          address: fromEmail
        },
        to,
        subject: prefixedSubject,
        html
      });
      deliveryStatus = 'sent_gmail_smtp';
      deliveryDetail = `Delivered via Gmail SMTP (${host}:${port}) as "${brandName}" <${fromEmail}>`;
    } catch (err) {
      deliveryStatus = 'error';
      deliveryDetail = `Gmail SMTP error: ${err.message}`;
    }
  }

  const emailRecord = {
    id: 'em_' + crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    to,
    from: `"${brandName}" <${fromEmail}>`,
    subject: prefixedSubject,
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

async function verifyAndSendTestEmail(state, testRecipient) {
  const cfg = state.config || {};
  const brandName = (cfg.brandName || process.env.BRAND_NAME || 'Meridian Pay').trim();
  const { host, port, user, pass, fromEmail } = getGmailTransportConfig(cfg);

  if (!nodemailer) {
    throw new Error('Nodemailer module is unavailable.');
  }
  if (!user || !pass) {
    throw new Error('Gmail Address and 16-Character App Password are required.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  await transporter.verify();

  const recipient = (testRecipient || user).trim();
  const subject = `${brandName} — Gmail SMTP Live Connection Verified`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E4E7EC;border-radius:14px;background:#FFFFFF;color:#0F172A">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #F1F5F9">
      <strong style="font-size:16px;color:#0A1220">${brandName}</strong>
      <span style="font-size:11px;font-weight:700;color:#0B8F63;background:#E7F6F0;padding:4px 10px;border-radius:999px">GMAIL SMTP ACTIVE</span>
    </div>
    <h2 style="margin:0 0 8px;font-size:19px">Your Gmail App Password is connected</h2>
    <p style="margin:0 0 14px;font-size:14px;color:#475467;line-height:1.55">
      This confirms that <strong>${brandName}</strong> is actively sending customer notifications through <code>${host}:${port}</code> from <strong>"${brandName}" &lt;${fromEmail}&gt;</strong>.
    </p>
    <p style="margin:0;font-size:12px;color:#667085">
      All customer micro-deposit links, auto-debit initiation receipts, and settlement confirmations will display <strong>${brandName}</strong> as the sender name.
    </p>
  </div>`;

  await transporter.sendMail({
    from: { name: brandName, address: fromEmail },
    to: recipient,
    subject,
    html
  });

  const emailRecord = {
    id: 'em_' + crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    to: recipient,
    from: `"${brandName}" <${fromEmail}>`,
    subject,
    tag: 'SMTP_TEST_OK',
    deliveryStatus: 'sent_gmail_smtp',
    deliveryDetail: `Verified & delivered via ${host}:${port} as "${brandName}" <${fromEmail}>`,
    meta: {},
    html
  };
  state.emails.unshift(emailRecord);
  state.emails = state.emails.slice(0, 50);
  return emailRecord;
}

function emailBankPendingTemplate({ brandName, businessName, verifyUrl, accountLast4 }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E4E7EC;border-radius:14px;background:#FFFFFF;color:#0F172A">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #F1F5F9">
      <strong style="font-size:16px;color:#0A1220">${brandName}</strong>
      <span style="font-size:11px;font-weight:700;color:#B54708;background:#FEF6EE;padding:4px 10px;border-radius:999px">ACTION REQUIRED · MICRO-DEPOSITS</span>
    </div>
    <h2 style="margin:0 0 8px;font-size:20px">Confirm your two micro-deposits with ${brandName}</h2>
    <p style="margin:0 0 16px;font-size:14px;color:#475467;line-height:1.55">
      Hi <strong>${businessName}</strong>, <strong>${brandName}</strong> initiated two small micro-deposit credits (each under $1.00) to your bank account ending in <strong>•••• ${accountLast4}</strong>.
    </p>
    <p style="margin:0 0 18px;font-size:14px;color:#475467;line-height:1.55">
      As soon as the two amounts appear on your bank statement, click the button below to return directly to your guest verification session and confirm both amounts:
    </p>
    <div style="margin:20px 0">
      <a href="${verifyUrl}" style="display:inline-block;background:#0B8F63;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:9px">
        Confirm Micro-Deposit Amounts &rarr;
      </a>
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#667085;border-top:1px solid #EAECF0;padding-top:14px">
      Sent by <strong>${brandName}</strong> &middot; Direct link: <a href="${verifyUrl}" style="color:#0B8F63">${verifyUrl}</a>
    </p>
  </div>`;
}

function emailInvoiceAutoDebitInitiatedTemplate({ brandName, businessName, invoiceNumber, amount, description, accountLast4, status, checkbookPaymentId }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E4E7EC;border-radius:14px;background:#FFFFFF;color:#0F172A">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #F1F5F9">
      <strong style="font-size:16px;color:#0A1220">${brandName}</strong>
      <span style="font-size:11px;font-weight:700;color:#1D4ED8;background:#EFF4FF;padding:4px 10px;border-radius:999px">ACH AUTO-DEBIT · ${status}</span>
    </div>
    <h2 style="margin:0 0 8px;font-size:20px">Invoice #${invoiceNumber} Issued &amp; Auto-Debit Initiated</h2>
    <p style="margin:0 0 16px;font-size:14px;color:#475467;line-height:1.55">
      Hi <strong>${businessName}</strong>, <strong>${brandName}</strong> has issued Invoice <strong>#${invoiceNumber}</strong> and automatically initiated an ACH debit against your verified bank account ending in <strong>•••• ${accountLast4}</strong>.
      <strong>No manual payment action is required from you.</strong>
    </p>
    <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border:1px solid #E4E7EC;border-radius:10px;padding:12px;font-size:13px;margin-bottom:16px">
      <tr><td style="padding:8px 12px;color:#667085">Billed By</td><td style="padding:8px 12px;text-align:right;font-weight:600">${brandName}</td></tr>
      <tr><td style="padding:8px 12px;color:#667085">Invoice Number</td><td style="padding:8px 12px;text-align:right;font-weight:600">#${invoiceNumber}</td></tr>
      <tr><td style="padding:8px 12px;color:#667085">Description</td><td style="padding:8px 12px;text-align:right;font-weight:600">${description}</td></tr>
      <tr><td style="padding:8px 12px;color:#667085">Debited Bank Account</td><td style="padding:8px 12px;text-align:right;font-weight:600">Verified Bank •••• ${accountLast4}</td></tr>
      <tr><td style="padding:8px 12px;color:#667085">Settlement Reference</td><td style="padding:8px 12px;text-align:right;font-family:monospace">${checkbookPaymentId}</td></tr>
      <tr><td style="padding:8px 12px;color:#667085">Payment Status</td><td style="padding:8px 12px;text-align:right;font-weight:700;color:#1D4ED8">${status}</td></tr>
      <tr style="border-top:1px solid #E4E7EC"><td style="padding:10px 12px;font-weight:700">Total Auto-Debited</td><td style="padding:10px 12px;text-align:right;font-weight:700;font-size:16px">$${Number(amount).toFixed(2)} USD</td></tr>
    </table>
    <p style="margin:0;font-size:12px;color:#667085">
      <strong>${brandName}</strong> will automatically email you a final settlement confirmation as soon as the ACH transfer clears (status: <strong>PAID</strong>).
    </p>
  </div>`;
}

function emailInvoicePaidWebhookTemplate({ brandName, businessName, invoiceNumber, amount, description, accountLast4, status }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E4E7EC;border-radius:14px;background:#FFFFFF;color:#0F172A">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #F1F5F9">
      <strong style="font-size:16px;color:#0A1220">${brandName}</strong>
      <span style="font-size:11px;font-weight:700;color:#0B8F63;background:#E7F6F0;padding:4px 10px;border-radius:999px">PAYMENT SETTLED · ${status}</span>
    </div>
    <h2 style="margin:0 0 8px;font-size:20px">Payment Receipt — Invoice #${invoiceNumber} is ${status}</h2>
    <p style="margin:0 0 14px;font-size:14px;color:#475467;line-height:1.55">
      Hi <strong>${businessName}</strong>, your automatic ACH payment of <strong>$${Number(amount).toFixed(2)} USD</strong> to <strong>${brandName}</strong> for Invoice <strong>#${invoiceNumber}</strong> (${description}) from bank account <strong>•••• ${accountLast4}</strong> has settled with status <strong>${status}</strong>.
    </p>
    <p style="margin:0;font-size:12px;color:#667085">Thank you for doing business with <strong>${brandName}</strong>. Keep this receipt for your accounting records.</p>
  </div>`;
}

function emailPayoutSentTemplate({ brandName, recipientName, amount, description, checkId, status }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #E4E7EC;border-radius:14px;background:#FFFFFF;color:#0F172A">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #F1F5F9">
      <strong style="font-size:16px;color:#0A1220">${brandName}</strong>
      <span style="font-size:11px;font-weight:700;color:#0B8F63;background:#E7F6F0;padding:4px 10px;border-radius:999px">OUTBOUND PAYOUT · ${status}</span>
    </div>
    <h2 style="margin:0 0 8px;font-size:20px">${brandName} sent you a payment of $${Number(amount).toFixed(2)}</h2>
    <p style="margin:0 0 14px;font-size:14px;color:#475467;line-height:1.55">
      Hi <strong>${recipientName}</strong>, <strong>${brandName}</strong> has disbursed <strong>$${Number(amount).toFixed(2)} USD</strong> to you for: <em>${description}</em> (Checkbook Reference: <code>${checkId}</code>).
    </p>
  </div>`;
}

module.exports = {
  sendCustomerEmail,
  verifyAndSendTestEmail,
  emailBankPendingTemplate,
  emailInvoiceAutoDebitInitiatedTemplate,
  emailInvoicePaidWebhookTemplate,
  emailPayoutSentTemplate
};
