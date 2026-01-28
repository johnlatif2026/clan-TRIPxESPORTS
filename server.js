require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   Helpers
========================= */

// ضمان وجود مجلدات ثابتة
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// مسار public/uploads
const uploadsDir = ensureDir(path.join(__dirname, 'public', 'uploads'));

// ربط آمن لمسارات الملفات المخزنة كـ "/uploads/xxx"
const publicPathFromUrl = (urlPath) => {
  // مهم: لو urlPath يبدأ بـ "/"، path.join هيهمل "public"
  const clean = String(urlPath || '').replace(/^\//, '');
  return path.join(__dirname, 'public', clean);
};

/* =========================
   Firebase Admin Init (Firestore)
========================= */

if (!process.env.FIREBASE_CONFIG) {
  console.error('FIREBASE_CONFIG is missing in .env');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
} catch (e) {
  console.error('FIREBASE_CONFIG must be valid JSON');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/* =========================
   Multer (Uploads)
========================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});

const upload = multer({ storage });

/* =========================
   Mail (Nodemailer)
========================= */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/* =========================
   Sessions
   - MemoryStore: بسيط لكنه غير مناسب للإنتاج على سيرفرات متعددة/Restart
========================= */

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
  },
};

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

/* =========================
   Middleware
========================= */

app.use(session(sessionConfig));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// منع تكرار دخول الأدمن للوجين
app.use((req, res, next) => {
  if (req.session.adminLoggedIn && req.path === '/admin-login.html') {
    return res.redirect('/admin/dashboard');
  }
  next();
});

// تحقق من تسجيل دخول المدير
const isAdminAuthenticated = (req, res, next) => {
  if (req.session.adminLoggedIn) return next();
  return res.status(401).json({ loggedIn: false });
};

/* =========================
   Notifications
========================= */

const sendTelegramNotification = async (message) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.warn('Telegram bot token or chat ID not configured');
      return;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    });

    console.log('Telegram notification sent successfully');
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
  }
};

const sendEmailNotification = async (subject, htmlContent) => {
  try {
    if (!process.env.NOTIFICATION_EMAIL) {
      console.warn('NOTIFICATION_EMAIL not configured');
      return;
    }

    const mailOptions = {
      from: `"Clan King ESPORTS" <${process.env.SMTP_USER}>`,
      to: process.env.NOTIFICATION_EMAIL,
      subject,
      html: htmlContent,
    };

    await transporter.sendMail(mailOptions);
    console.log('Email notification sent successfully');
  } catch (error) {
    console.error('Error sending email notification:', error);
  }
};

/* =========================
   Admin bootstrap (create admin doc if not exists)
   - collection: admin
   - doc id: ADMIN_USERNAME
========================= */

