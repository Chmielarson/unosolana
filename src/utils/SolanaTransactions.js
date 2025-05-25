// src/utils/SolanaTransactions.js
import { 
  Connection, 
  SystemProgram, 
  Transaction, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  clusterApiUrl,
  TransactionInstruction
} from '@solana/web3.js';
import io from 'socket.io-client';
import { Buffer } from 'buffer';

// Połączenie z siecią Solana
const NETWORK = process.env.REACT_APP_SOLANA_NETWORK || 'devnet';
const connection = new Connection(clusterApiUrl(NETWORK), 'confirmed');

// Adres serwera gry - domyślnie localhost dla developmentu
const GAME_SERVER_URL = process.env.REACT_APP_GAME_SERVER_URL || 'http://localhost:3001';

// Adres programu Solana (smart contract)
const PROGRAM_ID = new PublicKey(process.env.REACT_APP_PROGRAM_ID || 'E3Am45cxhcUSanKtqrLW9kSpE3M2U674RjTsidb6yYNj');

// Stałe dla Solana
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

// Socket.IO dla komunikacji w czasie rzeczywistym
let socket = null;
let socketConnected = false;
let roomSubscriptions = new Map(); // Mapa subskrypcji pokojów
let gameStateSubscriptions = new Map(); // Mapa subskrypcji stanów gier

// ========== SERIALIZACJA DANYCH BORSH DLA INSTRUKCJI PROGRAMU SOLANA ==========

/*
WAŻNE: Te funkcje serializacji muszą odpowiadać strukturom w programie Rust:

pub enum UnoInstruction {
    CreateRoom {        // Tag: 0
        max_players: u8,        // 1 bajt na pozycji 1
        entry_fee_lamports: u64, // 8 bajtów na pozycji 2-9 (little-endian)
        room_slot: u8,          // 1 bajt na pozycji 10
    },
    JoinRoom,           // Tag: 1 (tylko tag)
    StartGame {         // Tag: 2
        game_id: String,        // u32 długość + UTF-8 bajty
    },
    EndGame {           // Tag: 3
        winner: Pubkey,         // 32 bajty
    },
    ClaimPrize,         // Tag: 4 (tylko tag)
    CancelRoom,         // Tag: 5 (tylko tag)
}

Porządek bajtów: little-endian dla liczb, UTF-8 dla stringów
*/

// Serializacja instrukcji CreateRoom z room_slot
function serializeCreateRoomData(maxPlayers, entryFee, roomSlot = 0) {
  // Tworzymy bufor odpowiedniej wielkości: 1 + 1 + 8 + 1 = 11 bajtów
  const buffer = Buffer.alloc(11);
  
  // Instrukcja CreateRoom (0)
  buffer.writeUInt8(0, 0);
  
  // max_players: u8
  buffer.writeUInt8(maxPlayers, 1);
  
  // entry_fee_lamports: u64 (zapisane jako little-endian)
  const entryFeeLamports = Math.round(entryFee * LAMPORTS_PER_SOL);
  console.log("Entry fee:", entryFee, "SOL =", entryFeeLamports, "lamports");
  
  // Sprawdź, czy wartość mieści się w zakresie u64
  if (entryFeeLamports < 0) {
    throw new Error("Entry fee cannot be negative");
  }
  
  // Używamy Buffer.writeBigUInt64LE na pozycji 2
  buffer.writeBigUInt64LE(BigInt(entryFeeLamports), 2);
  
  // room_slot: u8 na pozycji 10
  buffer.writeUInt8(roomSlot, 10);
  
  console.log("Serialized CreateRoom data:", {
    instruction: buffer[0],
    maxPlayers: buffer[1], 
    entryFeeLamports: entryFeeLamports,
    roomSlot: buffer[10],
    bufferLength: buffer.length,
    buffer: Array.from(buffer)
  });
  
  return buffer;
}

// Serializacja instrukcji JoinRoom
function serializeJoinRoomData() {
  const buffer = Buffer.alloc(1);
  
  // Instrukcja JoinRoom (1)  
  buffer.writeUInt8(1, 0);
  
  console.log("Serialized JoinRoom data:", Array.from(buffer));
  return buffer;
}

// Serializacja instrukcji StartGame
function serializeStartGameData(gameId) {
  // Oblicz długość potrzebną: 1 bajt instrukcji + 4 bajty długość stringa + długość stringa
  const gameIdBytes = Buffer.from(gameId, 'utf8');
  const buffer = Buffer.alloc(1 + 4 + gameIdBytes.length);
  
  // Instrukcja StartGame (2)
  buffer.writeUInt8(2, 0);
  
  // Długość gameId jako u32 (little-endian)
  buffer.writeUInt32LE(gameIdBytes.length, 1);
  
  // Zawartość gameId
  gameIdBytes.copy(buffer, 5);
  
  console.log("Serialized StartGame data:", {
    instruction: buffer[0],
    gameIdLength: buffer.readUInt32LE(1), 
    gameId: gameId,
    bufferLength: buffer.length,
    buffer: Array.from(buffer)
  });
  
  return buffer;
}

