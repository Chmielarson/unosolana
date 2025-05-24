// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { 
  Connection, 
  PublicKey, 
  Keypair,
  clusterApiUrl,
  VersionedTransaction,
  TransactionMessage
} = require('@solana/web3.js');
const UnoGame = require('./game/UnoGame');
const routes = require('./routes');

// Ładowanie zmiennych środowiskowych
dotenv.config();

// Inicjalizacja Express
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Tworzenie serwera HTTP
const server = http.createServer(app);

// Inicjalizacja Socket.IO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Konfiguracja połączenia z Solana
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl(SOLANA_NETWORK);
const PROGRAM_ID = new PublicKey(process.env.SOLANA_PROGRAM_ID);

console.log(`Connecting to Solana ${SOLANA_NETWORK} at ${SOLANA_RPC_URL}`);
console.log(`Program ID: ${PROGRAM_ID.toString()}`);

// Połączenie z Solana
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Przechowywanie stanów gier w pamięci
const gameStates = new Map();
const activeRooms = new Map();
const gameStateSubscriptions = new Map();

// Opcjonalnie: wczytaj klucz prywatny dla serwera (do użycia w przyszłości dla autoryzacji transakcji)
let serverKeyPair = null;
try {
  const keyPath = path.join(__dirname, 'keys', 'server-keypair.json');
  if (fs.existsSync(keyPath)) {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    serverKeyPair = Keypair.fromSecretKey(Uint8Array.from(keyData));
    console.log(`Server keypair loaded. Public key: ${serverKeyPair.publicKey.toString()}`);
  } else {
    console.log('No server keypair found. Operating in verification-only mode.');
  }
} catch (error) {
  console.error('Error loading server keypair:', error);
}

// Weryfikacja transakcji Solana
async function verifyTransaction(signature) {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    
    if (!tx) {
      throw new Error(`Transaction not found: ${signature}`);
    }
    
    return {
      blockTime: tx.blockTime,
      slot: tx.slot,
      status: tx.meta.err ? 'failed' : 'success',
      fee: tx.meta.fee,
      accounts: tx.transaction.message.staticAccountKeys.map(key => key.toString())
    };
  } catch (error) {
    console.error(`Error verifying transaction ${signature}:`, error);
    throw error;
  }
}

// Znajdź adres PDA dla pokoju gry
async function findGamePDA(creatorPubkey, roomSlot = 0) {
  // Uwzględnij slot pokoju w PDA
  return await PublicKey.findProgramAddress(
    [Buffer.from('uno_game'), creatorPubkey.toBuffer(), Buffer.from([roomSlot])],
    PROGRAM_ID
  );
}

// Pobierz dane pokoju on-chain
async function getRoomStateFromChain(roomAddress) {
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(roomAddress));
    
    if (!accountInfo) {
      throw new Error('Room account not found on-chain');
    }
    
    // Tutaj możemy deserializować dane, ale potrzebujemy dokładnej implementacji schematu Borsh
    // Na razie zwróćmy surowe dane
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

// Udostępnianie danych dla modułów
app.set("solanaConnection", connection);
app.set("solanaProgram", PROGRAM_ID);
app.set("gameStates", gameStates);
app.set("activeRooms", activeRooms);
app.set("gameStateSubscriptions", gameStateSubscriptions);
app.set("verifyTransaction", verifyTransaction);
app.set("findGamePDA", findGamePDA);
app.set("getRoomStateFromChain", getRoomStateFromChain);
app.set("socketIo", io);
app.set("serverKeyPair", serverKeyPair); // Udostępnij klucz serwera jeśli istnieje

// Ustawienie tras
app.use('/api', routes);

// Trasa główna
app.get('/', (req, res) => {
  res.send('UNO Solana Server Running');
});

