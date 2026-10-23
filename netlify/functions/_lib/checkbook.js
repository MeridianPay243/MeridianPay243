const crypto = require('crypto');
const { logApiCall } = require('./store');

function getBaseUrl(env) {
  if (env === 'production' || env === 'prod') return 'https://checkbook.io/v3';
  if (env === 'demo') return 'https://demo.checkbook.io/v3';
  return 'https://sandbox.checkbook.io/v3';
}

function hasLiveOwnerKeys(config) {
  return Boolean(config && config.checkbookKey && config.checkbookSecret);
}

async function checkbookRequest(state, { method, path, auth, authLabel, body }) {
  const baseUrl = getBaseUrl(state.config.checkbookEnv);
  const url = `${baseUrl}${path}`;
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': auth
  };

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    logApiCall(state, {
      method,
      path,
      authLabel,
      status: res.status,
      ms: Date.now() - start,
      live: true,
      error: res.ok ? null : (data.error || data.message || text.slice(0, 160))
    });
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    logApiCall(state, {
      method,
      path,
      authLabel,
      status: 500,
      ms: Date.now() - start,
      live: true,
      error: err.message
    });
    return { ok: false, status: 500, data: { error: err.message } };
  }
}

// 1. Create Marketplace User (POST /v3/user with Owner key)
async function createMarketplaceUser(state, { businessName, userIdSlug }) {
  if (hasLiveOwnerKeys(state.config)) {
    const ownerAuth = `${state.config.checkbookKey}:${state.config.checkbookSecret}`;
    const res = await checkbookRequest(state, {
      method: 'POST',
      path: '/user',
      auth: ownerAuth,
      authLabel: 'owner key',
      body: { name: businessName, user_id: userIdSlug }
    });
    if (res.ok && res.data && res.data.key && res.data.secret) {
      return {
        live: true,
        id: res.data.id,
        user_id: res.data.user_id || userIdSlug,
        key: res.data.key,
        secret: res.data.secret
      };
    }
    throw new Error(`Checkbook POST /v3/user failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  // Simulated sandbox response when live keys are not entered yet
  const sim = {
    live: false,
    id: crypto.randomBytes(16).toString('hex'),
    user_id: userIdSlug,
    key: 'sim_pub_' + crypto.randomBytes(8).toString('hex'),
    secret: 'sim_sec_' + crypto.randomBytes(12).toString('hex')
  };
  logApiCall(state, {
    method: 'POST',
    path: '/v3/user',
    authLabel: 'owner key (sandbox sim)',
    status: 201,
    ms: 42,
    live: false
  });
  return sim;
}

// 2. Get Supported IAV Institutions (GET /v3/account/bank/institutions)
const DEFAULT_INSTITUTIONS = [
  {
    id: 'ins_chase',
    name: 'JPMorgan Chase Bank',
    routing: '322271627',
    login_form: [
      { name: 'login', description: 'User ID', type: 'TEXT' },
      { name: 'password', description: 'Password', type: 'PASSWORD' }
    ]
  },
  {
    id: 'ins_bofa',
    name: 'Bank of America',
    routing: '026009593',
    login_form: [
      { name: 'login', description: 'Online ID', type: 'TEXT' },
      { name: 'password', description: 'Passcode', type: 'PASSWORD' }
    ]
  },
  {
    id: 'ins_wells',
    name: 'Wells Fargo',
    routing: '121000248',
    login_form: [
      { name: 'login', description: 'Username', type: 'TEXT' },
      { name: 'password', description: 'Password', type: 'PASSWORD' }
    ]
  },
  {
    id: 'ins_citi',
    name: 'Citibank',
    routing: '021000089',
    login_form: [
      { name: 'login', description: 'User ID', type: 'TEXT' },
      { name: 'password', description: 'Password', type: 'PASSWORD' }
    ]
  },
  {
    id: 'ins_usbank',
    name: 'U.S. Bank',
    routing: '122105155',
    login_form: [
      { name: 'login', description: 'Username', type: 'TEXT' },
      { name: 'password', description: 'Password', type: 'PASSWORD' }
    ]
  },
  {
    id: 'ins_pnc',
    name: 'PNC Bank',
    routing: '043000096',
    login_form: [
      { name: 'login', description: 'User ID', type: 'TEXT' },
      { name: 'password', description: 'Password / PIN', type: 'PASSWORD' }
    ]
  }
];

async function getInstitutions(state, userAuth) {
  if (hasLiveOwnerKeys(state.config) && userAuth && !userAuth.startsWith('sim_')) {
    const res = await checkbookRequest(state, {
      method: 'GET',
      path: '/account/bank/institutions',
      auth: userAuth,
      authLabel: 'guest key'
    });
    if (res.ok && Array.isArray(res.data.institutions) && res.data.institutions.length > 0) {
      return res.data.institutions.slice(0, 50);
    }
  }
  return DEFAULT_INSTITUTIONS;
}

// 3. Instant Bank Verification via Checkbook IAV (POST /v3/account/bank/iav + POST /v3/account/bank)
async function instantVerifyBank(state, userAuth, { institution_id, institution_name, login, password, type }) {
  const acctType = ['BUSINESS', 'CHECKING', 'PERSONAL'].includes(type) ? type : 'BUSINESS';

  if (hasLiveOwnerKeys(state.config) && userAuth && !userAuth.startsWith('sim_')) {
    const iavRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank/iav',
      auth: userAuth,
      authLabel: 'guest key',
      body: { institution_id, login, password }
    });
    if (!iavRes.ok) {
      throw new Error(`Checkbook POST /v3/account/bank/iav failed (${iavRes.status}): ${JSON.stringify(iavRes.data)}`);
    }
    const matched = (iavRes.data.accounts && iavRes.data.accounts[0]) || null;
    if (!matched) {
      throw new Error('No bank accounts returned from Checkbook IAV login');
    }

    const addRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank',
      auth: userAuth,
      authLabel: 'guest key',
      body: {
        routing: matched.routing,
        account: matched.account,
        type: acctType,
        name: matched.name || institution_name || 'Verified Bank'
      }
    });
    if (!addRes.ok) {
      throw new Error(`Checkbook POST /v3/account/bank failed (${addRes.status}): ${JSON.stringify(addRes.data)}`);
    }
    return {
      live: true,
      bank_id: addRes.data.id,
      routing: addRes.data.routing || matched.routing,
      accountLast4: String(addRes.data.account || matched.account).replace('-', '').slice(-4),
      bankName: matched.name || institution_name || 'Verified Bank',
      type: addRes.data.type || acctType,
      status: addRes.data.status || 'VERIFIED'
    };
  }

  // Sandbox simulation: Checkbook sandbox accepts user_good / pass_good (or any non-empty credentials in demo)
  if (state.config.checkbookEnv === 'sandbox' && login === 'user_bad') {
    throw new Error('Invalid bank credentials (in Sandbox use user_good / pass_good)');
  }
  const inst = DEFAULT_INSTITUTIONS.find(i => i.id === institution_id) || DEFAULT_INSTITUTIONS[0];
  logApiCall(state, {
    method: 'POST',
    path: '/v3/account/bank/iav',
    authLabel: 'guest key (sandbox sim)',
    status: 200,
    ms: 88,
    live: false
  });
  logApiCall(state, {
    method: 'POST',
    path: '/v3/account/bank',
    authLabel: 'guest key (sandbox sim)',
    status: 201,
    ms: 64,
    live: false
  });
  return {
    live: false,
    bank_id: 'bank_' + crypto.randomBytes(12).toString('hex'),
    routing: inst.routing || '021000021',
    accountLast4: '8076',
    bankName: inst.name,
    type: acctType,
    status: 'VERIFIED'
  };
}

// 4. Manual Routing & Account + Micro-Deposit Release (POST /v3/account/bank + POST /v3/account/bank/release)
async function addManualBankAndRelease(state, userAuth, { routing, account, type, bankName }) {
  const acctType = ['BUSINESS', 'CHECKING', 'PERSONAL'].includes(type) ? type : 'BUSINESS';

  if (hasLiveOwnerKeys(state.config) && userAuth && !userAuth.startsWith('sim_')) {
    const addRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank',
      auth: userAuth,
      authLabel: 'guest key',
      body: { routing, account, type: acctType }
    });
    if (!addRes.ok) {
      throw new Error(`Checkbook POST /v3/account/bank failed (${addRes.status}): ${JSON.stringify(addRes.data)}`);
    }
    const bankId = addRes.data.id;

    // Immediately release micro-deposits so status moves DEPOSIT_ONLY -> PENDING
    const relRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank/release',
      auth: userAuth,
      authLabel: 'guest key',
      body: { account: bankId }
    });
    if (!relRes.ok) {
      throw new Error(`Checkbook POST /v3/account/bank/release failed (${relRes.status}): ${JSON.stringify(relRes.data)}`);
    }

    return {
      live: true,
      bank_id: bankId,
      routing,
      accountLast4: String(addRes.data.account || account).slice(-4),
      bankName: bankName || 'Business Checking',
      type: acctType,
      status: 'PENDING'
    };
  }

  // Sandbox simulation
  logApiCall(state, {
    method: 'POST',
    path: '/v3/account/bank',
    authLabel: 'guest key (sandbox sim)',
    status: 201,
    ms: 53,
    live: false
  });
  logApiCall(state, {
    method: 'POST',
    path: '/v3/account/bank/release',
    authLabel: 'guest key (sandbox sim)',
    status: 200,
    ms: 49,
    live: false
  });

  return {
    live: false,
    bank_id: 'bank_' + crypto.randomBytes(12).toString('hex'),
    routing,
    accountLast4: String(account).slice(-4),
    bankName: bankName || 'Business Checking',
    type: acctType,
    status: 'PENDING'
  };
}

// 5. Verify Micro-Deposit Amounts (POST /v3/account/bank/verify)
async function verifyMicroDeposits(state, userAuth, { bank_id, amount_1, amount_2 }) {
  const a1 = Number(parseFloat(amount_1).toFixed(2));
  const a2 = Number(parseFloat(amount_2).toFixed(2));

  if (hasLiveOwnerKeys(state.config) && userAuth && !userAuth.startsWith('sim_')) {
    const verRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank/verify',
      auth: userAuth,
      authLabel: 'guest key',
      body: { account: bank_id, amount_1: a1, amount_2: a2 }
    });
    if (!verRes.ok) {
      throw new Error(`Checkbook POST /v3/account/bank/verify failed (${verRes.status}): ${JSON.stringify(verRes.data)}`);
    }
    return { live: true, status: 'VERIFIED' };
  }

  // Sandbox rule: amounts are always 0.07 and 0.15
  const validPair = (a1 === 0.07 && a2 === 0.15) || (a1 === 0.15 && a2 === 0.07);
  logApiCall(state, {
    method: 'POST',
    path: '/v3/account/bank/verify',
    authLabel: 'guest key (sandbox sim)',
    status: validPair ? 200 : 400,
    ms: 46,
    live: false,
    error: validPair ? null : 'Microdeposit amounts did not match (expected 0.07 and 0.15 in Sandbox)'
  });

  if (!validPair) {
    throw new Error('Incorrect micro-deposit amounts. In Sandbox, enter 0.07 and 0.15.');
  }
  return { live: false, status: 'VERIFIED' };
}

// 6. Admin 1-Click Issue & Auto-Debit Invoice:
//    Call 1 (Owner key): POST /v3/invoice { name, recipient: customer.user_id, amount, description }
//    Call 2 (Guest key): POST /v3/invoice/payment { id: invoice.id, amount, account: customer.bank_id }
async function issueAndAutoDebitInvoice(state, { customer, userAuth, amount, description }) {
  const numericAmount = Number(parseFloat(amount).toFixed(2));

  if (hasLiveOwnerKeys(state.config) && userAuth && !userAuth.startsWith('sim_')) {
    const ownerAuth = `${state.config.checkbookKey}:${state.config.checkbookSecret}`;

    // Step A: Create invoice assigned to customer's marketplace user_id
    const invRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/invoice',
      auth: ownerAuth,
      authLabel: 'owner key',
      body: {
        name: customer.businessName,
        recipient: customer.user_id,
        description,
        amount: numericAmount
      }
    });
    if (!invRes.ok) {
      throw new Error(`Checkbook POST /v3/invoice failed (${invRes.status}): ${JSON.stringify(invRes.data)}`);
    }

    const invoiceId = invRes.data.id;
    const invoiceNumber = invRes.data.number || String(Math.floor(1000 + Math.random() * 9000));

    // Step B: Immediately pay/debit the invoice using the customer's stored credentials & verified bank_id
    const payRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/invoice/payment',
      auth: userAuth,
      authLabel: 'guest key',
      body: {
        id: invoiceId,
        amount: numericAmount,
        account: customer.bank_id
      }
    });
    if (!payRes.ok) {
      throw new Error(`Invoice #${invoiceNumber} created, but POST /v3/invoice/payment failed (${payRes.status}): ${JSON.stringify(payRes.data)}`);
    }

    return {
      live: true,
      invoice_id: invoiceId,
      payment_id: payRes.data.id,
      number: invoiceNumber,
      amount: numericAmount,
      status: payRes.data.status || 'IN_PROCESS'
    };
  }

  // Sandbox simulation
  const invoiceId = 'inv_' + crypto.randomBytes(10).toString('hex');
  const paymentId = 'pay_' + crypto.randomBytes(10).toString('hex');
  const invoiceNumber = String(1042 + state.invoices.length);

  logApiCall(state, {
    method: 'POST',
    path: '/v3/invoice',
    authLabel: 'owner key (sandbox sim)',
    status: 201,
    ms: 58,
    live: false
  });
  logApiCall(state, {
    method: 'POST',
    path: '/v3/invoice/payment',
    authLabel: 'guest key (sandbox sim)',
    status: 200,
    ms: 67,
    live: false
  });

  return {
    live: false,
    invoice_id: invoiceId,
    payment_id: paymentId,
    number: invoiceNumber,
    amount: numericAmount,
    status: 'IN_PROCESS'
  };
}