// Serializacja instrukcji EndGame
function serializeEndGameData(winnerPubkey) {
  const buffer = Buffer.alloc(1 + 32); // 1 bajt instrukcji + 32 bajty pubkey
  
  // Instrukcja EndGame (3)
  buffer.writeUInt8(3, 0);
  
  // Winner Pubkey (32 bajty)
  const winnerPubkeyBuffer = winnerPubkey.toBuffer();
  winnerPubkeyBuffer.copy(buffer, 1);
  
  console.log("Serialized EndGame data:", {
    instruction: buffer[0],
    winner: winnerPubkey.toString(),
    bufferLength: buffer.length
  });
  
  return buffer;
}

// Serializacja instrukcji ClaimPrize
function serializeClaimPrizeData() {
  const buffer = Buffer.alloc(1);
  
  // Instrukcja ClaimPrize (4)
  buffer.writeUInt8(4, 0);
  
  return buffer;
}

// Serializacja instrukcji CancelRoom
function serializeCancelRoomData() {
  const buffer = Buffer.alloc(1);
  
  // Instrukcja CancelRoom (5)
  buffer.writeUInt8(5, 0);
  
  return buffer;
}

// ========== FUNKCJE POMOCNICZE ==========

// Znajdź adres PDA dla pokoju gry z uwzględnieniem slotu
async function findGamePDA(creatorPubkey, roomSlot = 0) {
  return await PublicKey.findProgramAddress(
    [Buffer.from('uno_game'), creatorPubkey.toBuffer(), Buffer.from([roomSlot])],
    PROGRAM_ID
  );
}

// Inicjalizacja i zarządzanie Socket.IO
function initializeSocket() {
  if (socket && socket.connected) {
    console.log('Socket already connected');
    return socket;
  }
  
  if (!socket) {
    console.log('Creating new socket connection to:', GAME_SERVER_URL);
    socket = io(GAME_SERVER_URL, {
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      autoConnect: true,
      transports: ['websocket', 'polling'] // Dodaj transport options
    });
    
    // Globalne handlery
    socket.on('connect', () => {
      console.log('✅ Connected to game server:', socket.id);
      socketConnected = true;
      
      // Emit custom event dla komponentów
      window.dispatchEvent(new CustomEvent('socketConnected', { detail: { socketId: socket.id } }));
    });
    
    socket.on('disconnect', (reason) => {
      console.log('❌ Disconnected from game server:', reason);
      socketConnected = false;
      
      window.dispatchEvent(new CustomEvent('socketDisconnected', { detail: { reason } }));
    });
    
    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
    });
    
    socket.on('reconnect', (attemptNumber) => {
      console.log('Reconnected after', attemptNumber, 'attempts');
      recheckSubscriptions();
    });
  }
  
  // Jeśli socket istnieje ale nie jest połączony, połącz
  if (!socket.connected) {
    console.log('Connecting socket...');
    socket.connect();
  }
  
  return socket;
}

// Dodaj funkcję pomocniczą do sprawdzenia stanu socket
export function getSocketStatus() {
  return {
    exists: !!socket,
    connected: socket?.connected || false,
    id: socket?.id || null
  };
}

// Eksportuj socket dla komponentów
export function getSocket() {
  return initializeSocket();
}

// Ponowna subskrypcja wszystkich pokojów i stanów gier
function recheckSubscriptions() {
  if (!socket || !socketConnected) return;
  
  // Ponowna subskrypcja pokojów
  for (const [roomId, callback] of roomSubscriptions.entries()) {
    console.log('Re-subscribing to room:', roomId);
    socket.emit('subscribe_room', { roomId });
  }
  
  // Ponowna subskrypcja stanów gier
  for (const [data, callback] of gameStateSubscriptions.entries()) {
    const { roomId, playerAddress } = JSON.parse(data);
    console.log('Re-subscribing to game state:', { roomId, playerAddress });
    socket.emit('join_game', { roomId, playerAddress });
  }
}

