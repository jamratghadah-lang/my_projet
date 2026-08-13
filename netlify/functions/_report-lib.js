// netlify/functions/_report-lib.js
//
// وحدة مشتركة تستخدمها دوال التقارير (daily-report, notify-rsvp,
// event-reminder, send-report-now):
//   1) resolveRecipients()  — تقرأ content/settings.json من الموقع المنشور
//      وتحدد وين تروح التقارير (بريد العميلة و/أو بريد المدير) حسب
//      إعدادات لوحة التحكم (reports.client_email / reports.send_to).
//   2) fetchResponses()     — تقرأ كل ردود المدعوين من Firestore.
//   3) buildExcelBuffer()   — تولّد ملف Excel حقيقي (.xlsx) من الردود.
//   4) buildPdfBuffer()     — تولّد ملف PDF حقيقي من الردود.
//   5) sendReportEmail()    — ترسل الإيميل مرفقًا فيه الملفين عبر nodemailer.

// ملاحظة: PROJECT_ID يُقرأ من متغيّر البيئة FIREBASE_PROJECT_ID إن وُجد،
// وإلا نستخدم القيمة الافتراضية. لا حاجة لمفتاح Firebase API هنا لأن
// الـ Admin SDK يربط مباشرة بصلاحية حساب الخدمة دون المرور عبر REST API.
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "jamrat-ghadah";

// ===== 0) اتصال Firestore بصلاحية إدارية (Admin) =====
// قواعد أمان Firestore تشترط تسجيل دخول لقراءة "responses" (allow read: if
// isSignedIn()). دوال السيرفر هذي ما تسجّل دخول كمستخدم عادي، فلازم تتصل
// بصلاحية إدارية (Service Account) تتجاوز القواعد بشكل آمن ورسمي، بدل ما
// تحاول تقرأ بمفتاح API عادي (اللي يفشل لأنه مو "مسجّل دخول" من منظور القواعد).
//
// يتطلب متغيّر بيئة بـ Netlify اسمه FIREBASE_SERVICE_ACCOUNT_JSON يحتوي محتوى
// ملف مفتاح حساب الخدمة كامل (JSON) — يتولّد من Firebase Console:
// Project Settings → Service Accounts → Generate new private key.
let _adminDb = null;
function getAdminDb() {
  if (_adminDb) return _adminDb;
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON غير مضبوطة بإعدادات Netlify");
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  _adminDb = admin.firestore();
  return _adminDb;
}

// ===== 1) تحديد المستلمين حسب إعدادات لوحة التحكم =====
async function resolveRecipients() {
  const adminEmail = process.env.NOTIFY_EMAIL_TO || "";
  let reportsCfg = {};

  try {
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || "";
    if (siteUrl) {
      const res = await fetch(`${siteUrl}/content/settings.json`);
      if (res.ok) {
        const settings = await res.json();
        reportsCfg = settings.reports || {};
      }
    }
  } catch {
    // لو فشلت القراءة، نكمل بالإعدادات الافتراضية (بريد المدير فقط)
  }

  const clientEmail = (reportsCfg.client_email || "").trim();
  const sendTo = reportsCfg.send_to || "auto";

  let recipients = [];
  if (sendTo === "admin_only" || !clientEmail) {
    recipients = [adminEmail];
  } else if (sendTo === "both") {
    recipients = [adminEmail, clientEmail];
  } else {
    // auto: بريد العميلة إن وُجد، وإلا بريد المدير
    recipients = [clientEmail];
  }

  return { recipients: recipients.filter(Boolean), reportsCfg, adminEmail, clientEmail };
}

// ===== 2) قراءة الردود من Firestore =====
async function fetchResponses() {
  const db = getAdminDb();
  const snap = await db.collection("responses").get();

  const rows = [];
  let yes = 0, no = 0, pending = 0;

  snap.forEach((doc) => {
    const f = doc.data() || {};
    const name = f.name || "ضيف";
    const phone = f.phone || "—";
    const status = f.status || "";
    const guests = f.guests || "—";
    const style = f.style || "—";

    let statusAr;
    if (status === "yes") { yes++; statusAr = "مؤكد الحضور"; }
    else if (status === "no") { no++; statusAr = "معتذر"; }
    else { pending++; statusAr = "لم يرد"; }

    rows.push({ name, phone, status: statusAr, guests, style });
  });

  return { rows, total: rows.length, yes, no, pending };
}

// ===== 3) توليد ملف Excel حقيقي =====
async function buildExcelBuffer(rows) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("قائمة المدعوين");

  sheet.columns = [
    { header: "الاسم", key: "name", width: 26 },
    { header: "الحالة", key: "status", width: 16 },
    { header: "الهاتف", key: "phone", width: 18 },
    { header: "عدد الضيوف", key: "guests", width: 12 },
    { header: "القالب", key: "style", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  rows.forEach(r => sheet.addRow(r));

  return wb.xlsx.writeBuffer();
}

// ===== 4) توليد ملف PDF حقيقي =====
async function buildPdfBuffer(rows, stats, title) {
  const PDFDocument = (await import("pdfkit")).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(title || "تقرير المدعوين", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(
      `الإجمالي: ${stats.total}   |   مؤكد: ${stats.yes}   |   معتذر: ${stats.no}   |   لم يرد: ${stats.pending}`,
      { align: "center" }
    );
    doc.moveDown();

    doc.fontSize(10);
    rows.forEach((r, i) => {
      doc.text(`${i + 1}. ${r.name} — ${r.status} — ${r.phone} — ${r.guests} ضيوف — ${r.style}`);
    });

    doc.end();
  });
}

// ===== 5) إرسال الإيميل مع المرفقات =====
async function sendReportEmail({ to, subject, text, html, attachments }) {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost || !to || !to.length) {
    return { sent: false, reason: "SMTP_NOT_CONFIGURED_OR_NO_RECIPIENT" };
  }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: parseInt(process.env.SMTP_PORT || "587", 10) === 465,
    auth: { user: process.env.SMTP_USER || "", pass: process.env.SMTP_PASS || "" },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
    to: to.join(","),
    subject,
    text,
    html,
    attachments: attachments || [],
  });

  return { sent: true };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = {
  resolveRecipients,
  fetchResponses,
  buildExcelBuffer,
  buildPdfBuffer,
  sendReportEmail,
  escapeHtml,
  getAdminDb,
};
