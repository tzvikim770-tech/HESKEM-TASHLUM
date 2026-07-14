const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENV_PATHS = [
  path.join(__dirname, ".env.local"),
  path.join(__dirname, ".env.local.txt"),
];

function loadLocalEnv() {
  for (const envPath of ENV_PATHS) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 8787);
const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "google-service-account.json");
const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1FsYu89kSbnJNEcWLDHo3oEvuolf-EMvWrmZMpd03u64";
const SHEET_NAME = process.env.SHEET_NAME || "הסדר תשלומים";

function escapeSheetName(sheetName) {
  return String(sheetName).replace(/'/g, "''");
}

const RANGE = `'${escapeSheetName(SHEET_NAME)}'!A:X`;

const REQUIRED_HEADERS = [
  "מספר פנימי",
  "שם מלא בעברית",
  "תאריך לידה לועזי",
  "סכום לתשלום חודשי",
  "מספר חודשי תשלום",
  "חלק חיוב עם הפיקדון",
  "תאריך תשלום ראשון",
  "תאריך תשלום אחרון",
  "חלק חיוב אחרון",
  "סכום הפקדון",
  "שילם פקדון",
  "שילם תשלום ראשוני וסידר תשלומים להמשך",
];

const OPTIONAL_WRITE_HEADERS = [
  "שם המשלם",
  "קשר לתלמיד",
  "אימייל לקבלות",
  "טלפון",
  "אופן תשלום פקדון",
  "אופן תשלום ראשוני",
  "אופן תשלום עתידי",
  "שילם פקדון",
  "שילם תשלום ראשוני וסידר תשלומים להמשך",
  "חתימה",
  "תאריך חתימה",
  "סטטוס חוזה",
  "הערות משרד",
];

function getStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY || "";
}

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
}

async function getAccessToken() {
  const account = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claim),
  )}`;
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    account.private_key,
  );
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status}`);
  }

  return (await response.json()).access_token;
}

async function readSheetRows() {
  const accessToken = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(
    RANGE,
  )}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Google Sheets request failed: ${response.status}`);
  }

  const data = await response.json();
  return data.values || [];
}

function columnToLetter(index) {
  let column = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function sheetRange(cell) {
  return `'${escapeSheetName(SHEET_NAME)}'!${cell}`;
}

function nowDisplay() {
  return new Intl.DateTimeFormat("he-IL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date());
}

async function updateSheetCells(rowNumber, headers, updates) {
  const accessToken = await getAccessToken();
  const data = [];

  for (const [header, value] of Object.entries(updates)) {
    const index = headers.indexOf(header);
    if (index === -1) continue;
    data.push({
      range: sheetRange(`${columnToLetter(index)}${rowNumber}`),
      values: [[value == null ? "" : String(value)]],
    });
  }

  if (data.length === 0) {
    throw new Error("No matching writable columns found in sheet");
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets update failed: ${response.status} ${text}`);
  }

  return response.json();
}

function normalizeDigits(value) {
  return String(value || "")
    .trim()
    .replace(/[^\d]/g, "");
}

function excelSerialToDate(serial) {
  const days = Number(serial);
  if (!Number.isFinite(days)) return "";
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d+(\.\d+)?$/.test(text)) return excelSerialToDate(text);

  const match = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})$/);
  if (!match) return text;

  let first = Number(match[1]);
  let second = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;

  // Google Sheets API returns dates according to the sheet locale/format.
  // In this sheet, 9/1/2026 means September 1, 2026.
  let month = first;
  let day = second;

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDate(value) {
  const normalized = normalizeDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  return new Date(`${normalized}T12:00:00Z`);
}

function formatDisplayDate(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return String(value || "");
  return new Intl.DateTimeFormat("he-IL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  const originalDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(originalDay, lastDay));
  return next;
}

function countMonthlyDatesInclusive(firstDateValue, lastDateValue) {
  const first = parseDate(firstDateValue);
  const last = parseDate(lastDateValue);
  if (!first || !last || last < first) return null;
  const yearDiff = last.getUTCFullYear() - first.getUTCFullYear();
  const monthDiff = last.getUTCMonth() - first.getUTCMonth();
  return yearDiff * 12 + monthDiff + 1;
}

function toNumber(value) {
  const num = Number(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatMonthCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : String(number);
}

function rowToRecord(headers, row) {
  const record = {};
  headers.forEach((header, index) => {
    if (header) record[header] = row[index] || "";
  });
  return record;
}

function validateHeaders(headers) {
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`Missing required headers: ${missing.join(", ")}`);
  }
}

function buildPaymentSchedule({
  depositAmount,
  initialTuitionPayment,
  monthlyAmount,
  firstChargeDate,
  fullMonthCount,
  finalPayment,
  finalChargeFraction,
  lastChargeDate,
}) {
  const schedule = [
    {
      label: "פיקדון",
      date: "בעת השלמת ההרשמה",
      amount: roundMoney(depositAmount),
      note: "",
    },
    {
      label: "תשלום ראשוני",
      date: "בעת השלמת ההרשמה",
      amount: roundMoney(initialTuitionPayment),
      note: "תשלום של חצי חודש.",
    },
  ];

  const firstDate = parseDate(firstChargeDate);
  for (let index = 0; firstDate && index < fullMonthCount; index += 1) {
    schedule.push({
      label: `תשלום חודשי ${index + 1}`,
      date: formatDisplayDate(addMonths(firstDate, index)),
      amount: roundMoney(monthlyAmount),
      note: "",
    });
  }

  if (finalChargeFraction > 0 && finalChargeFraction < 1 && finalPayment > 0) {
    schedule.push({
      label: "תשלום אחרון",
      date: formatDisplayDate(lastChargeDate),
      amount: roundMoney(finalPayment),
      note:
        finalChargeFraction === 1
          ? "חיוב חודשי מלא."
          : "חיוב אחרון חלקי לפי התוכנית האישית.",
    });
  }

  return schedule;
}

