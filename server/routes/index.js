// server/routes/index.js
const express = require('express');
const router = express.Router();
const { PublicKey } = require('@solana/web3.js');

// Obsługa tras związanych z pokojami
router.get('/rooms', async (req, res) => {
  try {
    const activeRooms = req.app.get('activeRooms');
    
    // Filtruj tylko aktywne pokoje bez zwycięzcy
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
    
    res.status(200).json(rooms);
  } catch (error) {
    console.error('Error getting rooms:', error);
    res.status(500).json({ error: 'Failed to get rooms' });
  }
});

// Pobierz informacje o pokoju
router.get('/rooms/:id', async (req, res) => {
  try {
    const roomId = req.params.id;
    const activeRooms = req.app.get('activeRooms');
    const room = activeRooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    res.status(200).json(room);
  } catch (error) {
    console.error('Error getting room:', error);
    res.status(500).json({ error: 'Failed to get room' });
  }
});

// Utwórz nowy pokój
router.post('/rooms', async (req, res) => {
  try {
    const { creatorAddress, maxPlayers, entryFee, roomAddress, transactionSignature } = req.body;
    
    if (!creatorAddress || !maxPlayers || !entryFee || !roomAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Weryfikacja transakcji (opcjonalna)
    if (transactionSignature) {
      try {
        const verifyTransaction = req.app.get('verifyTransaction');
        const txInfo = await verifyTransaction(transactionSignature);
        
        if (txInfo.status !== 'success') {
          return res.status(400).json({ error: 'Transaction failed on-chain' });
        }
        
        console.log(`Transaction ${transactionSignature} verified:`, txInfo);
      } catch (verifyError) {
        console.error('Error verifying transaction:', verifyError);
        // Możemy zdecydować, czy kontynuować mimo błędu weryfikacji
      }
    }
    
    // Generuj unikalny identyfikator
    const roomId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Utwórz pokój
    const room = {
      id: roomId,
      creatorAddress,
      roomAddress,
      maxPlayers,
      entryFee,
      players: [creatorAddress],
      gameStarted: false,
      winner: null,
      createdAt: new Date().toISOString(),
      isActive: true,
      gameId: null,
      lastActivity: new Date().toISOString(),
      transactionSignature
    };
    
    // Zapisz pokój
    const activeRooms = req.app.get('activeRooms');
    activeRooms.set(roomId, room);
    
    // Powiadom wszystkich o nowym pokoju
    const io = req.app.get('socketIo');
    if (io) {
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
      
      io.emit('rooms_update', rooms);
    }
    
    res.status(201).json({ roomId });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Dołącz do pokoju
router.post('/rooms/:id/join', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerAddress, transactionSignature } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ error: 'Missing player address' });
    }
    
    const activeRooms = req.app.get('activeRooms');
    const room = activeRooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    if (room.gameStarted) {
      return res.status(400).json({ error: 'Game already started' });
    }
    
    if (room.players.length >= room.maxPlayers) {
      return res.status(400).json({ error: 'Room is full' });
    }
    
    // Weryfikacja transakcji (opcjonalna)
    if (transactionSignature) {
      try {
        const verifyTransaction = req.app.get('verifyTransaction');
        const txInfo = await verifyTransaction(transactionSignature);
        
        if (txInfo.status !== 'success') {
          return res.status(400).json({ error: 'Transaction failed on-chain' });
        }
        
        console.log(`Transaction ${transactionSignature} verified:`, txInfo);
      } catch (verifyError) {
        console.error('Error verifying transaction:', verifyError);
        // Możemy zdecydować, czy kontynuować mimo błędu weryfikacji
      }
    }
    
    // Sprawdź, czy gracz już jest w pokoju
    if (!room.players.includes(playerAddress)) {
      room.players.push(playerAddress);
    }
    
    // Aktualizuj czas ostatniej aktywności
    room.lastActivity = new Date().toISOString();
    
    // Zapisz zaktualizowany pokój
    activeRooms.set(roomId, room);
    
    // Powiadom graczy w pokoju
    const io = req.app.get('socketIo');
    if (io) {
      io.to(`room_${roomId}`).emit('room_update', room);
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error joining room:', error);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

// Rozpocznij grę
router.post('/rooms/:id/start', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { gameId, initiatorAddress, transactionSignature } = req.body;
    
    if (!gameId || !initiatorAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const activeRooms = req.app.get('activeRooms');
    const room = activeRooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    if (room.gameStarted) {
      return res.status(400).json({ error: 'Game already started' });
    }
    
    // Sprawdź, czy inicjator jest w pokoju
    if (!room.players.includes(initiatorAddress)) {
      return res.status(403).json({ error: 'Not authorized to start the game' });
    }
    
    // Weryfikacja transakcji (opcjonalna)
    if (transactionSignature) {
      try {
        const verifyTransaction = req.app.get('verifyTransaction');
        const txInfo = await verifyTransaction(transactionSignature);
        
        if (txInfo.status !== 'success') {
          return res.status(400).json({ error: 'Transaction failed on-chain' });
        }
        
        console.log(`Transaction ${transactionSignature} verified:`, txInfo);
      } catch (verifyError) {
        console.error('Error verifying transaction:', verifyError);
        // Możemy zdecydować, czy kontynuować mimo błędu weryfikacji
      }
    }
    
    // Rozpocznij grę
    room.gameStarted = true;
    room.gameId = gameId;
    room.lastActivity = new Date().toISOString();
    
    // Zapisz zaktualizowany pokój
    activeRooms.set(roomId, room);
    
    // Inicjalizuj stan gry
    const gameStates = req.app.get('gameStates');
    const UnoGame = require('../game/UnoGame');
    const game = new UnoGame(roomId, room.players);
    gameStates.set(roomId, game);
    
    // Powiadom graczy w pokoju
    const io = req.app.get('socketIo');
    if (io) {
      io.to(`room_${roomId}`).emit('room_update', room);
      io.to(`room_${roomId}`).emit('game_started', { gameId });
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error starting game:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

// Zakończ grę
router.post('/rooms/:id/end', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { winnerAddress, transactionSignature } = req.body;
    
    if (!winnerAddress) {
      return res.status(400).json({ error: 'Missing winner address' });
    }
    
    const activeRooms = req.app.get('activeRooms');
    const room = activeRooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Sprawdź, czy zwycięzca jest w pokoju
    if (!room.players.includes(winnerAddress)) {
      return res.status(400).json({ error: 'Winner is not a player in this room' });
    }
    
    // Weryfikacja transakcji (opcjonalna)
    if (transactionSignature) {
      try {
        const verifyTransaction = req.app.get('verifyTransaction');
        const txInfo = await verifyTransaction(transactionSignature);
        
        if (txInfo.status !== 'success') {
          return res.status(400).json({ error: 'Transaction failed on-chain' });
        }
        
        console.log(`Transaction ${transactionSignature} verified:`, txInfo);
      } catch (verifyError) {
        console.error('Error verifying transaction:', verifyError);
        // Możemy zdecydować, czy kontynuować mimo błędu weryfikacji
      }
    }
    
    // Zakończ grę
    room.winner = winnerAddress;
    room.isActive = false;
    room.endedAt = new Date().toISOString();
    room.lastActivity = new Date().toISOString();
    
    // Zapisz zaktualizowany pokój
    activeRooms.set(roomId, room);
    
    // Aktualizuj stan gry
    const gameStates = req.app.get('gameStates');
    const game = gameStates.get(roomId);
    
    if (game) {
      game.winner = winnerAddress;
      game.isActive = false;
    }
    
    // Powiadom graczy w pokoju
    const io = req.app.get('socketIo');
    if (io) {
      io.to(`room_${roomId}`).emit('room_update', room);
      io.to(`room_${roomId}`).emit('game_ended', { winner: winnerAddress });
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error ending game:', error);
    res.status(500).json({ error: 'Failed to end game' });
  }
});

// Odbiór nagrody
router.post('/rooms/:id/claim', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { claimerAddress, transactionSignature } = req.body;
    
    if (!claimerAddress) {
      return res.status(400).json({ error: 'Missing claimer address' });
    }
    
    const activeRooms = req.app.get('activeRooms');
    const room = activeRooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Sprawdź, czy osoba odbierająca jest zwycięzcą
    if (room.winner !== claimerAddress) {
      return res.status(403).json({ error: 'Only the winner can claim the prize' });
    }
    
    // Sprawdź, czy nagroda nie została już odebrana
    if (room.prizeClaimedBy) {
      return res.status(400).json({ error: 'Prize already claimed' });
    }
    
    // Weryfikacja transakcji (opcjonalna)
    if (transactionSignature) {
      try {
        const verifyTransaction = req.app.get('verifyTransaction');
        const txInfo = await verifyTransaction(transactionSignature);
        
        if (txInfo.status !== 'success') {
          return res.status(400).json({ error: 'Transaction failed on-chain' });
        }
        
        console.log(`Transaction ${transactionSignature} verified:`, txInfo);
      } catch (verifyError) {
        console.error('Error verifying transaction:', verifyError);
        // Możemy zdecydować, czy kontynuować mimo błędu weryfikacji
      }
    }
    
    // Oznacz nagrodę jako odebraną
    room.prizeClaimedBy = claimerAddress;
    room.prizeClaimedAt = new Date().toISOString();
    room.lastActivity = new Date().toISOString();
    
    // Zapisz zaktualizowany pokój
    activeRooms.set(roomId, room);
    
    // Powiadom graczy w pokoju
    const io = req.app.get('socketIo');
    if (io) {
      io.to(`room_${roomId}`).emit('room_update', room);
    }
    
    res.status(200).json({ 
      success: true,
      prize: room.entryFee * room.players.length,
      claimedAt: room.prizeClaimedAt
    });
  } catch (error) {
    console.error('Error claiming prize:', error);
    res.status(500).json({ error: 'Failed to claim prize' });
  }
});

// Opuść pokój
router.post('/rooms/:id/leave', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ error: 'Missing player address' });
    }
    
    const activeRooms = req.app.get('activeRooms');
    const room = activeRooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Sprawdź, czy gracz jest w pokoju
    const playerIndex = room.players.indexOf(playerAddress);
    if (playerIndex === -1) {
      return res.status(400).json({ error: 'Player is not in this room' });
    }
    
    // Zapisz, czy pokój był aktywny przed opuszczeniem
    const wasActive = room.isActive && room.gameStarted && !room.winner;
    
    // Jeśli gra jest w toku, a gracz opuszcza pokój, ustaw przeciwnika jako zwycięzcę
    if (wasActive && room.players.length === 2) {
      const opponentAddress = room.players.find(p => p !== playerAddress);
      
      room.winner = opponentAddress;
      room.isActive = false;
      room.endedAt = new Date().toISOString();
      room.opponentWins = true;
      
      // Aktualizuj stan gry
      const gameStates = req.app.get('gameStates');
      const game = gameStates.get(roomId);
      
      if (game) {
        game.winner = opponentAddress;
        game.isActive = false;
      }
      
      // Powiadom graczy w pokoju
      const io = req.app.get('socketIo');
      if (io) {
        io.to(`room_${roomId}`).emit('room_update', room);
        io.to(`room_${roomId}`).emit('game_ended', { 
          winner: opponentAddress,
          reason: 'opponent_left'
        });
      }
      
      res.status(200).json({ 
        success: true, 
        wasActive, 
        opponentWins: true,
        opponentAddress 
      });
    } else {
      // Jeśli gra jeszcze się nie rozpoczęła lub jest więcej graczy, po prostu usuń gracza
      room.players = room.players.filter(p => p !== playerAddress);
      
      // Jeśli to był ostatni gracz, oznacz pokój jako nieaktywny
      if (room.players.length === 0) {
        room.isActive = false;
      }
      
      room.lastActivity = new Date().toISOString();
      
      // Zapisz zaktualizowany pokój
      activeRooms.set(roomId, room);
      
      // Powiadom graczy w pokoju
      const io = req.app.get('socketIo');
      if (io) {
        io.to(`room_${roomId}`).emit('room_update', room);
      }
      
      res.status(200).json({ success: true, wasActive, opponentWins: false });
    }
  } catch (error) {
    console.error('Error leaving room:', error);
    res.status(500).json({ error: 'Failed to leave room' });
  }
});

