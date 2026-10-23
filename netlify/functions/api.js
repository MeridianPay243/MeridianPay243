const crypto = require('crypto');
const {
  loadState,
  saveState,
  encryptText,
  decryptText,
  createAdminToken,
  verifyAdminToken
} = require('./_lib/store');
const {
  verifyCheckbookConnection,
  syncWithCheckbookDashboard,
  createGuestMarketplaceUser,
  listInstitutionsForCustomer,
  linkBankViaCheckbookIAV,
  linkBankViaMicrodeposits,
  verifyMicrodeposits,
  issueAndAutoDebitInvoice,
  sendOutboundDigitalCheck,
  verifyWebhookSignature
} = require('./_lib/checkbook');
const {
  sendCustomerEmail,
  verifyAndSendTestEmail,
  emailBankPendingTemplate,
  emailInvoiceAutoDebitInitiatedTemplate,
  emailInvoicePaidWebhookTemplate,
  emailPayoutSentTemplate,
  emailVerificationInviteTemplate
} = require('./_lib/mailer');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token, signature',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify(payload)
  };
}

function getRoute(event) {
  let p = event.path || '/';
  p = p.replace(/^\/\.netlify\/functions\/api/, '');
  p = p.replace(/^\/api/, '');
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

function sanitizeCustomer(c) {
  if (!c) return null;
  const { encrypted_key, encrypted_secret, ...rest } = c;
  return {
    ...rest,
    hasStoredKeys: Boolean(encrypted_key && encrypted_secret)
  };
}

function extractAdminToken(event) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return headers['x-admin-token'] || headers['X-Admin-Token'] || '';
}

async function ensureMarketplaceUserKeys(state, customer) {
  if (customer.encrypted_key && customer.encrypted_secret) {
    return {
      custKey: decryptText(customer.encrypted_key),
      custSecret: decryptText(customer.encrypted_secret)
    };
  }
  const slug = customer.email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'guest';
  const user_id = customer.user_id || `cust_${slug}_${crypto.randomBytes(2).toString('hex')}`;
  const cbUser = await createGuestMarketplaceUser(state, {
    businessName: customer.businessName,
    email: customer.email,
    user_id
  });
  customer.user_id = cbUser.user_id || user_id;
  customer.checkbook_user_uuid = cbUser.id;
  customer.encrypted_key = encryptText(cbUser.key);
  customer.encrypted_secret = encryptText(cbUser.secret);
  saveState(state);
  return { custKey: cbUser.key, custSecret: cbUser.secret };
}

