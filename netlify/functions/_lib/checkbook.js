const crypto = require('crypto');

function getBaseUrl(env) {
  if (env === 'production' || env === 'prod') return 'https://api.checkbook.io/v3';
  if (env === 'demo') return 'https://demo.checkbook.io/v3';
  return 'https://sandbox.checkbook.io/v3';
}

function hasLiveOwnerKeys(config) {
  return Boolean(config && config.checkbookKey && config.checkbookSecret);
}

function recordApiLog(state, entry) {
  state.apiLogs = state.apiLogs || [];
  state.apiLogs.unshift({
    id: 'log_' + crypto.randomBytes(5).toString('hex'),
    ts: new Date().toISOString(),
    ...entry
  });
  state.apiLogs = state.apiLogs.slice(0, 60);
}

async function checkbookRequest(state, { method, path, auth, authLabel, body, baseUrlOverride }) {
  const baseUrl = baseUrlOverride || getBaseUrl(state.config.checkbookEnv);
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
    recordApiLog(state, {
      method,
      path: `/v3${path}`,
      authLabel,
      status: res.status,
      ms: Date.now() - start,
      live: true,
      error: res.ok ? null : (data.error || data.message || text.slice(0, 160))
    });
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    recordApiLog(state, {
      method,
      path: `/v3${path}`,
      authLabel,
      status: 500,
      ms: Date.now() - start,
      live: true,
      error: err.message
    });
    return { ok: false, status: 500, data: { error: err.message } };
  }
}

// 0. Live Verification of Owner Checkbook API Key, Secret & Webhook Signing Key
async function verifyCheckbookConnection(state) {
  const cfg = state.config || {};
  const result = {
    hasApiKeys: hasLiveOwnerKeys(cfg),
    apiConnected: false,
    detectedEnv: cfg.checkbookEnv || 'sandbox',
    apiStatusMessage: 'No Checkbook API Key & Secret entered yet (running in Sandbox Simulator mode).',
    ownerAccountsCount: 0,
    hasWebhookSecret: Boolean(cfg.webhookSecret),
    webhookConnected: false,
    webhookStatusMessage: 'No Webhook Signing Key entered yet.',
    verifiedAt: new Date().toISOString()
  };

  if (result.hasApiKeys) {
    const ownerAuth = `${cfg.checkbookKey}:${cfg.checkbookSecret}`;
    const primaryEnv = cfg.checkbookEnv === 'production' ? 'production' : 'sandbox';
    const fallbackEnv = primaryEnv === 'production' ? 'sandbox' : 'production';

    // Try selected environment first (GET /v3/account/bank)
    let probe = await checkbookRequest(state, {
      method: 'GET',
      path: '/account/bank',
      auth: ownerAuth,
      authLabel: `owner key (${primaryEnv} probe)`,
      baseUrlOverride: getBaseUrl(primaryEnv)
    });

    if (probe.ok) {
      result.apiConnected = true;
      result.detectedEnv = primaryEnv;
      const banks = (probe.data && (probe.data.banks || probe.data.accounts)) || [];
      result.ownerAccountsCount = Array.isArray(banks) ? banks.length : 0;
      const firstBank = result.ownerAccountsCount > 0 ? banks[0] : null;
      const bankNote = firstBank
        ? `Owner Bank •••• ${firstBank.account} (${firstBank.status})`
        : `${result.ownerAccountsCount} owner bank(s)`;
      result.apiStatusMessage = `Connected to Checkbook ${primaryEnv.toUpperCase()} API (HTTP ${probe.status} OK · ${bankNote}).`;
    } else if (probe.status === 401) {
      // Auto-check the other environment in case the user pasted a Sandbox key while Production was selected (or vice versa)
      const altProbe = await checkbookRequest(state, {
        method: 'GET',
        path: '/account/bank',
        auth: ownerAuth,
        authLabel: `owner key (${fallbackEnv} auto-detect)`,
        baseUrlOverride: getBaseUrl(fallbackEnv)
      });
      if (altProbe.ok) {
        cfg.checkbookEnv = fallbackEnv;
        result.apiConnected = true;
        result.detectedEnv = fallbackEnv;
        const banks = (altProbe.data && (altProbe.data.banks || altProbe.data.accounts)) || [];
        result.ownerAccountsCount = Array.isArray(banks) ? banks.length : 0;
        const firstBank = result.ownerAccountsCount > 0 ? banks[0] : null;
        const bankNote = firstBank
          ? `Owner Bank •••• ${firstBank.account} (${firstBank.status})`
          : `${result.ownerAccountsCount} owner bank(s)`;
        result.apiStatusMessage = `Connected! Auto-detected ${fallbackEnv.toUpperCase()} key and switched environment to ${fallbackEnv.toUpperCase()} (${bankNote}).`;
      } else {
        result.apiConnected = false;
        result.apiStatusMessage = `Checkbook returned 401 Unauthorized on both Production and Sandbox. Please double-check your Publishable Key and Secret Key.`;
      }
    } else {
      result.apiConnected = false;
      result.apiStatusMessage = `Checkbook API returned HTTP ${probe.status}: ${JSON.stringify(probe.data).slice(0, 140)}`;
    }
  }

  // Verify Webhook Signing Key & HMAC pipeline via cryptographic self-test
  if (cfg.webhookSecret) {
    const sampleBody = JSON.stringify({
      id: 'wh_verify_ping',
      type: 'CHECKBOOK_WEBHOOK_SELF_TEST',
      status: 'VERIFIED'
    });
    const sampleNonce = String(Date.now());
    const sampleSig = crypto
      .createHmac('sha256', cfg.webhookSecret)
      .update(sampleBody + sampleNonce)
      .digest('hex');
    const sigHeader = `nonce=${sampleNonce},signature=${sampleSig}`;
    const check = verifyWebhookSignature(sampleBody, sigHeader, cfg.webhookSecret);
    result.webhookConnected = Boolean(check.valid);
    result.webhookStatusMessage = check.valid
      ? 'Webhook Signing Key configured & HMAC-SHA256 verification active on /webhook/checkbook.'
      : 'Webhook HMAC self-test failed.';
  } else {
    result.webhookConnected = true;
    result.webhookStatusMessage = 'Webhook endpoint /webhook/checkbook is live (open mode — add Webhook Signing Key to enforce HMAC-SHA256).';
  }

  cfg.lastVerification = result;
  return result;
}

