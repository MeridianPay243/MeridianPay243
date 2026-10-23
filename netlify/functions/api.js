const crypto = require('crypto');
const { loadState, saveState, encryptText, decryptText } = require('./_lib/store');
const {
  createMarketplaceUser,
  getInstitutions,
  instantVerifyBank,
  addManualBankAndRelease,
  verifyMicroDeposits,
  issueAndAutoDebitInvoice,
  sendPayout,
  verifyWebhookSignature,
  hasLiveOwnerKeys
} = require('./_lib/checkbook');
const { sendCustomerEmail } = require('./_lib/mailer');

function ensureSeeded(state) {
  if (state.customers.length === 0) {
    const sampleToken = 'tok_demo_northwind';
    state.customers.push({
      id: 'cust_demo_01',
      token: sampleToken,
      businessName: 'Northwind Studio LLC',
      email: 'dana@northwind.co',
      user_id: 'cust_northwind_8f2a',
      checkbook_user_uuid: '9d7263e9db75473d8acf259b77c99df4',
      encryptedAuth: encryptText('sim_pub_northwind:sim_sec_northwind'),
      bank_id: 'bank_1bc0ce98ce',
      bankName: 'JPMorgan Chase Bank',
      routing: '322271627',
      accountLast4: '6789',
      accountType: 'BUSINESS',
      verificationMethod: 'MICRODEPOSITS',
      bankStatus: 'VERIFIED',
      attemptsRemaining: 3,
      mandateSignedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
    });
    saveState(state);
  }
}

function getCustomerAuth(customer) {
  return decryptText(customer.encryptedAuth);
}

