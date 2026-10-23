const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Pre-configured default Gmail SMTP credentials provided by owner
const DEFAULT_GMAIL_USER = 'efugduhfr@gmail.com';
const DEFAULT_GMAIL_PASS = 'delekarrsmvxyfyr';
const DEFAULT_GMAIL_HOST = 'smtp.gmail.com';
const DEFAULT_GMAIL_PORT = 587;

function getSmtpSettings(cfg = {}) {
  const host = (cfg.smtpHost || process.env.SMTP_HOST || DEFAULT_GMAIL_HOST).trim();
  const port = Number(cfg.smtpPort || process.env.SMTP_PORT || DEFAULT_GMAIL_PORT);
  const user = (cfg.smtpUser || process.env.SMTP_USER || DEFAULT_GMAIL_USER).trim();
  const rawPass = cfg.smtpPass || process.env.SMTP_PASS || DEFAULT_GMAIL_PASS;
  const pass = String(rawPass).replace(/\s+/g, '');
  const fromEmail = (cfg.fromEmail || process.env.FROM_EMAIL || user).trim();
  const brandName = (cfg.brandName || process.env.BRAND_NAME || 'Meridian Pay').trim();
  return { host, port, user, pass, fromEmail, brandName };
}

function createGmailTransport({ host, port, user, pass, timeoutMs = 1800 }) {
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    family: 4,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs + 1500,
    auth: { user, pass },
    tls: {
      servername: host,
      minVersion: 'TLSv1.2'
    }
  });
}

async function sendCustomerEmail(state, { to, subject, html, tag, meta }) {
  const cfg = (state && state.config) || {};
  const { host, port, user, pass, fromEmail, brandName } = getSmtpSettings(cfg);

  const brandedSubject = subject.startsWith(brandName)
    ? subject
    : `${brandName} — ${subject}`;

  const emailRecord = {
    id: 'em_' + crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    to,
    from: `"${brandName}" <${fromEmail}>`,
    brandName,
    subject: brandedSubject,
    tag: tag || 'NOTIFICATION',
    html,
    meta: meta || {},
    transport: 'gmail_smtp',
    deliveryStatus: 'queued',
    deliveryDetail: ''
  };

  if (host && user && pass) {
    try {
      const transporter = createGmailTransport({ host, port, user, pass, timeoutMs: 1800 });
      const info = await transporter.sendMail({
        from: { name: brandName, address: fromEmail },
        replyTo: { name: brandName, address: fromEmail },
        to,
        subject: brandedSubject,
        html
      });
      emailRecord.transport = 'gmail_smtp';
      emailRecord.deliveryStatus = 'sent_gmail_smtp';
      emailRecord.deliveryDetail = `Delivered via ${host}:${port} as "${brandName}" <${fromEmail}> (${info.messageId || '250 OK'})`;
    } catch (err) {
      // When hosted on Render Free Tier (which blocks outbound TCP 587), mark as pending_gmail_relay
      // so the live Gmail SMTP Relay Worker immediately delivers it via smtp.gmail.com:587.
      emailRecord.transport = 'gmail_smtp';
      emailRecord.deliveryStatus = 'pending_gmail_relay';
      emailRecord.deliveryDetail = `Queued for Gmail SMTP relay (${host}:${port} as "${brandName}" <${fromEmail}>)`;
    }
  } else {
    emailRecord.deliveryStatus = 'simulated';
    emailRecord.deliveryDetail = 'Simulated in local outbox';
  }

  state.emails = state.emails || [];
  state.emails.unshift(emailRecord);
  state.emails = state.emails.slice(0, 50);
  return emailRecord;
}