// 1. Create Guest Marketplace User (POST /v3/user with Owner key)
async function createGuestMarketplaceUser(state, { businessName, user_id }) {
  if (hasLiveOwnerKeys(state.config)) {
    const ownerAuth = `${state.config.checkbookKey}:${state.config.checkbookSecret}`;
    const res = await checkbookRequest(state, {
      method: 'POST',
      path: '/user',
      auth: ownerAuth,
      authLabel: 'owner key',
      body: { name: businessName, user_id }
    });
    if (res.ok && res.data && res.data.key && res.data.secret) {
      return {
        live: true,
        id: res.data.id,
        user_id: res.data.user_id || user_id,
        key: res.data.key,
        secret: res.data.secret
      };
    }
    // If user_id already exists on Checkbook or live call fails, surface clear error
    throw new Error(`Checkbook POST /v3/user failed (${res.status}): ${res.data.error || res.data.message || JSON.stringify(res.data)}`);
  }

  // Simulated sandbox response when live keys are not entered yet
  const sim = {
    live: false,
    id: crypto.randomBytes(16).toString('hex'),
    user_id,
    key: 'sim_pub_' + crypto.randomBytes(8).toString('hex'),
    secret: 'sim_sec_' + crypto.randomBytes(12).toString('hex')
  };
  recordApiLog(state, {
    method: 'POST',
    path: '/v3/user',
    authLabel: 'owner key (sandbox sim)',
    status: 201,
    ms: 42,
    live: false
  });
  return sim;
}

// 2. Supported Institutions for Checkbook Native IAV (GET /v3/account/bank/institutions)
const DEFAULT_INSTITUTIONS = [
  { id: 'c7b3cb4a243a4427b2bd12871d8f6deb', name: 'JPMorgan Chase Bank, N.A.', routing: '322271627' },
  { id: 'ins_bofa', name: 'Bank of America, N.A.', routing: '026009593' },
  { id: 'ins_wells', name: 'Wells Fargo Bank, N.A.', routing: '121000248' },
  { id: 'ins_citi', name: 'Citibank, N.A.', routing: '021000089' },
  { id: 'ins_usbank', name: 'U.S. Bank, N.A.', routing: '122105155' },
  { id: 'ins_pnc', name: 'PNC Bank, N.A.', routing: '043000096' },
  { id: 'ins_capone', name: 'Capital One, N.A.', routing: '051405515' },
  { id: 'ins_td', name: 'TD Bank, N.A.', routing: '031101266' },
  { id: 'ins_truist', name: 'Truist Bank', routing: '061000104' }
];