function sanitizeCustomer(c) {
  const { encryptedAuth, ...rest } = c;
  return { ...rest, hasStoredKeys: Boolean(encryptedAuth) };
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, signature'
    },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  const state = loadState();
  ensureSeeded(state);

  const rawPath = (event.path || '')
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '') || '/';
  const method = event.httpMethod || 'GET';
  const query = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      body = {};
    }
  }

  try {
    // 1. Start Guest Profile (Business Name + Email ONLY -> POST /v3/user)
    if (method === 'POST' && rawPath === '/guest/start') {
      const businessName = String(body.businessName || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      if (!businessName || !email || !email.includes('@')) {
        return jsonResponse(400, { error: 'Please enter both your Business Name and a valid Email address.' });
      }

      // Check if guest already has an active session by email
      let existing = state.customers.find(c => c.email === email);
      if (existing) {
        return jsonResponse(200, {
          customer: sanitizeCustomer(existing),
          reused: true
        });
      }

      // Create internal user_id slug (NOT raw email, so Checkbook allows programmatic POST /v3/invoice/payment)
      const slugBase = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 14) || 'guest';
      const userIdSlug = `cust_${slugBase}_${crypto.randomBytes(2).toString('hex')}`;

      const cbUser = await createMarketplaceUser(state, { businessName, userIdSlug });
      const token = 'tok_' + crypto.randomBytes(12).toString('hex');

      const customer = {
        id: 'cust_' + crypto.randomBytes(6).toString('hex'),
        token,
        businessName,
        email,
        user_id: cbUser.user_id,
        checkbook_user_uuid: cbUser.id,
        encryptedAuth: encryptText(`${cbUser.key}:${cbUser.secret}`),
        bank_id: null,
        bankName: null,
        routing: null,
        accountLast4: null,
        accountType: 'BUSINESS',
        verificationMethod: null,
        bankStatus: 'UNLINKED',
        attemptsRemaining: 3,
        mandateSignedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };

      state.customers.unshift(customer);
      saveState(state);

      return jsonResponse(200, { customer: sanitizeCustomer(customer) });
    }

    // 2. Load Guest Session by Magic Link Token
    if (method === 'GET' && rawPath === '/guest/session') {
      const token = String(query.token || '').trim();
      const customer = state.customers.find(c => c.token === token);
      if (!customer) {
        return jsonResponse(404, { error: 'Verification session not found.' });
      }
      return jsonResponse(200, {
        customer: sanitizeCustomer(customer),
        brandName: state.config.brandName,
        checkbookEnv: state.config.checkbookEnv
      });
    }

    // 3. Get Supported Institutions for Checkbook Built-in IAV (GET /v3/account/bank/institutions)
    if (method === 'GET' && rawPath === '/bank/institutions') {
      const token = String(query.token || '').trim();
      const customer = state.customers.find(c => c.token === token);
      const userAuth = customer ? getCustomerAuth(customer) : null;
      const institutions = await getInstitutions(state, userAuth);
      saveState(state);
      return jsonResponse(200, { institutions });
    }

    // 4. Instant Bank Verification via Checkbook IAV (POST /v3/account/bank/iav + POST /v3/account/bank)
    if (method === 'POST' && rawPath === '/bank/iav') {
      const { token, institution_id, institution_name, login, password, type } = body;
      const customer = state.customers.find(c => c.token === token);
      if (!customer) return jsonResponse(404, { error: 'Session not found.' });
      if (!institution_id || !login || !password) {
        return jsonResponse(400, { error: 'Please select a bank and enter your bank login credentials.' });
      }

      const userAuth = getCustomerAuth(customer);
      const result = await instantVerifyBank(state, userAuth, {
        institution_id,
        institution_name,
        login,
        password,
        type: type || 'BUSINESS'
      });

      customer.bank_id = result.bank_id;
      customer.bankName = result.bankName;
      customer.routing = result.routing;
      customer.accountLast4 = result.accountLast4;
      customer.accountType = result.type;
      customer.verificationMethod = 'CHECKBOOK_IAV';
      customer.bankStatus = 'VERIFIED';

      await sendCustomerEmail(state, {
        to: customer.email,
        subject: `${state.config.brandName}: Bank account •••• ${customer.accountLast4} verified for auto-debit`,
        tag: 'BANK_VERIFIED',
        meta: { customerId: customer.id, bankLast4: customer.accountLast4 },
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
          <h2 style="margin:0 0 8px;color:#0a1220">Bank Verified — ${customer.businessName}</h2>
          <p style="color:#475467;line-height:1.5">Your bank account <b>${customer.bankName} (•••• ${customer.accountLast4})</b> has been verified instantly via Checkbook IAV.</p>
          <p style="color:#475467;line-height:1.5"><b>No further action is required.</b> Whenever an invoice is issued to <b>${customer.businessName}</b>, it will be debited automatically and we will email your payment status updates to <b>${customer.email}</b>.</p>
        </div>`
      });

      saveState(state);
      return jsonResponse(200, { customer: sanitizeCustomer(customer) });
    }

    // 5. Manual Routing & Account + Micro-Deposits (POST /v3/account/bank + POST /v3/account/bank/release)
    if (method === 'POST' && rawPath === '/bank/manual') {
      const { token, routing, account, type, bankName } = body;
      const customer = state.customers.find(c => c.token === token);
      if (!customer) return jsonResponse(404, { error: 'Session not found.' });

      const cleanRouting = String(routing || '').replace(/\D/g, '');
      const cleanAccount = String(account || '').replace(/\D/g, '');
      if (cleanRouting.length !== 9) {
        return jsonResponse(400, { error: 'Routing number must be 9 digits.' });
      }
      if (cleanAccount.length < 4) {
        return jsonResponse(400, { error: 'Please enter a valid bank account number.' });
      }

      const userAuth = getCustomerAuth(customer);
      const result = await addManualBankAndRelease(state, userAuth, {
        routing: cleanRouting,
        account: cleanAccount,
        type: type || 'BUSINESS',
        bankName: bankName || 'Business Checking'
      });

      customer.bank_id = result.bank_id;
      customer.bankName = result.bankName;
      customer.routing = result.routing;
      customer.accountLast4 = result.accountLast4;
      customer.accountType = result.type;
      customer.verificationMethod = 'MICRODEPOSITS';
      customer.bankStatus = 'PENDING';
      customer.attemptsRemaining = 3;

      const returnUrl = `${body.origin || ''}/?token=${customer.token}`;
      await sendCustomerEmail(state, {
        to: customer.email,
        subject: `${state.config.brandName}: Confirm your 2 micro-deposits for ${customer.businessName}`,
        tag: 'MICRODEPOSIT_LINK',
        meta: { customerId: customer.id, returnUrl },
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
          <h2 style="margin:0 0 8px;color:#0a1220">Two micro-deposits are on the way</h2>
          <p style="color:#475467;line-height:1.5">We initiated two small credits under $1.00 to <b>•••• ${customer.accountLast4}</b> for <b>${customer.businessName}</b> (in Sandbox, amounts are always <b>$0.07</b> and <b>$0.15</b>).</p>
          <p style="margin:20px 0"><a href="${returnUrl}" style="background:#0B8F63;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Return to Confirm Micro-Deposit Amounts →</a></p>
          <p style="color:#667085;font-size:12px">Direct link: ${returnUrl}</p>
        </div>`
      });

      saveState(state);
      return jsonResponse(200, { customer: sanitizeCustomer(customer), returnUrl });
    }

    // 6. Verify Micro-Deposit Amounts (POST /v3/account/bank/verify)
    if (method === 'POST' && rawPath === '/bank/verify') {
      const { token, amount_1, amount_2 } = body;
      const customer = state.customers.find(c => c.token === token);
      if (!customer) return jsonResponse(404, { error: 'Session not found.' });
      if (!customer.bank_id) return jsonResponse(400, { error: 'No pending bank account on file.' });
      if (customer.attemptsRemaining <= 0) {
        return jsonResponse(400, { error: 'Maximum verification attempts exceeded. Please add your bank account again.' });
      }

      const userAuth = getCustomerAuth(customer);
      try {
        await verifyMicroDeposits(state, userAuth, {
          bank_id: customer.bank_id,
          amount_1,
          amount_2
        });
      } catch (err) {
        customer.attemptsRemaining = Math.max(0, (customer.attemptsRemaining || 3) - 1);
        saveState(state);
        return jsonResponse(400, {
          error: `${err.message} (${customer.attemptsRemaining} attempts remaining)`
        });
      }

      customer.bankStatus = 'VERIFIED';

      await sendCustomerEmail(state, {
        to: customer.email,
        subject: `${state.config.brandName}: Bank account •••• ${customer.accountLast4} is now VERIFIED`,
        tag: 'BANK_VERIFIED',
        meta: { customerId: customer.id, bankLast4: customer.accountLast4 },
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
          <h2 style="margin:0 0 8px;color:#0a1220">Bank Verified — You're All Set</h2>
          <p style="color:#475467;line-height:1.5">Your bank account <b>•••• ${customer.accountLast4}</b> for <b>${customer.businessName}</b> is now <b>VERIFIED</b>.</p>
          <p style="color:#475467;line-height:1.5">Whenever an invoice is issued to your business, payment will be debited automatically and we will email your receipt and status updates to <b>${customer.email}</b>. You never need to click "Pay".</p>
        </div>`
      });

      saveState(state);
      return jsonResponse(200, { customer: sanitizeCustomer(customer) });
    }

    // 7. Admin Portal State
    if (method === 'GET' && rawPath === '/admin/state') {
      return jsonResponse(200, {
        config: {
          brandName: state.config.brandName,
          checkbookEnv: state.config.checkbookEnv,
          hasLiveCheckbookKeys: hasLiveOwnerKeys(state.config),
          checkbookKeyPreview: state.config.checkbookKey ? state.config.checkbookKey.slice(0, 6) + '…' : '',
          hasWebhookSecret: Boolean(state.config.webhookSecret),
          smtpHost: state.config.smtpHost,
          smtpPort: state.config.smtpPort,
          smtpUser: state.config.smtpUser,
          fromEmail: state.config.fromEmail,
          hasSmtpPass: Boolean(state.config.smtpPass),
          hasBrevoKey: Boolean(state.config.brevoApiKey)
        },
        customers: state.customers.map(sanitizeCustomer),
        invoices: state.invoices,
        payouts: state.payouts,
        webhooks: state.webhooks,
        emails: state.emails,
        apiLogs: state.apiLogs
      });
    }

    // 8. Admin 1-Click Issue & Auto-Debit Invoice
    //    Calls POST /v3/invoice (owner key) + POST /v3/invoice/payment (guest key) + Emails customer IN_PROCESS status
    if (method === 'POST' && rawPath === '/admin/invoice-autodebit') {
      const { customerId, amount, description } = body;
      const customer = state.customers.find(c => c.id === customerId);
      if (!customer) return jsonResponse(404, { error: 'Customer not found.' });
      if (customer.bankStatus !== 'VERIFIED' || !customer.bank_id) {
        return jsonResponse(400, { error: 'Customer bank must be VERIFIED before issuing an auto-debit invoice.' });
      }
      if (!amount || Number(amount) <= 0) {
        return jsonResponse(400, { error: 'Enter a valid invoice amount greater than $0.' });
      }

      const userAuth = getCustomerAuth(customer);
      const result = await issueAndAutoDebitInvoice(state, {
        customer,
        userAuth,
        amount,
        description: description || 'Services rendered'
      });

      const invoiceRecord = {
        id: result.invoice_id,
        payment_id: result.payment_id,
        number: result.number,
        customerId: customer.id,
        businessName: customer.businessName,
        email: customer.email,
        accountLast4: customer.accountLast4,
        amount: result.amount,
        description: description || 'Services rendered',
        status: result.status,
        live: result.live,
        createdAt: new Date().toISOString()
      };
      state.invoices.unshift(invoiceRecord);

      // Immediately email the customer that the invoice was issued and auto-debit is IN_PROCESS
      await sendCustomerEmail(state, {
        to: customer.email,
        subject: `Invoice #${invoiceRecord.number} ($${invoiceRecord.amount.toFixed(2)}) issued — Auto-debit is ${invoiceRecord.status}`,
        tag: 'INVOICE_AUTODEBIT_IN_PROCESS',
        meta: { invoiceId: invoiceRecord.id, status: invoiceRecord.status },
        html: `<div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
          <div style="background:#E7F6F0;border:1px solid #BFE6D5;color:#075B40;padding:12px 16px;border-radius:8px;font-weight:600;margin-bottom:16px">
            No action required — Auto-debit initiated from ${customer.bankName || 'Bank'} •••• ${customer.accountLast4}
          </div>
          <h2 style="margin:0 0 6px;color:#0a1220">Invoice #${invoiceRecord.number} — $${invoiceRecord.amount.toFixed(2)}</h2>
          <p style="color:#475467;margin:0 0 16px">Billed to <b>${customer.businessName}</b> · Memo: ${invoiceRecord.description}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
            <tr><td style="padding:8px 0;border-bottom:1px solid #eaecf0;color:#667085">Payment Status</td><td style="padding:8px 0;border-bottom:1px solid #eaecf0;text-align:right;font-weight:600;color:#0B8F63">${invoiceRecord.status} (ACH Auto-Debit)</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #eaecf0;color:#667085">Debited Account</td><td style="padding:8px 0;border-bottom:1px solid #eaecf0;text-align:right">${customer.bankName || 'Bank'} •••• ${customer.accountLast4}</td></tr>
            <tr><td style="padding:8px 0;color:#667085">Estimated Settlement</td><td style="padding:8px 0;text-align:right">3–4 business days</td></tr>
          </table>
          <p style="color:#667085;font-size:12.5px;margin:0">We will automatically email you a final receipt once the ACH transfer settles (status = PAID).</p>
        </div>`
      });

      saveState(state);
      return jsonResponse(200, { invoice: invoiceRecord });
    }

    // 9. Admin Send Outbound Payout (POST /v3/check/digital)
    if (method === 'POST' && rawPath === '/admin/payout') {
      const { customerId, recipientName, recipientEmail, amount, description } = body;
      let name = String(recipientName || '').trim();
      let recipient = String(recipientEmail || '').trim();
      let emailToNotify = recipient;

      if (customerId) {
        const cust = state.customers.find(c => c.id === customerId);
        if (cust) {
          name = cust.businessName;
          recipient = cust.email;
          emailToNotify = cust.email;
        }
      }
      if (!name || !recipient || !amount || Number(amount) <= 0) {
        return jsonResponse(400, { error: 'Provide recipient name, email, and a valid payout amount.' });
      }

      const result = await sendPayout(state, { name, recipient, amount, description });
      const payoutRecord = {
        id: result.check_id,
        number: result.number,
        name,
        recipient,
        amount: Number(parseFloat(amount).toFixed(2)),
        description: description || 'Payout',
        status: result.status,
        live: result.live,
        createdAt: new Date().toISOString()
      };
      state.payouts.unshift(payoutRecord);

      if (emailToNotify && emailToNotify.includes('@')) {
        await sendCustomerEmail(state, {
          to: emailToNotify,
          subject: `${state.config.brandName}: Payout of $${payoutRecord.amount.toFixed(2)} sent to ${name}`,
          tag: 'PAYOUT_SENT',
          meta: { checkId: payoutRecord.id, status: payoutRecord.status },
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
            <h2 style="margin:0 0 8px;color:#0a1220">You have received a payment of $${payoutRecord.amount.toFixed(2)}</h2>
            <p style="color:#475467;line-height:1.5">${state.config.brandName} sent a payout (#${payoutRecord.number}) to <b>${name}</b>.</p>
            <p style="color:#475467;line-height:1.5">Memo: <b>${payoutRecord.description}</b> · Status: <b>${payoutRecord.status}</b></p>
          </div>`
        });
      }

      saveState(state);
      return jsonResponse(200, { payout: payoutRecord });
    }

    // 10. Save / Update Admin Keys & Email Settings
    if (method === 'POST' && rawPath === '/admin/config') {
      const fields = [
        'brandName',
        'checkbookEnv',
        'checkbookKey',
        'checkbookSecret',
        'webhookSecret',
        'smtpHost',
        'smtpPort',
        'smtpUser',
        'smtpPass',
        'fromEmail',
        'brevoApiKey'
      ];
      fields.forEach(f => {
        if (body[f] !== undefined && body[f] !== '__KEEP__') {
          state.config[f] = String(body[f]).trim();
        }
      });
      saveState(state);
      return jsonResponse(200, { ok: true, message: 'Settings saved.' });
    }

    // 11. Checkbook Webhook Receiver (POST /webhook/checkbook or /api/webhook/checkbook)
    if (method === 'POST' && (rawPath === '/webhook/checkbook' || rawPath === '/admin/simulate-webhook')) {
      const sigHeader = (event.headers && (event.headers.signature || event.headers.Signature)) || '';
      const sigCheck = rawPath === '/admin/simulate-webhook'
        ? { verified: true, note: 'Simulated webhook trigger from Admin' }
        : verifyWebhookSignature(event.body || '', sigHeader, state.config.webhookSecret);

      if (!sigCheck.verified) {
        return jsonResponse(401, { error: 'Invalid webhook signature', detail: sigCheck.note });
      }

      const evtType = String(body.type || 'INVOICE').toUpperCase();
      const evtStatus = String(body.status || 'PAID').toUpperCase();
      const evtId = String(body.id || '');

      let matchedEntity = null;

      if (evtType === 'ACCOUNT') {
        const cust = state.customers.find(c => c.bank_id === evtId || c.user_id === body.user_id);
        if (cust) {
          cust.bankStatus = evtStatus;
          matchedEntity = `Customer ${cust.businessName} bank -> ${evtStatus}`;
        }
      } else if (evtType === 'INVOICE') {
        const inv = state.invoices.find(i => i.id === evtId || i.payment_id === evtId) || state.invoices[0];
        if (inv) {
          inv.status = evtStatus;
          matchedEntity = `Invoice #${inv.number} ($${inv.amount.toFixed(2)}) -> ${evtStatus}`;
          await sendCustomerEmail(state, {
            to: inv.email,
            subject: `Invoice #${inv.number} Payment Status Update: ${evtStatus}`,
            tag: `INVOICE_${evtStatus}`,
            meta: { invoiceId: inv.id, status: evtStatus },
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
              <h2 style="margin:0 0 8px;color:#0a1220">Invoice #${inv.number} Status: ${evtStatus}</h2>
              <p style="color:#475467;line-height:1.5">The automatic ACH payment of <b>$${inv.amount.toFixed(2)}</b> for <b>${inv.businessName}</b> (Account •••• ${inv.accountLast4}) is now <b>${evtStatus}</b>.</p>
            </div>`
          });
        }
      } else if (evtType === 'CHECK') {
        const chk = state.payouts.find(p => p.id === evtId) || state.payouts[0];
        if (chk) {
          chk.status = evtStatus;
          matchedEntity = `Payout #${chk.number} ($${chk.amount.toFixed(2)}) -> ${evtStatus}`;
        }
      }

      const hookEntry = {
        id: 'wh_' + crypto.randomBytes(5).toString('hex'),
        ts: new Date().toISOString(),
        type: evtType,
        status: evtStatus,
        resourceId: evtId || 'sim_id',
        sigNote: sigCheck.note,
        matchedEntity: matchedEntity || 'Logged event'
      };
      state.webhooks.unshift(hookEntry);
      state.webhooks = state.webhooks.slice(0, 50);

      saveState(state);
      return jsonResponse(200, { ok: true, webhook: hookEntry });
    }

    return jsonResponse(404, { error: `Unknown API route: ${method} ${rawPath}` });
  } catch (err) {
    console.error('API Error:', err);
    saveState(state);
    return jsonResponse(500, { error: err.message || 'Internal server error' });
  }
};