function computeLimitsAndVolumes(state) {
  const cfg = state.config || {};
  const perTxLimit = Number(cfg.perTxLimit || 2000);
  const dailyLimit = Number(cfg.dailyLimit || 2000);
  const monthlyLimit = Number(cfg.monthlyLimit || 15000);

  const invoices = Array.isArray(state.invoices) ? state.invoices : [];
  const payouts = Array.isArray(state.payouts) ? state.payouts : [];

  const totalInvoicedVolume = invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const unpaidVolume = invoices
    .filter(i => !i.status || i.status === 'UNPAID')
    .reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const inProcessVolume = invoices
    .filter(i => i.status === 'IN_PROCESS')
    .reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const paidVolume = invoices
    .filter(i => i.status === 'PAID')
    .reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const outboundPayoutsVolume = payouts.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // Daily (GMT YYYY-MM-DD) & Monthly (GMT YYYY-MM) volume tracking across active payments & invoices
  const nowIso = new Date().toISOString();
  const todayPrefix = nowIso.slice(0, 10); // YYYY-MM-DD
  const monthPrefix = nowIso.slice(0, 7);  // YYYY-MM

  const allTx = [
    ...invoices.map(i => ({ amount: Number(i.amount) || 0, date: String(i.createdAt || ''), status: i.status })),
    ...payouts.map(p => ({ amount: Number(p.amount) || 0, date: String(p.createdAt || ''), status: p.status }))
  ];

  const dailyUsedVolume = allTx
    .filter(t => t.date.startsWith(todayPrefix) && (t.status === 'IN_PROCESS' || t.status === 'PAID'))
    .reduce((s, t) => s + t.amount, 0);

  const dailyInvoicedOrActiveVolume = allTx
    .filter(t => t.date.startsWith(todayPrefix))
    .reduce((s, t) => s + t.amount, 0);

  const monthlyUsedVolume = allTx
    .filter(t => t.date.startsWith(monthPrefix))
    .reduce((s, t) => s + t.amount, 0);

  return {
    perTxLimit,
    dailyLimit,
    monthlyLimit,
    totalInvoicedVolume,
    unpaidVolume,
    inProcessVolume,
    paidVolume,
    outboundPayoutsVolume,
    totalCombinedVolume: totalInvoicedVolume + outboundPayoutsVolume,
    dailyUsedVolume,
    dailyInvoicedOrActiveVolume,
    dailyRemainingVolume: Math.max(0, dailyLimit - dailyUsedVolume),
    dailyPercent: dailyLimit > 0 ? Math.min(100, Number(((dailyUsedVolume / dailyLimit) * 100).toFixed(1))) : 0,
    monthlyUsedVolume,
    monthlyRemainingVolume: Math.max(0, monthlyLimit - monthlyUsedVolume),
    monthlyPercent: monthlyLimit > 0 ? Math.min(100, Number(((monthlyUsedVolume / monthlyLimit) * 100).toFixed(1))) : 0
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return json(200, { ok: true });
  }

  const route = getRoute(event);
  const method = event.httpMethod || 'GET';
  const rawBody = event.body || '';
  let body = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      body = {};
    }
  }

  const state = loadState();
  const brandName = state.config.brandName || 'Meridian Pay';

  try {
    // 0. Public Brand Config for Guest Home Page (No Secrets)
    if (method === 'GET' && route === '/public/config') {
      return json(200, {
        brandName,
        checkbookEnv: state.config.checkbookEnv || 'sandbox'
      });
    }

    // 0B. Admin Login Endpoint (Koaa0@hotmail.com / 243@love)
    if (method === 'POST' && route === '/admin/login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const expectedEmail = String(state.config.adminEmail || 'Koaa0@hotmail.com').trim().toLowerCase();
      const expectedPass = String(state.config.adminPassword || '243@love');

      if (!email || !password || email !== expectedEmail || password !== expectedPass) {
        return json(401, { error: 'Invalid admin email or password.' });
      }

      const token = createAdminToken(state);
      return json(200, {
        ok: true,
        token,
        adminEmail: state.config.adminEmail || 'Koaa0@hotmail.com',
        brandName
      });
    }

    // Protect all /admin/* endpoints with Admin Authentication
    if (route.startsWith('/admin/')) {
      const token = extractAdminToken(event);
      if (!verifyAdminToken(token, state)) {
        return json(401, { error: 'Admin authentication required. Please sign in.' });
      }
    }

    // 1. Guest Step 1: Business Name + Email ONLY -> POST /v3/user
    if (method === 'POST' && route === '/guest/start') {
      const businessName = (body.businessName || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      if (!businessName || !email || !email.includes('@')) {
        return json(400, { error: 'Please provide both Business Name and a valid Email.' });
      }

      if (!state.config.lastDashboardSyncAt) {
        await syncWithCheckbookDashboard(state);
      }

      let existing = state.customers.find(c => c.email.toLowerCase() === email);
      if (existing) {
        existing.businessName = businessName;
        saveState(state);
        return json(200, { customer: sanitizeCustomer(existing), reused: true });
      }

      const slug = email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'guest';
      const user_id = `cust_${slug}_${crypto.randomBytes(2).toString('hex')}`;
      const cbUser = await createGuestMarketplaceUser(state, { businessName, email, user_id });

      const customer = {
        id: 'cust_' + crypto.randomBytes(5).toString('hex'),
        token: 'tok_' + crypto.randomBytes(8).toString('hex'),
        businessName,
        email,
        user_id: cbUser.user_id || user_id,
        checkbook_user_uuid: cbUser.id,
        encrypted_key: encryptText(cbUser.key),
        encrypted_secret: encryptText(cbUser.secret),
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
      return json(200, { customer: sanitizeCustomer(customer), reused: false });
    }

    // 2. Load guest session by token (for magic link return or personalized Checkbook directory link)
    if (method === 'GET' && route === '/guest/session') {
      const token = (event.queryStringParameters && event.queryStringParameters.token) || '';
      let customer = state.customers.find(c => c.token === token);
      if (!customer && token.startsWith('tok_cb_')) {
        await syncWithCheckbookDashboard(state);
        saveState(state);
        customer = state.customers.find(c => c.token === token);
      }
      if (!customer) {
        return json(404, { error: 'Guest verification session not found.' });
      }
      return json(200, { customer: sanitizeCustomer(customer), brandName });
    }

    // 3. List institutions for Checkbook IAV (GET /v3/account/bank/institutions)
    if (method === 'GET' && route === '/bank/institutions') {
      const token = (event.queryStringParameters && event.queryStringParameters.token) || '';
      const customer = state.customers.find(c => c.token === token) || state.customers[0];
      const custKey = customer ? decryptText(customer.encrypted_key) : '';
      const custSecret = customer ? decryptText(customer.encrypted_secret) : '';
      const inst = await listInstitutionsForCustomer(state, custKey, custSecret);
      saveState(state);
      return json(200, inst);
    }

    // 4. Link bank via Checkbook Built-in IAV (POST /v3/account/bank/iav -> POST /v3/account/bank)
    if (method === 'POST' && route === '/bank/iav') {
      const { token, institution_id, institution_name, login, password, type } = body;
      const customer = state.customers.find(c => c.token === token);
      if (!customer) return json(404, { error: 'Guest session not found.' });

      const { custKey, custSecret } = await ensureMarketplaceUserKeys(state, customer);

      const res = await linkBankViaCheckbookIAV(state, custKey, custSecret, {
        institution_id: institution_id || 'c7b3cb4a243a4427b2bd12871d8f6deb',
        institution_name: institution_name || 'JPMorgan Chase Bank',
        login: login || 'user_good',
        password: password || 'pass_good',
        type: type || 'BUSINESS'
      });

      if (!res.ok) {
        saveState(state);
        return json(res.status || 400, { error: res.error });
      }

      customer.bank_id = res.bank.id;
      customer.bankName = res.bank.name;
      customer.routing = res.bank.routing;
      customer.accountLast4 = res.bank.accountLast4;
      customer.accountType = res.bank.type;
      customer.verificationMethod = 'CHECKBOOK_IAV';
      customer.bankStatus = 'VERIFIED';

      saveState(state);
      return json(200, { customer: sanitizeCustomer(customer) });
    }

    // 5. Link bank via Manual Routing + Account (Micro-deposits: POST /v3/account/bank + /release)
    if (method === 'POST' && route === '/bank/manual') {
      const { token, routing, account, bankName, type, origin } = body;
      const customer = state.customers.find(c => c.token === token);
      if (!customer) return json(404, { error: 'Guest session not found.' });

      const cleanRouting = String(routing || '').replace(/\D/g, '');
      const cleanAccount = String(account || '').replace(/\D/g, '');
      if (cleanRouting.length !== 9 || cleanAccount.length < 4) {
        return json(400, { error: 'Please enter a valid 9-digit ABA routing number and account number.' });
      }

      const { custKey, custSecret } = await ensureMarketplaceUserKeys(state, customer);

      const res = await linkBankViaMicrodeposits(state, custKey, custSecret, {
        routing: cleanRouting,
        account: cleanAccount,
        type: type || 'BUSINESS',
        bankName: bankName || 'Business Checking Account'
      });

      if (!res.ok) {
        saveState(state);
        return json(res.status || 400, { error: res.error });
      }

      customer.bank_id = res.bank.id;
      customer.bankName = res.bank.name;
      customer.routing = res.bank.routing;
      customer.accountLast4 = res.bank.accountLast4;
      customer.accountType = res.bank.type;
      customer.verificationMethod = 'MICRODEPOSITS';
      customer.bankStatus = 'PENDING';
      customer.attemptsRemaining = 3;

      const baseOrigin = origin || 'https://meridianpay243.onrender.com';
      const verifyUrl = `${baseOrigin}/?token=${customer.token}`;

      const emailRec = await sendCustomerEmail(state, {
        to: customer.email,
        subject: `Confirm your 2 micro-deposits for account •••• ${customer.accountLast4}`,
        tag: 'MICRODEPOSITS_RELEASED',
        meta: { verifyUrl, customerId: customer.id },
        html: emailBankPendingTemplate({
          brandName,
          businessName: customer.businessName,
          verifyUrl,
          accountLast4: customer.accountLast4
        })
      });

      saveState(state);
      return json(200, {
        customer: sanitizeCustomer(customer),
        verifyUrl,
        emailSent: emailRec
      });
    }

    // 6. Confirm two micro-deposit amounts (POST /v3/account/bank/verify)
    if (method === 'POST' && route === '/bank/verify') {
      const { token, amount_1, amount_2 } = body;
      const customer = state.customers.find(c => c.token === token);
      if (!customer) return json(404, { error: 'Guest session not found.' });
      if (!customer.bank_id) return json(400, { error: 'No pending bank account found.' });

      const custKey = decryptText(customer.encrypted_key);
      const custSecret = decryptText(customer.encrypted_secret);

      const res = await verifyMicrodeposits(state, custKey, custSecret, {
        bank_id: customer.bank_id,
        amount_1,
        amount_2
      });

      if (!res.ok) {
        customer.attemptsRemaining = Math.max(0, (customer.attemptsRemaining || 3) - 1);
        saveState(state);
        return json(res.status || 400, {
          error: res.error,
          attemptsRemaining: customer.attemptsRemaining
        });
      }

      customer.bankStatus = 'VERIFIED';
      saveState(state);
      return json(200, { customer: sanitizeCustomer(customer) });
    }

    // 7. Admin Portal State (Protected by Admin Auth)
    if (method === 'GET' && route === '/admin/state') {
      let needsSave = false;
      if (!state.config.lastVerification) {
        await verifyCheckbookConnection(state);
        needsSave = true;
      }
      if (!state.config.lastDashboardSyncAt) {
        await syncWithCheckbookDashboard(state);
        needsSave = true;
      }
      if (needsSave) saveState(state);

      return json(200, {
        config: {
          brandName: state.config.brandName,
          checkbookEnv: state.config.checkbookEnv,
          hasLiveCheckbookKeys: Boolean(state.config.checkbookKey && state.config.checkbookSecret),
          checkbookKeyPreview: state.config.checkbookKey ? state.config.checkbookKey.slice(0, 6) + '••••' : '',
          hasWebhookSecret: Boolean(state.config.webhookSecret),
          webhookSecretPreview: state.config.webhookSecret ? state.config.webhookSecret.slice(0, 4) + '••••' : '',
          lastVerification: state.config.lastVerification || null,
          lastDashboardSyncAt: state.config.lastDashboardSyncAt || null,
          smtpHost: state.config.smtpHost || 'smtp.gmail.com',
          smtpPort: state.config.smtpPort || '587',
          smtpUser: state.config.smtpUser || 'efugduhfr@gmail.com',
          fromEmail: state.config.fromEmail || state.config.smtpUser || 'efugduhfr@gmail.com',
          hasSmtpPass: Boolean(state.config.smtpPass),
          adminEmail: state.config.adminEmail || 'Koaa0@hotmail.com',
          perTxLimit: Number(state.config.perTxLimit || 2000),
          dailyLimit: Number(state.config.dailyLimit || 2000),
          monthlyLimit: Number(state.config.monthlyLimit || 15000)
        },
        limitsAndVolumes: computeLimitsAndVolumes(state),
        customers: state.customers.map(sanitizeCustomer),
        invoices: state.invoices,
        payouts: state.payouts,
        emails: state.emails,
        webhooks: state.webhooks,
        apiLogs: state.apiLogs
      });
    }

    // 7B. Manual Re-Sync from Checkbook Dashboard (Directory + Invoices)
    if (method === 'POST' && route === '/admin/sync-checkbook') {
      const syncResult = await syncWithCheckbookDashboard(state);
      saveState(state);
      return json(200, {
        ok: true,
        ...syncResult,
        message: `Synced from Checkbook Dashboard (${syncResult.syncedCustomers} new customer(s), ${syncResult.syncedInvoices} new invoice(s)).`
      });
    }

    // 7C. 1-Click Send Verification Link & Custom Memo to Selected Unverified Customers via Email
    if (method === 'POST' && route === '/admin/send-verification-invites') {
      const { customerIds, memo, origin } = body;
      const baseOrigin = (origin || 'https://meridianpay243.onrender.com').replace(/\/$/, '');
      const cleanMemo = String(memo || 'Please verify your business bank account via our secure guest portal so we can process your billing automatically.').trim();

      let targets = [];
      if (Array.isArray(customerIds) && customerIds.includes('ALL_UNVERIFIED')) {
        targets = state.customers.filter(c => c.bankStatus !== 'VERIFIED');
      } else if (Array.isArray(customerIds) && customerIds.length > 0) {
        targets = state.customers.filter(c => customerIds.includes(c.id));
      } else {
        return json(400, { error: 'Please select at least one unverified customer to email.' });
      }

      if (targets.length === 0) {
        return json(400, { error: 'No matching unverified customers found.' });
      }

      const results = [];
      for (const cust of targets) {
        const verifyUrl = `${baseOrigin}/?token=${cust.token}`;
        const unpaidInvoice = state.invoices.find(
          i => (i.customerId === cust.id || String(i.email || '').toLowerCase() === cust.email.toLowerCase()) && i.status === 'UNPAID'
        );

        const subject = unpaidInvoice
          ? `Action Required: Verify Bank Account for Invoice #${unpaidInvoice.number} ($${Number(unpaidInvoice.amount).toFixed(2)})`
          : `Action Required: Verify Your Business Bank Account with ${brandName}`;

        const emailRec = await sendCustomerEmail(state, {
          to: cust.email,
          subject,
          tag: 'BANK_VERIFICATION_INVITE',
          meta: {
            customerId: cust.id,
            verifyUrl,
            memo: cleanMemo,
            invoiceNumber: unpaidInvoice ? unpaidInvoice.number : null
          },
          html: emailVerificationInviteTemplate({
            brandName,
            businessName: cust.businessName,
            verifyUrl,
            memo: cleanMemo,
            unpaidInvoice
          })
        });

        cust.lastInviteSentAt = new Date().toISOString();
        cust.lastInviteMemo = cleanMemo;
        results.push({
          customerId: cust.id,
          businessName: cust.businessName,
          email: cust.email,
          verifyUrl,
          transport: emailRec.transport
        });
      }

      saveState(state);
      return json(200, {
        ok: true,
        sentCount: results.length,
        results,
        message: `Verification link & memo sent to ${results.length} customer(s): ${results.map(r => `${r.businessName} (${r.email})`).join(', ')}`
      });
    }

    // 8. Owner Issues Invoice & Auto-Debits Verified Bank Immediately
    if (method === 'POST' && route === '/admin/invoice-autodebit') {
      const { customerId, amount, description } = body;
      const customer = state.customers.find(c => c.id === customerId);
      if (!customer) return json(404, { error: 'Customer not found.' });
      if (customer.bankStatus !== 'VERIFIED') {
        return json(400, { error: 'Customer bank must be VERIFIED before issuing an auto-debit invoice.' });
      }

      const numAmount = Number(amount);
      if (!numAmount || numAmount <= 0) {
        return json(400, { error: 'Enter a valid invoice amount greater than $0.' });
      }

      const invoiceNumber = `INV-${2040 + state.invoices.length + 1}`;
      const custKey = decryptText(customer.encrypted_key);
      const custSecret = decryptText(customer.encrypted_secret);

      const res = await issueAndAutoDebitInvoice(state, {
        customer,
        custKey,
        custSecret,
        amount: numAmount,
        description: description || 'Commercial Service Agreement',
        invoiceNumber
      });

      if (!res.ok) {
        saveState(state);
        return json(res.status || 400, { error: res.error });
      }

      const invoiceRecord = {
        id: res.invoice_id,
        payment_id: res.payment_id,
        number: invoiceNumber,
        customerId: customer.id,
        businessName: customer.businessName,
        email: customer.email,
        user_id: customer.user_id,
        accountLast4: customer.accountLast4,
        amount: numAmount,
        description: description || 'Commercial Service Agreement',
        status: res.status || 'IN_PROCESS',
        createdAt: new Date().toISOString()
      };

      state.invoices.unshift(invoiceRecord);

      const emailRec = await sendCustomerEmail(state, {
        to: customer.email,
        subject: `Invoice #${invoiceNumber} ($${numAmount.toFixed(2)}) Auto-Debit Initiated (${invoiceRecord.status})`,
        tag: `INVOICE_${invoiceRecord.status}`,
        meta: { invoiceId: invoiceRecord.id },
        html: emailInvoiceAutoDebitInitiatedTemplate({
          brandName,
          businessName: customer.businessName,
          invoiceNumber,
          amount: numAmount,
          description: invoiceRecord.description,
          accountLast4: customer.accountLast4,
          status: invoiceRecord.status,
          checkbookPaymentId: invoiceRecord.payment_id
        })
      });

      saveState(state);
      return json(200, { invoice: invoiceRecord, emailSent: emailRec });
    }

    // 9. Owner Sends Outbound Payment (POST /v3/check/digital)
    if (method === 'POST' && route === '/admin/payout') {
      const { recipientName, recipientEmail, customerId, amount, description } = body;
      const numAmount = Number(amount);
      if (!numAmount || numAmount <= 0) {
        return json(400, { error: 'Enter a valid payout amount greater than $0.' });
      }

      let recipient = (recipientEmail || '').trim();
      let name = (recipientName || '').trim();
      let account = undefined;

      if (customerId) {
        const cust = state.customers.find(c => c.id === customerId);
        if (cust) {
          recipient = cust.email;
          name = cust.businessName;
          if (cust.bank_id && cust.bankStatus === 'VERIFIED') {
            account = cust.bank_id;
          }
        }
      }

      if (!recipient || !name) {
        return json(400, { error: 'Provide recipient name and email (or select a verified customer).' });
      }

      const res = await sendOutboundDigitalCheck(state, {
        recipient,
        name,
        amount: numAmount,
        description: description || 'Vendor / Contractor Payout',
        account
      });

      if (!res.ok) {
        saveState(state);
        return json(res.status || 400, { error: res.error });
      }

      const payoutRecord = {
        id: res.check.id,
        number: res.check.number,
        name,
        recipient,
        amount: numAmount,
        description: description || 'Vendor / Contractor Payout',
        status: res.check.status || 'IN_PROCESS',
        directDepositBankId: account || null,
        createdAt: new Date().toISOString()
      };

      state.payouts.unshift(payoutRecord);

      await sendCustomerEmail(state, {
        to: recipient,
        subject: ` sent you a payment of $${numAmount.toFixed(2)} (${payoutRecord.status})`,
        tag: `PAYOUT_${payoutRecord.status}`,
        meta: { checkId: payoutRecord.id },
        html: emailPayoutSentTemplate({
          brandName,
          recipientName: name,
          amount: numAmount,
          description: payoutRecord.description,
          checkId: payoutRecord.id,
          status: payoutRecord.status
        })
      });

      saveState(state);
      return json(200, { payout: payoutRecord });
    }

    // 10. Save Admin Settings (Checkbook keys & Gmail SMTP settings)
    if (method === 'POST' && route === '/admin/config') {
      const {
        brandName: newBrand,
        checkbookEnv,
        checkbookKey,
        checkbookSecret,
        webhookSecret,
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPass,
        fromEmail
      } = body;

      if (typeof newBrand === 'string' && newBrand.trim()) state.config.brandName = newBrand.trim();
      if (checkbookEnv === 'sandbox' || checkbookEnv === 'production') state.config.checkbookEnv = checkbookEnv;
      if (typeof checkbookKey === 'string' && checkbookKey.trim()) state.config.checkbookKey = checkbookKey.trim();
      if (typeof checkbookSecret === 'string' && checkbookSecret.trim()) state.config.checkbookSecret = checkbookSecret.trim();
      if (typeof webhookSecret === 'string' && webhookSecret.trim()) state.config.webhookSecret = webhookSecret.trim();
      if (typeof smtpHost === 'string' && smtpHost.trim()) state.config.smtpHost = smtpHost.trim();
      if (typeof smtpPort === 'string' && smtpPort.trim()) state.config.smtpPort = smtpPort.trim();
      if (typeof smtpUser === 'string' && smtpUser.trim()) {
        state.config.smtpUser = smtpUser.trim();
        state.config.fromEmail = (typeof fromEmail === 'string' && fromEmail.trim()) ? fromEmail.trim() : smtpUser.trim();
      } else if (typeof fromEmail === 'string' && fromEmail.trim()) {
        state.config.fromEmail = fromEmail.trim();
      }
      if (typeof smtpPass === 'string' && smtpPass.trim()) {
        state.config.smtpPass = smtpPass.replace(/\s+/g, '');
      }
      if (body.perTxLimit !== undefined && Number(body.perTxLimit) > 0) {
        state.config.perTxLimit = Number(body.perTxLimit);
      }
      if (body.dailyLimit !== undefined && Number(body.dailyLimit) > 0) {
        state.config.dailyLimit = Number(body.dailyLimit);
      }
      if (body.monthlyLimit !== undefined && Number(body.monthlyLimit) > 0) {
        state.config.monthlyLimit = Number(body.monthlyLimit);
      }

      const verification = await verifyCheckbookConnection(state);
      saveState(state);
      return json(200, {
        ok: true,
        message: verification.apiConnected
          ? `Saved & verified! ${verification.apiStatusMessage}`
          : 'Settings saved.',
        verification
      });
    }

    // 10A. Live Test & Verify Checkbook API + Webhook Connection
    if (method === 'POST' && route === '/admin/verify-checkbook') {
      const { checkbookEnv, checkbookKey, checkbookSecret, webhookSecret, brandName: newBrand } = body;
      if (typeof newBrand === 'string' && newBrand.trim()) state.config.brandName = newBrand.trim();
      if (checkbookEnv === 'sandbox' || checkbookEnv === 'production') state.config.checkbookEnv = checkbookEnv;
      if (typeof checkbookKey === 'string' && checkbookKey.trim()) state.config.checkbookKey = checkbookKey.trim();
      if (typeof checkbookSecret === 'string' && checkbookSecret.trim()) state.config.checkbookSecret = checkbookSecret.trim();
      if (typeof webhookSecret === 'string' && webhookSecret.trim()) state.config.webhookSecret = webhookSecret.trim();

      const verification = await verifyCheckbookConnection(state);
      state.webhooks.unshift({
        id: 'wh_' + crypto.randomBytes(5).toString('hex'),
        ts: new Date().toISOString(),
        type: 'WEBHOOK_SELF_TEST',
        entityId: 'wh_verify_ping',
        status: verification.webhookConnected ? 'VERIFIED' : 'FAILED',
        matchedEntity: verification.hasWebhookSecret ? 'HMAC-SHA256 Signing Key Verified' : 'Endpoint Active (No Signing Key Set)',
        hmacMode: verification.hasWebhookSecret ? 'hmac_sha256_verified' : 'open_no_secret_configured'
      });
      state.webhooks = state.webhooks.slice(0, 40);
      saveState(state);

      return json(200, {
        ok: true,
        verification
      });
    }

    // 10B. Save & Send Live Gmail Test Email
    if (method === 'POST' && route === '/admin/test-smtp') {
      const { smtpHost, smtpPort, smtpUser, smtpPass, fromEmail, testRecipient } = body;
      if (typeof smtpHost === 'string' && smtpHost.trim()) state.config.smtpHost = smtpHost.trim();
      if (typeof smtpPort === 'string' && smtpPort.trim()) state.config.smtpPort = smtpPort.trim();
      if (typeof smtpUser === 'string' && smtpUser.trim()) {
        state.config.smtpUser = smtpUser.trim();
        state.config.fromEmail = (fromEmail || smtpUser).trim();
      }
      if (typeof smtpPass === 'string' && smtpPass.trim()) {
        state.config.smtpPass = smtpPass.replace(/\s+/g, '');
      }
      saveState(state);

      const rec = await verifyAndSendTestEmail(state, testRecipient || state.config.smtpUser);
      saveState(state);
      return json(200, {
        ok: true,
        message: `Test email sent via Gmail SMTP (${state.config.smtpHost}:${state.config.smtpPort}) as "${state.config.brandName}" <${state.config.fromEmail}> to ${rec.to}.`,
        email: rec
      });
    }

    // 11. Checkbook Webhook Receiver (POST /webhook/checkbook) + Admin Webhook Simulator
    if (method === 'POST' && (route === '/webhook/checkbook' || route === '/admin/simulate-webhook')) {
      const sigHeader = (event.headers && (event.headers.signature || event.headers.Signature)) || '';
      const isSimulated = route === '/admin/simulate-webhook';

      let sigCheck = { valid: true, mode: 'simulated_by_admin' };
      if (!isSimulated) {
        sigCheck = verifyWebhookSignature(rawBody, sigHeader, state.config.webhookSecret);
        if (!sigCheck.valid) {
          return json(401, { error: 'Invalid Checkbook webhook HMAC signature', detail: sigCheck.mode });
        }
      }

      const eventType = body.type || 'INVOICE';
      const entityId = body.id || '';
      const newStatus = body.status || 'PAID';

      let matchedEntity = null;
      if (eventType === 'INVOICE') {
        const inv = state.invoices.find(i => i.id === entityId || i.payment_id === entityId) || state.invoices[0];
        if (inv) {
          inv.status = newStatus;
          matchedEntity = `Invoice #${inv.number}`;
          await sendCustomerEmail(state, {
            to: inv.email,
            subject: `Payment Receipt — Invoice #${inv.number} ($${Number(inv.amount).toFixed(2)}) is ${newStatus}`,
            tag: `WEBHOOK_INVOICE_${newStatus}`,
            meta: { invoiceId: inv.id },
            html: emailInvoicePaidWebhookTemplate({
              brandName,
              businessName: inv.businessName,
              invoiceNumber: inv.number,
              amount: inv.amount,
              description: inv.description,
              accountLast4: inv.accountLast4,
              status: newStatus
            })
          });
        }
      } else if (eventType === 'CHECK') {
        const pay = state.payouts.find(p => p.id === entityId) || state.payouts[0];
        if (pay) {
          pay.status = newStatus;
          matchedEntity = `Payout #${pay.number}`;
        }
      } else if (eventType === 'ACCOUNT') {
        const cust = state.customers.find(c => c.bank_id === entityId);
        if (cust) {
          cust.bankStatus = newStatus;
          matchedEntity = `Customer ${cust.businessName}`;
        }
      }

      const whRecord = {
        id: 'wh_' + crypto.randomBytes(5).toString('hex'),
        ts: new Date().toISOString(),
        type: eventType,
        entityId,
        status: newStatus,
        matchedEntity: matchedEntity || entityId,
        hmacMode: sigCheck.mode
      };
      state.webhooks.unshift(whRecord);
      state.webhooks = state.webhooks.slice(0, 40);

      saveState(state);
      return json(200, { received: true, webhook: whRecord });
    }

    return json(404, { error: `Unknown endpoint: ${method} ${route}` });
  } catch (err) {
    return json(500, { error: err.message || 'Internal server error' });
  }
};