async function listInstitutionsForCustomer(state, custKey, custSecret) {
  const isSimCustomer = !custKey || custKey.startsWith('sim_') || custKey.startsWith('demo_');
  if (hasLiveOwnerKeys(state.config)) {
    const auth = !isSimCustomer
      ? `${custKey}:${custSecret}`
      : `${state.config.checkbookKey}:${state.config.checkbookSecret}`;
    const authLabel = !isSimCustomer ? 'guest key' : 'owner key';
    const res = await checkbookRequest(state, {
      method: 'GET',
      path: '/account/bank/institutions',
      auth,
      authLabel
    });
    if (res.ok && Array.isArray(res.data.institutions) && res.data.institutions.length > 0) {
      return { institutions: res.data.institutions };
    }
  }
  return { institutions: DEFAULT_INSTITUTIONS };
}

// 3. Instant Bank Verification via Checkbook IAV (POST /v3/account/bank/iav + POST /v3/account/bank)
async function linkBankViaCheckbookIAV(state, custKey, custSecret, { institution_id, institution_name, login, password, type }) {
  const acctType = ['BUSINESS', 'CHECKING', 'PERSONAL'].includes(type) ? type : 'BUSINESS';
  const isSimCustomer = !custKey || custKey.startsWith('sim_') || custKey.startsWith('demo_');

  if (hasLiveOwnerKeys(state.config) && !isSimCustomer) {
    const guestAuth = `${custKey}:${custSecret}`;
    const iavRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank/iav',
      auth: guestAuth,
      authLabel: 'guest key',
      body: { institution_id, login, password }
    });
    if (!iavRes.ok) {
      return {
        ok: false,
        status: iavRes.status,
        error: `Checkbook IAV failed (${iavRes.status}): ${iavRes.data.error || iavRes.data.message || JSON.stringify(iavRes.data)}`
      };
    }
    const matched = (iavRes.data.accounts && iavRes.data.accounts[0]) || null;
    if (!matched) {
      return { ok: false, status: 400, error: 'No checking/business accounts returned by institution.' };
    }

    const addRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank',
      auth: guestAuth,
      authLabel: 'guest key',
      body: {
        routing: matched.routing,
        account: matched.account,
        type: acctType,
        name: matched.name || institution_name || 'Verified Bank'
      }
    });
    if (!addRes.ok) {
      return {
        ok: false,
        status: addRes.status,
        error: `Checkbook POST /v3/account/bank failed (${addRes.status}): ${addRes.data.error || addRes.data.message || JSON.stringify(addRes.data)}`
      };
    }

    return {
      ok: true,
      bank: {
        id: addRes.data.id,
        name: matched.name || institution_name || 'Verified Bank',
        routing: addRes.data.routing || matched.routing,
        accountLast4: String(addRes.data.account || matched.account).replace(/\D/g, '').slice(-4) || '8076',
        type: addRes.data.type || acctType,
        status: 'VERIFIED'
      }
    };
  }

  // Sandbox simulation
  if (login === 'user_bad') {
    return { ok: false, status: 400, error: 'Invalid bank credentials (use user_good / pass_good in Sandbox).' };
  }
  const inst = DEFAULT_INSTITUTIONS.find(i => i.id === institution_id) || DEFAULT_INSTITUTIONS[0];
  recordApiLog(state, {
    method: 'POST',
    path: '/v3/account/bank/iav',
    authLabel: 'guest key (sandbox sim)',
    status: 200,
    ms: 84,
    live: false
  });
  recordApiLog(state, {
    method: 'POST',
    path: '/v3/account/bank',
    authLabel: 'guest key (sandbox sim)',
    status: 201,
    ms: 61,
    live: false
  });

  return {
    ok: true,
    bank: {
      id: 'bank_' + crypto.randomBytes(8).toString('hex'),
      name: institution_name || inst.name,
      routing: inst.routing || '021000021',
      accountLast4: '8076',
      type: acctType,
      status: 'VERIFIED'
    }
  };
}