// Funkcja do obsługi błędów HTTP
async function handleApiResponse(response) {
  if (!response.ok) {
    // Próba odczytu szczegółów błędu
    try {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    } catch (e) {
      // Jeśli nie udało się odczytać JSON, użyj ogólnego komunikatu
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }
  
  return await response.json();
}

// Retry z eksponencjalnym opóźnieniem dla wywołań API
async function retryFetch(url, options, maxRetries = 3) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const response = await fetch(url, options);
      return await handleApiResponse(response);
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        throw error;
      }
      
      // Eksponencjalne opóźnienie przed ponowną próbą
      const delay = Math.min(1000 * Math.pow(2, retries), 10000);
      console.log(`Retry ${retries}/${maxRetries} after ${delay}ms for ${url}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ========== FUNKCJE API SERWERA GRY ==========

// Funkcja do pobrania listy pokojów
export async function getRooms() {
  console.log("Getting rooms list from server");
  try {
    return await retryFetch(`${GAME_SERVER_URL}/api/rooms`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error getting rooms:', error);
    throw error;
  }
}

// Funkcja do nasłuchiwania aktualizacji pokojów
export function getRoomsUpdates(callback) {
  console.log("Setting up rooms updates listener");
  
  // Inicjalizuj Socket.IO, jeśli nie jest zainicjalizowane
  initializeSocket();
  
  // Usuń istniejącą subskrypcję, jeśli istnieje
  if (socket) {
    socket.off('rooms_update');
  }
  
  // Nasłuchuj aktualizacji pokojów
  socket.on('rooms_update', (rooms) => {
    console.log('Received rooms update:', rooms.length);
    callback(rooms);
  });
  
  // Zażądaj początkowej listy pokojów
  socket.emit('get_rooms');
  
  // Zwróć funkcję do anulowania nasłuchiwania
  return () => {
    if (socket) {
      socket.off('rooms_update');
    }
  };
}

// Funkcja do nasłuchiwania zmian w pokoju
export function listenForRoom(roomId, callback) {
  console.log("Setting up room listener for:", roomId);
  
  // Inicjalizuj Socket.IO, jeśli nie jest zainicjalizowane
  initializeSocket();
  
  // Zapisz callback w mapie subskrypcji
  roomSubscriptions.set(roomId, callback);
  
  // Anuluj poprzednią subskrypcję
  if (socket) {
    socket.off(`room_update_${roomId}`);
  }
  
  // Nasłuchuj aktualizacji pokoju
  socket.on(`room_update_${roomId}`, (roomData) => {
    console.log('Received room update:', roomId);
    callback(roomData);
  });
  
  // Zażądaj subskrypcji pokoju
  socket.emit('subscribe_room', { roomId });
  
  // Zwróć funkcję do anulowania nasłuchiwania
  return () => {
    if (socket) {
      socket.off(`room_update_${roomId}`);
    }
    roomSubscriptions.delete(roomId);
  };
}

// Funkcja do tworzenia nowego pokoju z obsługą slotów
export async function createRoom(maxPlayers, entryFee, wallet) {
  console.log("Creating room with parameters:", { maxPlayers, entryFee });
  
  // Walidacja parametrów wejściowych
  if (!maxPlayers || maxPlayers < 2 || maxPlayers > 4) {
    throw new Error('Liczba graczy musi być między 2 a 4');
  }
  
  if (!entryFee || entryFee <= 0) {
    throw new Error('Wpisowe musi być większe od 0');
  }
  
  if (entryFee > 10) {
    throw new Error('Wpisowe nie może być większe niż 10 SOL');
  }
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }

  console.log("Wallet info:", {
    publicKey: publicKey.toString(),
    hasSignTransaction: typeof signTransaction === 'function'
  });

  try {
    // Znajdź wolny slot pokoju (od 0 do 9)
    let roomSlot = 0;
    let gamePDA = null;
    let bump = null;
    let foundFreeSlot = false;
    
    // Sprawdź który slot jest wolny
    for (let slot = 0; slot < 10; slot++) {
      const [pda, bumpSeed] = await findGamePDA(publicKey, slot);
      
      try {
        // Sprawdź czy konto już istnieje
        const accountInfo = await connection.getAccountInfo(pda);
        
        if (!accountInfo) {
          // Ten slot jest wolny
          roomSlot = slot;
          gamePDA = pda;
          bump = bumpSeed;
          foundFreeSlot = true;
          break;
        }
      } catch (error) {
        // Slot jest wolny
        roomSlot = slot;
        gamePDA = pda;
        bump = bumpSeed;
        foundFreeSlot = true;
        break;
      }
    }
    
    if (!foundFreeSlot) {
      throw new Error('Wszystkie sloty pokojów są zajęte. Maksymalnie możesz mieć 10 aktywnych pokojów.');
    }
    
    console.log("Using room slot:", roomSlot);
    console.log("Game PDA found:", {
      address: gamePDA.toString(),
      bump,
      creator: publicKey.toString(),
      programId: PROGRAM_ID.toString(),
      slot: roomSlot
    });
    
    // Serializuj dane instrukcji z room_slot
    const data = serializeCreateRoomData(maxPlayers, entryFee, roomSlot);
    
    // Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: gamePDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: data
    });
    
    console.log("Instruction created:", {
      keys: instruction.keys.map(k => ({
        pubkey: k.pubkey.toString(),
        isSigner: k.isSigner,
        isWritable: k.isWritable
      })),
      programId: instruction.programId.toString(),
      dataLength: instruction.data.length,
      data: Array.from(instruction.data)
    });
    
    // Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // Wyświetl szczegóły transakcji przed wysłaniem
    console.log("Transaction details:", {
      blockhash: transaction.recentBlockhash,
      feePayer: transaction.feePayer?.toString(),
      instructionsCount: transaction.instructions.length,
      signatures: transaction.signatures.length
    });
    
    // Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
      console.log("Transaction signed successfully");
    } catch (signError) {
      console.error("Error signing transaction:", signError);
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // Wyślij transakcję
    console.log("Sending transaction...");
    const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    
    console.log("Transaction sent, signature:", signature);
    
    // Poczekaj na potwierdzenie
    console.log("Waiting for confirmation...");
    const confirmation = await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log("Room creation transaction confirmed:", signature);
    
    // Zarejestruj pokój na serwerze
    const roomData = await retryFetch(`${GAME_SERVER_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorAddress: publicKey.toString(),
        maxPlayers,
        entryFee,
        roomAddress: gamePDA.toString(),
        roomSlot, // Dodaj slot do danych
        transactionSignature: signature
      }),
    });
    
    console.log("Room registered on server:", roomData);
    
    return roomData.roomId;
  } catch (error) {
    console.error('Error creating room:', error);
    
    // Jeśli to błąd SendTransaction, spróbuj uzyskać dodatkowe informacje
    if (error.name === 'SendTransactionError') {
      try {
        const logs = await error.getLogs();
        console.error('Transaction logs:', logs);
      } catch (logError) {
        console.error('Could not get transaction logs:', logError);
      }
    }
    
    throw error;
  }
}