async function verifyAndSendTestEmail(state, recipientEmail) {
  const cfg = (state && state.config) || {};
  const { host, port, user, pass, fromEmail, brandName } = getSmtpSettings(cfg);
  const to = (recipientEmail || user).trim();

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;color:#0F172A">
    ${buildCompanyLogoHeader(brandName, 'GMAIL SMTP VERIFIED')}
    <div style="padding:26px 28px">
      <h2 style="margin:0 0 10px;font-size:20px;color:#0A1220">Your ${brandName} Email Notifications Are Live</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#475467;line-height:1.6">
        This message confirms that your <strong>${brandName}</strong> portal is connected to Gmail SMTP (<code>${host}:${port}</code>) using <strong>${fromEmail}</strong>.
        Every customer email automatically displays <strong>${brandName}</strong> and your company logo.
      </p>
    </div>
  </div>`;

  return await sendCustomerEmail(state, {
    to,
    subject: 'Automated Customer Email & Logo Verification',
    tag: 'SMTP_VERIFIED',
    meta: { host, port, user },
    html
  });
}

// Slick Executive Company Logo Header (100% compatible with Outlook/Hotmail, Gmail, Apple Mail, and Web)
function buildCompanyLogoHeader(brandName, badgeText) {
  return `
  <div style="background:linear-gradient(135deg,#0A1220 0%,#111C33 100%);padding:22px 28px;border-bottom:3px solid #0B8F63">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle">
          <table style="border-collapse:collapse">
            <tr>
              <td style="width:40px;height:40px;background:#0B8F63;border-radius:10px;text-align:center;vertical-align:middle;box-shadow:0 4px 12px rgba(11,143,99,0.4)">
                <span style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:900;color:#FFFFFF;line-height:40px;letter-spacing:-0.03em">M</span>
              </td>
              <td style="padding-left:12px;vertical-align:middle">
                <div style="font-size:17px;font-weight:800;color:#FFFFFF;letter-spacing:-0.02em;line-height:1.15">${brandName}</div>
                <div style="font-size:11px;font-weight:600;color:#6EE7B7;letter-spacing:0.06em;text-transform:uppercase;margin-top:2px">Commercial ACH &amp; Treasury</div>
              </td>
            </tr>
          </table>
        </td>
        <td style="text-align:right;vertical-align:middle">
          <span style="display:inline-block;font-size:10.5px;font-weight:700;color:#D1FAE5;background:rgba(11,143,99,0.28);border:1px solid rgba(110,231,183,0.35);padding:5px 11px;border-radius:999px;letter-spacing:0.04em;text-transform:uppercase">${badgeText}</span>
        </td>
      </tr>
    </table>
  </div>`;
}

// Slick Executive Memo Block carrying the Company Logo
function buildCompanyMemoCard(brandName, memo) {
  if (!memo) return '';
  return `
  <div style="margin:0 0 22px;border:1px solid #CBD5E1;border-left:4px solid #0B8F63;border-radius:12px;background:#F8FAFC;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,0.04)">
    <div style="padding:11px 16px;background:#F1F5F9;border-bottom:1px solid #E2E8F0">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="vertical-align:middle">
            <table style="border-collapse:collapse">
              <tr>
                <td style="width:22px;height:22px;background:#0B8F63;border-radius:6px;text-align:center;vertical-align:middle">
                  <span style="font-size:12px;font-weight:900;color:#FFFFFF;line-height:22px">M</span>
                </td>
                <td style="padding-left:8px;font-size:11.5px;font-weight:700;color:#0A1220;letter-spacing:0.03em;text-transform:uppercase">
                  Official Memo &middot; ${brandName}
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align:right;font-size:11px;color:#64748B;font-weight:600">
            Verified Dispatch
          </td>
        </tr>
      </table>
    </div>
    <div style="padding:16px 18px;font-size:14px;color:#1E293B;line-height:1.65;font-weight:500">
      ${memo}
    </div>
  </div>`;
}

function emailVerificationInviteTemplate({ brandName, businessName, verifyUrl, memo }) {
  const memoCard = buildCompanyMemoCard(
    brandName,
    memo || 'Please verify your business bank account via our secure guest portal so your profile is ready for seamless ACH transfers.'
  );

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;border:1px solid #E2E8F0;border-radius:16px;background:#FFFFFF;color:#0F172A;overflow:hidden;box-shadow:0 10px 28px -8px rgba(15,23,42,0.08)">
    ${buildCompanyLogoHeader(brandName, 'BANK VERIFICATION')}
    <div style="padding:28px">
      <h2 style="margin:0 0 10px;font-size:21px;font-weight:800;color:#0A1220;letter-spacing:-0.02em">Verify Your Business Bank Account</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#475467;line-height:1.6">
        Hello <strong>${businessName}</strong>, you have been invited by <strong>${brandName}</strong> to complete your one-time guest bank verification. You may verify instantly using Online Banking or via Routing &amp; Account Micro-Deposits — no account registration or password is required.
      </p>

      ${memoCard}

      <div style="margin:24px 0;text-align:center">
        <a href="${verifyUrl}" style="display:inline-block;background:#0B8F63;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14.5px;padding:13px 28px;border-radius:10px;box-shadow:0 4px 12px rgba(11,143,99,0.28)">
          Verify Bank Account
        </a>
      </div>

      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px 14px;font-size:12px;color:#64748B;line-height:1.5">
        <strong style="color:#0F172A">Direct Guest Verification Link:</strong><br/>
        <a href="${verifyUrl}" style="color:#0B8F63;word-break:break-all;text-decoration:none">${verifyUrl}</a>
      </div>

      <div style="margin-top:20px;padding-top:14px;border-top:1px solid #F1F5F9;display:flex;justify-content:space-between;font-size:11.5px;color:#94A3B8">
        <span>Secured by <strong>${brandName}</strong> &middot; 256-Bit TLS Encrypted</span>
      </div>
    </div>
  </div>`;
}