// Pobierz stan gry
router.get('/game/:id/state', async (req, res) => {
  try {
    const roomId = req.params.id;
    const playerAddress = req.query.playerAddress;
    
    if (!playerAddress) {
      return res.status(400).json({ error: 'Missing player address' });
    }
    
    const gameStates = req.app.get('gameStates');
    const game = gameStates.get(roomId);
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    const gameState = game.getGameStateForPlayer(playerAddress);
    
    res.status(200).json(gameState);
  } catch (error) {
    console.error('Error getting game state:', error);
    res.status(500).json({ error: 'Failed to get game state' });
  }
});

// Zagranie karty
router.post('/game/:id/play', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerAddress, cardIndex, chosenColor } = req.body;
    
    if (!playerAddress || cardIndex === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const gameStates = req.app.get('gameStates');
    const game = gameStates.get(roomId);
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    // Wykonaj ruch
    const result = game.playCard(playerAddress, cardIndex, chosenColor);
    
    // Sprawdź, czy gra się zakończyła
    if (result.winner) {
      const activeRooms = req.app.get('activeRooms');
      const room = activeRooms.get(roomId);
      
      if (room) {
        room.winner = playerAddress;
        room.isActive = false;
        room.endedAt = new Date().toISOString();
        room.lastActivity = new Date().toISOString();
        
        // Zapisz zaktualizowany pokój
        activeRooms.set(roomId, room);
        
        // Powiadom graczy w pokoju
        const io = req.app.get('socketIo');
        if (io) {
          io.to(`room_${roomId}`).emit('room_update', room);
          io.to(`room_${roomId}`).emit('game_ended', { winner: playerAddress });
        }
      }
    } else {
      // Powiadom graczy o aktualizacji stanu gry
      broadcastGameState(req, roomId, game);
    }
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error playing card:', error);
    res.status(400).json({ error: error.message });
  }
});