function buildSummary(record) {
  const monthlyAmount = toNumber(record["סכום לתשלום חודשי"]);
  const depositAmount = toNumber(record["סכום הפקדון"]);
  const initialFraction = toNumber(record["חלק חיוב עם הפיקדון"]);
  const finalFraction = toNumber(record["חלק חיוב אחרון"]);
  const sheetMonthCount = toNumber(record["מספר חודשי תשלום"]);
  const datedChargeCount = countMonthlyDatesInclusive(
    record["תאריך תשלום ראשון"],
    record["תאריך תשלום אחרון"],
  );
  const fullMonthCount =
    datedChargeCount == null
      ? Math.floor(sheetMonthCount)
      : finalFraction > 0 && finalFraction < 1
        ? Math.max(0, datedChargeCount - 1)
        : datedChargeCount;
  const initialTuitionPayment = monthlyAmount * initialFraction;
  const finalPayment = finalFraction > 0 && finalFraction < 1 ? monthlyAmount * finalFraction : 0;
  const fullMonthlyTotal = monthlyAmount * fullMonthCount;
  const displayMonthCount =
    sheetMonthCount > 0
      ? formatMonthCount(sheetMonthCount)
      : formatMonthCount(
          initialFraction +
            fullMonthCount +
            (finalFraction > 0 && finalFraction < 1 ? finalFraction : 0),
        );

  const paymentSchedule = buildPaymentSchedule({
    depositAmount,
    initialTuitionPayment,
    monthlyAmount,
    firstChargeDate: record["תאריך תשלום ראשון"],
    fullMonthCount,
    finalPayment,
    finalChargeFraction: finalFraction,
    lastChargeDate: record["תאריך תשלום אחרון"],
  });

  return {
    studentName: record["שם מלא בעברית"],
    monthlyAmount: roundMoney(monthlyAmount),
    depositAmount: roundMoney(depositAmount),
    initialTuitionPayment: roundMoney(initialTuitionPayment),
    depositAndInitialTotal: roundMoney(depositAmount + initialTuitionPayment),
    firstChargeDate: formatDisplayDate(record["תאריך תשלום ראשון"]),
    lastChargeDate: formatDisplayDate(record["תאריך תשלום אחרון"]),
    finalPayment: roundMoney(finalPayment),
    fullMonthCount,
    displayMonthCount,
    estimatedTuitionTotal: roundMoney(
      initialTuitionPayment + fullMonthlyTotal + finalPayment,
    ),
    estimatedTotalWithDeposit: roundMoney(
      depositAmount + initialTuitionPayment + fullMonthlyTotal + finalPayment,
    ),
    paymentSchedule,
    paidDeposit: record["שילם פקדון"] || "לא",
    paidInitialAndArrangedFuturePayments:
      record["שילם תשלום ראשוני וסידר תשלומים להמשך"] || "לא",
    contractStatus: record["סטטוס חוזה"] || "",
  };
}

function getBaseUrl(request) {
  const host = request.headers.host || `localhost:${PORT}`;
  const proto = request.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

async function createStripeCheckoutSession({ request, internalNumber, birthDate, payer }) {
  const stripeKey = getStripeSecretKey();
  if (!stripeKey) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }

  const student = await lookupStudent({ internalNumber, birthDate });
  if (!student) {
    const error = new Error("Student not found");
    error.statusCode = 404;
    throw error;
  }

  const amountCents = Math.round(Number(student.depositAndInitialTotal || 0) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 50) {
    throw new Error("Invalid Stripe amount");
  }

  await saveRegistration({
    internalNumber,
    birthDate,
    payer,
    paymentMethod: payer?.paymentMethod || "כרטיס אשראי",
    status: "נחתם - ממתין לתשלום Stripe",
    note: "נשמר לפני מעבר ל-Stripe",
  });

  const baseUrl = getBaseUrl(request);
  const body = new URLSearchParams({
    mode: "payment",
    success_url: `${baseUrl}/stripe-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/stripe-cancel`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]":
      `תשלום הרשמה - ${student.studentName || "תלמיד"}`,
    "line_items[0][price_data][product_data][description]":
      `פיקדון + תשלום ראשוני (${student.displayMonthCount || ""} חודשים)`,
    "metadata[internal_number]": String(internalNumber || ""),
    "metadata[birth_date]": String(normalizeDate(birthDate) || ""),
    "metadata[student_name]": String(student.studentName || ""),
    "metadata[payment_purpose]": "registration_deposit_and_initial",
  });

  if (payer?.payerEmail) {
    body.set("customer_email", payer.payerEmail);
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `Stripe error ${response.status}`;
    throw new Error(message);
  }

  return {
    url: data.url,
    id: data.id,
    amount: student.depositAndInitialTotal,
  };
}