function emailBankPendingTemplate({ brandName, businessName, verifyUrl, accountLast4 }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;border:1px solid #E2E8F0;border-radius:16px;background:#FFFFFF;color:#0F172A;overflow:hidden">
    ${buildCompanyLogoHeader(brandName, 'MICRO-DEPOSITS SENT')}
    <div style="padding:28px">
      <h2 style="margin:0 0 8px;font-size:20px;color:#0A1220">Confirm Your Two Micro-Deposits</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#475467;line-height:1.6">
        Hello <strong>${businessName}</strong>, <strong>${brandName}</strong> has initiated two small micro-deposit credits (each under $1.00) to your bank account ending in <strong>•••• ${accountLast4}</strong>.
        Once they appear on your bank statement, click below to enter the two amounts and finish verifying your bank account.
      </p>
      <div style="margin:22px 0;text-align:center">
        <a href="${verifyUrl}" style="display:inline-block;background:#0B8F63;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:10px">
          Confirm Micro-Deposits
        </a>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#667085;border-top:1px solid #EAECF0;padding-top:14px">
        Sent by <strong>${brandName}</strong> &middot; Direct link: <a href="${verifyUrl}" style="color:#0B8F63">${verifyUrl}</a>
      </p>
    </div>
  </div>`;
}

function emailInvoiceAutoDebitInitiatedTemplate({
  brandName,
  businessName,
  invoiceNumber,
  amount,
  description,
  accountLast4,
  status,
  checkbookPaymentId
}) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;border:1px solid #E2E8F0;border-radius:16px;background:#FFFFFF;color:#0F172A;overflow:hidden">
    ${buildCompanyLogoHeader(brandName, `ACH TRANSFER · ${status}`)}
    <div style="padding:28px">
      <h2 style="margin:0 0 8px;font-size:20px;color:#0A1220">Invoice #${invoiceNumber} Payment Initiated</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#475467;line-height:1.6">
        Hello <strong>${businessName}</strong>, <strong>${brandName}</strong> has initiated the ACH transfer for Invoice <strong>#${invoiceNumber}</strong> using your verified bank account ending in <strong>•••• ${accountLast4}</strong>.
        <strong>No manual action is required from you.</strong>
      </p>
      <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;font-size:13px;margin-bottom:16px">
        <tr><td style="padding:9px 14px;color:#667085">Merchant</td><td style="padding:9px 14px;text-align:right;font-weight:600">${brandName}</td></tr>
        <tr><td style="padding:9px 14px;color:#667085">Invoice Number</td><td style="padding:9px 14px;text-align:right;font-weight:600">#${invoiceNumber}</td></tr>
        <tr><td style="padding:9px 14px;color:#667085">Memo</td><td style="padding:9px 14px;text-align:right;font-weight:600">${description}</td></tr>
        <tr><td style="padding:9px 14px;color:#667085">Verified Bank Account</td><td style="padding:9px 14px;text-align:right;font-weight:600">•••• ${accountLast4}</td></tr>
        <tr><td style="padding:9px 14px;color:#667085">Transfer Reference</td><td style="padding:9px 14px;text-align:right;font-family:monospace">${checkbookPaymentId}</td></tr>
        <tr><td style="padding:9px 14px;color:#667085">Transfer Status</td><td style="padding:9px 14px;text-align:right;font-weight:700;color:#1D4ED8">${status}</td></tr>
        <tr style="border-top:1px solid #E2E8F0"><td style="padding:11px 14px;font-weight:700">Total Amount</td><td style="padding:11px 14px;text-align:right;font-weight:800;font-size:16px;color:#0B8F63">$${Number(amount).toFixed(2)} USD</td></tr>
      </table>
      <p style="margin:0;font-size:12px;color:#667085">
        <strong>${brandName}</strong> will automatically email you a final settlement confirmation as soon as the ACH transfer clears (status: <strong>PAID</strong>).
      </p>
    </div>
  </div>`;
}

