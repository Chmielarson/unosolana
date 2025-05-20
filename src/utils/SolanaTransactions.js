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
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

// Adres serwera gry
const GAME_SERVER_URL = process.env.REACT_APP_GAME_SERVER_URL || 'http://localhost:3001';

// Adres programu Solana (smart contract)
const PROGRAM_ID = new PublicKey(process.env.REACT_APP_PROGRAM_ID || '3PtVXcKqQTQpUyCn5RCsrKL9nnHsAD6Kinf81LeBr1Vs');

// Instancja Socket.IO
let socket = null;

// Serializacja danych Borsh dla instrukcji programu Solana
function serializeCreateRoomData(maxPlayers, entryFee) {
  const buffer = Buffer.alloc(1000);
  
  // Instrukcja CreateRoom (0)
  buffer.writeUInt8(0, 0);
  
  // max_players: u8
  buffer.writeUInt8(maxPlayers, 1);
  
  // entry_fee_lamports: u64
  const entryFeeLamports = Math.round(entryFee * LAMPORTS_PER_SOL);
  buffer.writeBigUInt64LE(BigInt(entryFeeLamports), 2);
  
  return buffer.slice(0, 10);
}

function serializeJoinRoomData() {
  const buffer = Buffer.alloc(1);
  
  // Instrukcja JoinRoom (1)
  buffer.writeUInt8(1, 0);
  
  return buffer;
}

function serializeStartGameData(gameId) {
  const buffer = Buffer.alloc(100);
  
  // Instrukcja StartGame (2)
  buffer.writeUInt8(2, 0);
  
  // Długość gameId
  const gameIdBytes = Buffer.from(gameId, 'utf8');
  buffer.writeUInt8(gameIdBytes.length, 1);
  
  // Zawartość gameId
  gameIdBytes.copy(buffer, 2);
  
  return buffer.slice(0, 2 + gameIdBytes.length);
}

function serializeEndGameData(winnerPubkey) {
  const buffer = Buffer.alloc(34);
  
  // Instrukcja EndGame (3)
  buffer.writeUInt8(3, 0);
  
  // Winner Pubkey
  const winnerPubkeyBuffer = winnerPubkey.toBuffer();
  winnerPubkeyBuffer.copy(buffer, 1);
  
  return buffer;
}

function serializeClaimPrizeData() {
  const buffer = Buffer.alloc(1);
  
  // Instrukcja ClaimPrize (4)
  buffer.writeUInt8(4, 0);
  
  return buffer;
}

function serializeCancelRoomData() {
  const buffer = Buffer.alloc(1);
  
  // Instrukcja CancelRoom (5)
  buffer.writeUInt8(5, 0);
  
  return buffer;
}

// Znajdź adres PDA dla pokoju gry
async function findGamePDA(creatorPubkey) {
  return await PublicKey.findProgramAddress(
    [Buffer.from('uno_game'), creatorPubkey.toBuffer()],
    PROGRAM_ID
  );
}

