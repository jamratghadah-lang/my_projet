# مزامنة integrations.html مع Netlify — خطوة إعداد أولى (مرة وحدة بس)

كان الوضع: مفاتيح واتساب/الذكاء الاصطناعي اللي تُدخلينها من `dashboard/integrations.html`
تُحفظ في Firestore فقط، بينما `ai-webhook.js` و`send-whatsapp.js` وبقية الدوال
(`send-bulk.js`, `event-reminder.js`, `message-scheduler.js`, `post-event-survey.js`,
`video-scheduler.js`, `_ai-lib.js`) تقرأ المفاتيح من متغيرات بيئة Netlify فقط — مسارين
منفصلين، تعبئة الداشبورد وحدها ما كانت كافية.

## اللي انسوى

- دالة جديدة `netlify/functions/save-secrets.js` (محمية بصلاحية admin فقط) تاخذ القيم
  اللي تحفظينها من الداشبورد وتكتبها مباشرة في متغيرات بيئة Netlify عبر الـ API الرسمي،
  ثم تطلب إعادة نشر تلقائية عشان الدوال تلتقط القيم الجديدة.
- `dashboard/integrations.html` صار زر "حفظ" لكل من واتساب، Msegat، Unifonic، Twilio،
  والذكاء الاصطناعي (Groq + Z.ai) يحفظ في Firestore **و** يزامن Netlify بنفس الضغطة.
- ضفت حقول كانت ناقصة كليًا وما كان لها مكان بالداشبورد أصلًا رغم إن الكود يحتاجها:
  Webhook Verify Token و App Secret لواتساب، Username لـ Msegat، Sender ID لـ Unifonic،
  ومفتاحي Groq وZ.ai بدل حقل "Gemini" اللي ما كان مربوط بشي أصلًا (المشروع ما يستخدم Gemini).
- صلّحت مؤشر حالة "Gemini AI" في status bar كان يختبر رابط Google الحقيقي دايم يفشل؛
  صار يختبر Groq فعليًا.

## خطوة لازم تسوينها يدويًا مرة وحدة بس

عشان الدالة الجديدة تقدر تكتب في متغيرات Netlify نيابة عنك، لازم تعطينها مفتاح دخول:

1. Netlify → **User settings → Applications → New access token** → انسخي التوكن.
2. Netlify → **Site settings → General → Site details** → انسخي **Site ID**.
3. أضيفي هذولا كمتغيرين بيئة عاديين من نفس مكان بقية المفاتيح
   (Site settings → Environment variables):
   - `NETLIFY_AUTH_TOKEN` = التوكن من الخطوة 1
   - `NETLIFY_SITE_ID` = الـ Site ID من الخطوة 2
4. أعيدي نشر الموقع مرة وحدة يدويًا بعد إضافتهم.

من بعدها، أي مفتاح تحفظينه من صفحة `integrations.html` (واتساب/Msegat/Unifonic/Twilio/AI)
ينكتب تلقائيًا في Netlify وتنعاد نشر الموقع — مكان واحد بس.

## أشياء لسا ناقصة (ما لمستها لأنها تحتاج قرار منك)

- **SMTP**: الحقول موجودة بالداشبورد لكن ما فيه أي كود بالمشروع يقرأها — الإيميل الفعلي
  يرسل عبر Resend (`RESEND_API_KEY`) مش SMTP. البطاقة حاليًا شكلية بالكامل.
- **Cloudinary**: نفس القصة — ما فيه كود يستخدم هذي القيم حاليًا.
- إذا تبين هذي الاثنتين تشتغلين فعليًا أو تنشالن من الداشبورد، قوليلي أسوي أيهم.