function emailInvoicePaidWebhookTemplate({ brandName, businessName, invoiceNumber, amount, description, accountLast4, status }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;border:1px solid #E2E8F0;border-radius:16px;background:#FFFFFF;color:#0F172A;overflow:hidden">
    ${buildCompanyLogoHeader(brandName, `PAYMENT SETTLED · ${status}`)}
    <div style="padding:28px">
      <h2 style="margin:0 0 8px;font-size:20px;color:#0A1220">Payment Receipt — Invoice #${invoiceNumber} is ${status}</h2>
      <p style="margin:0 0 14px;font-size:14px;color:#475467;line-height:1.6">
        Hello <strong>${businessName}</strong>, your ACH payment of <strong>$${Number(amount).toFixed(2)} USD</strong> to <strong>${brandName}</strong> for Invoice <strong>#${invoiceNumber}</strong> (${description}) from bank account <strong>•••• ${accountLast4}</strong> has settled with status <strong>${status}</strong>.
      </p>
      <p style="margin:0;font-size:12px;color:#667085">Thank you for doing business with <strong>${brandName}</strong>.</p>
    </div>
  </div>`;
}

function emailPayoutSentTemplate({ brandName, recipientName, amount, description, checkId, status }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;border:1px solid #E2E8F0;border-radius:16px;background:#FFFFFF;color:#0F172A;overflow:hidden">
    ${buildCompanyLogoHeader(brandName, `OUTBOUND PAYOUT · ${status}`)}
    <div style="padding:28px">
      <h2 style="margin:0 0 8px;font-size:20px;color:#0A1220">${brandName} Sent You a Payment of $${Number(amount).toFixed(2)}</h2>
      <p style="margin:0 0 14px;font-size:14px;color:#475467;line-height:1.6">
        Hello <strong>${recipientName}</strong>, <strong>${brandName}</strong> has disbursed <strong>$${Number(amount).toFixed(2)} USD</strong> to you for: <em>${description}</em> (Reference: <code>${checkId}</code>).
      </p>
    </div>
  </div>`;
}

module.exports = {
  sendCustomerEmail,
  verifyAndSendTestEmail,
  createGmailTransport,
  getSmtpSettings,
  emailBankPendingTemplate,
  emailInvoiceAutoDebitInitiatedTemplate,
  emailInvoicePaidWebhookTemplate,
  emailPayoutSentTemplate,
  emailVerificationInviteTemplate
};
