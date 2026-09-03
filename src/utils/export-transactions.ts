export interface TransactionRow {
  transactionId: string;
  timestampIst: string;
  customerName: string;
  customerEmail: string;
  paymentMethod: string;
  grossAmountInr: string;
  grossAmountPaise: number;
  status: 'Captured' | 'Failed - Recovered' | 'Failed - In Recovery' | 'Failed';
  failureReason: string;
  recoveryChannel: string;
  recoveryProbability: string;
  mdrFeeInr: string;
  gstOnFeeInr: string;
  netSettlementInr: string;
  settlementBatchId: string;
  ledgerEntryRef: string;
  auditHash: string;
}

const CUSTOMERS = [
  { name: 'TechLearn Pro Pvt Ltd', email: 'billing@techlearnpro.in', defaultChannel: 'Credit Card' },
  { name: 'Apex Innovations', email: 'accounts@apexinnovations.co.in', defaultChannel: 'UPI' },
  { name: 'Zenith Logistics LLP', email: 'finance@zenithlogistics.in', defaultChannel: 'Payment Link' },
  { name: 'Kavita Sharma', email: 'kavita.sharma@gmail.com', defaultChannel: 'Debit Card' },
  { name: 'Rohit Verma', email: 'rohit.verma@outlook.com', defaultChannel: 'UPI' },
  { name: 'Bharat Agritech Ventures', email: 'finance@bharatagri.com', defaultChannel: 'Netbanking' },
  { name: 'Aarav Enterprise Solutions', email: 'pay@aaravsolutions.in', defaultChannel: 'Credit Card' },
  { name: 'Urban Services Network', email: 'ops@urbanservices.co.in', defaultChannel: 'UPI' },
  { name: 'Swiggy Cloud Kitchen Partner #409', email: 'partner409@cloudkitchens.in', defaultChannel: 'UPI' },
  { name: 'Zomato Merchant Services', email: 'merchants@zomato-vendors.in', defaultChannel: 'Credit Card' },
  { name: 'Delhi NCR Freight Logistics', email: 'accounts@delhifreight.in', defaultChannel: 'Netbanking' },
  { name: 'Bangalore EdTech Academy', email: 'fees@bangaloreedtech.edu.in', defaultChannel: 'Payment Link' },
  { name: 'Mumbai Retail Hub', email: 'finance@mumbairetail.com', defaultChannel: 'UPI' },
  { name: 'Hyderabad Pharma Chem', email: 'admin@hydpharma.com', defaultChannel: 'Credit Card' },
  { name: 'Chennai SaaS Technologies', email: 'billing@chennaisaas.io', defaultChannel: 'Credit Card' },
];

const FAILURE_REASONS = [
  { reason: 'Bank Server Timeout', channel: 'Card Dynamic Retry', prob: '81%' },
  { reason: 'Insufficient Account Balance', channel: 'Razorpay WhatsApp Link', prob: '68%' },
  { reason: '3DS Authentication Timeout', channel: 'WhatsApp Interactive Link', prob: '78%' },
  { reason: 'Card Expired / Invalid Details', channel: 'Payment Link via SMS', prob: '84%' },
  { reason: 'UPI PIN Limit Exceeded', channel: 'UPI AutoPay Re-collect', prob: '91%' },
  { reason: 'Netbanking Gateway Timeout', channel: 'Smart Netbanking Fallback', prob: '58%' },
];