// Funkcja do dołączania do pokoju
export async function joinRoom(roomId, entryFee, wallet) {
  console.log("Joining room:", { roomId, entryFee });
  
  if (!roomId) {
    throw new Error('Brak identyfikatora pokoju');
  }
  
  if (typeof entryFee !== 'number' || isNaN(entryFee) || entryFee <= 0) {
    throw new Error('Nieprawidłowa kwota wpisowego');
  }
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }

  try {
    // 1. Pobierz dane pokoju z serwera
    const roomData = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log("Room data from server:", roomData);
    
    // 2. Pobierz adres PDA pokoju
    const roomPDA = new PublicKey(roomData.roomAddress);
    
    // 3. Serializuj dane instrukcji
    const data = serializeJoinRoomData();
    
    // 4. Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: roomPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: data
    });
    
    // 5. Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // 6. Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // 7. Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // 8. Wyślij transakcję
    console.log("Sending join room transaction...");
    const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    
    console.log("Join room transaction sent, signature:", signature);
    
    // 9. Poczekaj na potwierdzenie
    console.log("Waiting for confirmation...");
    const confirmation = await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log("Join room transaction confirmed:", signature);
    
    // 10. Powiadom serwer o dołączeniu gracza
    const joinResult = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerAddress: publicKey.toString(),
        transactionSignature: signature
      }),
    });
    
    console.log("Join room completed successfully:", joinResult);
    return joinResult;
  } catch (error) {
    console.error('Error joining room:', error);
    
    // Jeśli to błąd SendTransaction, spróbuj uzyskać dodatkowe informacje
    if (error.name === 'SendTransactionError') {
      try {
        const logs = await error.getLogs();
        console.error('Transaction logs:', logs);
      } catch (logError) {
        console.error('Could not get transaction logs:', logError);
      }
    }
    
    throw error;
  }
}

// Funkcja do opuszczania gry
export async function leaveGame(roomId, wallet) {
  console.log("Leaving game:", roomId);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  try {
    // Powiadom serwer o opuszczeniu pokoju
    const leaveResult = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerAddress: publicKey.toString()
      }),
    });
    
    // Jeśli gra była w toku i jest inny gracz, zakończ grę na łańcuchu
    if (leaveResult.wasActive && leaveResult.opponentWins) {
      await endGame(roomId, leaveResult.opponentAddress, wallet);
    }
    
    // Rozłącz socket.io, jeśli istnieje
    if (socket && socket.connected) {
      socket.emit('leave_game', { roomId, playerAddress: publicKey.toString() });
    }
    
    return leaveResult;
  } catch (error) {
    console.error('Error leaving game:', error);
    throw error;
  }
}

// Funkcja do pobrania informacji o pokoju
export async function getRoomInfo(roomId) {
  console.log("Getting room info for room:", roomId);
  
  try {
    const roomData = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log("Room data from server:", roomData);
    
    return {
      id: roomId,
      creatorAddress: roomData.creatorAddress,
      maxPlayers: roomData.maxPlayers,
      currentPlayers: roomData.players.length,
      players: roomData.players,
      entryFee: roomData.entryFee,
      pool: roomData.entryFee * roomData.players.length,
      gameStarted: roomData.gameStarted,
      gameId: roomData.gameId,
      winner: roomData.winner,
      createdAt: roomData.createdAt,
      isActive: roomData.isActive,
      endedAt: roomData.endedAt,
      lastActivity: roomData.lastActivity,
      roomAddress: roomData.roomAddress,
      roomSlot: roomData.roomSlot,
      blockchainEnded: roomData.blockchainEnded || false
    };
  } catch (error) {
    console.error('Error getting room info:', error);
    throw error;
  }
}