async function retrieveStripeCheckoutSession(sessionId) {
  const stripeKey = getStripeSecretKey();
  if (!stripeKey) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }

  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        authorization: `Bearer ${stripeKey}`,
      },
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `Stripe error ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function markStripeSessionPaid(sessionId) {
  const session = await retrieveStripeCheckoutSession(sessionId);
  const internalNumber = session?.metadata?.internal_number;
  const birthDate = session?.metadata?.birth_date;
  if (!internalNumber || !birthDate) {
    throw new Error("Stripe session is missing registration metadata");
  }

  const paid = session.payment_status === "paid";
  const status = paid ? "שולם ב-Stripe" : "נחתם - ממתין לתשלום Stripe";
  await saveRegistration({
    internalNumber,
    birthDate,
    payer: {
      payerEmail: session.customer_details?.email || session.customer_email || "",
      paymentMethod: "כרטיס אשראי",
    },
    paymentMethod: "כרטיס אשראי",
    status,
    note: paid
      ? "עודכן לאחר חזרה מוצלחת מ-Stripe"
      : `חזרה מ-Stripe ללא סטטוס תשלום סופי: ${session.payment_status || "לא ידוע"}`,
    stripeSessionId: session.id,
  });

  return { paid, status };
}

async function findStudentRow({ internalNumber, birthDate }) {
  const rows = await readSheetRows();
  const headers = rows[0] || [];
  validateHeaders(headers);

  const requestedNumber = normalizeDigits(internalNumber);
  const requestedBirthDate = normalizeDate(birthDate);

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const record = rowToRecord(headers, row);
    const rowNumber = normalizeDigits(record["מספר פנימי"]);
    const rowBirthDate = normalizeDate(record["תאריך לידה לועזי"]);
    if (rowNumber === requestedNumber && rowBirthDate === requestedBirthDate) {
      return {
        rowNumber: index + 1,
        headers,
        record,
        student: buildSummary(record),
      };
    }
  }

  return null;
}

async function lookupStudent({ internalNumber, birthDate }) {
  const match = await findStudentRow({ internalNumber, birthDate });
  return match ? match.student : null;
}

function cleanPayer(payer) {
  return {
    payerName: String(payer?.payerName || "").trim(),
    payerRelation: String(payer?.payerRelation || "").trim(),
    payerEmail: String(payer?.payerEmail || "").trim(),
    payerPhone: String(payer?.payerPhone || "").trim(),
    paymentMethod: String(payer?.paymentMethod || "").trim(),
  };
}

function buildRegistrationUpdates({ payer, paymentMethod, status, note, stripeSessionId }) {
  const clean = cleanPayer({ ...payer, paymentMethod });
  const isCard = clean.paymentMethod === "כרטיס אשראי";
  const isChecks = clean.paymentMethod === "צ׳קים";
  const methodText = clean.paymentMethod || "";

  const updates = {
    "אופן תשלום פקדון": methodText,
    "אופן תשלום ראשוני": methodText,
    "אופן תשלום עתידי": methodText,
    "חתימה": "נחתם",
    "תאריך חתימה": nowDisplay(),
    "סטטוס חוזה": status,
    "הערות משרד": note || "",
  };

  if (clean.payerName) updates["שם המשלם"] = clean.payerName;
  if (clean.payerRelation) updates["קשר לתלמיד"] = clean.payerRelation;
  if (clean.payerEmail) updates["אימייל לקבלות"] = clean.payerEmail;
  if (clean.payerPhone) updates["טלפון"] = clean.payerPhone;

  if (isCard && status === "שולם ב-Stripe") {
    updates["שילם פקדון"] = "כן";
    updates["שילם תשלום ראשוני וסידר תשלומים להמשך"] =
      "תשלום ראשוני שולם ב-Stripe - המשך תשלומים לבדיקה";
  } else if (isCard) {
    updates["שילם פקדון"] = "ממתין לתשלום Stripe";
    updates["שילם תשלום ראשוני וסידר תשלומים להמשך"] =
      "ממתין לתשלום Stripe";
  } else if (isChecks) {
    updates["שילם פקדון"] = "ממתין לקבלת צ׳קים";
    updates["שילם תשלום ראשוני וסידר תשלומים להמשך"] =
      "ממתין לקבלת צ׳קים";
  }

  if (stripeSessionId) {
    updates["הערות משרד"] = [updates["הערות משרד"], `Stripe session: ${stripeSessionId}`]
      .filter(Boolean)
      .join(" | ");
  }

  return updates;
}

async function saveRegistration({ internalNumber, birthDate, payer, paymentMethod, status, note, stripeSessionId }) {
  const match = await findStudentRow({ internalNumber, birthDate });
  if (!match) {
    const error = new Error("Student not found");
    error.statusCode = 404;
    throw error;
  }

  const headers = match.headers;
  const missingWritableHeaders = OPTIONAL_WRITE_HEADERS.filter((header) => !headers.includes(header));
  const updates = buildRegistrationUpdates({
    payer,
    paymentMethod,
    status,
    note: missingWritableHeaders.length
      ? `${note || ""}${note ? " | " : ""}עמודות חסרות לעדכון: ${missingWritableHeaders.join(", ")}`
      : note,
    stripeSessionId,
  });

  await updateSheetCells(match.rowNumber, headers, updates);
  return {
    rowNumber: match.rowNumber,
    student: match.student,
    status,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 500000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function pageHtml() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>בדיקת חיבור לגיליון</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f6f8fb; color: #18212f; }
    main { max-width: 1040px; margin: 0 auto; padding: 32px 18px; }
    .panel { background: white; border: 1px solid #d9e0ea; border-radius: 8px; padding: 20px; box-shadow: 0 12px 30px rgba(20, 30, 45, .08); }
    label { display: block; font-weight: 700; margin: 12px 0 6px; }
    input, button { font: inherit; min-height: 44px; border-radius: 7px; }
    input, select { width: 100%; border: 1px solid #b8c2d1; padding: 8px 10px; box-sizing: border-box; background: white; }
    button { margin-top: 14px; border: 0; background: #1d5d9b; color: white; font-weight: 800; padding: 0 16px; cursor: pointer; }
    button.secondary { background: #eef2f7; color: #18212f; border: 1px solid #d9e0ea; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
    .metric:nth-child(-n+4) { background: #eef7f4; border-color: #9ad1bd; }
    .metric:nth-child(2) { background: #e7f1fb; border-color: #88b9e3; }
    .grid.with-gap .metric:nth-child(5) { margin-top: 24px; }
    .grid.with-gap .metric:nth-child(6) { margin-top: 24px; }
    .grid.with-gap .metric:nth-child(5),
    .grid.with-gap .metric:nth-child(6) { border-top: 4px solid #d7dde8; }
    .metric { border: 1px solid #d9e0ea; border-radius: 8px; padding: 12px; background: #fff; }
    .metric span { display: block; color: #667085; font-size: 14px; }
    .metric strong { display: block; margin-top: 4px; font-size: 18px; }
    .notice { margin-top: 14px; padding: 12px; border-radius: 8px; background: #fff7e8; color: #673b00; }
    .warning { background: #fff3e0; color: #653b00; border: 1px solid #f1c27d; }
    .step-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .section-title { margin: 24px 0 8px; font-size: 22px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 10px; }
    .payment-choice { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 10px; }
    .choice { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; border: 1px solid #d9e0ea; border-radius: 8px; padding: 12px; background: #fff; cursor: pointer; }
    .choice input { width: 18px; min-height: 18px; margin-top: 3px; }
    .choice strong { display: block; }
    .choice span { display: block; color: #667085; font-size: 14px; margin-top: 2px; }
    .contract-box { margin-top: 10px; max-height: 420px; overflow: auto; border: 1px solid #d9e0ea; border-radius: 8px; padding: 16px; background: #fff; }
    .contract-box h3 { margin: 18px 0 6px; font-size: 18px; }
    .contract-box h3:first-child { margin-top: 0; }
    .contract-box p { margin: 0 0 10px; }
    .checks { display: grid; gap: 10px; margin-top: 14px; }
    .check { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; border: 1px solid #d9e0ea; border-radius: 8px; padding: 10px; background: #fff; }
    .check input { width: 18px; min-height: 18px; margin-top: 3px; }
    .signature-pad { width: 100%; height: 190px; border: 1px dashed #8da0b8; border-radius: 8px; background: #fff; touch-action: none; display: block; }
    .table-wrap { margin-top: 10px; overflow-x: auto; border: 1px solid #d9e0ea; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; background: white; min-width: 680px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #e6ebf2; text-align: right; vertical-align: top; }
    th { background: #f1f5f9; font-size: 14px; color: #344054; }
    tr:last-child td { border-bottom: 0; }
    .amount { direction: ltr; white-space: nowrap; font-weight: 700; }
    .muted { color: #667085; font-size: 14px; }
    .summary-block { border: 1px solid #d9e0ea; border-radius: 8px; padding: 14px; background: #fff; margin-top: 12px; }
    .summary-block h3 { margin: 0 0 8px; }
    .signature-preview { max-width: 360px; width: 100%; border: 1px solid #d9e0ea; border-radius: 8px; background: #fff; margin-top: 8px; }
    @media print {
      body { background: #fff; }
      form, .step-actions, #lookupForm, #message { display: none !important; }
      .panel { box-shadow: none; border: 0; }
      #finalSummarySection { display: block !important; }
      .summary-block, .table-wrap { break-inside: avoid; }
    }
    @media (max-width: 680px) { .grid, .form-grid, .payment-choice { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="panel">
      <h1>הסכם ותשלומים אישיים</h1>
      <p>הזן מספר פנימי ותאריך לידה כדי לראות את סיכום התשלומים האישי.</p>
      <form id="lookupForm">
        <label for="internalNumber">מספר פנימי</label>
        <input id="internalNumber" name="internalNumber" inputmode="numeric" autocomplete="off" required />
        <label for="birthDate">תאריך לידה לועזי</label>
        <input id="birthDate" name="birthDate" type="date" required />
        <button type="submit">איתור</button>
      </form>
      <div id="message" class="notice" hidden></div>
      <section id="summaryStep" hidden>
        <div id="summary" class="grid with-gap"></div>
        <section id="scheduleSection">
          <h2 class="section-title">פירוט התשלומים</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>סוג תשלום</th>
                  <th>תאריך</th>
                  <th>סכום</th>
                  <th>הערה</th>
                </tr>
              </thead>
              <tbody id="scheduleRows"></tbody>
            </table>
          </div>
        </section>
        <div class="step-actions">
          <button id="continueToPayer" type="button">המשך לפרטי המשלם</button>
        </div>
      </section>
      <section id="payerSection" hidden>
        <h2 class="section-title">פרטי המשלם</h2>
        <p class="muted">נא למלא את הפרטים שאליהם יישלחו אישורי התשלום והקבלות.</p>
        <form id="payerForm" novalidate>
          <div class="form-grid">
            <div>
              <label for="payerName">שם המשלם</label>
              <input id="payerName" name="payerName" autocomplete="name" />
            </div>
            <div>
              <label for="payerRelation">קשר לתלמיד</label>
              <select id="payerRelation" name="payerRelation">
                <option value="">בחר</option>
                <option>אב</option>
                <option>אם</option>
                <option>התלמיד</option>
                <option>אחר</option>
              </select>
            </div>
            <div id="payerRelationOtherWrap" hidden>
              <label for="payerRelationOther">נא לפרט קשר לתלמיד</label>
              <input id="payerRelationOther" name="payerRelationOther" autocomplete="off" />
            </div>
            <div>
              <label for="payerEmail">אימייל לקבלות</label>
              <input id="payerEmail" name="payerEmail" type="email" autocomplete="email" />
            </div>
            <div>
              <label for="payerPhone">טלפון</label>
              <input id="payerPhone" name="payerPhone" type="tel" autocomplete="tel" />
            </div>
          </div>
          <h3 class="section-title">אופן תשלום</h3>
          <div class="payment-choice">
            <label class="choice">
              <input type="radio" name="paymentMethod" value="כרטיס אשראי" />
              <span>
                <strong>משלם בכרטיס אשראי</strong>
                <span>התשלום יבוצע דרך מערכת תשלומים מאובטחת.</span>
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="paymentMethod" value="צ׳קים" />
              <span>
                <strong>תשלום באמצעות צ׳קים</strong>
                <span>המשך הרישום ימתין לקבלת הצ׳קים במשרד.</span>
              </span>
            </label>
          </div>
          <div id="checksWarning" class="notice warning" hidden>
            שים לב: הרישום לא ייסגר עד לאחר קבלת הצ׳קים במשרד בארץ ואישורם על ידי המשרד.
          </div>
          <div class="step-actions">
            <button id="backToSummary" class="secondary" type="button">חזרה לסיכום</button>
            <button type="submit">המשך להסכם</button>
          </div>
        </form>
        <div id="payerPreview" class="notice" hidden></div>
      </section>
      <section id="contractSection" hidden>
        <h2 class="section-title">הסכם ואישורים</h2>
        <p class="muted">נא לקרוא את התנאים ולאשר את הסעיפים לפני המשך לחתימה.</p>
        <div class="contract-box">
          <h3>סיכום התשלום האישי</h3>
          <p>התשלומים בהסכם זה נקבעים לפי תוכנית התשלומים האישית של התלמיד כפי שהוצגה במסך הסיכום, כולל סכום התשלום החודשי, הפיקדון, התשלום הראשוני ולוח התשלומים.</p>

          <h3>פיקדון ותשלום ראשוני</h3>
          <p>הפיקדון והתשלום הראשוני מוצגים כשני רכיבים נפרדים. התשלום הראשוני הוא חלק משכר הלימוד לפי התוכנית האישית של התלמיד.</p>

          <h3>תשלומים חודשיים</h3>
          <p>התשלומים החודשיים יתחילו בתאריך התשלום הראשון ויימשכו לפי מספר התשלומים והתאריכים שהוצגו בלוח התשלומים האישי. אם מועד תשלום חל ביום שבו מערכת התשלומים אינה פעילה, החיוב עשוי להתבצע ביום העסקים הבא.</p>

          <h3>פיקדון והפחתות</h3>
          <p>הפיקדון מוחזק על ידי הישיבה במשך תקופת השהות. ההנהלה רשאית להפחית מהפיקדון במקרים של נזק לפנימייה או לרכוש, חוסר תשלומים, אי תשלום קנס על הפרת כללים בישיבה, או הוצאה אחרת החלה על התלמיד לפי ההסכם.</p>

          <h3>ביטול לפני כניסה לפנימייה</h3>
          <p>במקרה של ביטול הרישום לפני שהתלמיד נכנס בפועל לפנימייה, ייגבה סכום השווה לחלק התשלום הראשוני שנקבע עבורו. הפיקדון יוחזר בהתאם למדיניות הישיבה ולמצב התשלום בפועל.</p>

          <h3>יציאה לאחר כניסה</h3>
          <p>לאחר כניסת התלמיד לפנימייה, תנאי היציאה והחיובים יחולו לפי מדיניות הישיבה ונוסח ההסכם הסופי. מ-1 בינואר ואילך, יציאה דורשת הודעה מראש של 30 יום וקבלת אישור מהמשרד.</p>

          <h3>אופן תשלום</h3>
          <p>אם נבחר תשלום בכרטיס אשראי, התשלום יתבצע דרך מערכת תשלומים מאובטחת. אם נבחר תשלום באמצעות צ׳קים, הרישום לא ייסגר עד לאחר קבלת הצ׳קים במשרד בארץ ואישורם על ידי המשרד.</p>
        </div>

        <div class="checks">
          <label class="check">
            <input type="checkbox" class="contractCheck" />
            <span>קראתי והבנתי את סכומי התשלום ולוח התשלומים האישי שהוצג לי.</span>
          </label>
          <label class="check">
            <input type="checkbox" class="contractCheck" />
            <span>ידוע לי שהפיקדון והתשלום הראשוני מוצגים כרכיבים נפרדים.</span>
          </label>
          <label class="check">
            <input type="checkbox" class="contractCheck" />
            <span>קראתי והבנתי את תנאי הפיקדון, הביטול והיציאה.</span>
          </label>
          <label class="check" id="checksAgreement" hidden>
            <input type="checkbox" class="contractCheck" />
            <span>בחרתי לשלם באמצעות צ׳קים, וידוע לי שהרישום לא ייסגר עד לאחר קבלת הצ׳קים במשרד ואישורם.</span>
          </label>
          <label class="check">
            <input type="checkbox" class="contractCheck" />
            <span>אני מאשר שהחתימה האלקטרונית שלי תהווה את הסכמתי לתנאי ההסכם.</span>
          </label>
        </div>

        <h3 class="section-title">חתימה</h3>
        <p class="muted">נא לחתום באמצעות העכבר או האצבע.</p>
        <canvas id="signaturePad" class="signature-pad" width="900" height="240" aria-label="משטח חתימה"></canvas>
        <div class="step-actions">
          <button id="clearSignature" class="secondary" type="button">ניקוי חתימה</button>
        </div>

        <div class="step-actions">
          <button id="backToPayerFromContract" class="secondary" type="button">חזרה לפרטי המשלם</button>
          <button id="completeContract" type="button">חתימה והמשך</button>
        </div>
        <div id="contractPreview" class="notice" hidden></div>
      </section>
      <section id="finalSummarySection" hidden>
        <h2 class="section-title">סיכום הסכם לפני שליחה</h2>
        <p class="muted">זהו הסיכום שיוכל לשמש את המשלם לאורך השנה. ניתן להדפיס או לשמור כ-PDF.</p>

        <div class="summary-block">
          <h3>פרטי תלמיד ותשלום</h3>
          <div id="finalStudentSummary" class="grid"></div>
        </div>

        <div class="summary-block">
          <h3>פרטי המשלם</h3>
          <div id="finalPayerSummary" class="grid"></div>
        </div>

        <div class="summary-block">
          <h3>טבלת תשלומים</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>סוג תשלום</th>
                  <th>תאריך</th>
                  <th>סכום</th>
                  <th>הערה</th>
                </tr>
              </thead>
              <tbody id="finalScheduleRows"></tbody>
            </table>
          </div>
        </div>

        <div class="summary-block">
          <h3>עיקרי ההסכם</h3>
          <p>התשלומים נקבעים לפי התוכנית האישית שהוצגה. הפיקדון והתשלום הראשוני מוצגים כרכיבים נפרדים. תנאי הפיקדון, הביטול והיציאה חלים לפי ההסכם שאושר במסך הקודם.</p>
          <p id="finalPaymentStatus"></p>
        </div>

        <div class="summary-block">
          <h3>חתימה</h3>
          <p>החתימה האלקטרונית נקלטה בתאריך ובשעה שיופיעו בעת השמירה הסופית.</p>
          <img id="signaturePreview" class="signature-preview" alt="חתימה" />
        </div>

        <div class="step-actions">
          <button id="backToContract" class="secondary" type="button">חזרה להסכם</button>
          <button id="printAgreement" class="secondary" type="button">הורדת / הדפסת הסכם</button>
          <button id="skipStripe" class="secondary" type="button">דילוג Stripe לבדיקה</button>
          <button id="finalSubmit" type="button">שליחה</button>
        </div>
        <div id="finalSubmitPreview" class="notice" hidden></div>
      </section>
    </div>
  </main>
  <script>
    const form = document.getElementById("lookupForm");
    const message = document.getElementById("message");
    const summaryStep = document.getElementById("summaryStep");
    const summary = document.getElementById("summary");
    const scheduleSection = document.getElementById("scheduleSection");
    const scheduleRows = document.getElementById("scheduleRows");
    const continueToPayer = document.getElementById("continueToPayer");
    const payerSection = document.getElementById("payerSection");
    const payerForm = document.getElementById("payerForm");
    const payerPreview = document.getElementById("payerPreview");
    const backToSummary = document.getElementById("backToSummary");
    const payerRelation = document.getElementById("payerRelation");
    const payerRelationOtherWrap = document.getElementById("payerRelationOtherWrap");
    const payerRelationOther = document.getElementById("payerRelationOther");
    const checksWarning = document.getElementById("checksWarning");
    const contractSection = document.getElementById("contractSection");
    const checksAgreement = document.getElementById("checksAgreement");
    const backToPayerFromContract = document.getElementById("backToPayerFromContract");
    const completeContract = document.getElementById("completeContract");
    const contractPreview = document.getElementById("contractPreview");
    const signaturePad = document.getElementById("signaturePad");
    const clearSignature = document.getElementById("clearSignature");
    const finalSummarySection = document.getElementById("finalSummarySection");
    const finalStudentSummary = document.getElementById("finalStudentSummary");
    const finalPayerSummary = document.getElementById("finalPayerSummary");
    const finalScheduleRows = document.getElementById("finalScheduleRows");
    const finalPaymentStatus = document.getElementById("finalPaymentStatus");
    const signaturePreview = document.getElementById("signaturePreview");
    const backToContract = document.getElementById("backToContract");
    const printAgreement = document.getElementById("printAgreement");
    const skipStripe = document.getElementById("skipStripe");
    const finalSubmit = document.getElementById("finalSubmit");
    const finalSubmitPreview = document.getElementById("finalSubmitPreview");
    const signatureContext = signaturePad.getContext("2d");
    let hasSignature = false;
    let selectedPaymentMethod = "";
    let currentStudent = null;
    let currentPayer = null;
    let currentLookupPayload = null;
    const money = value => "$" + Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const fields = [
      ["שם התלמיד", "studentName"],
      ["לתשלום כעת", "depositAndInitialTotal", money],
      ["תשלום ראשוני", "initialTuitionPayment", money],
      ["פיקדון", "depositAmount", money],
      ["סכום לתשלום חודשי", "monthlyAmount", money],
      ["מספר חודשי תשלום", "displayMonthCount"],
      ["תאריך תשלום ראשון", "firstChargeDate"],
      ["תאריך תשלום אחרון", "lastChargeDate"],
      ["סה״כ שכר לימוד", "estimatedTuitionTotal", money],
      ["סה״כ כולל פיקדון", "estimatedTotalWithDeposit", money],
    ];
    function showMessage(text) {
      message.hidden = !text;
      message.textContent = text || "";
    }
    form.addEventListener("submit", async event => {
      event.preventDefault();
      showMessage("בודק...");
      summary.innerHTML = "";
      scheduleRows.innerHTML = "";
      summaryStep.hidden = true;
      payerSection.hidden = true;
      contractSection.hidden = true;
      finalSummarySection.hidden = true;
      payerPreview.hidden = true;
      contractPreview.hidden = true;
      finalSubmitPreview.hidden = true;
      const payload = Object.fromEntries(new FormData(form).entries());
      currentLookupPayload = payload;
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.found) {
        showMessage(data.error || "הפרטים לא תואמים.");
        return;
      }
      currentStudent = data.student;
      if (data.student.contractStatus && data.student.contractStatus.includes("ממתין לתשלום")) {
        showMessage("החוזה כבר נשמר במערכת, אך התשלום עדיין לא הושלם. אפשר להמשיך מכאן לתשלום.");
      } else {
        showMessage("");
      }
      summary.innerHTML = fields.map(([label, key, format]) => {
        const value = format ? format(data.student[key]) : data.student[key];
        return '<div class="metric"><span>' + label + '</span><strong>' + (value || "") + '</strong></div>';
      }).join("");
      scheduleRows.innerHTML = (data.student.paymentSchedule || []).map(item => {
        return '<tr><td>' + item.label + '</td><td>' + item.date + '</td><td class="amount">' + money(item.amount) + '</td><td class="muted">' + (item.note || "") + '</td></tr>';
      }).join("");
      summaryStep.hidden = false;
      summaryStep.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    continueToPayer.addEventListener("click", () => {
      summaryStep.hidden = true;
      payerSection.hidden = false;
      payerForm.reset();
      payerPreview.hidden = true;
      checksWarning.hidden = true;
      selectedPaymentMethod = "";
      payerSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    backToSummary.addEventListener("click", () => {
      payerSection.hidden = true;
      payerPreview.hidden = true;
      summaryStep.hidden = false;
      summaryStep.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    payerRelation.addEventListener("change", () => {
      const isOther = payerRelation.value === "אחר";
      payerRelationOtherWrap.hidden = !isOther;
      payerRelationOther.required = false;
      if (!isOther) payerRelationOther.value = "";
    });
    payerForm.querySelectorAll('input[name="paymentMethod"]').forEach(input => {
      input.addEventListener("change", () => {
        checksWarning.hidden = input.value !== "צ׳קים" || !input.checked;
      });
    });
    payerForm.addEventListener("submit", event => {
      event.preventDefault();
      const payer = Object.fromEntries(new FormData(payerForm).entries());
      const relation = payer.payerRelation === "אחר" ? payer.payerRelationOther : payer.payerRelation;
      selectedPaymentMethod = payer.paymentMethod || "לא נבחר";
      currentPayer = {
        payerName: payer.payerName || "",
        payerRelation: relation || "",
        payerEmail: payer.payerEmail || "",
        payerPhone: payer.payerPhone || "",
        paymentMethod: selectedPaymentMethod,
      };
      payerPreview.hidden = false;
      payerPreview.textContent = "הפרטים נקלטו לבדיקה: " + payer.payerName + ", " + relation + ", " + payer.payerEmail + ", " + payer.payerPhone + ". אופן תשלום: " + selectedPaymentMethod + ".";
      payerSection.hidden = true;
      contractSection.hidden = false;
      contractPreview.hidden = true;
      checksAgreement.hidden = selectedPaymentMethod !== "צ׳קים";
      document.querySelectorAll(".contractCheck").forEach(input => input.checked = false);
      clearSignaturePad();
      completeContract.textContent = selectedPaymentMethod === "צ׳קים" ? "חתימה ושליחה למשרד" : "חתימה והמשך לתשלום";
      contractSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    backToPayerFromContract.addEventListener("click", () => {
      contractSection.hidden = true;
      contractPreview.hidden = true;
      payerSection.hidden = false;
      payerSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    function signaturePoint(event) {
      const rect = signaturePad.getBoundingClientRect();
      const source = event.touches ? event.touches[0] : event;
      return {
        x: (source.clientX - rect.left) * (signaturePad.width / rect.width),
        y: (source.clientY - rect.top) * (signaturePad.height / rect.height),
      };
    }
    let drawingSignature = false;
    function startSignature(event) {
      drawingSignature = true;
      const point = signaturePoint(event);
      signatureContext.beginPath();
      signatureContext.moveTo(point.x, point.y);
      event.preventDefault();
    }
    function drawSignature(event) {
      if (!drawingSignature) return;
      const point = signaturePoint(event);
      signatureContext.lineWidth = 3;
      signatureContext.lineCap = "round";
      signatureContext.strokeStyle = "#18212f";
      signatureContext.lineTo(point.x, point.y);
      signatureContext.stroke();
      hasSignature = true;
      event.preventDefault();
    }
    function endSignature() {
      drawingSignature = false;
    }
    function clearSignaturePad() {
      signatureContext.clearRect(0, 0, signaturePad.width, signaturePad.height);
      signatureContext.fillStyle = "#fff";
      signatureContext.fillRect(0, 0, signaturePad.width, signaturePad.height);
      hasSignature = false;
    }
    signaturePad.addEventListener("mousedown", startSignature);
    signaturePad.addEventListener("mousemove", drawSignature);
    window.addEventListener("mouseup", endSignature);
    signaturePad.addEventListener("touchstart", startSignature, { passive: false });
    signaturePad.addEventListener("touchmove", drawSignature, { passive: false });
    signaturePad.addEventListener("touchend", endSignature);
    clearSignature.addEventListener("click", clearSignaturePad);
    clearSignaturePad();
    completeContract.addEventListener("click", () => {
      const visibleChecks = Array.from(document.querySelectorAll(".contractCheck")).filter(input => !input.closest("[hidden]"));
      const allChecked = visibleChecks.every(input => input.checked);
      const signatureText = hasSignature ? "החתימה נקלטה." : "טרם נקלטה חתימה.";
      const nextText = selectedPaymentMethod === "צ׳קים"
        ? "בשלב הבא יוצג סיכום סופי לשליחה למשרד."
        : "בשלב הבא יוצג סיכום סופי ולאחר מכן מעבר לתשלום.";
      if (!hasSignature) {
        contractPreview.hidden = false;
        contractPreview.textContent = signatureText + " לצורך בדיקות אפשר להמשיך בהמשך, אבל במסלול חי תהיה חובה לחתום.";
      }
      showFinalSummary(allChecked, signatureText + " " + nextText);
    });
    function metricHtml(label, value) {
      return '<div class="metric"><span>' + label + '</span><strong>' + (value || "") + '</strong></div>';
    }
    function showFinalSummary(allChecked, messageText) {
      const student = currentStudent || {};
      const payer = currentPayer || {};
      const paymentStatus = payer.paymentMethod === "צ׳קים"
        ? "סטטוס צפוי: נחתם - ממתין לקבלת צ׳קים במשרד."
        : "סטטוס צפוי: נחתם - ממתין לתשלום ב-Stripe.";
      finalStudentSummary.innerHTML = [
        ["שם התלמיד", student.studentName],
        ["לתשלום כעת", money(student.depositAndInitialTotal)],
        ["תשלום ראשוני", money(student.initialTuitionPayment)],
        ["פיקדון", money(student.depositAmount)],
        ["סכום חודשי", money(student.monthlyAmount)],
        ["מספר חודשי תשלום", student.displayMonthCount],
        ["תאריך תשלום ראשון", student.firstChargeDate],
        ["תאריך תשלום אחרון", student.lastChargeDate],
        ["סה״כ שכר לימוד", money(student.estimatedTuitionTotal)],
        ["סה״כ כולל פיקדון", money(student.estimatedTotalWithDeposit)],
      ].map(([label, value]) => metricHtml(label, value)).join("");
      finalPayerSummary.innerHTML = [
        ["שם המשלם", payer.payerName],
        ["קשר לתלמיד", payer.payerRelation],
        ["אימייל לקבלות", payer.payerEmail],
        ["טלפון", payer.payerPhone],
        ["אופן תשלום", payer.paymentMethod],
      ].map(([label, value]) => metricHtml(label, value)).join("");
      finalScheduleRows.innerHTML = (student.paymentSchedule || []).map(item => {
        return '<tr><td>' + item.label + '</td><td>' + item.date + '</td><td class="amount">' + money(item.amount) + '</td><td class="muted">' + (item.note || "") + '</td></tr>';
      }).join("");
      finalPaymentStatus.textContent = paymentStatus;
      signaturePreview.src = signaturePad.toDataURL("image/png");
      finalSubmit.textContent = payer.paymentMethod === "צ׳קים" ? "שליחה למשרד" : "שמירה והמשך לתשלום";
      skipStripe.hidden = payer.paymentMethod === "צ׳קים";
      finalSubmitPreview.hidden = false;
      finalSubmitPreview.textContent = allChecked
        ? messageText
        : "לצורך בדיקות מוצג הסיכום. במסלול חי כל תיבות האישור יהיו חייבות להיות מסומנות לפני שליחה.";
      contractSection.hidden = true;
      finalSummarySection.hidden = false;
      finalSummarySection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    backToContract.addEventListener("click", () => {
      finalSummarySection.hidden = true;
      finalSubmitPreview.hidden = true;
      contractSection.hidden = false;
      contractSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    printAgreement.addEventListener("click", () => window.print());
    async function saveRegistrationFromPage(status, note) {
      const response = await fetch("/api/save-registration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...currentLookupPayload,
          payer: currentPayer,
          paymentMethod: selectedPaymentMethod,
          status,
          note,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.saved) {
        throw new Error(data.error || "השמירה לגיליון לא הצליחה.");
      }
      return data;
    }
    skipStripe.addEventListener("click", async () => {
      finalSubmitPreview.hidden = false;
      skipStripe.disabled = true;
      try {
        await saveRegistrationFromPage("דילוג Stripe לבדיקה", "נשמר במסלול בדיקה ללא מעבר ל-Stripe");
        finalSubmitPreview.textContent = "נשמר בגיליון במסלול בדיקה ללא מעבר ל-Stripe.";
      } catch (error) {
        finalSubmitPreview.textContent = "שגיאה בשמירה לגיליון: " + error.message;
      } finally {
        skipStripe.disabled = false;
      }
    });
    finalSubmit.addEventListener("click", async () => {
      finalSubmitPreview.hidden = false;
      if (selectedPaymentMethod === "צ׳קים") {
        finalSubmit.disabled = true;
        finalSubmitPreview.textContent = "שומר בגיליון...";
        try {
          await saveRegistrationFromPage(
            "נחתם - ממתין לקבלת צ׳קים",
            "נבחר תשלום באמצעות צ׳קים",
          );
          finalSubmitPreview.textContent = "נשמר בגיליון. הרישום ממתין לקבלת הצ׳קים במשרד.";
        } catch (error) {
          finalSubmitPreview.textContent = "שגיאה בשמירה לגיליון: " + error.message;
        } finally {
          finalSubmit.disabled = false;
        }
        return;
      }
      finalSubmit.disabled = true;
      finalSubmitPreview.textContent = "יוצר תשלום ב-Stripe...";
      try {
        const response = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...currentLookupPayload,
            payer: currentPayer,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data.url) {
          throw new Error(data.error || "לא נוצר קישור Stripe.");
        }
        window.location.href = data.url;
      } catch (error) {
        finalSubmit.disabled = false;
        finalSubmitPreview.textContent = "שגיאה ביצירת תשלום Stripe: " + error.message;
      }
    });
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml());
      return;
    }

    if (request.method === "POST" && request.url === "/api/lookup") {
      const payload = JSON.parse(await readBody(request));
      const student = await lookupStudent(payload);
      if (!student) {
        sendJson(response, 404, { found: false, error: "הפרטים לא תואמים." });
        return;
      }
      sendJson(response, 200, { found: true, student });
      return;
    }

    if (request.method === "POST" && request.url === "/api/create-checkout-session") {
      const payload = JSON.parse(await readBody(request));
      const session = await createStripeCheckoutSession({
        request,
        internalNumber: payload.internalNumber,
        birthDate: payload.birthDate,
        payer: payload.payer,
      });
      sendJson(response, 200, session);
      return;
    }

    if (request.method === "POST" && request.url === "/api/save-registration") {
      const payload = JSON.parse(await readBody(request));
      const result = await saveRegistration({
        internalNumber: payload.internalNumber,
        birthDate: payload.birthDate,
        payer: payload.payer,
        paymentMethod: payload.paymentMethod,
        status: payload.status || "נחתם",
        note: payload.note || "",
      });
      sendJson(response, 200, { saved: true, ...result });
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/stripe-success")) {
      const url = new URL(request.url, getBaseUrl(request));
      const sessionId = url.searchParams.get("session_id");
      let message = "התשלום נקלט ב-Stripe.";
      if (sessionId) {
        try {
          const result = await markStripeSessionPaid(sessionId);
          message = result.paid
            ? "התשלום נקלט ב-Stripe והגיליון עודכן."
            : "חזרת מ-Stripe, אבל עדיין לא התקבל אישור תשלום סופי. הגיליון נשאר במצב ממתין לתשלום.";
        } catch (error) {
          console.error(error);
          message = "התשלום נקלט ב-Stripe, אך עדכון הגיליון לא הושלם אוטומטית. יש לבדוק במשרד.";
        }
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><body style="font-family:Arial;padding:32px"><h1>התשלום נקלט ב-Stripe</h1><p>${message}</p><p><a href="/">חזרה למערכת</a></p></body></html>`);
      return;
    }

    if (request.method === "GET" && request.url === "/stripe-cancel") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html lang=\"he\" dir=\"rtl\"><meta charset=\"utf-8\"><body style=\"font-family:Arial;padding:32px\"><h1>התשלום בוטל</h1><p>אפשר לחזור למערכת ולנסות שוב.</p><p><a href=\"/\">חזרה למערכת</a></p></body></html>");
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: "שגיאה בקריאת הנתונים. בדוק הרשאות וכותרות גיליון." });
    console.error(error);
  }
});

server.listen(PORT, () => {
  console.log(`Sheets lookup server running at http://localhost:${PORT}`);
});
