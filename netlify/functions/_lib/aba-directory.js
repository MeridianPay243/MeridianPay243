const abaData = require('./aba-data.json');

const FRB_DISTRICTS = {
  '01': 'Federal Reserve District 1 (Boston) Member Bank',
  '21': 'Federal Reserve District 1 (Boston) Thrift Institution',
  '02': 'Federal Reserve District 2 (New York) Member Bank',
  '22': 'Federal Reserve District 2 (New York) Thrift Institution',
  '03': 'Federal Reserve District 3 (Philadelphia) Member Bank',
  '23': 'Federal Reserve District 3 (Philadelphia) Thrift Institution',
  '04': 'Federal Reserve District 4 (Cleveland) Member Bank',
  '24': 'Federal Reserve District 4 (Cleveland) Thrift Institution',
  '05': 'Federal Reserve District 5 (Richmond) Member Bank',
  '25': 'Federal Reserve District 5 (Richmond) Thrift Institution',
  '06': 'Federal Reserve District 6 (Atlanta) Member Bank',
  '26': 'Federal Reserve District 6 (Atlanta) Thrift Institution',
  '07': 'Federal Reserve District 7 (Chicago) Member Bank',
  '27': 'Federal Reserve District 7 (Chicago) Thrift Institution',
  '08': 'Federal Reserve District 8 (St. Louis) Member Bank',
  '28': 'Federal Reserve District 8 (St. Louis) Thrift Institution',
  '09': 'Federal Reserve District 9 (Minneapolis) Member Bank',
  '29': 'Federal Reserve District 9 (Minneapolis) Thrift Institution',
  '10': 'Federal Reserve District 10 (Kansas City) Member Bank',
  '30': 'Federal Reserve District 10 (Kansas City) Thrift Institution',
  '11': 'Federal Reserve District 11 (Dallas) Member Bank',
  '31': 'Federal Reserve District 11 (Dallas) Thrift Institution',
  '12': 'Federal Reserve District 12 (San Francisco) Member Bank',
  '32': 'Federal Reserve District 12 (San Francisco) Thrift Institution'
};

function isValidAbaChecksum(routing) {
  const clean = String(routing || '').replace(/\D/g, '');
  if (clean.length !== 9) return false;
  const d = clean.split('').map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum > 0 && sum % 10 === 0;
}

function lookupAbaRouting(routing) {
  const clean = String(routing || '').replace(/\D/g, '');
  if (clean.length !== 9) {
    return { valid: false, routing: clean, bankName: null, error: 'Routing number must be 9 digits.' };
  }

  const idx = abaData.map && abaData.map[clean];
  if (idx !== undefined && abaData.names && abaData.names[idx]) {
    return {
      valid: true,
      routing: clean,
      bankName: abaData.names[idx],
      source: 'fed_ach_directory'
    };
  }

  const checksumValid = isValidAbaChecksum(clean);
  if (!checksumValid) {
    return {
      valid: false,
      routing: clean,
      bankName: null,
      error: 'Invalid 9-digit ABA routing checksum.'
    };
  }

  const prefix2 = clean.slice(0, 2);
  const fallbackName = FRB_DISTRICTS[prefix2] || 'U.S. Commercial Bank (ABA Verified)';
  return {
    valid: true,
    routing: clean,
    bankName: fallbackName,
    source: 'aba_checksum_verified'
  };
}

module.exports = {
  isValidAbaChecksum,
  lookupAbaRouting
};
