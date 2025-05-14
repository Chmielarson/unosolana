// src/firebase.js

// Funkcja do ograniczenia logowania - zastępuje console.log, unikając nadmiernego spamu
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Poziom szczegółowości logów: 0 - brak, 1 - podstawowe, 2 - debugowanie
const LOG_LEVEL = 1;
const LOG_HISTORY = {};
const LOG_THROTTLE_MS = 2000; // Minimalna przerwa między tymi samymi logami

// Zastąp oryginalne funkcje
console.log = function(...args) {
  if (LOG_LEVEL < 1) return;
  
  // Ograniczenie powtarzalnych logów
  const logString = args.map(arg => 
    typeof arg === 'object' ? '[Object]' : String(arg)
  ).join(' ');
  
  const now = Date.now();
  const lastLog = LOG_HISTORY[logString];
  
  if (lastLog && now - lastLog < LOG_THROTTLE_MS) {
    // Pomijamy log, bo niedawno był taki sam
    return;
  }
  
  LOG_HISTORY[logString] = now;
  originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
  // Błędy zawsze pokazujemy
  originalConsoleError.apply(console, args);
};

// Tylko w fazie debugowania:
window.enableFullLogging = function() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.log("Pełne logowanie włączone");
};

window.disableLogging = function() {
  console.log = function() {};
  console.error = function() {};
  console.log("Logowanie wyłączone");
};

import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { 
  getFirestore, 
  collection, 
  getDocs, 
  doc, 
  onSnapshot,
  query,
  where 
} from "firebase/firestore";

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

// Funkcje do słuchania zmian w czasie rzeczywistym

/**
 * Nasłuchuje zmian w liście pokojów
 * @param {Function} callback - Funkcja wywoływana przy każdej zmianie
 * @returns {Function} - Funkcja do anulowania nasłuchiwania
 */
export function listenForRooms(callback) {
  const roomsCollection = collection(db, 'rooms');
  // Dodanie warunków filtrowania - tylko aktywne pokoje bez zwycięzcy
  const q = query(
    roomsCollection, 
    where("isActive", "==", true),
    where("winner", "==", null)
  );
  
  return onSnapshot(q, (snapshot) => {
    const roomsData = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        creatorAddress: data.creatorAddress,
        maxPlayers: data.maxPlayers,
        currentPlayers: data.players.length,
        entryFee: data.entryFee,
        pool: data.entryFee * data.players.length,
        gameStarted: data.gameStarted,
        players: data.players
      };
    });
    callback(roomsData);
  }, (error) => {
    console.error("Error listening for rooms:", error);
  });
}

/**
 * Nasłuchuje zmian w konkretnym pokoju
 * @param {string} roomId - ID pokoju
 * @param {Function} callback - Funkcja wywoływana przy każdej zmianie
 * @returns {Function} - Funkcja do anulowania nasłuchiwania
 */
export function listenForRoom(roomId, callback) {
  const roomRef = doc(db, 'rooms', roomId);
  return onSnapshot(roomRef, (snapshot) => {
    if (snapshot.exists()) {
      const roomData = snapshot.data();
      callback({
        id: snapshot.id,
        creatorAddress: roomData.creatorAddress,
        maxPlayers: roomData.maxPlayers,
        currentPlayers: roomData.players.length,
        players: roomData.players,
        entryFee: roomData.entryFee,
        pool: roomData.entryFee * roomData.players.length,
        gameStarted: roomData.gameStarted,
        winner: roomData.winner,
        createdAt: roomData.createdAt,
        isActive: roomData.isActive === true, // Jawne porównanie
        endedAt: roomData.endedAt
      });
    }
  }, (error) => {
    console.error(`Error listening for room ${roomId}:`, error);
  });
}

/**
 * Nasłuchuje zmian w stanie gry
 * @param {string} roomId - ID pokoju
 * @param {string} playerAddress - Adres gracza
 * @param {Function} callback - Funkcja wywoływana przy każdej zmianie
 * @returns {Function} - Funkcja do anulowania nasłuchiwania
 */
export function listenForGameState(roomId, playerAddress, callback) {
  const gameStateRef = doc(db, 'gameStates', roomId);
  return onSnapshot(gameStateRef, (snapshot) => {
    if (snapshot.exists()) {
      const gameState = snapshot.data();
      // Pobierz również informacje o pokoju, aby uzyskać listę graczy
      const roomRef = doc(db, 'rooms', roomId);
      onSnapshot(roomRef, (roomSnapshot) => {
        if (roomSnapshot.exists()) {
          const roomData = roomSnapshot.data();
          
          // Zwróć stan gry z perspektywy danego gracza
          const playerState = {
            currentCard: gameState.currentCard,
            playerHand: gameState.playerHands[playerAddress] || [],
            currentPlayerIndex: Number(gameState.currentPlayerIndex),
            playerIndex: Number(roomData.players.indexOf(playerAddress)),
            playersCount: roomData.players.length,
            direction: gameState.direction,
            deckSize: gameState.deck.length,
            turnStartTime: gameState.turnStartTime, // Pole zawierające timestamp początku tury
            otherPlayersCardCount: roomData.players.reduce((acc, addr) => {
              if (addr !== playerAddress) {
                acc[addr] = (gameState.playerHands[addr] || []).length;
              }
              return acc;
            }, {}),
            lastAction: gameState.lastAction,
            winner: roomData.winner,
            isActive: roomData.isActive === true // Jawne porównanie
          };
          
          callback(playerState);
        }
      });
    }
  }, (error) => {
    console.error(`Error listening for game state ${roomId}:`, error);
  });
}

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