// Funkcja rozpoczynająca grę on-chain
export async function startGame(roomId, wallet) {
  console.log("Starting game for room:", roomId);
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  try {
    // 1. Pobierz dane pokoju z serwera
    const roomData = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log("Room data from server:", roomData);
    
    // 2. Wygeneruj unikalny identyfikator gry
    const gameId = `game_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    
    // 3. Pobierz adres PDA pokoju
    const roomPDA = new PublicKey(roomData.roomAddress);
    
    // 4. Serializuj dane instrukcji
    const data = serializeStartGameData(gameId);
    
    // 5. Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: roomPDA, isSigner: false, isWritable: true },
      ],
      programId: PROGRAM_ID,
      data: data
    });
    
    // 6. Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // 7. Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // 8. Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // 9. Wyślij transakcję
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    
    // 10. Poczekaj na potwierdzenie
    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    console.log("Start game transaction confirmed:", signature);
    
    // 11. Powiadom serwer o rozpoczęciu gry
    const startResult = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId,
        initiatorAddress: publicKey.toString(),
        transactionSignature: signature
      }),
    });
    
    // 12. Połącz z serwerem gry przez WebSocket
    await connectToGameServer(roomId, gameId, publicKey.toString());
    
    console.log("Game started successfully:", startResult);
    return gameId;
  } catch (error) {
    console.error('Error starting game:', error);
    throw error;
  }
}

// Funkcja kończąca grę on-chain
export async function endGame(roomId, winnerAddress, wallet) {
  console.log("Ending game:", { roomId, winnerAddress });
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  try {
    // 1. Pobierz dane pokoju z serwera
    const roomData = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log("Room data for ending game:", roomData);
    
    // Sprawdź czy gra nie została już zakończona
    if (roomData.blockchainEnded) {
      console.log("Game already ended on blockchain");
      return { success: true, alreadyEnded: true };
    }
    
    // 2. Pobierz adres PDA pokoju
    const roomPDA = new PublicKey(roomData.roomAddress);
    
    // 3. Utwórz PublicKey dla zwycięzcy
    const winnerPubkey = new PublicKey(winnerAddress);
    
    // 4. Serializuj dane instrukcji
    const data = serializeEndGameData(winnerPubkey);
    
    // 5. Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: roomPDA, isSigner: false, isWritable: true },
      ],
      programId: PROGRAM_ID,
      data: data
    });
    
    // 6. Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // 7. Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // 8. Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // 9. Wyślij transakcję
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    
    // 10. Poczekaj na potwierdzenie
    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    console.log("End game transaction confirmed:", signature);
    
    // 11. Powiadom serwer o zakończeniu gry
    const endResult = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        winnerAddress: winnerAddress,
        transactionSignature: signature
      }),
    });
    
    console.log("Game ended successfully:", endResult);
    return endResult;
  } catch (error) {
    console.error('Error ending game:', error);
    throw error;
  }
}

// Funkcja do odebrania nagrody przez zwycięzcę
export async function claimPrize(roomId, wallet) {
  console.log("Claiming prize for room:", roomId);
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  try {
    // 1. Pobierz dane pokoju z serwera
    const roomData = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log("Room data for claiming prize:", roomData);
    
    // 2. Sprawdź, czy gracz jest zwycięzcą
    if (roomData.winner !== publicKey.toString()) {
      throw new Error('Tylko zwycięzca może odebrać nagrodę');
    }
    
    // 3. Sprawdź, czy nagroda nie została już odebrana
    if (roomData.prizeClaimedBy) {
      throw new Error('Nagroda została już odebrana');
    }
    
    // 4. Pobierz adres PDA pokoju
    const roomPDA = new PublicKey(roomData.roomAddress);
    
    // 5. Serializuj dane instrukcji
    const data = serializeClaimPrizeData();
    
    // 6. Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: roomPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: data
    });
    
    // 7. Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // 8. Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // 9. Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // 10. Wyślij transakcję
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    
    // 11. Poczekaj na potwierdzenie
    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    console.log("Claim prize transaction confirmed:", signature);
    
    // 12. Powiadom serwer o odebraniu nagrody
    const claimResult = await retryFetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimerAddress: publicKey.toString(),
        transactionSignature: signature
      }),
    });
    
    const prize = roomData.entryFee * roomData.players.length;
    
    console.log("Prize claimed successfully:", prize, "SOL");
    return {
      winner: publicKey.toString(),
      prize,
      claimedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error claiming prize:', error);
    throw error;
  }
}

// ========== FUNKCJE SOCKET.IO DLA GRY W CZASIE RZECZYWISTYM ==========

// Połączenie z serwerem gry przez Socket.IO
export function connectToGameServer(roomId, gameId, playerAddress) {
  console.log("Connecting to game server:", { roomId, gameId, playerAddress });
  
  return new Promise((resolve, reject) => {
    // Inicjalizuj Socket.IO
    const socket = initializeSocket();
    
    if (socket.connected) {
      console.log("Socket already connected, joining game room");
      socket.emit('join_game', { roomId, gameId, playerAddress });
      
      // Ustaw handler dla potwierdzenia dołączenia
      const joinHandler = (data) => {
        if (data.roomId === roomId) {
          console.log("Joined game room successfully:", data);
          socket.off('join_game_confirm', joinHandler);
          resolve(true);
        }
      };
      
      socket.on('join_game_confirm', joinHandler);
      
      // Ustaw timeout na połączenie
      const timeoutId = setTimeout(() => {
        socket.off('join_game_confirm', joinHandler);
        reject(new Error('Timeout connecting to game server'));
      }, 10000);
      
      // Ustaw handler dla błędów
      const errorHandler = (error) => {
        console.error("Error joining game room:", error);
        socket.off('join_game_confirm', joinHandler);
        socket.off('error', errorHandler);
        clearTimeout(timeoutId);
        reject(error);
      };
      
      socket.on('error', errorHandler);
    } else {
      console.log("Socket not connected, waiting for connection");
      
      // Przygotuj handler dla połączenia
      const connectHandler = () => {
        console.log("Socket connected, joining game room");
        socket.emit('join_game', { roomId, gameId, playerAddress });
        
        // Ustaw handler dla potwierdzenia dołączenia
        const joinHandler = (data) => {
          if (data.roomId === roomId) {
            console.log("Joined game room successfully:", data);
            socket.off('join_game_confirm', joinHandler);
            socket.off('connect', connectHandler);
            resolve(true);
          }
        };
        
        socket.on('join_game_confirm', joinHandler);
      };
      
      socket.on('connect', connectHandler);
      
      // Ustaw timeout na połączenie
      const timeoutId = setTimeout(() => {
        socket.off('connect', connectHandler);
        reject(new Error('Timeout connecting to game server'));
      }, 15000);
      
      // Ustaw handler dla błędów
      const errorHandler = (error) => {
        console.error("Error connecting to game server:", error);
        socket.off('connect', connectHandler);
        socket.off('error', errorHandler);
        clearTimeout(timeoutId);
        reject(error);
      };
      
      socket.on('error', errorHandler);
    }
  });
}

// Pobierz stan gry z serwera
export async function getGameState(roomId, wallet) {
  console.log("Getting game state for room:", roomId);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  const playerAddress = publicKey.toString();
  
  // Upewnij się, że socket.io jest zainicjalizowane
  const socket = initializeSocket();
  
  return new Promise((resolve, reject) => {
    // Jeśli socket jest już połączony, zażądaj stanu gry
    if (socket.connected) {
      const requestId = Date.now().toString();
      
      console.log("Requesting game state:", { roomId, playerAddress, requestId });
      socket.emit('get_game_state', { roomId, playerAddress, requestId });
      
      // Ustaw handler dla odpowiedzi
      const gameStateHandler = (data) => {
        if (data.requestId === requestId) {
          console.log("Received game state:", { roomId, requestId });
          socket.off('game_state', gameStateHandler);
          resolve(data.gameState);
        }
      };
      
      socket.on('game_state', gameStateHandler);
      
      // Ustaw timeout na odpowiedź
      const timeoutId = setTimeout(() => {
        socket.off('game_state', gameStateHandler);
        
        // Alternatywnie, spróbuj pobrać dane przez REST API
        console.log("Socket timeout, trying REST API");
        retryFetch(`${GAME_SERVER_URL}/api/game/${roomId}/state?playerAddress=${encodeURIComponent(playerAddress)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        })
          .then(gameState => resolve(gameState))
          .catch(error => reject(error));
      }, 5000);
      
      // Ustaw handler dla błędów
      const errorHandler = (error) => {
        console.error("Error getting game state:", error);
        socket.off('game_state', gameStateHandler);
        socket.off('error', errorHandler);
        clearTimeout(timeoutId);
        reject(error);
      };
      
      socket.on('error', errorHandler);
    } else {
      // Spróbuj pobrać dane przez REST API, jeśli socket nie jest połączony
      console.log("Socket not connected, using REST API");
      retryFetch(`${GAME_SERVER_URL}/api/game/${roomId}/state?playerAddress=${encodeURIComponent(playerAddress)}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(gameState => resolve(gameState))
        .catch(error => reject(error));
    }
  });
}

// Nasłuchiwanie na zmiany stanu gry
export function listenForGameState(roomId, playerAddress, callback) {
  console.log("Setting up game state listener:", { roomId, playerAddress });
  
  // Inicjalizuj Socket.IO
  const socket = initializeSocket();
  
  // Klucz do mapy subskrypcji
  const subscriptionKey = JSON.stringify({ roomId, playerAddress });
  
  // Zapisz callback w mapie subskrypcji
  gameStateSubscriptions.set(subscriptionKey, callback);
  
  // Ustaw handler dla aktualizacji stanu gry
  const gameStateUpdateHandler = (data) => {
    if (data.roomId === roomId) {
      console.log("Game state update received:", { roomId, timestamp: new Date().toISOString() });
      callback(data);
    }
  };
  
  // Anuluj poprzednią subskrypcję
  if (socket) {
    socket.off('game_state_update', gameStateUpdateHandler);
  }
  
  // Nasłuchuj aktualizacji stanu gry
  socket.on('game_state_update', gameStateUpdateHandler);
  
  // Dołącz do pokoju, jeśli socket jest połączony
  if (socket.connected) {
    socket.emit('join_game', { roomId, playerAddress });
  }
  
  // Zwróć funkcję do anulowania nasłuchiwania
  return () => {
    if (socket) {
      socket.off('game_state_update', gameStateUpdateHandler);
    }
    gameStateSubscriptions.delete(subscriptionKey);
  };
}

// Zagranie karty - ZMODYFIKOWANA FUNKCJA
export async function playCard(roomId, cardIndex, chosenColor = null, wallet) {
  console.log("Playing card:", { roomId, cardIndex, chosenColor });
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  const playerAddress = publicKey.toString();
  
  // Inicjalizuj Socket.IO
  const socket = initializeSocket();
  
  return new Promise((resolve, reject) => {
    // Jeśli socket jest połączony, wyślij ruch
    if (socket.connected) {
      const requestId = Date.now().toString();
      
      console.log("Sending play card request:", { roomId, cardIndex, requestId });
      socket.emit('play_card', { 
        roomId, 
        playerAddress, 
        cardIndex, 
        chosenColor,
        requestId
      });
      
      // Ustaw handler dla odpowiedzi
      const playCardResultHandler = async (data) => {
        if (data.requestId === requestId) {
          console.log("Play card result received:", data);
          socket.off('play_card_result', playCardResultHandler);
          
          if (data.error) {
            reject(new Error(data.error));
          } else {
            // WAŻNE: Jeśli gracz wygrał, automatycznie zakończ grę na blockchainie
            if (data.winner === playerAddress) {
              console.log("Player won! Ending game on blockchain...");
              
              try {
                // Poczekaj chwilę, aby serwer zaktualizował stan
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Wywołaj endGame na blockchainie
                const endGameResult = await endGame(roomId, playerAddress, wallet);
                console.log("Game ended on blockchain successfully:", endGameResult);
                
                // Dodaj flagę, że gra została zakończona
                data.gameEndedOnChain = true;
              } catch (endError) {
                console.error("Error ending game on blockchain:", endError);
                // Nie przerywaj procesu, ale zaznacz błąd
                data.endGameError = endError.message;
              }
            }
            
            resolve(data);
          }
        }
      };
      
      socket.on('play_card_result', playCardResultHandler);
      
      // Ustaw timeout na odpowiedź
      const timeoutId = setTimeout(() => {
        socket.off('play_card_result', playCardResultHandler);
        reject(new Error('Timeout playing card'));
      }, 15000); // Zwiększony timeout dla transakcji blockchain
      
      // Ustaw handler dla błędów
      const errorHandler = (error) => {
        console.error("Error playing card:", error);
        socket.off('play_card_result', playCardResultHandler);
        socket.off('error', errorHandler);
        clearTimeout(timeoutId);
        reject(error);
      };
      
      socket.on('error', errorHandler);
    } else {
      // Jeśli socket nie jest połączony, użyj REST API
      console.log("Socket not connected, using REST API");
      retryFetch(`${GAME_SERVER_URL}/api/game/${roomId}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerAddress,
          cardIndex,
          chosenColor
        })
      })
        .then(async (result) => {
          // Jeśli gracz wygrał, zakończ grę na blockchainie
          if (result.winner === playerAddress) {
            try {
              await endGame(roomId, playerAddress, wallet);
              result.gameEndedOnChain = true;
            } catch (endError) {
              console.error("Error ending game on blockchain:", endError);
              result.endGameError = endError.message;
            }
          }
          resolve(result);
        })
        .catch(error => reject(error));
    }
  });
}