// Funkcja do pobrania listy pokojów
export async function getRooms() {
  console.log("Getting rooms list from server and blockchain");
  try {
    // Pobierz pokoje przez API serwera
    const response = await fetch(`${GAME_SERVER_URL}/api/rooms`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const rooms = await response.json();
    console.log("Rooms found:", rooms.length);
    
    return rooms;
  } catch (error) {
    console.error('Error getting rooms:', error);
    return [];
  }
}

// Funkcja do tworzenia nowego pokoju
export async function createRoom(maxPlayers, entryFee, wallet) {
  console.log("Creating room with:", { maxPlayers, entryFee });
  console.log("Wallet:", wallet);
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }

  try {
    // Znajdź adres PDA dla pokoju
    const [gamePDA, bump] = await findGamePDA(publicKey);
    console.log("Game PDA:", gamePDA.toString());
    
    // Serializuj dane instrukcji
    const data = serializeCreateRoomData(maxPlayers, entryFee);
    
    // Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: gamePDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // Rent sysvar
      ],
      programId: PROGRAM_ID,
      data: data
    });
    
    // Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // Wyślij transakcję
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    
    // Poczekaj na potwierdzenie
    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    console.log("Room creation transaction confirmed:", signature);
    
    // Zarejestruj pokój na serwerze
    const serverRegistration = await fetch(`${GAME_SERVER_URL}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        creatorAddress: publicKey.toString(),
        maxPlayers,
        entryFee,
        roomAddress: gamePDA.toString()
      }),
    });
    
    if (!serverRegistration.ok) {
      throw new Error(`Server error: ${serverRegistration.status}`);
    }
    
    const roomData = await serverRegistration.json();
    console.log("Room registered on server:", roomData);
    
    return roomData.roomId;
  } catch (error) {
    console.error('Error creating room:', error);
    throw error;
  }
}

export async function joinRoom(roomId, entryFee, wallet) {
  console.log("Join room function called:", { roomId, entryFee });
  
  // Zabezpieczenie przed nieprawidłowymi danymi wejściowymi
  if (!roomId) {
    throw new Error('Brak identyfikatora pokoju');
  }
  
  if (typeof entryFee !== 'number' || isNaN(entryFee) || entryFee <= 0) {
    throw new Error('Nieprawidłowa kwota wpisowego');
  }
  
  if (!wallet || !wallet.publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  const { publicKey, signTransaction } = wallet;
  
  if (!signTransaction) {
    throw new Error('Portfel nie ma funkcji podpisywania transakcji');
  }

  try {
    // 1. Pobierz dane pokoju z serwera
    const roomResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`);
    if (!roomResponse.ok) {
      throw new Error(`Server error: ${roomResponse.status}`);
    }
    
    const roomData = await roomResponse.json();
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
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    
    // 9. Poczekaj na potwierdzenie
    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    console.log("Join room transaction confirmed:", signature);
    
    // 10. Powiadom serwer o dołączeniu gracza
    const joinResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerAddress: publicKey.toString()
      }),
    });
    
    if (!joinResponse.ok) {
      throw new Error(`Server error: ${joinResponse.status}`);
    }
    
    console.log("Join room completed successfully");
    return true;
  } catch (error) {
    console.error('Error joining room:', error);
    throw error;
  }
}

// Funkcja do opuszczania gry
export async function leaveGame(roomId, wallet) {
  console.log("Player is leaving game:", roomId);
  try {
    const { publicKey } = wallet;
    
    if (!publicKey) {
      throw new Error('Portfel nie jest połączony');
    }
    
    // Powiadom serwer o opuszczeniu pokoju
    const leaveResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerAddress: publicKey.toString()
      }),
    });
    
    if (!leaveResponse.ok) {
      throw new Error(`Server error: ${leaveResponse.status}`);
    }
    
    const result = await leaveResponse.json();
    
    // Jeśli gra była w toku i jest inny gracz, zakończ grę na łańcuchu
    if (result.wasActive && result.opponentWins) {
      await endGame(roomId, result.opponentAddress, wallet);
    }
    
    if (socket) {
      socket.disconnect();
    }
    
    return { success: true, message: 'Opuszczono pokój' };
  } catch (error) {
    console.error('Error leaving game:', error);
    throw error;
  }
}

// Funkcja do pobrania informacji o pokoju
export async function getRoomInfo(roomId) {
  console.log("Getting room info for room:", roomId);
  
  try {
    const response = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`);
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
    
    const roomData = await response.json();
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
      winner: roomData.winner,
      createdAt: roomData.createdAt,
      isActive: roomData.isActive,
      endedAt: roomData.endedAt
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
    const roomResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`);
    if (!roomResponse.ok) {
      throw new Error(`Server error: ${roomResponse.status}`);
    }
    
    const roomData = await roomResponse.json();
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
    const startResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        gameId,
        initiatorAddress: publicKey.toString()
      }),
    });
    
    if (!startResponse.ok) {
      throw new Error(`Server error: ${startResponse.status}`);
    }
    
    // 12. Połącz z serwerem gry przez WebSocket
    await connectToGameServer(roomId, gameId, publicKey.toString());
    
    console.log("Game started successfully");
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
    const roomResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`);
    if (!roomResponse.ok) {
      throw new Error(`Server error: ${roomResponse.status}`);
    }
    
    const roomData = await roomResponse.json();
    console.log("Room data from server:", roomData);
    
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
    const endResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        winnerAddress: winnerAddress
      }),
    });
    
    if (!endResponse.ok) {
      throw new Error(`Server error: ${endResponse.status}`);
    }
    
    console.log("Game ended successfully");
    return true;
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
    const roomResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`);
    if (!roomResponse.ok) {
      throw new Error(`Server error: ${roomResponse.status}`);
    }
    
    const roomData = await roomResponse.json();
    console.log("Room data from server:", roomData);
    
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
    const claimResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        claimerAddress: publicKey.toString()
      }),
    });
    
    if (!claimResponse.ok) {
      throw new Error(`Server error: ${claimResponse.status}`);
    }
    
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