// 7. Admin Send Outbound Payout (POST /v3/check/digital with Owner key)
async function sendPayout(state, { name, recipient, amount, description }) {
  const numericAmount = Number(parseFloat(amount).toFixed(2));

  if (hasLiveOwnerKeys(state.config)) {
    const ownerAuth = `${state.config.checkbookKey}:${state.config.checkbookSecret}`;
    const res = await checkbookRequest(state, {
      method: 'POST',
      path: '/check/digital',
      auth: ownerAuth,
      authLabel: 'owner key',
      body: {
        name,
        recipient,
        amount: numericAmount,
        description: description || 'Payout'
      }
    });
    if (!res.ok) {
      throw new Error(`Checkbook POST /v3/check/digital failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return {
      live: true,
      check_id: res.data.id,
      number: res.data.number || '5001',
      status: res.data.status || 'IN_PROCESS',
      image_uri: res.data.image_uri || null
    };
  }

  logApiCall(state, {
    method: 'POST',
    path: '/v3/check/digital',
    authLabel: 'owner key (sandbox sim)',
    status: 201,
    ms: 61,
    live: false
  });

  return {
    live: false,
    check_id: 'chk_' + crypto.randomBytes(10).toString('hex'),
    number: String(5010 + state.payouts.length),
    status: 'IN_PROCESS'
  };
}

// 8. Verify Checkbook Webhook HMAC Signature: header `signature: nonce=1243549809,signature=ee23a8e...`
function verifyWebhookSignature(rawBody, signatureHeader, signingKey) {
  if (!signingKey) return { verified: true, note: 'No signing key configured (accepted in dev mode)' };
  if (!signatureHeader) return { verified: false, note: 'Missing signature header' };

  const parts = {};
  String(signatureHeader).split(',').forEach(kv => {
    const [k, v] = kv.trim().split('=');
    if (k && v) parts[k] = v;
  });
  if (!parts.nonce || !parts.signature) {
    return { verified: false, note: 'Malformed signature header' };
  }

  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(String(rawBody) + String(parts.nonce))
    .digest('hex');

  const verified = expected.toLowerCase() === String(parts.signature).toLowerCase();
  return { verified, nonce: parts.nonce, note: verified ? 'HMAC-SHA256 verified' : 'Signature mismatch' };
}

module.exports = {
  createMarketplaceUser,
  getInstitutions,
  instantVerifyBank,
  addManualBankAndRelease,
  verifyMicroDeposits,
  issueAndAutoDebitInvoice,
  sendPayout,
  verifyWebhookSignature,
  hasLiveOwnerKeys
};
