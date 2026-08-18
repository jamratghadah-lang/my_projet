// firebase-init.js
// تهيئة Firebase — تُستخدم من كل صفحات لوحة التحكم (dashboard/*.html)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
  onSnapshot,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAAYOne0CTht9906nStecbqCHkb_CY6glw",
  authDomain: "jamrat-ghadah.firebaseapp.com",
  projectId: "jamrat-ghadah",
  storageBucket: "jamrat-ghadah.firebasestorage.app",
  messagingSenderId: "283693105617",
  appId: "1:283693105617:web:45645ef4e088f54934a0f0",
  measurementId: "G-VBK8QNSTJV",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
  onSnapshot,
  deleteField,
};

// حماية أي صفحة لوحة تحكم: يستدعيها كل ملف Dashboard في بداية تنفيذه
// لو ما فيه تسجيل دخول، يرجع المستخدم لصفحة login.html
export function requireLogin(onReady, allowedRoles = ["staff", "admin", "super_admin"]) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      const role = snap.exists() ? String(snap.data().role || "") : "";
      if (!allowedRoles.includes(role)) {
        await signOut(auth);
        window.location.href = "login.html?error=unauthorized";
        return;
      }
      onReady(user, role);
    } catch (err) {
      console.error("Dashboard authorization failed");
      await signOut(auth);
      window.location.href = "login.html?error=unauthorized";
    }
  });
}
