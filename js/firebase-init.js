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
  serverTimestamp,
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
  serverTimestamp,
};

// حماية أي صفحة لوحة تحكم: يستدعيها كل ملف Dashboard في بداية تنفيذه
// لو ما فيه تسجيل دخول، يرجع المستخدم لصفحة login.html
export function requireLogin(onReady) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "login.html";
    } else {
      onReady(user);
    }
  });
}