// Funkcja anulowania pokoju
export async function cancelRoom(roomId, wallet) {
  console.log("Cancelling room:", roomId);
  
  const { publicKey, signTransaction } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  try {
    // 1. Pobierz dane pokoju z serwera
    const roomResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`);
    if (!roomResponse.ok) {
      throw new Error(`Server error: ${roomResponse.status}`);
    }
    
    const roomData = await roomResponse.json();
    console.log("Room data from server:", roomData);
    
    // 2. Sprawdź, czy użytkownik jest twórcą pokoju
    if (roomData.creatorAddress !== publicKey.toString()) {
      throw new Error('Tylko twórca może anulować pokój');
    }
    
    // 3. Pobierz adres PDA pokoju
    const roomPDA = new PublicKey(roomData.roomAddress);
    
    // 4. Serializuj dane instrukcji
    const data = serializeCancelRoomData();
    
    // 5. Przygotuj listę kluczy do instrukcji
    const keys = [
      { pubkey: publicKey, isSigner: true, isWritable: true },
      { pubkey: roomPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    // 6. Dodaj klucze dla każdego gracza do zwrotu wpisowego
    for (const playerAddress of roomData.players) {
      if (playerAddress !== publicKey.toString()) {
        keys.push({
          pubkey: new PublicKey(playerAddress),
          isSigner: false,
          isWritable: true
        });
      }
    }
    
    // 7. Utwórz instrukcję
    const instruction = new TransactionInstruction({
      keys,
      programId: PROGRAM_ID,
      data: data
    });
    
    // 8. Utwórz transakcję
    const transaction = new Transaction().add(instruction);
    
    // 9. Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;
    
    // 10. Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }
    
    // 11. Wyślij transakcję
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    
    // 12. Poczekaj na potwierdzenie
    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    console.log("Cancel room transaction confirmed:", signature);
    
    // 13. Powiadom serwer o anulowaniu pokoju
    const cancelResponse = await fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        creatorAddress: publicKey.toString()
      }),
    });
    
    if (!cancelResponse.ok) {
      throw new Error(`Server error: ${cancelResponse.status}`);
    }
    
    console.log("Room cancelled successfully");
    return true;
  } catch (error) {
    console.error('Error cancelling room:', error);
    throw error;
  }
}

// ---- FUNKCJE SOCKET.IO DLA GRY W CZASIE RZECZYWISTYM ----

// Połączenie z serwerem gry przez Socket.IO
export function connectToGameServer(roomId, gameId, playerAddress) {
  console.log("Connecting to game server:", { roomId, gameId, playerAddress });
  
  return new Promise((resolve, reject) => {
    // Rozłącz poprzednie połączenie, jeśli istnieje
    if (socket) {
      socket.disconnect();
    }
    
    // Inicjalizuj nowe połączenie
    socket = io(GAME_SERVER_URL);
    
    // Obsługa zdarzenia połączenia
    socket.on('connect', () => {
      console.log("Connected to game server with socket ID:", socket.id);
      
      // Dołącz do pokoju
      socket.emit('join_game', { roomId, gameId, playerAddress });
      
      resolve(true);
    });
    
    // Obsługa błędów
    socket.on('connect_error', (error) => {
      console.error("Socket.IO connection error:", error);
      reject(error);
    });
    
    socket.on('error', (error) => {
      console.error("Socket.IO error:", error);
      reject(error);
    });
  });
}

// Pobierz stan gry z serwera
export async function getGameState(roomId, wallet) {
  console.log("Getting game state for room:", roomId);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      // Jeśli socket nie jest podłączony, spróbuj go ponownie podłączyć
      fetch(`${GAME_SERVER_URL}/api/rooms/${roomId}`)
        .then(response => response.json())
        .then(roomData => {
          connectToGameServer(roomId, roomData.gameId, publicKey.toString())
            .then(() => {
              socket.emit('get_game_state', { roomId, playerAddress: publicKey.toString() });
              socket.once('game_state', (gameState) => {
                resolve(gameState);
              });
            })
            .catch(error => {
              reject(error);
            });
        })
        .catch(error => {
          reject(error);
        });
    } else {
      // Socket jest już podłączony
      socket.emit('get_game_state', { roomId, playerAddress: publicKey.toString() });
      socket.once('game_state', (gameState) => {
        resolve(gameState);
      });
    }
  });
}

// Nasłuchiwanie na zmiany stanu gry
export function listenForGameState(roomId, playerAddress, callback) {
  console.log("Setting up game state listener for:", { roomId, playerAddress });
  
  if (!socket || !socket.connected) {
    console.warn("Socket not connected, game state updates will not be received");
    return () => {};
  }
  
  const handleGameStateUpdate = (gameState) => {
    console.log("Game state update received:", gameState);
    callback(gameState);
  };
  
  socket.on('game_state_update', handleGameStateUpdate);
  
  // Zwróć funkcję usuwającą nasłuchiwanie
  return () => {
    if (socket) {
      socket.off('game_state_update', handleGameStateUpdate);
    }
  };
}

// Zagranie karty
export async function playCard(roomId, cardIndex, chosenColor = null, wallet) {
  console.log("Playing card:", { roomId, cardIndex, chosenColor });
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  if (!socket || !socket.connected) {
    throw new Error('Brak połączenia z serwerem gry');
  }
  
  return new Promise((resolve, reject) => {
    socket.emit('play_card', { 
      roomId, 
      playerAddress: publicKey.toString(), 
      cardIndex, 
      chosenColor 
    });
    
    socket.once('play_card_result', (result) => {
      console.log("Play card result:", result);
      
      if (result.error) {
        reject(new Error(result.error));
      } else {
        // Sprawdź, czy gra się zakończyła
        if (result.winner) {
          // Wywołaj funkcję kończącą grę on-chain
          endGame(roomId, result.winner, wallet)
            .then(() => {
              resolve(result);
            })
            .catch(error => {
              console.error("Error ending game on blockchain:", error);
              resolve(result); // Mimo błędu, zwróć wynik
            });
        } else {
          resolve(result);
        }
      }
    });
    
    // Timeout dla odpowiedzi
    setTimeout(() => {
      reject(new Error('Timeout: Brak odpowiedzi od serwera gry'));
    }, 10000);
  });
}

// Dobranie karty
export async function drawCard(roomId, wallet) {
  console.log("Drawing card from room:", roomId);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  if (!socket || !socket.connected) {
    throw new Error('Brak połączenia z serwerem gry');
  }
  
  return new Promise((resolve, reject) => {
    socket.emit('draw_card', { 
      roomId, 
      playerAddress: publicKey.toString()
    });
    
    socket.once('draw_card_result', (result) => {
      console.log("Draw card result:", result);
      
      if (result.error) {
        reject(new Error(result.error));
      } else {
        resolve(result.card);
      }
    });
    
    // Timeout dla odpowiedzi
    setTimeout(() => {
      reject(new Error('Timeout: Brak odpowiedzi od serwera gry'));
    }, 10000);
  });
}

// Automatyczne pominięcie tury
export async function autoSkipTurn(roomId, wallet) {
  console.log("Auto skipping turn due to inactivity:", roomId);
  
  // Wywołaj funkcję dobierania karty, która automatycznie przesunie turę
  return await drawCard(roomId, wallet);
}