export function generateTransactionData(days: 7 | 30 | 90): TransactionRow[] {
  const rows: TransactionRow[] = [];
  const now = new Date(2026, 7, 30, 18, 0, 0); // Reference date: 30 Aug 2026
  const txPerDay = days === 7 ? 35 : days === 30 ? 25 : 18;

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
    const currentDate = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const dayStr = currentDate.toISOString().slice(0, 10);
    const batchId = `setl_batch_${dayStr.replace(/-/g, '')}_01`;

    for (let t = 0; t < txPerDay; t++) {
      const hour = Math.floor(8 + (t / txPerDay) * 14);
      const minute = Math.floor(Math.random() * 60);
      const second = Math.floor(Math.random() * 60);
      const timeStr = `${dayStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} IST`;

      const cust = CUSTOMERS[(dayOffset * 3 + t) % CUSTOMERS.length]!;
      const txNum = 100000 + dayOffset * 100 + t;
      const transactionId = `pay_rzp_${txNum}`;
      const ledgerEntryRef = `les_${dayStr.replace(/-/g, '')}_${t + 1}`;

      const roll = (t * 17 + dayOffset * 7) % 100;
      let status: TransactionRow['status'] = 'Captured';
      let failureReason = 'N/A - Captured Successfully';
      let recoveryChannel = 'N/A';
      let recoveryProbability = '100%';

      const amounts = [1500, 2400, 4500, 8500, 9500, 12000, 14500, 18500, 24000, 38500];
      const grossInrNum = amounts[(t + dayOffset) % amounts.length]!;
      const grossPaise = grossInrNum * 100;

      if (roll >= 78 && roll < 93) {
        status = 'Failed - Recovered';
        const fail = FAILURE_REASONS[(t + dayOffset) % FAILURE_REASONS.length]!;
        failureReason = fail.reason;
        recoveryChannel = fail.channel;
        recoveryProbability = fail.prob;
      } else if (roll >= 93 && roll < 98) {
        status = 'Failed - In Recovery';
        const fail = FAILURE_REASONS[(t + dayOffset + 1) % FAILURE_REASONS.length]!;
        failureReason = fail.reason;
        recoveryChannel = fail.channel;
        recoveryProbability = fail.prob;
      } else if (roll >= 98) {
        status = 'Failed';
        const fail = FAILURE_REASONS[(t + dayOffset + 2) % FAILURE_REASONS.length]!;
        failureReason = fail.reason;
        recoveryChannel = fail.channel;
        recoveryProbability = fail.prob;
      }

      const mdrNum = grossInrNum * 0.02;
      const gstNum = mdrNum * 0.18;
      const netNum = grossInrNum - mdrNum - gstNum;

      const hash = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);

      rows.push({
        transactionId,
        timestampIst: timeStr,
        customerName: cust.name,
        customerEmail: cust.email,
        paymentMethod: cust.defaultChannel,
        grossAmountInr: grossInrNum.toFixed(2),
        grossAmountPaise: grossPaise,
        status,
        failureReason,
        recoveryChannel,
        recoveryProbability,
        mdrFeeInr: mdrNum.toFixed(2),
        gstOnFeeInr: gstNum.toFixed(2),
        netSettlementInr: netNum.toFixed(2),
        settlementBatchId: batchId,
        ledgerEntryRef,
        auditHash: `sha256_${hash}`,
      });
    }
  }

  return rows;
}

export function downloadTransactionsCsv(days: 7 | 30 | 90) {
  const data = generateTransactionData(days);

  const headers = [
    'Transaction ID',
    'Date & Time (IST)',
    'Customer Name',
    'Customer Email',
    'Payment Method',
    'Gross Amount (INR)',
    'Status',
    'Failure Reason',
    'Recovery Channel',
    'Recovery Probability',
    'MDR Fee 2% (INR)',
    'GST on Fee 18% (INR)',
    'Net Settlement Amount (INR)',
    'Settlement Batch ID',
    'Ledger Entry Ref',
    'Cryptographic SHA-256 Hash',
  ];

  const csvRows = [headers.join(',')];

  for (const r of data) {
    const row = [
      r.transactionId,
      `"${r.timestampIst}"`,
      `"${r.customerName}"`,
      `"${r.customerEmail}"`,
      `"${r.paymentMethod}"`,
      r.grossAmountInr,
      `"${r.status}"`,
      `"${r.failureReason}"`,
      `"${r.recoveryChannel}"`,
      `"${r.recoveryProbability}"`,
      r.mdrFeeInr,
      r.gstOnFeeInr,
      r.netSettlementInr,
      `"${r.settlementBatchId}"`,
      `"${r.ledgerEntryRef}"`,
      `"${r.auditHash}"`,
    ];
    csvRows.push(row.join(','));
  }

  const csvContent = '\uFEFF' + csvRows.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `FinanceOS_Daily_Transactions_${days}Days.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