const ensureAdminUser = async () => {
  try {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const plainPassword = process.env.ADMIN_PASSWORD || 'admin123';

    const adminRef = db.collection('admin').doc(username);
    const snap = await adminRef.get();

    if (!snap.exists) {
      const hashed = bcrypt.hashSync(plainPassword, 8);
      await adminRef.set({
        username,
        password: hashed,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log('Admin user created in Firestore:', username);
    } else {
      console.log('Admin user exists in Firestore:', username);
    }
  } catch (e) {
    console.error('Error ensuring admin user:', e);
  }
};

/* =========================
   API Routes (Frontend)
========================= */

// Booking
app.post('/api/booking', upload.single('bGameVideo'), async (req, res) => {
  try {
    const { bName, bEmail, bPhone, bDuration, bAge } = req.body;
    const gameVideo = req.file ? '/uploads/' + req.file.filename : null;

    const id = uuidv4();

    await db.collection('bookings').doc(id).set({
      id,
      name: bName,
      email: bEmail,
      phone: bPhone,
      duration: bDuration,
      age: bAge,
      gameVideo,
      status: 'pending',
      notes: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const telegramMessage = `
<b>🎮 طلب انضمام جديد 🎮</b>
<b>الاسم:</b> ${bName}
<b>البريد:</b> ${bEmail}
<b>الهاتف:</b> ${bPhone}
<b>الفريمات:</b> ${bDuration}
<b>السن:</b> ${bAge}
<b>رابط لوحة التحكم:</b> ${process.env.ADMIN_PANEL_URL || ''}
`;
    sendTelegramNotification(telegramMessage);

    const emailSubject = `طلب انضمام جديد من ${bName}`;
    const emailContent = `
<div dir="rtl" style="font-family: Arial, sans-serif;">
  <h2 style="color: #4f46e5;">طلب انضمام جديد</h2>
  <p><strong>الاسم:</strong> ${bName}</p>
  <p><strong>البريد الإلكتروني:</strong> ${bEmail}</p>
  <p><strong>رقم الهاتف:</strong> ${bPhone}</p>
  <p><strong>الفريمات:</strong> ${bDuration}</p>
  <p><strong>العمر:</strong> ${bAge}</p>
  <p style="margin-top: 20px;">
    <a href="${process.env.ADMIN_PANEL_URL || '#'}" style="background-color: #4f46e5; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">
      الانتقال إلى لوحة التحكم
    </a>
  </p>
</div>
`;
    sendEmailNotification(emailSubject, emailContent);

    res.json({ success: true, message: 'تم تقديم طلب الانضمام بنجاح', bookingId: id });
  } catch (error) {
    console.error('Error in booking:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تقديم الطلب' });
  }
});

// Results by phone
app.get('/api/results/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;

    const snap = await db.collection('results').where('playerPhone', '==', phone).get();

    if (snap.empty) {
      return res.json({ success: false, message: 'لا توجد نتائج لهذا الرقم' });
    }

    const results = snap.docs.map((d) => d.data());
    res.json({ success: true, results });
  } catch (err) {
    console.error('Error fetching results:', err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء جلب النتائج' });
  }
});

// Contact / inquiries
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;
    const id = uuidv4();

    await db.collection('inquiries').doc(id).set({
      id,
      name,
      email,
      phone,
      message,
      status: 'new',
      response: null,
      respondedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const telegramMessage = `
<b>📩 استفسار جديد 📩</b>
<b>الاسم:</b> ${name}
<b>البريد:</b> ${email}
<b>الهاتف:</b> ${phone}
<b>الرسالة:</b> ${message}
<b>رابط لوحة التحكم:</b> ${process.env.ADMIN_PANEL_URL || ''}
`;
    sendTelegramNotification(telegramMessage);

    const emailSubject = `استفسار جديد من ${name}`;
    const emailContent = `
<div dir="rtl" style="font-family: Arial, sans-serif;">
  <h2 style="color: #4f46e5;">استفسار جديد</h2>
  <p><strong>الاسم:</strong> ${name}</p>
  <p><strong>البريد الإلكتروني:</strong> ${email}</p>
  <p><strong>رقم الهاتف:</strong> ${phone}</p>
  <p><strong>الرسالة:</strong></p>
  <div style="background-color: #f3f4f6; padding: 10px; border-radius: 5px;">
    ${String(message || '').replace(/\n/g, '<br>')}
  </div>
  <p style="margin-top: 20px;">
    <a href="${process.env.ADMIN_PANEL_URL || '#'}" style="background-color: #4f46e5; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">
      الانتقال إلى لوحة التحكم
    </a>
  </p>
</div>
`;
    sendEmailNotification(emailSubject, emailContent);

    res.json({ success: true, message: 'تم إرسال استفسارك بنجاح' });
  } catch (error) {
    console.error('Error in contact form:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء إرسال الاستفسار' });
  }
});

/* =========================
   Admin Routes
========================= */

app.get('/admin/dashboard', isAdminAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html'));
});

app.get('/admin/data', isAdminAuthenticated, async (req, res) => {
  try {
    const [bookingsSnap, inquiriesSnap, resultsSnap] = await Promise.all([
      db.collection('bookings').orderBy('createdAt', 'desc').get(),
      db.collection('inquiries').orderBy('createdAt', 'desc').get(),
      db.collection('results').orderBy('uploadedAt', 'desc').get(),
    ]);

    res.json({
      bookings: bookingsSnap.docs.map((d) => d.data()),
      inquiries: inquiriesSnap.docs.map((d) => d.data()),
      results: resultsSnap.docs.map((d) => d.data()),
    });
  } catch (err) {
    console.error('Error fetching admin data:', err);
    res.status(500).json({ success: false });
  }
});

// Login
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    db.get(
      `SELECT * FROM admin WHERE username = ?`,
      [username],
      (err, admin) => {
        if (err || !admin) {
          return res.json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        if (bcrypt.compareSync(password, admin.password)) {
          req.session.adminLoggedIn = true;
          res.json({ success: true });
        } else {
          res.json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }
      }
    );
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تسجيل الدخول' });
  }
});

app.get('/admin/check-session', (req, res) => {
  res.json({ loggedIn: !!req.session.adminLoggedIn });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false });
    }
    res.json({ success: true });
  });
});

// Update booking
app.post('/admin/update-booking/:id', isAdminAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    const { status, notes } = req.body;

    await db.collection('bookings').doc(id).update({ status, notes });
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تحديث الطلب' });
  }
});

