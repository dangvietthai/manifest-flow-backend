const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Khởi tạo Firebase Admin (Sử dụng Environment Variables trên Vercel)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
    });
  } catch (error) {
    console.error('Firebase Admin Init Error:', error);
  }
}

const db = admin.firestore();

module.exports = async (req, res) => {
  // 1. Cấu hình CORS để Extension có thể gọi được
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 2. Xác thực Token người dùng gửi lên từ Extension
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    
    // Giải mã token để lấy UID
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // 3. Kiểm tra trạng thái PRO trong Firestore
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    let isCurrentlyPro = false;

    if (userDoc.exists) {
      const data = userDoc.data();
      const now = admin.firestore.Timestamp.now();
      if (data.isPro === true) {
        isCurrentlyPro = true;
      } else if (data.proUntil && data.proUntil.toMillis() > now.toMillis()) {
        isCurrentlyPro = true;
      }
    }

    // 4. Nếu KHÔNG PHẢI PRO, kiểm tra giới hạn 30 lượt trên Server (Chống hack tuyệt đối)
    if (!isCurrentlyPro) {
      const today = new Date().toISOString().split('T')[0];
      const usageRef = db.collection('usage').doc(`${uid}_${today}`);
      const usageDoc = await usageRef.get();
      let count = usageDoc.exists ? usageDoc.data().count : 0;

      if (count >= 30) {
        return res.status(403).json({ 
          error: 'LIMIT_REACHED', 
          message: 'Bạn đã hết 30 lượt dùng thử hôm nay. Vui lòng nâng cấp PRO để tiếp tục!' 
        });
      }
      
      // Tăng số lượt dùng trên Server
      await usageRef.set({ 
        count: count + 1, 
        email: decodedToken.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp() 
      }, { merge: true });
    }

    // 5. Nếu mọi thứ OK, Vercel sẽ thay mặt Extension gọi API của Google
    const { url, method, headers, body } = req.body;
    
    // Bảo mật: Chỉ cho phép gọi đến đúng domain của Google Flow
    if (!url.includes('labs.google/fx') && !url.includes('aisandbox-pa.googleapis.com')) {
      return res.status(400).json({ error: 'Invalid Target URL' });
    }

    const googleResp = await fetch(url, {
      method: method || 'POST',
      headers: headers, // Bao gồm cả Authorization Token của khách hàng
      body: JSON.stringify(body)
    });

    const googleData = await googleResp.json();
    return res.status(googleResp.status).json(googleData);

  } catch (error) {
    console.error('Vercel Proxy Error:', error);
    return res.status(500).json({ error: 'Server Error', details: error.message });
  }
};