// Dobieranie karty
router.post('/game/:id/draw', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ error: 'Missing player address' });
    }
    
    const gameStates = req.app.get('gameStates');
    const game = gameStates.get(roomId);
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    // Wykonaj dobieranie karty
    const card = game.drawCard(playerAddress);
    
    // Powiadom graczy o aktualizacji stanu gry
    broadcastGameState(req, roomId, game);
    
    res.status(200).json({ card });
  } catch (error) {
    console.error('Error drawing card:', error);
    res.status(400).json({ error: error.message });
  }
});

// Funkcja do rozgłaszania stanu gry
function broadcastGameState(req, roomId, game) {
  const io = req.app.get('socketIo');
  const activeRooms = req.app.get('activeRooms');
  const room = activeRooms.get(roomId);
  
  if (!io || !room || !room.players) {
    return;
  }
  
  // Dla każdego gracza w pokoju
  for (const playerAddress of room.players) {
    try {
      // Pobierz stan gry z perspektywy gracza
      const playerState = game.getGameStateForPlayer(playerAddress);
      
      // Wyślij stan gry do gracza
      io.to(roomId).emit('game_state_update', playerState);
    } catch (error) {
      console.error(`Error broadcasting to player ${playerAddress}:`, error);
    }
  }
}

module.exports = router;