// Monitorowanie pokoi na blockchainie
async function monitorOnChainRooms() {
  try {
    console.log('Monitoring on-chain rooms...');
    
    // W przyszłości możemy implementować bardziej zaawansowane monitorowanie
    // Na razie sprawdzamy tylko aktywne pokoje
    for (const [roomId, roomData] of activeRooms.entries()) {
      try {
        if (roomData.roomAddress) {
          const onChainData = await getRoomStateFromChain(roomData.roomAddress);
          console.log(`Room ${roomId} exists on-chain: ${onChainData.exists}`);
          
          // Aktualizuj dane pokoju w pamięci
          if (onChainData.exists) {
            // Tutaj możemy aktualizować dodatkowe dane z łańcucha
            // Ale potrzebujemy schematu deserializacji Borsh
          }
        }
      } catch (error) {
        console.error(`Error monitoring room ${roomId}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in monitoring on-chain rooms:', error);
  }
}

// Uruchom monitorowanie co 60 sekund
setInterval(monitorOnChainRooms, 60 * 1000);

// Socket.IO eventy
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);
  
  // Obsługa dołączania do gry
  socket.on('join_game', ({ roomId, gameId, playerAddress }) => {
    console.log(`Player ${playerAddress} joining game room: ${roomId}, game ID: ${gameId}`);
    
    // Dołącz do pokoju Socket.IO
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerAddress = playerAddress;
    
    // Sprawdź, czy gra już istnieje
    let game = gameStates.get(roomId);
    
    if (!game) {
      // Jeśli nie istnieje, sprawdź, czy mamy dane o pokoju
      const room = activeRooms.get(roomId);
      
      if (room && room.players && room.players.length >= 2) {
        // Utwórz nową grę
        game = new UnoGame(roomId, room.players);
        gameStates.set(roomId, game);
        console.log(`New game created for room ${roomId} with ${room.players.length} players`);
      } else {
        console.log(`Unable to start game for room ${roomId}: insufficient players or room data`);
        socket.emit('error', { message: "Niewystarczająca liczba graczy lub brak danych pokoju" });
        return;
      }
    }
    
    // Dodaj gracza do subskrypcji stanu gry
    const subscriptionKey = `${roomId}-${playerAddress}`;
    gameStateSubscriptions.set(subscriptionKey, socket.id);
    
    // Wyślij aktualny stan gry do gracza
    const gameState = game.getGameStateForPlayer(playerAddress);
    socket.emit('game_state', { gameState, requestId: Date.now().toString() });
    
    // Potwierdź dołączenie do pokoju
    socket.emit('join_game_confirm', { roomId, playerAddress });
    
    console.log(`Player ${playerAddress} joined game room ${roomId}`);
  });
  
  // Obsługa opuszczania gry
  socket.on('leave_game', ({ roomId, playerAddress }) => {
    console.log(`Player ${playerAddress} leaving game room: ${roomId}`);
    
    // Usuń subskrypcję stanu gry
    const subscriptionKey = `${roomId}-${playerAddress}`;
    gameStateSubscriptions.delete(subscriptionKey);
    
    // Opuść pokój Socket.IO
    socket.leave(roomId);
    
    console.log(`Player ${playerAddress} left game room ${roomId}`);
  });
  
  // Obsługa pobierania stanu gry
  socket.on('get_game_state', ({ roomId, playerAddress, requestId }) => {
    console.log(`Get game state for room ${roomId}, player ${playerAddress}`);
    
    const game = gameStates.get(roomId);
    
    if (game) {
      const gameState = game.getGameStateForPlayer(playerAddress);
      socket.emit('game_state', { gameState, requestId });
    } else {
      socket.emit('error', { message: "Game not found", requestId });
    }
  });
  
  // Obsługa subskrypcji pokojów
  socket.on('subscribe_room', ({ roomId }) => {
    console.log(`Subscribing to room updates: ${roomId}`);
    socket.join(`room_${roomId}`);
  });
  
  // Obsługa pobierania listy pokojów
  socket.on('get_rooms', () => {
    console.log('Get rooms list');
    
    // Konwertuj activeRooms na tablicę
    const rooms = Array.from(activeRooms.values())
      .filter(room => room.isActive && !room.winner)
      .map(room => ({
        id: room.id,
        creatorAddress: room.creatorAddress,
        maxPlayers: room.maxPlayers,
        entryFee: room.entryFee,
        currentPlayers: room.players.length,
        players: room.players,
        gameStarted: room.gameStarted,
        roomAddress: room.roomAddress,
        lastActivity: room.lastActivity
      }));
    
    socket.emit('rooms_update', rooms);
  });
  
  // Obsługa zagrania karty
  socket.on('play_card', ({ roomId, playerAddress, cardIndex, chosenColor, requestId }) => {
    console.log(`Play card request from ${playerAddress}: room=${roomId}, card=${cardIndex}, color=${chosenColor}`);
    
    const game = gameStates.get(roomId);
    
    if (!game) {
      socket.emit('play_card_result', { 
        error: "Game not found", 
        requestId 
      });
      return;
    }
    
    try {
      // Wykonaj ruch
      const result = game.playCard(playerAddress, cardIndex, chosenColor);
      
      // Wyślij wynik do gracza
      socket.emit('play_card_result', { 
        ...result, 
        requestId 
      });
      
      // Wyślij aktualizację stanu gry do wszystkich graczy
      broadcastGameState(roomId, game);
      
      // Jeśli ktoś wygrał, aktualizuj dane pokoju i zakończ grę
      if (result.winner) {
        const room = activeRooms.get(roomId);
        if (room) {
          room.winner = playerAddress;
          room.isActive = false;
          room.endedAt = new Date().toISOString();
          room.lastActivity = new Date().toISOString();
          
          // Znajdź socket ID zwycięzcy
          const winnerSubscriptionKey = `${roomId}-${playerAddress}`;
          const winnerSocketId = gameStateSubscriptions.get(winnerSubscriptionKey);
          
          // Powiadom zwycięzcę, że musi wywołać endGame na blockchainie
          if (winnerSocketId) {
            io.to(winnerSocketId).emit('must_end_game_on_chain', {
              roomId,
              winnerAddress: playerAddress,
              message: "You won! Please confirm the game end on blockchain."
            });
          }
          
          // Powiadom wszystkich o oczekiwaniu na blockchain
          io.to(roomId).emit('game_ending', { 
            winner: playerAddress,
            waitingForBlockchain: true 
          });
          
          // Aktualizuj dane w pamięci
          activeRooms.set(roomId, room);
          
          // Ustaw timeout - jeśli po 30 sekundach gra nie została zakończona na blockchainie
          setTimeout(() => {
            const currentRoom = activeRooms.get(roomId);
            if (currentRoom && !currentRoom.blockchainEnded) {
              console.warn(`Game ${roomId} not ended on blockchain after 30s`);
              io.to(roomId).emit('blockchain_timeout', {
                message: "Game end confirmation timeout. You can try claiming prize manually."
              });
            }
          }, 30000);
        }
      }
    } catch (error) {
      console.error(`Error playing card in room ${roomId}:`, error);
      socket.emit('play_card_result', { 
        error: error.message, 
        requestId 
      });
    }
  });
  
  // Obsługa dobierania karty
  socket.on('draw_card', ({ roomId, playerAddress, requestId }) => {
    console.log(`Draw card request from ${playerAddress}: room=${roomId}`);
    
    const game = gameStates.get(roomId);
    
    if (!game) {
      socket.emit('draw_card_result', { 
        error: "Game not found", 
        requestId 
      });
      return;
    }
    
    try {
      // Wykonaj dobieranie karty
      const card = game.drawCard(playerAddress);
      
      // Wyślij wynik do gracza
      socket.emit('draw_card_result', { 
        card, 
        requestId 
      });
      
      // Wyślij aktualizację stanu gry do wszystkich graczy
      broadcastGameState(roomId, game);
    } catch (error) {
      console.error(`Error drawing card in room ${roomId}:`, error);
      socket.emit('draw_card_result', { 
        error: error.message, 
        requestId 
      });
    }
  });
  
  // Obsługa rozłączenia
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    // Jeśli gracz był w pokoju, usuń jego subskrypcję
    if (socket.data.roomId && socket.data.playerAddress) {
      const subscriptionKey = `${socket.data.roomId}-${socket.data.playerAddress}`;
      gameStateSubscriptions.delete(subscriptionKey);
      
      console.log(`Removed subscription for ${socket.data.playerAddress} in room ${socket.data.roomId}`);
    }
  });
});

// Funkcja do rozgłaszania stanu gry do wszystkich graczy w pokoju
function broadcastGameState(roomId, game) {
  const room = activeRooms.get(roomId);
  
  if (!room || !room.players) {
    console.error(`Cannot broadcast game state: room ${roomId} not found or no players`);
    return;
  }
  
  // Pobierz bazowy stan gry
  const baseState = game.getGameState();
  
  // Dla każdego gracza w pokoju
  for (const playerAddress of room.players) {
    try {
      // Pobierz socket ID gracza
      const subscriptionKey = `${roomId}-${playerAddress}`;
      const socketId = gameStateSubscriptions.get(subscriptionKey);
      
      if (socketId) {
        // Pobierz stan gry z perspektywy gracza
        const playerState = game.getGameStateForPlayer(playerAddress);
        
        // Wyślij stan gry do gracza
        io.to(socketId).emit('game_state_update', playerState);
      }
    } catch (error) {
      console.error(`Error broadcasting to player ${playerAddress} in room ${roomId}:`, error);
    }
  }
  
  console.log(`Broadcasted game state to all players in room ${roomId}`);
}

// Rozpocznij nasłuchiwanie na wskazanym porcie
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Connected to Solana ${SOLANA_NETWORK}`);
  console.log(`Program ID: ${PROGRAM_ID.toString()}`);
});