// Dobranie karty
export async function drawCard(roomId, wallet) {
  console.log("Drawing card from room:", roomId);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  const playerAddress = publicKey.toString();
  
  // Inicjalizuj Socket.IO
  const socket = initializeSocket();
  
  return new Promise((resolve, reject) => {
    // Jeśli socket jest połączony, wyślij żądanie dobrania karty
    if (socket.connected) {
      const requestId = Date.now().toString();
      
      console.log("Sending draw card request:", { roomId, requestId });
      socket.emit('draw_card', { 
        roomId, 
        playerAddress,
        requestId
      });
      
      // Ustaw handler dla odpowiedzi
      const drawCardResultHandler = (data) => {
        if (data.requestId === requestId) {
          console.log("Draw card result received:", data);
          socket.off('draw_card_result', drawCardResultHandler);
          
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data.card);
          }
        }
      };
      
      socket.on('draw_card_result', drawCardResultHandler);
      
      // Ustaw timeout na odpowiedź
      const timeoutId = setTimeout(() => {
        socket.off('draw_card_result', drawCardResultHandler);
        reject(new Error('Timeout drawing card'));
      }, 10000);
      
      // Ustaw handler dla błędów
      const errorHandler = (error) => {
        console.error("Error drawing card:", error);
        socket.off('draw_card_result', drawCardResultHandler);
        socket.off('error', errorHandler);
        clearTimeout(timeoutId);
        reject(error);
      };
      
      socket.on('error', errorHandler);
    } else {
      // Jeśli socket nie jest połączony, użyj REST API
      console.log("Socket not connected, using REST API");
      retryFetch(`${GAME_SERVER_URL}/api/game/${roomId}/draw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerAddress
        })
      })
        .then(result => resolve(result.card))
        .catch(error => reject(error));
    }
  });
}

// Automatyczne pominięcie tury
export async function autoSkipTurn(roomId, wallet) {
  console.log("Auto skipping turn due to inactivity:", roomId);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  const playerAddress = publicKey.toString();
  
  try {
    // Wywołaj funkcję dobierania karty, która automatycznie przesunie turę
    const result = await drawCard(roomId, wallet);
    return result;
  } catch (error) {
    console.error("Error auto-skipping turn:", error);
    throw error;
  }
}

// Handler dla zakończenia gry
export function listenForGameEnd(roomId, callback) {
  const socket = initializeSocket();
  
  if (!socket) return () => {};
  
  const gameEndHandler = (data) => {
    if (data.roomId === roomId) {
      console.log("Game ended event received:", data);
      callback(data);
    }
  };
  
  socket.on('game_ended', gameEndHandler);
  
  return () => {
    socket.off('game_ended', gameEndHandler);
  };
}

// ========== FUNKCJE POMOCNICZE SPECYFICZNE DLA SOLANA ==========

// Funkcja do sprawdzania salda portfela
export async function checkWalletBalance(wallet) {
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  try {
    const balance = await connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error('Error checking wallet balance:', error);
    throw error;
  }
}

// Funkcja do sprawdzania czy program istnieje
export async function checkProgramExists(programId = PROGRAM_ID) {
  try {
    const accountInfo = await connection.getAccountInfo(programId);
    
    if (!accountInfo) {
      console.error('Program does not exist at address:', programId.toString());
      return false;
    }
    
    console.log('Program exists:', {
      address: programId.toString(),
      executable: accountInfo.executable,
      owner: accountInfo.owner.toString(),
      lamports: accountInfo.lamports,
      dataLength: accountInfo.data.length
    });
    
    return accountInfo.executable;
  } catch (error) {
    console.error('Error checking program:', error);
    return false;
  }
}

// Funkcja do sprawdzania stanu pokoju w łańcuchu
export async function getRoomStateFromChain(roomAddress) {
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(roomAddress));
    
    if (!accountInfo) {
      throw new Error('Pokój nie istnieje na blockchainie');
    }
    
    // Deserializacja danych pokoju z formatu Borsh
    // Implementacja zależy od Twojego dokładnego schematu danych
    
    return {
      exists: true,
      data: accountInfo.data,
      lamports: accountInfo.lamports,
      owner: accountInfo.owner.toString(),
      executable: accountInfo.executable,
      rentEpoch: accountInfo.rentEpoch
    };
  } catch (error) {
    console.error('Error getting room state from chain:', error);
    throw error;
  }
}

// Funkcja do testowania serializacji danych (dla debugowania)
export function testSerialization() {
  console.log("=== Testing Serialization ===");
  
  try {
    // Test CreateRoom z room_slot
    console.log("1. Testing CreateRoom serialization...");
    const createRoomData = serializeCreateRoomData(2, 0.1, 0);
    console.log("✓ CreateRoom serialization successful");
    console.log("  Data length:", createRoomData.length);
    console.log("  Expected: 11 bytes (1 + 1 + 8 + 1)");
    
    // Test JoinRoom
    console.log("2. Testing JoinRoom serialization...");
    const joinRoomData = serializeJoinRoomData();
    console.log("✓ JoinRoom serialization successful");
    console.log("  Data length:", joinRoomData.length);
    
    // Test StartGame
    console.log("3. Testing StartGame serialization...");
    const startGameData = serializeStartGameData("test_game_123");
    console.log("✓ StartGame serialization successful");
    console.log("  Data length:", startGameData.length);
    
    console.log("=== All serialization tests passed ===");
    return true;
  } catch (error) {
    console.error("❌ Serialization test failed:", error);
    return false;
  }
}

// Funkcja do testowania połączenia z siecią Solana
export async function testSolanaConnection() {
  try {
    console.log('Testing Solana connection...');
    const version = await connection.getVersion();
    console.log('Solana RPC version:', version);
    
    const slot = await connection.getSlot();
    console.log('Current slot:', slot);
    
    const programExists = await checkProgramExists();
    console.log('Program exists and is executable:', programExists);
    
    return {
      connected: true,
      version,
      slot,
      programExists,
      network: NETWORK,
      rpcUrl: connection.rpcEndpoint
    };
  } catch (error) {
    console.error('Solana connection test failed:', error);
    return {
      connected: false,
      error: error.message,
      network: NETWORK,
      rpcUrl: connection.rpcEndpoint
    };
  }
}

// Eksport dodatkowych stałych i funkcji, które mogą być przydatne dla innych komponentów
export const LAMPORTS = LAMPORTS_PER_SOL;
export const NETWORK_URL = clusterApiUrl(NETWORK);
export const CONNECTION = connection;
export { socket }; // Eksportuj socket dla GameRoom.js

// Inicjalizacja i test połączenia przy załadowaniu modułu
let connectionTested = false;

export async function initializeSolanaConnection() {
  if (connectionTested) return;
  
  console.log('Initializing Solana connection...');
  
  // Test serializacji danych
  console.log('Testing data serialization...');
  const serializationResult = testSerialization();
  
  if (!serializationResult) {
    console.error('Serialization test failed - check data formats');
    connectionTested = true;
    return { 
      connected: false, 
      programExists: false, 
      error: 'Serialization test failed' 
    };
  }
  
  // Test połączenia z Solana
  const testResult = await testSolanaConnection();
  
  if (!testResult.connected) {
    console.error('Failed to connect to Solana:', testResult.error);
  } else if (!testResult.programExists) {
    console.error('Program does not exist or is not executable');
  } else {
    console.log('✓ Solana connection initialized successfully');
  }
  
  connectionTested = true;
  return testResult;
}

// Funkcja pomocnicza dla debugowania - eksportuj endGame do window dla łatwego dostępu
if (typeof window !== 'undefined') {
  window.endGame = endGame;
  window.socket = socket;
  console.log('Debug functions available: window.endGame(roomId, winnerAddress, wallet)');
}