// Delete booking
app.delete('/admin/delete-booking/:id', isAdminAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;

    const docRef = db.collection('bookings').doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const booking = snap.data();

    if (booking.gameVideo) {
      const filePath = publicPathFromUrl(booking.gameVideo);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await docRef.delete();

    res.json({ success: true, message: 'تم حذف الطلب بنجاح' });
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء حذف الطلب' });
  }
});

// Update inquiry
app.post('/admin/update-inquiry/:id', isAdminAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    const { status, response } = req.body;

    await db.collection('inquiries').doc(id).update({
      status,
      response,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating inquiry:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تحديث الاستفسار' });
  }
});

// Delete inquiry
app.delete('/admin/delete-inquiry/:id', isAdminAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;

    const docRef = db.collection('inquiries').doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'الاستفسار غير موجود' });
    }

    await docRef.delete();
    res.json({ success: true, message: 'تم حذف الاستفسار بنجاح' });
  } catch (error) {
    console.error('Error deleting inquiry:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء حذف الاستفسار' });
  }
});

// Send message (email)
app.post('/admin/send-message', isAdminAuthenticated, async (req, res) => {
  try {
    const { email, message, senderName = 'Clan King ESPORTS' } = req.body;

    await transporter.sendMail({
      from: `"${senderName}" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'رسالة من كلان King ESPORTS',
      html: `
<div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #4f46e5;">رسالة من Clan King ESPORTS</h2>
  <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin-top: 20px;">
    ${String(message || '').replace(/\n/g, '<br>')}
  </div>
  <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
    هذه الرسالة مرسلة من نظام Clan King ESPORTS - لا ترد على هذا البريد
    اذا احتجت الرد ابعت رسالتك هنا ${process.env.FRONTEND_URL || ''}/#inquiries
  </p>
</div>
`,
    });

    res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: 'فشل إرسال الرسالة' });
  }
});

// Upload result
app.post('/admin/upload-result', isAdminAuthenticated, upload.single('resultFile'), async (req, res) => {
  try {
    const { playerPhone, playerName = 'غير معروف', type = 'booking' } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'لم يتم اختيار ملف' });
    }

    const id = uuidv4();
    const fileUrl = '/uploads/' + req.file.filename;

    await db.collection('results').doc(id).set({
      id,
      playerPhone,
      playerName,
      fileUrl,
      type,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: 'تم رفع النتيجة بنجاح', fileUrl });
  } catch (error) {
    console.error('Error uploading result:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء رفع الملف' });
  }
});

// Update result
app.post('/admin/update-result', isAdminAuthenticated, upload.single('editResultFile'), async (req, res) => {
  try {
    const { id, playerPhone, playerName } = req.body;

    if (!id || !playerPhone) {
      return res.status(400).json({ success: false, message: 'معرّف النتيجة ورقم الهاتف مطلوبان' });
    }

    const docRef = db.collection('results').doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'النتيجة غير موجودة' });
    }

    const old = snap.data();
    const newFileUrl = req.file ? '/uploads/' + req.file.filename : old.fileUrl;

    // حذف الملف القديم لو في ملف جديد
    if (req.file && old.fileUrl) {
      const oldFilePath = publicPathFromUrl(old.fileUrl);
      if (fs.existsSync(oldFilePath)) {
        try { fs.unlinkSync(oldFilePath); } catch (e) { console.error('Error deleting old file:', e); }
      }
    }

    await docRef.update({
      playerPhone,
      playerName: playerName || null,
      fileUrl: newFileUrl,
    });

    res.json({ success: true, message: 'تم تحديث النتيجة بنجاح', fileUrl: newFileUrl });
  } catch (error) {
    console.error('Error updating result:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ غير متوقع أثناء تحديث النتيجة' });
  }
});

// Delete result
app.delete('/admin/delete-result/:id', isAdminAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;

    const docRef = db.collection('results').doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'النتيجة غير موجودة' });
    }

    const result = snap.data();

    if (result.fileUrl) {
      const filePath = publicPathFromUrl(result.fileUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await docRef.delete();

    res.json({ success: true, message: 'تم حذف النتيجة بنجاح' });
  } catch (error) {
    console.error('Error deleting result:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء حذف النتيجة' });
  }
});

/* =========================
   Static Routes
========================= */

app.get('/admin-login.html', (req, res) => {
  if (req.session.adminLoggedIn) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* =========================
   Start Server
========================= */

ensureAdminUser().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  }).on('error', (err) => {
    console.error('Server error:', err);
  });
});
