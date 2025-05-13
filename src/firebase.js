// src/firebase.js
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore, collection, getDocs } from "firebase/firestore";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD3nRBqvjbB2kyJu-uxuI-tJB8AUuUNeII",
  authDomain: "unosolana-b0e9c.firebaseapp.com",
  projectId: "unosolana-b0e9c",
  storageBucket: "unosolana-b0e9c.firebasestorage.app",
  messagingSenderId: "50005512704",
  appId: "1:50005512704:web:5d4cfbd81e9dd09c85bee5",
  measurementId: "G-0T1ZG43155"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);

// Test Firestore connection
async function testFirestoreConnection() {
  try {
    console.log("Testing Firestore connection...");
    const roomsCollection = collection(db, 'rooms');
    const roomsSnapshot = await getDocs(roomsCollection);
    console.log("Firestore connection successful. Rooms:", roomsSnapshot.docs.map(doc => doc.id));
  } catch (error) {
    console.error("Firestore connection test failed:", error);
  }
}

// Run the test when the app starts
testFirestoreConnection();

export { db };