// 4. Manual Routing + Account (Micro-deposits: POST /v3/account/bank + POST /v3/account/bank/release)
async function linkBankViaMicrodeposits(state, custKey, custSecret, { routing, account, type, bankName }) {
  const acctType = ['BUSINESS', 'CHECKING', 'PERSONAL'].includes(type) ? type : 'BUSINESS';
  const isSimCustomer = !custKey || custKey.startsWith('sim_') || custKey.startsWith('demo_');

  if (hasLiveOwnerKeys(state.config) && !isSimCustomer) {
    const guestAuth = `${custKey}:${custSecret}`;
    const addRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank',
      auth: guestAuth,
      authLabel: 'guest key',
      body: { routing, account, type: acctType }
    });
    if (!addRes.ok) {
      return {
        ok: false,
        status: addRes.status,
        error: `Checkbook POST /v3/account/bank failed (${addRes.status}): ${addRes.data.error || addRes.data.message || JSON.stringify(addRes.data)}`
      };
    }

    const bankId = addRes.data.id;
    const relRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank/release',
      auth: guestAuth,
      authLabel: 'guest key',
      body: { account: bankId }
    });
    if (!relRes.ok) {
      return {
        ok: false,
        status: relRes.status,
        error: `Checkbook POST /v3/account/bank/release failed (${relRes.status}): ${relRes.data.error || relRes.data.message || JSON.stringify(relRes.data)}`
      };
    }

    return {
      ok: true,
      bank: {
        id: bankId,
        name: bankName || 'Business Checking',
        routing,
        accountLast4: String(addRes.data.account || account).slice(-4),
        type: acctType,
        status: 'PENDING'
      }
    };
  }

  recordApiLog(state, {
    method: 'POST',
    path: '/v3/account/bank',
    authLabel: 'guest key (sandbox sim)',
    status: 201,
    ms: 52,
    live: false
  });
  recordApiLog(state, {
    method: 'POST',
    path: '/v3/account/bank/release',
    authLabel: 'guest key (sandbox sim)',
    status: 200,
    ms: 48,
    live: false
  });

  return {
    ok: true,
    bank: {
      id: 'bank_' + crypto.randomBytes(8).toString('hex'),
      name: bankName || 'Business Checking',
      routing,
      accountLast4: String(account).slice(-4),
      type: acctType,
      status: 'PENDING'
    }
  };
}

// 5. Confirm Two Micro-Deposit Amounts (POST /v3/account/bank/verify)
async function verifyMicrodeposits(state, custKey, custSecret, { bank_id, amount_1, amount_2 }) {
  const a1 = Number(parseFloat(amount_1).toFixed(2));
  const a2 = Number(parseFloat(amount_2).toFixed(2));
  const isSimCustomer = !custKey || custKey.startsWith('sim_') || custKey.startsWith('demo_');

  if (hasLiveOwnerKeys(state.config) && !isSimCustomer) {
    const guestAuth = `${custKey}:${custSecret}`;
    const verRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/account/bank/verify',
      auth: guestAuth,
      authLabel: 'guest key',
      body: { account: bank_id, amount_1: a1, amount_2: a2 }
    });
    if (!verRes.ok) {
      return {
        ok: false,
        status: verRes.status,
        error: `Checkbook micro-deposit verification failed (${verRes.status}): ${verRes.data.error || verRes.data.message || JSON.stringify(verRes.data)}`
      };
    }
    return { ok: true, status: 'VERIFIED' };
  }

  const validPair = (a1 === 0.07 && a2 === 0.15) || (a1 === 0.15 && a2 === 0.07);
  recordApiLog(state, {
    method: 'POST',
    path: '/v3/account/bank/verify',
    authLabel: 'guest key (sandbox sim)',
    status: validPair ? 200 : 400,
    ms: 45,
    live: false,
    error: validPair ? null : 'Micro-deposit amounts did not match'
  });

  if (!validPair) {
    return { ok: false, status: 400, error: 'Incorrect micro-deposit amounts (in Sandbox mode enter 0.07 and 0.15).' };
  }
  return { ok: true, status: 'VERIFIED' };
}

// 6. Issue Invoice (Owner key) & Auto-Debit Immediately (Customer key)
async function issueAndAutoDebitInvoice(state, { customer, custKey, custSecret, amount, description, invoiceNumber }) {
  const numericAmount = Number(parseFloat(amount).toFixed(2));
  const isSimCustomer = !custKey || custKey.startsWith('sim_') || custKey.startsWith('demo_');

  if (hasLiveOwnerKeys(state.config) && !isSimCustomer) {
    const ownerAuth = `${state.config.checkbookKey}:${state.config.checkbookSecret}`;
    const guestAuth = `${custKey}:${custSecret}`;

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
      return {
        ok: false,
        status: invRes.status,
        error: `Checkbook POST /v3/invoice failed (${invRes.status}): ${invRes.data.error || invRes.data.message || JSON.stringify(invRes.data)}`
      };
    }

    const invoiceId = invRes.data.id;
    const payRes = await checkbookRequest(state, {
      method: 'POST',
      path: '/invoice/payment',
      auth: guestAuth,
      authLabel: 'guest key',
      body: {
        id: invoiceId,
        amount: numericAmount,
        account: customer.bank_id
      }
    });
    if (!payRes.ok) {
      return {
        ok: false,
        status: payRes.status,
        error: `Invoice created (${invoiceId}), but POST /v3/invoice/payment failed (${payRes.status}): ${payRes.data.error || payRes.data.message || JSON.stringify(payRes.data)}`
      };
    }

    return {
      ok: true,
      live: true,
      invoice_id: invoiceId,
      payment_id: payRes.data.id,
      number: invoiceNumber,
      amount: numericAmount,
      status: payRes.data.status || 'IN_PROCESS'
    };
  }

  recordApiLog(state, {
    method: 'POST',
    path: '/v3/invoice',
    authLabel: 'owner key (sandbox sim)',
    status: 201,
    ms: 56,
    live: false
  });
  recordApiLog(state, {
    method: 'POST',
    path: '/v3/invoice/payment',
    authLabel: 'guest key (sandbox sim)',
    status: 200,
    ms: 63,
    live: false
  });

  return {
    ok: true,
    live: false,
    invoice_id: 'inv_' + crypto.randomBytes(8).toString('hex'),
    payment_id: 'pay_' + crypto.randomBytes(8).toString('hex'),
    number: invoiceNumber,
    amount: numericAmount,
    status: 'IN_PROCESS'
  };
}

// 7. Send Outbound Digital Check / ACH Payout (POST /v3/check/digital with Owner key)
async function sendOutboundDigitalCheck(state, { recipient, name, amount, description, account }) {
  const numericAmount = Number(parseFloat(amount).toFixed(2));

  if (hasLiveOwnerKeys(state.config)) {
    const ownerAuth = `${state.config.checkbookKey}:${state.config.checkbookSecret}`;
    const payload = {
      name,
      recipient,
      amount: numericAmount,
      description: description || 'Payout'
    };
    if (account && !String(account).startsWith('bank_')) {
      payload.account = account;
    }

    const res = await checkbookRequest(state, {
      method: 'POST',
      path: '/check/digital',
      auth: ownerAuth,
      authLabel: 'owner key',
      body: payload
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Checkbook POST /v3/check/digital failed (${res.status}): ${res.data.error || res.data.message || JSON.stringify(res.data)}`
      };
    }
    return {
      ok: true,
      live: true,
      check: {
        id: res.data.id,
        number: res.data.number || String(5010 + state.payouts.length + 1),
        status: res.data.status || 'IN_PROCESS'
      }
    };
  }

  recordApiLog(state, {
    method: 'POST',
    path: '/v3/check/digital',
    authLabel: 'owner key (sandbox sim)',
    status: 201,
    ms: 59,
    live: false
  });

  return {
    ok: true,
    live: false,
    check: {
      id: 'chk_' + crypto.randomBytes(8).toString('hex'),
      number: String(5010 + state.payouts.length + 1),
      status: 'IN_PROCESS'
    }
  };
}

// 8. Verify Checkbook Webhook HMAC Signature: header `signature: nonce=...,signature=...`
function verifyWebhookSignature(rawBody, signatureHeader, signingKey) {
  if (!signingKey) return { valid: true, mode: 'open_no_secret_configured' };
  if (!signatureHeader) return { valid: false, mode: 'missing_signature_header' };

  const parts = {};
  String(signatureHeader).split(',').forEach(kv => {
    const [k, v] = kv.trim().split('=');
    if (k && v) parts[k] = v;
  });
  if (!parts.nonce || !parts.signature) {
    return { valid: false, mode: 'malformed_signature_header' };
  }

  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(String(rawBody) + String(parts.nonce))
    .digest('hex');

  const valid = expected.toLowerCase() === String(parts.signature).toLowerCase();
  return { valid, mode: valid ? 'hmac_sha256_verified' : 'signature_mismatch' };
}

module.exports = {
  verifyCheckbookConnection,
  createGuestMarketplaceUser,
  listInstitutionsForCustomer,
  linkBankViaCheckbookIAV,
  linkBankViaMicrodeposits,
  verifyMicrodeposits,
  issueAndAutoDebitInvoice,
  sendOutboundDigitalCheck,
  verifyWebhookSignature,
  hasLiveOwnerKeys
};
